const express = require('express');
const router = express.Router();
const accountManager = require('../services/accountManager');
const steamService = require('../services/steamService');
const steamApiService = require('../services/steamApiService');
const logger = require('../services/logger');
const db = require('../models/database');
const {
  getEncryptionKey,
  encryptAccountCredentials,
  decryptAccountCredentials
} = require('../middleware/auth');
const { encrypt, decrypt, isEncrypted, generateSalt, deriveKey } = require('../utils/encryption');

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
      avatar_url: acc.avatar_url,
      status: acc.status,
      last_error: acc.last_error,
      is_idling: acc.is_idling,
      persona_state: acc.persona_state || 1,
      games: acc.games,
      created_at: acc.created_at,
      shared_secret: acc.shared_secret ? true : false, // Boolean only, not the actual secret
      vac_banned: acc.vac_banned,
      trade_banned: acc.trade_banned,
      game_bans: acc.game_bans,
      total_games: acc.total_games,
      lockout_until: acc.lockout_until,
      api_last_refresh: acc.api_last_refresh,
      incomplete: !acc.password || acc.password === '', // Account needs password to be set
      is_private_profile: acc.steam_id && acc.api_last_refresh && (acc.total_games === 0 || acc.total_games === null)
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
    safeAccount.incomplete = !password || password === ''; // Account needs password
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

    // Check if account is incomplete (no password)
    const account = accountManager.getById(id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    if (!account.password || account.password === '') {
      return res.status(400).json({ error: 'Account setup incomplete. Please set a password first.' });
    }

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

// Search and filter accounts
router.get('/api/accounts/search', (req, res) => {
  try {
    const { q, status, hasGuard, isIdling, sortBy, order } = req.query;

    let accounts = accountManager.search({
      q,
      status: status === 'incomplete' ? null : status, // Handle incomplete separately
      hasGuard,
      isIdling,
      sortBy,
      order
    });

    // Filter by incomplete status if requested
    if (status === 'incomplete') {
      accounts = accounts.filter(acc => !acc.password || acc.password === '');
    }

    // Don't expose passwords in API response
    const safeAccounts = accounts.map(acc => ({
      id: acc.id,
      username: acc.username,
      steam_id: acc.steam_id,
      display_name: acc.display_name,
      avatar_url: acc.avatar_url,
      status: acc.status,
      last_error: acc.last_error,
      is_idling: acc.is_idling,
      persona_state: acc.persona_state || 1,
      games: acc.games,
      created_at: acc.created_at,
      shared_secret: acc.shared_secret ? true : false,
      vac_banned: acc.vac_banned,
      trade_banned: acc.trade_banned,
      game_bans: acc.game_bans,
      lockout_until: acc.lockout_until,
      incomplete: !acc.password || acc.password === '',
      is_private_profile: acc.steam_id && acc.api_last_refresh && (acc.total_games === 0 || acc.total_games === null)
    }));

    res.json(safeAccounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export accounts (encrypted)
router.post('/api/accounts/export', async (req, res) => {
  try {
    const { exportPassword } = req.body;

    if (!exportPassword || exportPassword.length < 6) {
      return res.status(400).json({ error: 'Export password must be at least 6 characters' });
    }

    const appKey = getEncryptionKey();
    if (!appKey) {
      return res.status(400).json({ error: 'Encryption not initialized' });
    }

    // Generate export-specific salt
    const exportSalt = generateSalt();
    const exportKey = await deriveKey(exportPassword, exportSalt);

    // Get all accounts with decrypted data
    const accounts = db.accounts.findAll();
    const exportedAccounts = [];

    for (const account of accounts) {
      // Decrypt with app key
      const decrypted = decryptAccountCredentials(account);

      // Re-encrypt with export password
      const exportAccount = {
        username: decrypted.username,
        password: encrypt(decrypted.password, exportKey),
        shared_secret: decrypted.shared_secret ? encrypt(decrypted.shared_secret, exportKey) : null,
        identity_secret: decrypted.identity_secret ? encrypt(decrypted.identity_secret, exportKey) : null,
        steam_id: decrypted.steam_id,
        display_name: decrypted.display_name,
        persona_state: decrypted.persona_state,
        games: db.games.getGames(account.id)
      };

      exportedAccounts.push(exportAccount);
    }

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      salt: exportSalt,
      accountCount: exportedAccounts.length,
      accounts: exportedAccounts
    };

    logger.info(`Exported ${exportedAccounts.length} accounts`, null, 'SYSTEM');

    res.json({
      success: true,
      data: exportData
    });
  } catch (err) {
    logger.error(`Export failed: ${err.message}`, null, 'SYSTEM');
    res.status(500).json({ error: err.message });
  }
});

// Import accounts (encrypted)
router.post('/api/accounts/import', async (req, res) => {
  try {
    const { importPassword, data } = req.body;

    if (!importPassword) {
      return res.status(400).json({ error: 'Import password required' });
    }

    if (!data || !data.salt || !data.accounts) {
      return res.status(400).json({ error: 'Invalid import data format' });
    }

    const appKey = getEncryptionKey();
    if (!appKey) {
      return res.status(400).json({ error: 'Encryption not initialized' });
    }

    // Derive key from import password
    const importKey = await deriveKey(importPassword, data.salt);

    const results = {
      imported: 0,
      skipped: 0,
      errors: []
    };

    for (const account of data.accounts) {
      try {
        // Check if account already exists
        const existing = db.accounts.findByUsername(account.username);
        if (existing) {
          results.skipped++;
          continue;
        }

        // Decrypt with import key
        let password, sharedSecret, identitySecret;
        try {
          password = decrypt(account.password, importKey);
          sharedSecret = account.shared_secret ? decrypt(account.shared_secret, importKey) : null;
          identitySecret = account.identity_secret ? decrypt(account.identity_secret, importKey) : null;
        } catch (decryptErr) {
          results.errors.push(`${account.username}: Invalid password or corrupted data`);
          continue;
        }

        // Create account with app encryption
        accountManager.create({
          username: account.username,
          password,
          shared_secret: sharedSecret,
          identity_secret: identitySecret,
          steam_id: account.steam_id,
          display_name: account.display_name,
          persona_state: account.persona_state || 1,
          games: account.games?.map(g => g.app_id || g) || []
        });

        results.imported++;
      } catch (accErr) {
        results.errors.push(`${account.username}: ${accErr.message}`);
      }
    }

    logger.info(`Imported ${results.imported} accounts, skipped ${results.skipped}`, null, 'SYSTEM');

    res.json({
      success: true,
      ...results
    });
  } catch (err) {
    logger.error(`Import failed: ${err.message}`, null, 'SYSTEM');
    res.status(500).json({ error: err.message });
  }
});

// Refresh account Steam API data
router.post('/api/accounts/:id/refresh', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const account = accountManager.getById(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    if (!account.steam_id) {
      return res.status(400).json({ error: 'Account has no Steam ID. Start idling first to obtain it.' });
    }

    if (!steamApiService.isConfigured()) {
      return res.status(400).json({ error: 'Steam API key not configured' });
    }

    const data = await steamApiService.refreshAccount(id, account.steam_id);

    res.json({
      success: true,
      data: {
        displayName: data.summary?.displayName,
        avatarUrl: data.summary?.avatarUrl,
        gamesCount: data.games?.length || 0,
        bans: data.bans
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get account playtime data
router.get('/api/accounts/:id/playtime', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const account = accountManager.getById(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const playtime = db.playtime.getByAccount(id);

    res.json(playtime);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
