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
    // Check if persona_state column exists in accounts table
    const tableInfo = db.exec("PRAGMA table_info(accounts)");
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map(row => row[1]);
      if (!columns.includes('persona_state')) {
        console.log('[DB] Running migration: Adding persona_state column');
        db.run('ALTER TABLE accounts ADD COLUMN persona_state INTEGER DEFAULT 1');
      }
    }
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
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

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_account_games_account ON account_games(account_id)');

  // Run migrations for existing databases
  runMigrations();

  // Save database
  saveDatabase();

  console.log('[DB] Database initialized');
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
    console.error('Failed to get lastInsertRowid:', e);
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
      data.password,
      data.shared_secret || null,
      data.identity_secret || null,
      data.steam_id || null,
      data.display_name || null,
      data.persona_state || 1
    ]);
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

// Log methods
const logMethods = {
  add(level, message, accountId = null) {
    return run('INSERT INTO logs (level, message, account_id) VALUES (?, ?, ?)',
      [level, message, accountId]);
  },

  getRecent(limit = 50) {
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
  settings: settingsMethods
};
