const path = require('path');

module.exports = {
  // Server settings
  port: process.env.PORT || 8869,
  host: process.env.HOST || '0.0.0.0',

  // Paths
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  mafilesDir: process.env.MAFILES_DIR || path.join(__dirname, '..', 'mafiles'),

  // Database
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hour-boost.db'),

  // Session
  sessionSecret: process.env.SESSION_SECRET || 'hour-boost-secret-change-me',
  sessionMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Steam defaults
  defaultGames: [730], // CS2
  maxGamesPerAccount: 32,

  // Reconnection settings
  reconnectDelay: 30000, // 30 seconds
  maxReconnectAttempts: 10,

  // Logging
  logRetentionDays: 30
};
