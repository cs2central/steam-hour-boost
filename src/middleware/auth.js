const bcrypt = require('bcryptjs');
const db = require('../models/database');
const { generateSalt, deriveKey, encrypt, decrypt, isEncrypted, reEncrypt } = require('../utils/encryption');
const logger = require('../services/logger');

const SALT_ROUNDS = 10;

// Cached encryption key (in-memory, per-process)
let cachedEncryptionKey = null;

// Fields that should be encrypted in accounts
const ENCRYPTED_FIELDS = ['password', 'shared_secret', 'identity_secret'];

/**
 * Authentication middleware
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  // Check if this is an API request
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Redirect to login for page requests
  return res.redirect('/login');
}

/**
 * Check if setup is needed (no users exist)
 */
function checkSetup(req, res, next) {
  const userCount = db.users.count();

  if (userCount === 0) {
    // Allow access to setup page
    if (req.path === '/setup' || req.path === '/api/setup') {
      return next();
    }
    // Redirect to setup
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Setup required', setup: true });
    }
    return res.redirect('/setup');
  }

  // Setup already done, don't allow setup page
  if (req.path === '/setup' || req.path === '/api/setup') {
    return res.redirect('/');
  }

  next();
}

/**
 * Hash a password
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password
 */
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Create a new user
 */
async function createUser(username, password) {
  const hash = await hashPassword(password);
  return db.users.create(username, hash);
}

/**
 * Authenticate a user
 */
async function authenticateUser(username, password) {
  const user = db.users.findByUsername(username);
  if (!user) {
    return null;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return null;
  }

  return user;
}

/**
 * Change user password
 */
async function changePassword(userId, currentPassword, newPassword) {
  const user = db.users.findById(userId);

  if (!user) {
    throw new Error('User not found');
  }

  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) {
    throw new Error('Current password is incorrect');
  }

  const hash = await hashPassword(newPassword);
  db.users.updatePassword(userId, hash);
}

/**
 * Get the cached encryption key
 * @returns {Buffer|null} Encryption key or null if not set
 */
function getEncryptionKey() {
  return cachedEncryptionKey;
}

/**
 * Set the encryption key from password (derives and caches)
 * @param {string} password - Admin password to derive key from
 * @returns {Promise<Buffer>} Derived encryption key
 */
async function setEncryptionKey(password) {
  const salt = db.settings.get('encryption_salt');
  if (!salt) {
    throw new Error('Encryption salt not found in settings');
  }

  cachedEncryptionKey = await deriveKey(password, salt);
  logger.info('Encryption key derived and cached', null, 'ENCRYPTION');
  return cachedEncryptionKey;
}

/**
 * Initialize encryption for a new setup (generates salt, derives key)
 * @param {string} password - Admin password
 * @returns {Promise<Buffer>} Derived encryption key
 */
async function initializeEncryption(password) {
  // Generate and store encryption salt
  const salt = generateSalt();
  db.settings.set('encryption_salt', salt);

  // Derive and cache the key
  cachedEncryptionKey = await deriveKey(password, salt);
  logger.info('Encryption initialized with new salt', null, 'ENCRYPTION');

  return cachedEncryptionKey;
}

/**
 * Re-encrypt all account credentials with a new key
 * @param {Buffer} oldKey - Previous encryption key
 * @param {Buffer} newKey - New encryption key
 * @returns {Promise<Object>} Result with success count and errors
 */
async function reEncryptAllData(oldKey, newKey) {
  const accounts = db.accounts.findAll();
  let success = 0;
  let errors = 0;

  logger.info(`Re-encrypting credentials for ${accounts.length} accounts`, null, 'ENCRYPTION');

  for (const account of accounts) {
    try {
      const updates = {};

      for (const field of ENCRYPTED_FIELDS) {
        if (account[field]) {
          if (isEncrypted(account[field])) {
            // Re-encrypt with new key
            updates[field] = reEncrypt(account[field], oldKey, newKey);
          } else {
            // First time encryption
            updates[field] = encrypt(account[field], newKey);
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        db.accounts.update(account.id, updates);
      }

      success++;
    } catch (err) {
      errors++;
      logger.error(`Failed to re-encrypt account ${account.id}: ${err.message}`, account.id, 'ENCRYPTION');
    }
  }

  // Also re-encrypt Steam API key if it exists
  const apiKey = db.settings.get('steam_api_key');
  if (apiKey && isEncrypted(apiKey)) {
    try {
      const newApiKey = reEncrypt(apiKey, oldKey, newKey);
      db.settings.set('steam_api_key', newApiKey);
    } catch (err) {
      logger.error(`Failed to re-encrypt Steam API key: ${err.message}`, null, 'ENCRYPTION');
    }
  }

  logger.info(`Re-encryption complete: ${success} success, ${errors} errors`, null, 'ENCRYPTION');

  // Update the cached key
  cachedEncryptionKey = newKey;

  return { success, errors };
}

/**
 * Encrypt account credentials before saving
 * @param {Object} data - Account data with plaintext credentials
 * @returns {Object} Account data with encrypted credentials
 */
function encryptAccountCredentials(data) {
  if (!cachedEncryptionKey) {
    logger.warn('Encryption key not available, storing credentials unencrypted', null, 'ENCRYPTION');
    return data;
  }

  const result = { ...data };

  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] && !isEncrypted(result[field])) {
      result[field] = encrypt(result[field], cachedEncryptionKey);
    }
  }

  return result;
}

/**
 * Decrypt account credentials for use
 * @param {Object} account - Account data with encrypted credentials
 * @returns {Object} Account data with decrypted credentials
 */
function decryptAccountCredentials(account) {
  if (!cachedEncryptionKey || !account) {
    return account;
  }

  const result = { ...account };

  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] && isEncrypted(result[field])) {
      try {
        result[field] = decrypt(result[field], cachedEncryptionKey);
      } catch (err) {
        logger.error(`Failed to decrypt ${field} for account ${account.id}: ${err.message}`, account.id, 'ENCRYPTION');
      }
    }
  }

  return result;
}

/**
 * Clear the cached encryption key (for logout/shutdown)
 */
function clearEncryptionKey() {
  cachedEncryptionKey = null;
}

/**
 * Check if encryption is properly initialized
 * @returns {boolean} True if encryption salt exists
 */
function isEncryptionInitialized() {
  return !!db.settings.get('encryption_salt');
}

module.exports = {
  requireAuth,
  checkSetup,
  hashPassword,
  verifyPassword,
  createUser,
  authenticateUser,
  changePassword,
  // Encryption functions
  getEncryptionKey,
  setEncryptionKey,
  initializeEncryption,
  reEncryptAllData,
  encryptAccountCredentials,
  decryptAccountCredentials,
  clearEncryptionKey,
  isEncryptionInitialized,
  ENCRYPTED_FIELDS
};
