const fs = require('fs');
const path = require('path');
const db = require('../models/database');
const config = require('../config');

const LOG_LEVELS = {
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug'
};

// Log categories for structured logging
const LOG_CATEGORIES = {
  SYSTEM: 'SYSTEM',
  AUTH: 'AUTH',
  STEAM: 'STEAM',
  ENCRYPTION: 'ENCRYPTION',
  API: 'API',
  DATABASE: 'DATABASE',
  RATE_LIMIT: 'RATE_LIMIT'
};

// Log file path
const LOG_FILE = path.join(config.dataDir, 'hour-boost.log');

class Logger {
  constructor() {
    this.cleanupInterval = null;
    this.ensureLogFile();
  }

  ensureLogFile() {
    // Ensure data directory exists
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
  }

  writeToFile(level, message, accountId = null, category = 'SYSTEM') {
    const timestamp = new Date().toISOString();
    const prefix = accountId ? `[Account:${accountId}]` : '[System]';
    const categoryTag = category !== 'SYSTEM' ? `[${category}] ` : '';
    const logLine = `${timestamp} [${level.toUpperCase()}] ${categoryTag}${prefix} ${message}\n`;

    try {
      fs.appendFileSync(LOG_FILE, logLine);
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  log(level, message, accountId = null, category = 'SYSTEM') {
    // Console output for Docker logs
    const timestamp = new Date().toISOString();
    const prefix = accountId ? `[Account:${accountId}]` : '[System]';
    const categoryTag = category !== 'SYSTEM' ? `[${category}] ` : '';
    console.log(`${timestamp} [${level.toUpperCase()}] ${categoryTag}${prefix} ${message}`);

    // Write to log file
    this.writeToFile(level, message, accountId, category);

    // Database storage (skip for debug level to reduce noise)
    if (level !== 'debug') {
      try {
        db.logs.add(level, message, accountId, category);
      } catch (err) {
        console.error('Failed to write log to database:', err);
      }
    }
  }

  debug(message, accountId = null, category = 'SYSTEM') {
    this.log(LOG_LEVELS.debug, message, accountId, category);
  }

  info(message, accountId = null, category = 'SYSTEM') {
    this.log(LOG_LEVELS.info, message, accountId, category);
  }

  warn(message, accountId = null, category = 'SYSTEM') {
    this.log(LOG_LEVELS.warn, message, accountId, category);
  }

  error(message, accountId = null, category = 'SYSTEM') {
    this.log(LOG_LEVELS.error, message, accountId, category);
  }

  getRecent(limit = 50, category = null) {
    return db.logs.getRecent(limit, category);
  }

  getByAccount(accountId, limit = 100) {
    return db.logs.getByAccount(accountId, limit);
  }

  getByCategory(category, limit = 100) {
    return db.logs.getByCategory(category, limit);
  }

  startCleanupJob() {
    // Run cleanup daily
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 24 * 60 * 60 * 1000);

    // Initial cleanup on start
    this.cleanup();
  }

  stopCleanupJob() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  cleanup() {
    try {
      const result = db.logs.cleanup(config.logRetentionDays);
      if (result.changes > 0) {
        this.info(`Cleaned up ${result.changes} old log entries`);
      }

      // Also rotate log file if it gets too big (> 10MB)
      if (fs.existsSync(LOG_FILE)) {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size > 10 * 1024 * 1024) {
          const backupFile = LOG_FILE + '.old';
          if (fs.existsSync(backupFile)) {
            fs.unlinkSync(backupFile);
          }
          fs.renameSync(LOG_FILE, backupFile);
          this.info('Rotated log file');
        }
      }
    } catch (err) {
      console.error('Failed to cleanup logs:', err);
    }
  }
}

// Singleton instance
const logger = new Logger();

// Export logger and categories
module.exports = logger;
module.exports.LOG_CATEGORIES = LOG_CATEGORIES;
