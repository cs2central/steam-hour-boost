const express = require('express');
const router = express.Router();
const {
  createUser,
  authenticateUser,
  changePassword,
  initializeEncryption,
  setEncryptionKey,
  getEncryptionKey,
  reEncryptAllData,
  isEncryptionInitialized
} = require('../middleware/auth');
const { deriveKey } = require('../utils/encryption');
const { rateLimiters } = require('../middleware/rateLimiter');
const db = require('../models/database');
const logger = require('../services/logger');
const steamApiService = require('../services/steamApiService');
const steamService = require('../services/steamService');

// Setup - Create initial admin account
router.post('/api/setup', rateLimiters.setup, async (req, res) => {
  try {
    const userCount = db.users.count();
    if (userCount > 0) {
      return res.status(400).json({ error: 'Setup already completed' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Initialize encryption with the admin password
    const encryptionKey = await initializeEncryption(password);

    // Create the admin user
    await createUser(username, password);

    // Initialize Steam API service with encryption key
    steamApiService.initialize(db, encryptionKey).catch(err => {
      logger.error(`Failed to initialize Steam API service: ${err.message}`, null, 'API');
    });

    logger.info('Initial setup completed', null, 'AUTH');
    res.json({ success: true, message: 'Admin account created' });
  } catch (err) {
    logger.error(`Setup failed: ${err.message}`, null, 'AUTH');
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/api/login', rateLimiters.login, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      logger.warn(`Failed login attempt for user: ${username}`, null, 'AUTH');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Derive and cache encryption key for this session
    try {
      let encryptionKey;

      // Check if encryption is already initialized
      if (isEncryptionInitialized()) {
        // Existing install with encryption - derive key from password
        encryptionKey = await setEncryptionKey(password);
      } else {
        // Legacy install without encryption - initialize it now
        logger.info('Initializing encryption for existing install...', null, 'ENCRYPTION');
        encryptionKey = await initializeEncryption(password);

        // Encrypt all existing plaintext credentials
        const accounts = db.accounts.findAll();
        let encrypted = 0;
        for (const account of accounts) {
          const updates = {};
          const { encrypt, isEncrypted } = require('../utils/encryption');

          // Check each sensitive field
          if (account.password && !isEncrypted(account.password)) {
            updates.password = encrypt(account.password, encryptionKey);
          }
          if (account.shared_secret && !isEncrypted(account.shared_secret)) {
            updates.shared_secret = encrypt(account.shared_secret, encryptionKey);
          }
          if (account.identity_secret && !isEncrypted(account.identity_secret)) {
            updates.identity_secret = encrypt(account.identity_secret, encryptionKey);
          }

          if (Object.keys(updates).length > 0) {
            db.accounts.update(account.id, updates);
            encrypted++;
          }
        }

        if (encrypted > 0) {
          logger.info(`Encrypted credentials for ${encrypted} existing accounts`, null, 'ENCRYPTION');
        }
      }

      // Initialize Steam API service with database and encryption key
      await steamApiService.initialize(db, encryptionKey);

      // Start periodic refresh if configured
      const refreshInterval = steamApiService.getRefreshInterval();
      if (refreshInterval && refreshInterval > 0) {
        steamApiService.startPeriodicRefresh(refreshInterval);
      }

      // Resume idling now that encryption key is available
      steamService.resumeIdling().catch(err => {
        logger.error(`Failed to resume idling after login: ${err.message}`);
      });
    } catch (encErr) {
      // Log error but allow login to proceed
      logger.error(`Encryption initialization failed: ${encErr.message}`, null, 'ENCRYPTION');
    }

    req.session.userId = user.id;
    req.session.username = user.username;

    logger.info(`User ${username} logged in`, null, 'AUTH');
    res.json({ success: true, username: user.username });
  } catch (err) {
    logger.error(`Login error: ${err.message}`, null, 'AUTH');
    res.status(500).json({ error: err.message });
  }
});

// Logout
router.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

// Change password
router.post('/api/settings/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Get the old encryption key
    const oldKey = getEncryptionKey();

    // Change the user password
    await changePassword(req.session.userId, currentPassword, newPassword);

    // Re-encrypt all data with new key
    if (oldKey) {
      const salt = db.settings.get('encryption_salt');
      if (salt) {
        const newKey = await deriveKey(newPassword, salt);
        const result = await reEncryptAllData(oldKey, newKey);

        // Update Steam API service with new key
        steamApiService.updateEncryptionKey(newKey);

        logger.info(`Password changed, re-encrypted ${result.success} accounts`, null, 'AUTH');

        if (result.errors > 0) {
          return res.json({
            success: true,
            message: 'Password changed',
            warning: `${result.errors} accounts failed to re-encrypt`
          });
        }
      }
    }

    res.json({ success: true, message: 'Password changed' });
  } catch (err) {
    logger.error(`Password change failed: ${err.message}`, null, 'AUTH');
    res.status(400).json({ error: err.message });
  }
});

// Check auth status
router.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ authenticated: true, username: req.session.username });
  } else {
    res.json({ authenticated: false });
  }
});

module.exports = router;
