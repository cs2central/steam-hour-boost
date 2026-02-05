const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Ensure data directory exists
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

let db = null;
let SQL = null;

// Run database migrations for schema changes
function runMigrations() {
  try {
    // Check existing columns in accounts table
    const tableInfo = db.exec("PRAGMA table_info(accounts)");
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map(row => row[1]);

      // Add persona_state column
      if (!columns.includes('persona_state')) {
        // Migration: Running migration: Adding persona_state column');
        db.run('ALTER TABLE accounts ADD COLUMN persona_state INTEGER DEFAULT 1');
      }

      // Add encrypted flag column
      if (!columns.includes('encrypted')) {
        // Migration: Running migration: Adding encrypted column');
        db.run('ALTER TABLE accounts ADD COLUMN encrypted INTEGER DEFAULT 0');
      }

      // Add lockout columns for account protection
      if (!columns.includes('failed_logins')) {
        // Migration: Running migration: Adding lockout columns');
        db.run('ALTER TABLE accounts ADD COLUMN failed_logins INTEGER DEFAULT 0');
        db.run('ALTER TABLE accounts ADD COLUMN last_failed_login DATETIME');
        db.run('ALTER TABLE accounts ADD COLUMN lockout_until DATETIME');
      }

      // Add Steam API data columns
      if (!columns.includes('profile_visibility')) {
        // Migration: Running migration: Adding Steam API columns');
        db.run('ALTER TABLE accounts ADD COLUMN profile_visibility INTEGER');
        db.run('ALTER TABLE accounts ADD COLUMN vac_banned INTEGER DEFAULT 0');
        db.run('ALTER TABLE accounts ADD COLUMN trade_banned INTEGER DEFAULT 0');
        db.run('ALTER TABLE accounts ADD COLUMN game_bans INTEGER DEFAULT 0');
        db.run('ALTER TABLE accounts ADD COLUMN account_created DATETIME');
        db.run('ALTER TABLE accounts ADD COLUMN total_games INTEGER');
        db.run('ALTER TABLE accounts ADD COLUMN api_last_refresh DATETIME');
      }
    }

    // Check existing columns in logs table
    const logsInfo = db.exec("PRAGMA table_info(logs)");
    if (logsInfo.length > 0) {
      const logColumns = logsInfo[0].values.map(row => row[1]);

      // Add category column
      if (!logColumns.includes('category')) {
        // Migration: Running migration: Adding category column to logs');
        db.run("ALTER TABLE logs ADD COLUMN category TEXT DEFAULT 'SYSTEM'");
        db.run('CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category)');
      }
    }
  } catch (err) {
    // Migration error (logged silently to avoid circular dependency with logger)
  }
}

// Initialize sql.js and load/create database
async function initializeDatabase() {
  SQL = await initSqlJs();

  // Try to load existing database
  if (fs.existsSync(config.dbPath)) {
    const fileBuffer = fs.readFileSync(config.dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Create schema
  db.run(`
    -- Web UI users table (for authentication)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    -- Steam accounts table
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      shared_secret TEXT,
      identity_secret TEXT,
      steam_id TEXT,
      display_name TEXT,
      avatar_url TEXT,
      status TEXT DEFAULT 'offline',
      last_error TEXT,
      is_idling INTEGER DEFAULT 0,
      persona_state INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    -- Games to idle per account
    CREATE TABLE IF NOT EXISTS account_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      app_name TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      UNIQUE(account_id, app_id)
    )
  `);

  db.run(`
    -- MAFiles storage metadata
    CREATE TABLE IF NOT EXISTS mafiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name TEXT NOT NULL,
      steam_id TEXT,
      file_path TEXT NOT NULL,
      shared_secret TEXT,
      identity_secret TEXT,
      linked_account_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (linked_account_id) REFERENCES accounts(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    -- Idling sessions for tracking
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      games_played TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    -- Logs table
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      category TEXT DEFAULT 'SYSTEM',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    -- App settings/config
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    -- Account playtime tracking (from Steam API)
    CREATE TABLE IF NOT EXISTS account_playtime (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      playtime_forever INTEGER DEFAULT 0,
      playtime_2weeks INTEGER DEFAULT 0,
      last_played DATETIME,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      UNIQUE(account_id, app_id)
    )
  `);

  // Create indexes (category index created in migration after column exists)
  db.run('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_account_games_account ON account_games(account_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_account_playtime_account ON account_playtime(account_id)');

  // Run migrations for existing databases
  runMigrations();

  // Create category index (safe to run after migrations ensure column exists)
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category)');
  } catch (e) {
    // Ignore if column doesn't exist yet (shouldn't happen after migration)
  }

  // Save database
  saveDatabase();

  // Migration: Database initialized');
}

// Save database to disk
function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
}

// Auto-save every 30 seconds
setInterval(() => {
  if (db) saveDatabase();
}, 30000);

// Helper to get one row
function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

// Helper to get all rows
function all(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper to run a statement
function run(sql, params = []) {
  db.run(sql, params);

  // Get last insert rowid BEFORE any other operations
  let lastInsertRowid = 0;
  try {
    const result = db.exec("SELECT last_insert_rowid() as id");
    if (result && result.length > 0 && result[0].values && result[0].values.length > 0) {
      lastInsertRowid = result[0].values[0][0];
    }
  } catch (e) {
    // Silent fail: lastInsertRowid not available
  }

  const changes = db.getRowsModified();
  saveDatabase();

  return { lastInsertRowid, changes };
}

// User methods
const userMethods = {
  create(username, passwordHash) {
    return run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
  },

  findByUsername(username) {
    return get('SELECT * FROM users WHERE username = ?', [username]);
  },

  findById(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },

  updatePassword(id, passwordHash) {
    return run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  },

  count() {
    const result = get('SELECT COUNT(*) as count FROM users');
    return result ? result.count : 0;
  }
};

// Account methods
const accountMethods = {
  create(data) {
    return run(`
      INSERT INTO accounts (username, password, shared_secret, identity_secret, steam_id, display_name, persona_state)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      data.username,
      data.password || '', // Empty string for incomplete accounts (password required)
      data.shared_secret || null,
      data.identity_secret || null,
      data.steam_id || null,
      data.display_name || null,
      data.persona_state || 1
    ]);
  },

  // Check if account is incomplete (missing password)
  isIncomplete(account) {
    return !account.password || account.password === '';
  },

  findById(id) {
    return get('SELECT * FROM accounts WHERE id = ?', [id]);
  },

  findByUsername(username) {
    return get('SELECT * FROM accounts WHERE username = ?', [username]);
  },

  findAll() {
    return all('SELECT * FROM accounts ORDER BY created_at DESC');
  },

  update(id, data) {
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    return run(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, values);
  },

  updateStatus(id, status, lastError = null) {
    return run('UPDATE accounts SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, lastError, id]);
  },

  setIdling(id, isIdling) {
    return run('UPDATE accounts SET is_idling = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [isIdling ? 1 : 0, id]);
  },

  delete(id) {
    return run('DELETE FROM accounts WHERE id = ?', [id]);
  },

  count() {
    const result = get('SELECT COUNT(*) as count FROM accounts');
    return result ? result.count : 0;
  },

  countByStatus(status) {
    const result = get('SELECT COUNT(*) as count FROM accounts WHERE status = ?', [status]);
    return result ? result.count : 0;
  },

  getIdlingAccounts() {
    return all('SELECT * FROM accounts WHERE is_idling = 1');
  },

  // Lockout methods
  incrementFailedLogins(id) {
    return run(`
      UPDATE accounts
      SET failed_logins = COALESCE(failed_logins, 0) + 1,
          last_failed_login = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);
  },

  resetFailedLogins(id) {
    return run(`
      UPDATE accounts
      SET failed_logins = 0,
          lockout_until = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);
  },

  setLockout(id, until) {
    return run(`
      UPDATE accounts
      SET lockout_until = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [until, id]);
  },

  isLockedOut(id) {
    const account = get('SELECT lockout_until FROM accounts WHERE id = ?', [id]);
    if (!account || !account.lockout_until) return false;
    return new Date(account.lockout_until) > new Date();
  },

  getLockoutInfo(id) {
    return get('SELECT failed_logins, last_failed_login, lockout_until FROM accounts WHERE id = ?', [id]);
  },

  // Search and filter
  search(query = {}) {
    let sql = 'SELECT * FROM accounts WHERE 1=1';
    const params = [];

    if (query.q) {
      sql += ' AND (username LIKE ? OR display_name LIKE ? OR steam_id LIKE ?)';
      const searchTerm = `%${query.q}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (query.status) {
      sql += ' AND status = ?';
      params.push(query.status);
    }

    if (query.hasGuard === 'true') {
      sql += ' AND shared_secret IS NOT NULL';
    } else if (query.hasGuard === 'false') {
      sql += ' AND shared_secret IS NULL';
    }

    if (query.isIdling === 'true') {
      sql += ' AND is_idling = 1';
    } else if (query.isIdling === 'false') {
      sql += ' AND is_idling = 0';
    }

    // Sorting
    const sortBy = query.sortBy || 'created_at';
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const allowedSorts = ['username', 'display_name', 'status', 'created_at', 'updated_at'];
    if (allowedSorts.includes(sortBy)) {
      sql += ` ORDER BY ${sortBy} ${order}`;
    } else {
      sql += ' ORDER BY created_at DESC';
    }

    return all(sql, params);
  }
};

// Account games methods
const gameMethods = {
  addGame(accountId, appId, appName = null) {
    return run('INSERT OR IGNORE INTO account_games (account_id, app_id, app_name) VALUES (?, ?, ?)',
      [accountId, appId, appName]);
  },

  removeGame(accountId, appId) {
    return run('DELETE FROM account_games WHERE account_id = ? AND app_id = ?', [accountId, appId]);
  },

  getGames(accountId) {
    return all('SELECT * FROM account_games WHERE account_id = ?', [accountId]);
  },

  setGames(accountId, games) {
    run('DELETE FROM account_games WHERE account_id = ?', [accountId]);
    for (const game of games) {
      const appId = game.app_id || game;
      const appName = game.app_name || null;
      run('INSERT INTO account_games (account_id, app_id, app_name) VALUES (?, ?, ?)',
        [accountId, appId, appName]);
    }
  }
};

// MAFile methods
const mafileMethods = {
  create(data) {
    return run(`
      INSERT INTO mafiles (account_name, steam_id, file_path, shared_secret, identity_secret, linked_account_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      data.account_name,
      data.steam_id || null,
      data.file_path,
      data.shared_secret || null,
      data.identity_secret || null,
      data.linked_account_id || null
    ]);
  },

  findById(id) {
    return get('SELECT * FROM mafiles WHERE id = ?', [id]);
  },

  findAll() {
    return all(`
      SELECT m.*, a.username as linked_account
      FROM mafiles m
      LEFT JOIN accounts a ON m.linked_account_id = a.id
      ORDER BY m.created_at DESC
    `);
  },

  findByAccountName(accountName) {
    return get('SELECT * FROM mafiles WHERE account_name = ?', [accountName]);
  },

  linkToAccount(mafileId, accountId) {
    return run('UPDATE mafiles SET linked_account_id = ? WHERE id = ?', [accountId, mafileId]);
  },

  delete(id) {
    return run('DELETE FROM mafiles WHERE id = ?', [id]);
  }
};

// Session methods
const sessionMethods = {
  start(accountId, gamesPlayed) {
    return run('INSERT INTO sessions (account_id, games_played) VALUES (?, ?)',
      [accountId, JSON.stringify(gamesPlayed)]);
  },

  end(sessionId) {
    return run('UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);
  },

  getActive(accountId) {
    return get('SELECT * FROM sessions WHERE account_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [accountId]);
  },

  getHistory(accountId, limit = 50) {
    return all('SELECT * FROM sessions WHERE account_id = ? ORDER BY started_at DESC LIMIT ?',
      [accountId, limit]);
  }
};

// Playtime methods (from Steam API)
const playtimeMethods = {
  upsert(accountId, data) {
    return run(`
      INSERT INTO account_playtime (account_id, app_id, playtime_forever, playtime_2weeks, last_played)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, app_id) DO UPDATE SET
        playtime_forever = excluded.playtime_forever,
        playtime_2weeks = excluded.playtime_2weeks,
        last_played = excluded.last_played
    `, [
      accountId,
      data.app_id,
      data.playtime_forever || 0,
      data.playtime_2weeks || 0,
      data.last_played || null
    ]);
  },

  getByAccount(accountId) {
    return all('SELECT * FROM account_playtime WHERE account_id = ? ORDER BY playtime_forever DESC', [accountId]);
  },

  getByGame(accountId, appId) {
    return get('SELECT * FROM account_playtime WHERE account_id = ? AND app_id = ?', [accountId, appId]);
  },

  deleteByAccount(accountId) {
    return run('DELETE FROM account_playtime WHERE account_id = ?', [accountId]);
  }
};

// Log methods
const logMethods = {
  add(level, message, accountId = null, category = 'SYSTEM') {
    return run('INSERT INTO logs (level, message, account_id, category) VALUES (?, ?, ?, ?)',
      [level, message, accountId, category]);
  },

  getRecent(limit = 50, category = null) {
    if (category) {
      return all(`
        SELECT l.*, a.username as account_name
        FROM logs l
        LEFT JOIN accounts a ON l.account_id = a.id
        WHERE l.category = ?
        ORDER BY l.timestamp DESC
        LIMIT ?
      `, [category, limit]);
    }
    return all(`
      SELECT l.*, a.username as account_name
      FROM logs l
      LEFT JOIN accounts a ON l.account_id = a.id
      ORDER BY l.timestamp DESC
      LIMIT ?
    `, [limit]);
  },

  getByAccount(accountId, limit = 100) {
    return all('SELECT * FROM logs WHERE account_id = ? ORDER BY timestamp DESC LIMIT ?',
      [accountId, limit]);
  },

  getByCategory(category, limit = 100) {
    return all('SELECT * FROM logs WHERE category = ? ORDER BY timestamp DESC LIMIT ?',
      [category, limit]);
  },

  cleanup(daysToKeep) {
    return run("DELETE FROM logs WHERE timestamp < datetime('now', ? || ' days')", [-daysToKeep]);
  }
};

// Settings methods
const settingsMethods = {
  get(key, defaultValue = null) {
    const row = get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? JSON.parse(row.value) : defaultValue;
  },

  set(key, value) {
    return run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      [key, JSON.stringify(value)]);
  },

  getAll() {
    const rows = all('SELECT * FROM settings');
    const settings = {};
    for (const row of rows) {
      settings[row.key] = JSON.parse(row.value);
    }
    return settings;
  }
};

module.exports = {
  initializeDatabase,
  saveDatabase,
  users: userMethods,
  accounts: accountMethods,
  games: gameMethods,
  mafiles: mafileMethods,
  sessions: sessionMethods,
  logs: logMethods,
  playtime: playtimeMethods,
  settings: settingsMethods
};
