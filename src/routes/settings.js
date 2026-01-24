const express = require('express');
const router = express.Router();
const db = require('../models/database');
const logger = require('../services/logger');
const { changePassword } = require('../middleware/auth');

// Get all settings
router.get('/api/settings', (req, res) => {
  try {
    const settings = db.settings.getAll();
    res.json(settings);
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

module.exports = router;
