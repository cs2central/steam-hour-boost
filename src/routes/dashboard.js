const express = require('express');
const router = express.Router();
const accountManager = require('../services/accountManager');
const logger = require('../services/logger');
const db = require('../models/database');

// Get dashboard data
router.get('/api/dashboard', (req, res) => {
  try {
    const stats = accountManager.getStats();

    // Fetch all active sessions in one query instead of per-account (N+1 fix)
    const activeSessions = db.sessions.getAllActive();
    const sessionByAccount = {};
    for (const s of activeSessions) {
      sessionByAccount[s.account_id] = s;
    }

    const accounts = accountManager.getAll().map(acc => {
      const activeSession = acc.is_idling ? sessionByAccount[acc.id] : null;
      const session_started_at = activeSession ? activeSession.started_at : null;
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
