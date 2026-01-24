const express = require('express');
const router = express.Router();
const accountManager = require('../services/accountManager');
const steamService = require('../services/steamService');
const logger = require('../services/logger');

// Get all accounts
router.get('/api/accounts', (req, res) => {
  try {
    const accounts = accountManager.getAll();
    // Don't expose passwords in API response, but indicate if shared_secret exists
    const safeAccounts = accounts.map(acc => ({
      id: acc.id,
      username: acc.username,
      steam_id: acc.steam_id,
      display_name: acc.display_name,
      status: acc.status,
      last_error: acc.last_error,
      is_idling: acc.is_idling,
      persona_state: acc.persona_state || 1,
      games: acc.games,
      created_at: acc.created_at,
      shared_secret: acc.shared_secret ? true : false // Boolean only, not the actual secret
    }));
    res.json(safeAccounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single account
router.get('/api/accounts/:id', (req, res) => {
  try {
    const account = accountManager.getById(parseInt(req.params.id));
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Don't expose password or actual secrets
    const { password, shared_secret, identity_secret, ...safeAccount } = account;
    safeAccount.shared_secret = shared_secret ? true : false;
    safeAccount.identity_secret = identity_secret ? true : false;
    safeAccount.persona_state = account.persona_state || 1;
    res.json(safeAccount);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new account
router.post('/api/accounts', (req, res) => {
  try {
    const { username, password, mafile_id, games, shared_secret, identity_secret, persona_state } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const account = accountManager.create({
      username,
      password,
      mafile_id,
      games,
      shared_secret,
      identity_secret,
      persona_state: persona_state || 1
    });

    const { password: _, ...safeAccount } = account;
    res.status(201).json(safeAccount);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update account
router.put('/api/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { username, password, games, shared_secret, identity_secret, display_name, persona_state } = req.body;

    const account = accountManager.update(id, {
      username,
      password,
      games,
      shared_secret,
      identity_secret,
      display_name,
      persona_state
    });

    // Update persona state on active session if one exists
    if (persona_state !== undefined) {
      const session = steamService.getSession(id);
      if (session && session.isLoggedIn) {
        session.setPersonaState(persona_state);
      }
    }

    const { password: _, ...safeAccount } = account;
    res.json(safeAccount);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete account
router.delete('/api/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    accountManager.delete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start idling for an account
router.post('/api/accounts/:id/start', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const status = await steamService.startIdling(id);
    res.json({ success: true, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stop idling for an account
router.post('/api/accounts/:id/stop', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    steamService.stopIdling(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get account status
router.get('/api/accounts/:id/status', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const account = accountManager.getById(id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const steamStatus = steamService.getStatus(id);
    res.json({
      ...steamStatus,
      status: account.status,
      last_error: account.last_error
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get account logs
router.get('/api/accounts/:id/logs', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 100;
    const logs = logger.getByAccount(id, limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start all accounts
router.post('/api/accounts/start-all', async (req, res) => {
  try {
    const results = await steamService.startAll();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop all accounts
router.post('/api/accounts/stop-all', (req, res) => {
  try {
    steamService.stopAll();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
