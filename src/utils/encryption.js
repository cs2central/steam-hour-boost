const crypto = require('crypto');

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 100000;
const DIGEST = 'sha256';
const ENCRYPTED_PREFIX = '$ENC$';

/**
 * Generate a cryptographically secure random salt
 * @returns {string} Base64 encoded salt
 */
function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH).toString('base64');
}

/**
 * Derive an encryption key from a password using PBKDF2
 * @param {string} password - The password to derive key from
 * @param {string} salt - Base64 encoded salt
 * @returns {Promise<Buffer>} Derived key buffer
 */
async function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    const saltBuffer = Buffer.from(salt, 'base64');
    crypto.pbkdf2(password, saltBuffer, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST, (err, key) => {
      if (err) {
        reject(err);
      } else {
        resolve(key);
      }
    });
  });
}

/**
 * Derive key synchronously (for use in contexts where async isn't possible)
 * @param {string} password - The password to derive key from
 * @param {string} salt - Base64 encoded salt
 * @returns {Buffer} Derived key buffer
 */
function deriveKeySync(password, salt) {
  const saltBuffer = Buffer.from(salt, 'base64');
  return crypto.pbkdf2Sync(password, saltBuffer, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * @param {string} plaintext - Text to encrypt
 * @param {Buffer} key - 32-byte encryption key
 * @returns {string} Encrypted string in format: $ENC$<iv>:<authTag>:<ciphertext>
 */
function encrypt(plaintext, key) {
  if (!plaintext || typeof plaintext !== 'string') {
    return plaintext;
  }

  if (!key || key.length !== KEY_LENGTH) {
    throw new Error('Invalid encryption key: must be 32 bytes');
  }

  // Generate random IV
  const iv = crypto.randomBytes(IV_LENGTH);

  // Create cipher
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  // Encrypt the plaintext
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  // Get auth tag
  const authTag = cipher.getAuthTag();

  // Return formatted encrypted string
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt an encrypted string using AES-256-GCM
 * @param {string} encryptedText - Encrypted string in format: $ENC$<iv>:<authTag>:<ciphertext>
 * @param {Buffer} key - 32-byte encryption key
 * @returns {string} Decrypted plaintext
 */
function decrypt(encryptedText, key) {
  if (!encryptedText || typeof encryptedText !== 'string') {
    return encryptedText;
  }

  // Check if the text is actually encrypted
  if (!isEncrypted(encryptedText)) {
    return encryptedText;
  }

  if (!key || key.length !== KEY_LENGTH) {
    throw new Error('Invalid encryption key: must be 32 bytes');
  }

  // Remove prefix and split components
  const data = encryptedText.slice(ENCRYPTED_PREFIX.length);
  const parts = data.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const [ivBase64, authTagBase64, ciphertext] = parts;

  // Decode components
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  // Create decipher
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt
  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if a string is encrypted (has our encryption prefix)
 * @param {string} text - Text to check
 * @returns {boolean} True if text appears to be encrypted
 */
function isEncrypted(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  return text.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt multiple fields in an object
 * @param {Object} data - Object with fields to encrypt
 * @param {string[]} fields - Array of field names to encrypt
 * @param {Buffer} key - Encryption key
 * @returns {Object} Object with encrypted fields
 */
function encryptFields(data, fields, key) {
  const result = { ...data };
  for (const field of fields) {
    if (result[field] && !isEncrypted(result[field])) {
      result[field] = encrypt(result[field], key);
    }
  }
  return result;
}

/**
 * Decrypt multiple fields in an object
 * @param {Object} data - Object with fields to decrypt
 * @param {string[]} fields - Array of field names to decrypt
 * @param {Buffer} key - Encryption key
 * @returns {Object} Object with decrypted fields
 */
function decryptFields(data, fields, key) {
  const result = { ...data };
  for (const field of fields) {
    if (result[field] && isEncrypted(result[field])) {
      result[field] = decrypt(result[field], key);
    }
  }
  return result;
}

/**
 * Re-encrypt data with a new key
 * @param {string} encryptedText - Text encrypted with old key
 * @param {Buffer} oldKey - Original encryption key
 * @param {Buffer} newKey - New encryption key
 * @returns {string} Text re-encrypted with new key
 */
function reEncrypt(encryptedText, oldKey, newKey) {
  if (!encryptedText) {
    return encryptedText;
  }

  // Decrypt with old key
  const plaintext = decrypt(encryptedText, oldKey);

  // Encrypt with new key
  return encrypt(plaintext, newKey);
}

module.exports = {
  generateSalt,
  deriveKey,
  deriveKeySync,
  encrypt,
  decrypt,
  isEncrypted,
  encryptFields,
  decryptFields,
  reEncrypt,
  ENCRYPTED_PREFIX
};
