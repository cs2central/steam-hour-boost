const express = require('express');
const router = express.Router();
const accountManager = require('../services/accountManager');

// Get games for an account
router.get('/api/accounts/:id/games', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const account = accountManager.getById(id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json(account.games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add game to account
router.post('/api/accounts/:id/games', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { app_id, app_name } = req.body;

    if (!app_id) {
      return res.status(400).json({ error: 'app_id is required' });
    }

    accountManager.addGame(id, parseInt(app_id), app_name);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove game from account
router.delete('/api/accounts/:id/games/:appId', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const appId = parseInt(req.params.appId);

    accountManager.removeGame(id, appId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update all games for an account
router.put('/api/accounts/:id/games', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { games } = req.body;

    if (!Array.isArray(games)) {
      return res.status(400).json({ error: 'games must be an array' });
    }

    accountManager.setGames(id, games);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Common Steam games reference (for UI dropdown)
router.get('/api/games/common', (req, res) => {
  res.json([
    { app_id: 730, name: 'Counter-Strike 2' },
    { app_id: 570, name: 'Dota 2' },
    { app_id: 440, name: 'Team Fortress 2' },
    { app_id: 252490, name: 'Rust' },
    { app_id: 578080, name: 'PUBG: BATTLEGROUNDS' },
    { app_id: 271590, name: 'Grand Theft Auto V' },
    { app_id: 1172470, name: 'Apex Legends' },
    { app_id: 1599340, name: 'Lost Ark' },
    { app_id: 1245620, name: 'ELDEN RING' },
    { app_id: 413150, name: 'Stardew Valley' },
    { app_id: 892970, name: 'Valheim' },
    { app_id: 1091500, name: 'Cyberpunk 2077' },
    { app_id: 230410, name: 'Warframe' },
    { app_id: 359550, name: 'Rainbow Six Siege' },
    { app_id: 1063730, name: 'New World' },
    { app_id: 1085660, name: 'Destiny 2' },
    { app_id: 236390, name: 'War Thunder' },
    { app_id: 304930, name: 'Unturned' },
    { app_id: 252950, name: 'Rocket League' },
    { app_id: 105600, name: 'Terraria' }
  ]);
});

module.exports = router;
