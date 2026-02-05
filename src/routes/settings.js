const express = require('express');
const router = express.Router();
const db = require('../models/database');
const logger = require('../services/logger');
const steamApiService = require('../services/steamApiService');
const { changePassword, getEncryptionKey } = require('../middleware/auth');
const { encrypt, isEncrypted } = require('../utils/encryption');

// Get all settings
router.get('/api/settings', (req, res) => {
  try {
    const settings = db.settings.getAll();

    // Don't expose sensitive values, just indicate if they're set
    const safeSettings = {
      ...settings,
      steam_api_key: settings.steam_api_key ? '********' : null,
      encryption_salt: undefined // Never expose
    };
    delete safeSettings.encryption_salt;

    // Add computed fields
    safeSettings.steam_api_configured = !!settings.steam_api_key;
    safeSettings.api_refresh_interval = settings.api_refresh_interval || 0;

    res.json(safeSettings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update settings
router.put('/api/settings', (req, res) => {
  try {
    const { default_persona_state, auto_start, log_retention_days } = req.body;

    if (default_persona_state !== undefined) {
      db.settings.set('default_persona_state', default_persona_state);
    }
    if (auto_start !== undefined) {
      db.settings.set('auto_start', auto_start);
    }
    if (log_retention_days !== undefined) {
      db.settings.set('log_retention_days', log_retention_days);
    }

    logger.info('Settings updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password
router.post('/api/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    await changePassword(req.session.userId, currentPassword, newPassword);
    logger.info('Password changed');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Clear all logs
router.delete('/api/logs', (req, res) => {
  try {
    db.logs.cleanup(0); // 0 days = delete all
    logger.info('All logs cleared');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset all data
router.post('/api/reset', (req, res) => {
  try {
    const steamService = require('../services/steamService');

    // Stop all idling first
    steamService.logoutAll();

    // Clear all tables (except the current user)
    const currentUserId = req.session.userId;

    // Delete accounts (cascades to account_games, sessions)
    const accounts = db.accounts.findAll();
    for (const acc of accounts) {
      db.accounts.delete(acc.id);
    }

    // Delete MAFiles
    const mafiles = db.mafiles.findAll();
    for (const mf of mafiles) {
      db.mafiles.delete(mf.id);
    }

    // Clear logs
    db.logs.cleanup(0);

    // Clear settings
    db.settings.set('default_persona_state', 1);
    db.settings.set('auto_start', 'true');
    db.settings.set('log_retention_days', 7);

    // Delete all users except current
    // Since we only support single user, just redirect to setup
    // We keep the user so they can still reset without being locked out

    logger.info('All data has been reset');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Steam API key (encrypted)
router.post('/api/settings/steam-api-key', async (req, res) => {
  try {
    const { apiKey } = req.body;

    // Allow clearing the API key
    if (!apiKey) {
      await steamApiService.setApiKey(null);
      steamApiService.stopPeriodicRefresh();
      logger.info('Steam API key removed', null, 'API');
      return res.json({ success: true, message: 'API key removed' });
    }

    // Validate API key format (should be 32 hex characters)
    if (!/^[A-F0-9]{32}$/i.test(apiKey)) {
      return res.status(400).json({ error: 'Invalid API key format' });
    }

    await steamApiService.setApiKey(apiKey);
    logger.info('Steam API key updated', null, 'API');

    res.json({ success: true, message: 'API key saved' });
  } catch (err) {
    logger.error(`Failed to save Steam API key: ${err.message}`, null, 'API');
    res.status(500).json({ error: err.message });
  }
});

// Update API refresh interval
router.put('/api/settings/api-refresh-interval', (req, res) => {
  try {
    const { interval } = req.body;

    // Validate interval (0 = disabled, or 1 hour to 24 hours)
    const intervalMs = parseInt(interval);

    if (isNaN(intervalMs) || (intervalMs !== 0 && (intervalMs < 3600000 || intervalMs > 86400000))) {
      return res.status(400).json({
        error: 'Invalid interval. Use 0 to disable, or 1-24 hours in milliseconds.'
      });
    }

    steamApiService.setRefreshInterval(intervalMs);

    logger.info(`API refresh interval set to ${intervalMs}ms`, null, 'API');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually refresh all accounts
router.post('/api/settings/refresh-all-accounts', async (req, res) => {
  try {
    if (!steamApiService.isConfigured()) {
      return res.status(400).json({ error: 'Steam API key not configured' });
    }

    const result = await steamApiService.refreshAllAccounts();

    res.json({
      success: true,
      refreshed: result.refreshed,
      errors: result.errors
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
