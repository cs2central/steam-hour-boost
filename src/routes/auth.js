const express = require('express');
const router = express.Router();
const { createUser, authenticateUser, changePassword } = require('../middleware/auth');
const db = require('../models/database');

// Setup - Create initial admin account
router.post('/api/setup', async (req, res) => {
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

    await createUser(username, password);
    res.json({ success: true, message: 'Admin account created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;

    res.json({ success: true, username: user.username });
  } catch (err) {
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

    await changePassword(req.session.userId, currentPassword, newPassword);
    res.json({ success: true, message: 'Password changed' });
  } catch (err) {
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
