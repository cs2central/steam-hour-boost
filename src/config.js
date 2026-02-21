const path = require('path');
const os = require('os');

// Detect if running as a packaged binary (pkg)
const isPkg = typeof process.pkg !== 'undefined';

// Get appropriate base directory for data storage
function getBaseDir() {
  // Environment variable takes priority
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }

  // When running as packaged binary, use ~/.steam-hour-boost or current directory
  if (isPkg) {
    // Try home directory first
    const homeDir = os.homedir();
    if (homeDir) {
      return path.join(homeDir, '.steam-hour-boost');
    }
    // Fallback to current working directory
    return path.join(process.cwd(), 'steam-hour-boost-data');
  }

  // Development mode: use project's data directory
  return path.join(__dirname, '..', 'data');
}

const baseDir = getBaseDir();

module.exports = {
  // Server settings
  port: process.env.PORT || 8869,
  host: process.env.HOST || '0.0.0.0',

  // Paths - use external directory when packaged
  dataDir: baseDir,
  mafilesDir: process.env.MAFILES_DIR || path.join(baseDir, 'mafiles'),

  // Database
  dbPath: process.env.DB_PATH || path.join(baseDir, 'hour-boost.db'),

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
  logRetentionDays: 30,

  // Rate limiting
  rateLimit: {
    login: {
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000 // 15 minutes
    },
    setup: {
      maxAttempts: 3,
      windowMs: 60 * 60 * 1000 // 1 hour
    },
    api: {
      maxAttempts: 100,
      windowMs: 60 * 1000 // 1 minute
    }
  },

  // Account lockout (Steam login failures)
  lockout: {
    maxFailedLogins: 3,
    baseDuration: 30 * 60 * 1000, // 30 minutes
    maxDuration: 24 * 60 * 60 * 1000 // 24 hours max
  },

  // Steam Web API
  steamApi: {
    baseUrl: 'https://api.steampowered.com',
    defaultRefreshInterval: 6 * 60 * 60 * 1000 // 6 hours
  }
};
