const express = require('express');
const router = express.Router();
const accountManager = require('../services/accountManager');
const logger = require('../services/logger');
const db = require('../models/database');

// Get dashboard data
router.get('/api/dashboard', (req, res) => {
  try {
    const stats = accountManager.getStats();
    const accounts = accountManager.getAll().map(acc => {
      // Fetch active session start time for idling accounts
      let session_started_at = null;
      if (acc.is_idling) {
        const activeSession = db.sessions.getActive(acc.id);
        if (activeSession) {
          session_started_at = activeSession.started_at;
        }
      }
      return {
        id: acc.id,
        username: acc.username,
        display_name: acc.display_name,
        avatar_url: acc.avatar_url,
        steam_id: acc.steam_id,
        status: acc.status,
        is_idling: acc.is_idling,
        total_games: acc.total_games,
        games: acc.games.map(g => g.app_id),
        incomplete: !acc.password || acc.password === '',
        is_private_profile: acc.steam_id && acc.api_last_refresh && (acc.total_games === 0 || acc.total_games === null),
        session_started_at
      };
    });
    const logs = logger.getRecent(20);

    res.json({
      stats,
      accounts,
      logs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
