const express = require('express');
const router = express.Router();

// Get stats page
router.get('/stats', (req, res) => {
  const viewPath = require('path').join(__dirname, '..', '..', 'views', 'stats.html');
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.sendFile(viewPath);
});

// Get comprehensive stats
router.get('/api/stats', async (req, res) => {
  try {
    const db = require('../models/database');

    // Get all accounts with their playtime data
    const accounts = db.accounts.findAll();

    const accountStats = await Promise.all(accounts.map(async (acc) => {
      // Get playtime data for this account
      const playtimeData = db.playtime.getByAccount(acc.id);

      // Get session history
      const sessions = db.sessions.getHistory(acc.id, 100);

      // Calculate total boost time from sessions (in minutes)
      let totalBoostMinutes = 0;
      for (const session of sessions) {
        if (session.ended_at) {
          const start = new Date(session.started_at);
          const end = new Date(session.ended_at);
          totalBoostMinutes += Math.floor((end - start) / 60000);
        } else if (session.started_at) {
          // Active session
          const start = new Date(session.started_at);
          totalBoostMinutes += Math.floor((Date.now() - start) / 60000);
        }
      }

      // Get active session if any
      const activeSession = db.sessions.getActive(acc.id);
      let currentSessionMinutes = 0;
      if (activeSession) {
        const start = new Date(activeSession.started_at);
        currentSessionMinutes = Math.floor((Date.now() - start) / 60000);
      }

      // Get games being idled
      const idledGames = db.games.getGames(acc.id);

      // Map playtime to idled games
      const gamesWithPlaytime = idledGames.map(game => {
        const pt = playtimeData.find(p => p.app_id === game.app_id);
        return {
          app_id: game.app_id,
          app_name: game.app_name,
          playtime_forever: pt ? pt.playtime_forever : 0,
          playtime_2weeks: pt ? pt.playtime_2weeks : 0
        };
      });

      // Total playtime across all games in library
      const totalLibraryPlaytime = playtimeData.reduce((sum, p) => sum + (p.playtime_forever || 0), 0);

      // Detect if profile is private (has steam_id and was refreshed, but no game data)
      const isPrivateProfile = acc.steam_id && acc.api_last_refresh &&
        (acc.total_games === 0 || acc.total_games === null) && playtimeData.length === 0;

      return {
        id: acc.id,
        username: acc.username,
        display_name: acc.display_name,
        avatar_url: acc.avatar_url,
        steam_id: acc.steam_id,
        status: acc.status,
        is_idling: acc.is_idling,
        total_games_in_library: acc.total_games || 0,
        total_library_playtime: totalLibraryPlaytime,
        total_boost_time: totalBoostMinutes,
        current_session_time: currentSessionMinutes,
        games_idling: gamesWithPlaytime,
        top_games: playtimeData.slice(0, 10).map(p => ({
          app_id: p.app_id,
          playtime_forever: p.playtime_forever,
          playtime_2weeks: p.playtime_2weeks
        })),
        api_last_refresh: acc.api_last_refresh,
        is_private_profile: isPrivateProfile
      };
    }));

    // Aggregate stats
    const totalAccounts = accounts.length;
    const activeIdling = accounts.filter(a => a.is_idling).length;
    const totalBoostTime = accountStats.reduce((sum, a) => sum + a.total_boost_time, 0);
    const totalLibraryHours = accountStats.reduce((sum, a) => sum + a.total_library_playtime, 0);

    res.json({
      summary: {
        total_accounts: totalAccounts,
        active_idling: activeIdling,
        total_boost_minutes: totalBoostTime,
        total_library_minutes: totalLibraryHours
      },
      accounts: accountStats
    });
  } catch (err) {
    const logger = require('../services/logger');
    logger.error(`Stats error: ${err.message}`, null, 'API');
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get stats for a specific account
router.get('/api/stats/:id', async (req, res) => {
  try {
    const db = require('../models/database');
    const accountId = parseInt(req.params.id);

    const account = db.accounts.findById(accountId);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Get all playtime data
    const playtimeData = db.playtime.getByAccount(accountId);

    // Get all sessions
    const sessions = db.sessions.getHistory(accountId, 500);

    // Calculate session stats
    let totalBoostMinutes = 0;
    const sessionHistory = sessions.map(session => {
      let duration = 0;
      if (session.ended_at) {
        const start = new Date(session.started_at);
        const end = new Date(session.ended_at);
        duration = Math.floor((end - start) / 60000);
      } else if (session.started_at) {
        const start = new Date(session.started_at);
        duration = Math.floor((Date.now() - start) / 60000);
      }
      totalBoostMinutes += duration;

      return {
        id: session.id,
        started_at: session.started_at,
        ended_at: session.ended_at,
        duration_minutes: duration,
        games_played: JSON.parse(session.games_played || '[]')
      };
    });

    res.json({
      account: {
        id: account.id,
        username: account.username,
        display_name: account.display_name,
        avatar_url: account.avatar_url,
        steam_id: account.steam_id
      },
      playtime: playtimeData.map(p => ({
        app_id: p.app_id,
        playtime_forever: p.playtime_forever,
        playtime_2weeks: p.playtime_2weeks,
        last_played: p.last_played
      })),
      boost_stats: {
        total_boost_minutes: totalBoostMinutes,
        total_sessions: sessions.length
      },
      recent_sessions: sessionHistory.slice(0, 20)
    });
  } catch (err) {
    const logger = require('../services/logger');
    logger.error(`Account stats error: ${err.message}`, null, 'API');
    res.status(500).json({ error: 'Failed to fetch account stats' });
  }
});

module.exports = router;
