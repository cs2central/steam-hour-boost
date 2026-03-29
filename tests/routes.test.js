// ---------------------------------------------------------------------------
// Mock: database
// ---------------------------------------------------------------------------
jest.mock('../src/models/database', () => ({
  accounts: {
    findAll: jest.fn(() => []),
    findById: jest.fn(),
    findByUsername: jest.fn(),
    count: jest.fn(() => 2),
    countByStatus: jest.fn(() => 0),
    delete: jest.fn(),
  },
  games: {
    getGames: jest.fn(() => []),
    getAllGrouped: jest.fn(() => ({})),
    setGames: jest.fn(),
    addGame: jest.fn(),
    removeGame: jest.fn(),
  },
  sessions: {
    getActive: jest.fn(() => null),
    getAllActive: jest.fn(() => []),
  },
  logs: {
    getRecent: jest.fn(() => []),
    getByAccount: jest.fn(() => []),
    cleanup: jest.fn(() => ({ changes: 0 })),
    add: jest.fn(),
  },
  playtime: {
    getByAccount: jest.fn(() => []),
  },
  settings: {
    get: jest.fn(() => null),
    set: jest.fn(),
    getAll: jest.fn(() => ({})),
  },
  mafiles: {
    findAll: jest.fn(() => []),
    delete: jest.fn(),
  },
  webSessions: {
    get: jest.fn(() => null),
    set: jest.fn(),
    destroy: jest.fn(),
    touch: jest.fn(),
    cleanup: jest.fn(),
  },
  initializeDatabase: jest.fn(),
  saveDatabase: jest.fn(),
  batch: jest.fn(fn => fn()),
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------
jest.mock('../src/services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getRecent: jest.fn(() => []),
  getByAccount: jest.fn(() => []),
  startCleanupJob: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: steamService
// ---------------------------------------------------------------------------
jest.mock('../src/services/steamService', () => ({
  startIdling: jest.fn(),
  stopIdling: jest.fn(),
  getSession: jest.fn(),
  getStatus: jest.fn(() => ({ isLoggedIn: false, isIdling: false, currentGames: [] })),
  startAll: jest.fn(async () => []),
  stopAll: jest.fn(),
  logoutAll: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: steamApiService
// ---------------------------------------------------------------------------
jest.mock('../src/services/steamApiService', () => ({
  isConfigured: jest.fn(() => false),
  refreshAccount: jest.fn(),
  initialize: jest.fn(),
  setApiKey: jest.fn(),
  setRefreshInterval: jest.fn(),
  refreshAllAccounts: jest.fn(async () => ({ refreshed: 0, errors: 0 })),
  getRefreshInterval: jest.fn(() => null),
  startPeriodicRefresh: jest.fn(),
  stopPeriodicRefresh: jest.fn(),
  shutdown: jest.fn(),
  updateEncryptionKey: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: accountManager
// ---------------------------------------------------------------------------
jest.mock('../src/services/accountManager', () => ({
  getAll: jest.fn(() => []),
  getById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  search: jest.fn(() => []),
  getStats: jest.fn(() => ({ totalAccounts: 0, activeIdling: 0, online: 0, errors: 0 })),
  getDecryptedAccount: jest.fn(),
  getGames: jest.fn(() => []),
  addGame: jest.fn(),
  removeGame: jest.fn(),
  setGames: jest.fn(),
  setSteamService: jest.fn(),
  getIdlingAccounts: jest.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Mock: auth middleware
// ---------------------------------------------------------------------------
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.session = { userId: 1, username: 'test' };
    next();
  },
  checkSetup: (req, res, next) => next(),
  getEncryptionKey: jest.fn(() => Buffer.alloc(32)),
  encryptAccountCredentials: jest.fn(d => d),
  decryptAccountCredentials: jest.fn(d => d),
  isEncryptionInitialized: jest.fn(() => true),
  setEncryptionKey: jest.fn(),
  initializeEncryption: jest.fn(),
  clearEncryptionKey: jest.fn(),
  createUser: jest.fn(),
  authenticateUser: jest.fn(),
  changePassword: jest.fn(),
  reEncryptAllData: jest.fn(),
  ENCRYPTED_FIELDS: ['password', 'shared_secret', 'identity_secret', 'revocation_code'],
}));

// ---------------------------------------------------------------------------
// Mock: encryption
// ---------------------------------------------------------------------------
jest.mock('../src/utils/encryption', () => ({
  encrypt: jest.fn(v => v),
  decrypt: jest.fn(v => v),
  isEncrypted: jest.fn(() => false),
  generateSalt: jest.fn(() => 'test-salt'),
  deriveKey: jest.fn(async () => Buffer.alloc(32)),
  reEncrypt: jest.fn(v => v),
}));

// ---------------------------------------------------------------------------
// Requires
// ---------------------------------------------------------------------------
const http = require('http');
const express = require('express');
const accountManager = require('../src/services/accountManager');
const steamService = require('../src/services/steamService');
const steamApiService = require('../src/services/steamApiService');
const logger = require('../src/services/logger');
const db = require('../src/models/database');

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Inject a session stub on every request
  app.use((req, res, next) => {
    req.session = { userId: 1, username: 'test' };
    next();
  });

  const dashboardRoutes = require('../src/routes/dashboard');
  const accountRoutes = require('../src/routes/accounts');
  const gameRoutes = require('../src/routes/games');
  const settingsRoutes = require('../src/routes/settings');

  app.use(dashboardRoutes);
  app.use(accountRoutes);
  app.use(gameRoutes);
  app.use(settingsRoutes);

  return app;
}

// ---------------------------------------------------------------------------
// Lightweight HTTP helper (no supertest dependency)
// ---------------------------------------------------------------------------
function request(app, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let app;

beforeAll(() => {
  app = createTestApp();
});

beforeEach(() => {
  jest.clearAllMocks();

  // Restore sensible defaults that individual tests can override
  accountManager.getAll.mockReturnValue([]);
  accountManager.getStats.mockReturnValue({
    totalAccounts: 0,
    activeIdling: 0,
    online: 0,
    errors: 0,
  });
  accountManager.getById.mockReturnValue(undefined);
  accountManager.search.mockReturnValue([]);
  db.sessions.getAllActive.mockReturnValue([]);
  db.settings.getAll.mockReturnValue({});
  logger.getRecent.mockReturnValue([]);
  steamService.getStatus.mockReturnValue({
    isLoggedIn: false,
    isIdling: false,
    currentGames: [],
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/dashboard', () => {
  test('returns stats, accounts, and logs', async () => {
    accountManager.getStats.mockReturnValue({
      totalAccounts: 2,
      activeIdling: 1,
      online: 1,
      errors: 0,
    });
    accountManager.getAll.mockReturnValue([
      {
        id: 1,
        username: 'acc1',
        display_name: 'Acc One',
        avatar_url: null,
        steam_id: '123',
        status: 'online',
        is_idling: true,
        total_games: 5,
        games: [{ app_id: 730 }],
        password: 'secret',
        api_last_refresh: null,
      },
    ]);
    db.sessions.getAllActive.mockReturnValue([
      { account_id: 1, started_at: '2025-01-01T00:00:00Z' },
    ]);
    logger.getRecent.mockReturnValue([{ id: 1, message: 'log entry' }]);

    const res = await request(app, 'GET', '/api/dashboard');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stats');
    expect(res.body).toHaveProperty('accounts');
    expect(res.body).toHaveProperty('logs');
    expect(res.body.stats.totalAccounts).toBe(2);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.logs).toHaveLength(1);
  });

  test('returns correct structure with summary fields', async () => {
    accountManager.getAll.mockReturnValue([
      {
        id: 2,
        username: 'user2',
        display_name: null,
        avatar_url: null,
        steam_id: null,
        status: 'offline',
        is_idling: false,
        total_games: 0,
        games: [],
        password: 'pw',
        api_last_refresh: null,
      },
    ]);

    const res = await request(app, 'GET', '/api/dashboard');

    expect(res.status).toBe(200);

    const acc = res.body.accounts[0];
    expect(acc).toHaveProperty('id');
    expect(acc).toHaveProperty('username');
    expect(acc).toHaveProperty('status');
    expect(acc).toHaveProperty('is_idling');
    expect(acc).toHaveProperty('session_started_at');
    expect(acc).toHaveProperty('incomplete');
    // Password must never leak
    expect(acc).not.toHaveProperty('password');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Accounts - list
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/accounts', () => {
  test('returns array of safe accounts (no password exposed)', async () => {
    accountManager.getAll.mockReturnValue([
      {
        id: 1,
        username: 'user1',
        steam_id: '123',
        display_name: 'User One',
        avatar_url: null,
        status: 'online',
        last_error: null,
        is_idling: false,
        persona_state: 1,
        games: [],
        created_at: '2025-01-01',
        shared_secret: 'REAL_SECRET_VALUE',
        identity_secret: 'REAL_ID_SECRET',
        password: 'supersecretpassword',
        vac_banned: false,
        trade_banned: false,
        game_bans: 0,
        total_games: 10,
        lockout_until: null,
        api_last_refresh: null,
      },
    ]);

    const res = await request(app, 'GET', '/api/accounts');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);

    const acc = res.body[0];
    // Password must never appear
    expect(acc).not.toHaveProperty('password');
    expect(JSON.stringify(acc)).not.toContain('supersecretpassword');
  });

  test('includes shared_secret as boolean, not the actual secret', async () => {
    accountManager.getAll.mockReturnValue([
      {
        id: 1,
        username: 'user1',
        steam_id: null,
        display_name: null,
        avatar_url: null,
        status: 'offline',
        last_error: null,
        is_idling: false,
        persona_state: 1,
        games: [],
        created_at: '2025-01-01',
        shared_secret: 'MY_ACTUAL_SECRET',
        password: 'pw',
        vac_banned: false,
        trade_banned: false,
        game_bans: 0,
        total_games: 0,
        lockout_until: null,
        api_last_refresh: null,
      },
    ]);

    const res = await request(app, 'GET', '/api/accounts');
    const acc = res.body[0];

    expect(acc.shared_secret).toBe(true);
    expect(typeof acc.shared_secret).toBe('boolean');
    expect(JSON.stringify(acc)).not.toContain('MY_ACTUAL_SECRET');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Accounts - create
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/accounts', () => {
  test('creates account with valid data', async () => {
    accountManager.create.mockReturnValue({
      id: 10,
      username: 'newuser',
      password: 'pw',
      status: 'offline',
      persona_state: 1,
    });

    const res = await request(app, 'POST', '/api/accounts', {
      username: 'newuser',
      password: 'pw',
    });

    expect(res.status).toBe(201);
    expect(accountManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'newuser', password: 'pw' }),
    );
    // Password stripped from response
    expect(res.body).not.toHaveProperty('password');
  });

  test('returns 400 when username is missing', async () => {
    const res = await request(app, 'POST', '/api/accounts', {
      password: 'pw',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  test('returns 400 when password is missing', async () => {
    const res = await request(app, 'POST', '/api/accounts', {
      username: 'user',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Accounts - get by ID
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/accounts/:id', () => {
  test('returns account by ID', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'found',
      password: 'secret',
      shared_secret: 'sec',
      identity_secret: 'idsec',
      status: 'online',
      persona_state: 1,
    });

    const res = await request(app, 'GET', '/api/accounts/1');

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('found');
    expect(res.body.shared_secret).toBe(true);
    expect(res.body.identity_secret).toBe(true);
    expect(res.body).not.toHaveProperty('password');
  });

  test('returns 404 for non-existent account', async () => {
    accountManager.getById.mockReturnValue(undefined);

    const res = await request(app, 'GET', '/api/accounts/999');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Accounts - update
// ═══════════════════════════════════════════════════════════════════════════

describe('PUT /api/accounts/:id', () => {
  test('updates account', async () => {
    steamService.getSession.mockReturnValue(null);
    accountManager.update.mockReturnValue({
      id: 1,
      username: 'updated',
      password: 'newpw',
      status: 'offline',
    });

    const res = await request(app, 'PUT', '/api/accounts/1', {
      username: 'updated',
    });

    expect(res.status).toBe(200);
    expect(accountManager.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ username: 'updated' }),
    );
    expect(res.body).not.toHaveProperty('password');
  });

  test('returns 400 for invalid data (update throws)', async () => {
    accountManager.update.mockImplementation(() => {
      throw new Error('Invalid data');
    });

    const res = await request(app, 'PUT', '/api/accounts/1', {
      username: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid data');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Accounts - delete
// ═══════════════════════════════════════════════════════════════════════════

describe('DELETE /api/accounts/:id', () => {
  test('deletes account', async () => {
    accountManager.delete.mockReturnValue(undefined);

    const res = await request(app, 'DELETE', '/api/accounts/1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(accountManager.delete).toHaveBeenCalledWith(1);
  });

  test('returns 400 when account does not exist (delete throws)', async () => {
    accountManager.delete.mockImplementation(() => {
      throw new Error('Account not found');
    });

    const res = await request(app, 'DELETE', '/api/accounts/5');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Account actions - start / stop / status
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/accounts/:id/start', () => {
  test('starts idling for a valid account', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'acc',
      password: 'pw',
    });
    steamService.startIdling.mockResolvedValue({ isLoggedIn: true });

    const res = await request(app, 'POST', '/api/accounts/1/start');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(steamService.startIdling).toHaveBeenCalledWith(1);
  });

  test('returns 404 for non-existent account', async () => {
    accountManager.getById.mockReturnValue(undefined);

    const res = await request(app, 'POST', '/api/accounts/999/start');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 400 for incomplete account (no password)', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'acc',
      password: '',
    });

    const res = await request(app, 'POST', '/api/accounts/1/start');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/incomplete|password/i);
  });
});

describe('POST /api/accounts/:id/stop', () => {
  test('stops idling', async () => {
    const res = await request(app, 'POST', '/api/accounts/1/stop');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(steamService.stopIdling).toHaveBeenCalledWith(1);
  });
});

describe('GET /api/accounts/:id/status', () => {
  test('returns status for an existing account', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'acc',
      status: 'online',
      last_error: null,
    });
    steamService.getStatus.mockReturnValue({
      isLoggedIn: true,
      isIdling: true,
      currentGames: [730],
    });

    const res = await request(app, 'GET', '/api/accounts/1/status');

    expect(res.status).toBe(200);
    expect(res.body.isLoggedIn).toBe(true);
    expect(res.body.isIdling).toBe(true);
    expect(res.body.status).toBe('online');
  });

  test('returns 404 for non-existent account', async () => {
    accountManager.getById.mockReturnValue(undefined);

    const res = await request(app, 'GET', '/api/accounts/999/status');

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Account parameter validation
// ═══════════════════════════════════════════════════════════════════════════

describe('Account ID parameter validation', () => {
  test('returns 400 for non-numeric account ID', async () => {
    const res = await request(app, 'GET', '/api/accounts/abc');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('returns 400 for negative account ID', async () => {
    const res = await request(app, 'GET', '/api/accounts/-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('returns 400 for zero account ID', async () => {
    const res = await request(app, 'GET', '/api/accounts/0');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Games
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/accounts/:id/games', () => {
  test('returns games for an existing account', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'user1',
      games: [
        { app_id: 730, app_name: 'Counter-Strike 2' },
        { app_id: 570, app_name: 'Dota 2' },
      ],
    });

    const res = await request(app, 'GET', '/api/accounts/1/games');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].app_id).toBe(730);
  });

  test('returns 404 for non-existent account', async () => {
    accountManager.getById.mockReturnValue(undefined);

    const res = await request(app, 'GET', '/api/accounts/999/games');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('POST /api/accounts/:id/games', () => {
  test('adds a game with valid data', async () => {
    const res = await request(app, 'POST', '/api/accounts/1/games', {
      app_id: 730,
      app_name: 'Counter-Strike 2',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(accountManager.addGame).toHaveBeenCalledWith(1, 730, 'Counter-Strike 2');
  });

  test('returns 400 when app_id is missing', async () => {
    const res = await request(app, 'POST', '/api/accounts/1/games', {
      app_name: 'Some Game',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/app_id/i);
  });

  test('returns 400 for invalid app_id (non-numeric)', async () => {
    const res = await request(app, 'POST', '/api/accounts/1/games', {
      app_id: 'notanumber',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid app_id/i);
  });

  test('returns 400 for invalid app_id (negative)', async () => {
    const res = await request(app, 'POST', '/api/accounts/1/games', {
      app_id: -5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid app_id/i);
  });

  test('returns 400 for invalid app_id (zero)', async () => {
    const res = await request(app, 'POST', '/api/accounts/1/games', {
      app_id: 0,
    });

    expect(res.status).toBe(400);
    // 0 is falsy so the route catches it as "app_id is required"
    expect(res.body.error).toMatch(/app_id/i);
  });
});

describe('DELETE /api/accounts/:id/games/:appId', () => {
  test('removes a game', async () => {
    const res = await request(app, 'DELETE', '/api/accounts/1/games/730');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(accountManager.removeGame).toHaveBeenCalledWith(1, 730);
  });

  test('returns 400 for invalid appId parameter', async () => {
    const res = await request(app, 'DELETE', '/api/accounts/1/games/abc');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

describe('PUT /api/accounts/:id/games', () => {
  test('updates all games for an account', async () => {
    const games = [
      { app_id: 730, app_name: 'CS2' },
      { app_id: 570, app_name: 'Dota 2' },
    ];

    const res = await request(app, 'PUT', '/api/accounts/1/games', { games });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(accountManager.setGames).toHaveBeenCalledWith(1, games);
  });

  test('returns 400 when games is not an array', async () => {
    const res = await request(app, 'PUT', '/api/accounts/1/games', {
      games: 'not-an-array',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Common games
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/games/common', () => {
  test('returns a non-empty list of common games', async () => {
    const res = await request(app, 'GET', '/api/games/common');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // Each entry must have app_id and name
    for (const game of res.body) {
      expect(game).toHaveProperty('app_id');
      expect(game).toHaveProperty('name');
      expect(typeof game.app_id).toBe('number');
      expect(typeof game.name).toBe('string');
    }
  });

  test('includes well-known titles', async () => {
    const res = await request(app, 'GET', '/api/games/common');
    const ids = res.body.map(g => g.app_id);

    expect(ids).toContain(730);  // Counter-Strike 2
    expect(ids).toContain(570);  // Dota 2
    expect(ids).toContain(440);  // Team Fortress 2
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/settings', () => {
  test('returns settings with masked API key', async () => {
    db.settings.getAll.mockReturnValue({
      steam_api_key: 'ABCDEF1234567890ABCDEF1234567890',
      auto_start: 'true',
      encryption_salt: 'supersalt',
    });

    const res = await request(app, 'GET', '/api/settings');

    expect(res.status).toBe(200);
    // API key must be masked
    expect(res.body.steam_api_key).toBe('********');
    expect(res.body.steam_api_configured).toBe(true);
    // Encryption salt must never be exposed
    expect(res.body).not.toHaveProperty('encryption_salt');
  });

  test('returns null API key when not configured', async () => {
    db.settings.getAll.mockReturnValue({});

    const res = await request(app, 'GET', '/api/settings');

    expect(res.status).toBe(200);
    expect(res.body.steam_api_key).toBeNull();
    expect(res.body.steam_api_configured).toBe(false);
  });
});

describe('PUT /api/settings', () => {
  test('updates settings', async () => {
    const res = await request(app, 'PUT', '/api/settings', {
      default_persona_state: 3,
      auto_start: 'false',
      log_retention_days: 14,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.settings.set).toHaveBeenCalledWith('default_persona_state', 3);
    expect(db.settings.set).toHaveBeenCalledWith('auto_start', 'false');
    expect(db.settings.set).toHaveBeenCalledWith('log_retention_days', 14);
  });

  test('only updates provided fields', async () => {
    const res = await request(app, 'PUT', '/api/settings', {
      auto_start: 'true',
    });

    expect(res.status).toBe(200);
    expect(db.settings.set).toHaveBeenCalledWith('auto_start', 'true');
    // Other settings should not have been touched
    expect(db.settings.set).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Logs
// ═══════════════════════════════════════════════════════════════════════════

describe('DELETE /api/logs', () => {
  test('clears all logs', async () => {
    const res = await request(app, 'DELETE', '/api/logs');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.logs.cleanup).toHaveBeenCalledWith(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bulk actions
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/accounts/start-all', () => {
  test('starts all accounts', async () => {
    steamService.startAll.mockResolvedValue([
      { id: 1, success: true },
      { id: 2, success: true },
    ]);

    const res = await request(app, 'POST', '/api/accounts/start-all');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.results).toHaveLength(2);
    expect(steamService.startAll).toHaveBeenCalled();
  });
});

describe('POST /api/accounts/stop-all', () => {
  test('stops all accounts', async () => {
    const res = await request(app, 'POST', '/api/accounts/stop-all');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(steamService.stopAll).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/accounts/search', () => {
  test('returns filtered accounts with safe fields', async () => {
    accountManager.search.mockReturnValue([
      {
        id: 1,
        username: 'match',
        steam_id: null,
        display_name: null,
        avatar_url: null,
        status: 'online',
        last_error: null,
        is_idling: false,
        persona_state: 1,
        games: [],
        created_at: '2025-01-01',
        shared_secret: 'sec',
        password: 'pw',
        vac_banned: false,
        trade_banned: false,
        game_bans: 0,
        lockout_until: null,
        api_last_refresh: null,
        total_games: null,
      },
    ]);

    const res = await request(app, 'GET', '/api/accounts/search?q=match');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].username).toBe('match');
    expect(res.body[0]).not.toHaveProperty('password');
    expect(res.body[0].shared_secret).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Account logs
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/accounts/:id/logs', () => {
  test('returns logs for an account', async () => {
    logger.getByAccount.mockReturnValue([
      { id: 1, message: 'Logged in', account_id: 1 },
    ]);

    const res = await request(app, 'GET', '/api/accounts/1/logs');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(logger.getByAccount).toHaveBeenCalledWith(1, 100);
  });

  test('respects the limit query parameter', async () => {
    logger.getByAccount.mockReturnValue([]);

    await request(app, 'GET', '/api/accounts/1/logs?limit=10');

    expect(logger.getByAccount).toHaveBeenCalledWith(1, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Account playtime
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/accounts/:id/playtime', () => {
  test('returns playtime data for an existing account', async () => {
    accountManager.getById.mockReturnValue({ id: 1, username: 'user1' });
    db.playtime.getByAccount.mockReturnValue([
      { app_id: 730, minutes: 120 },
    ]);

    const res = await request(app, 'GET', '/api/accounts/1/playtime');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].app_id).toBe(730);
  });

  test('returns 404 for non-existent account', async () => {
    accountManager.getById.mockReturnValue(undefined);

    const res = await request(app, 'GET', '/api/accounts/999/playtime');

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Account refresh (Steam API)
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/accounts/:id/refresh', () => {
  test('returns 404 for non-existent account', async () => {
    accountManager.getById.mockReturnValue(undefined);

    const res = await request(app, 'POST', '/api/accounts/1/refresh');

    expect(res.status).toBe(404);
  });

  test('returns 400 when account has no steam_id', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'user1',
      steam_id: null,
    });

    const res = await request(app, 'POST', '/api/accounts/1/refresh');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/steam id/i);
  });

  test('returns 400 when Steam API is not configured', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'user1',
      steam_id: '76561198000000000',
    });
    steamApiService.isConfigured.mockReturnValue(false);

    const res = await request(app, 'POST', '/api/accounts/1/refresh');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
  });

  test('refreshes account successfully', async () => {
    accountManager.getById.mockReturnValue({
      id: 1,
      username: 'user1',
      steam_id: '76561198000000000',
    });
    steamApiService.isConfigured.mockReturnValue(true);
    steamApiService.refreshAccount.mockResolvedValue({
      summary: { displayName: 'Player', avatarUrl: 'http://img.url' },
      games: [{ appid: 730 }, { appid: 570 }],
      bans: { vacBanned: false },
    });

    const res = await request(app, 'POST', '/api/accounts/1/refresh');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.gamesCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings - Steam API key
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/settings/steam-api-key', () => {
  test('saves a valid API key', async () => {
    const res = await request(app, 'POST', '/api/settings/steam-api-key', {
      apiKey: 'ABCDEF1234567890ABCDEF1234567890',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(steamApiService.setApiKey).toHaveBeenCalledWith(
      'ABCDEF1234567890ABCDEF1234567890',
    );
  });

  test('returns 400 for invalid API key format', async () => {
    const res = await request(app, 'POST', '/api/settings/steam-api-key', {
      apiKey: 'too-short',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('clears API key when empty', async () => {
    const res = await request(app, 'POST', '/api/settings/steam-api-key', {
      apiKey: '',
    });

    expect(res.status).toBe(200);
    expect(steamApiService.setApiKey).toHaveBeenCalledWith(null);
    expect(steamApiService.stopPeriodicRefresh).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings - API refresh interval
// ═══════════════════════════════════════════════════════════════════════════

describe('PUT /api/settings/api-refresh-interval', () => {
  test('sets a valid interval', async () => {
    const res = await request(app, 'PUT', '/api/settings/api-refresh-interval', {
      interval: 3600000,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(steamApiService.setRefreshInterval).toHaveBeenCalledWith(3600000);
  });

  test('disables with interval 0', async () => {
    const res = await request(app, 'PUT', '/api/settings/api-refresh-interval', {
      interval: 0,
    });

    expect(res.status).toBe(200);
    expect(steamApiService.setRefreshInterval).toHaveBeenCalledWith(0);
  });

  test('returns 400 for invalid interval', async () => {
    const res = await request(app, 'PUT', '/api/settings/api-refresh-interval', {
      interval: 500,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings - refresh all accounts
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/settings/refresh-all-accounts', () => {
  test('returns 400 when API is not configured', async () => {
    steamApiService.isConfigured.mockReturnValue(false);

    const res = await request(app, 'POST', '/api/settings/refresh-all-accounts');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
  });

  test('refreshes all accounts when configured', async () => {
    steamApiService.isConfigured.mockReturnValue(true);
    steamApiService.refreshAllAccounts.mockResolvedValue({
      refreshed: 5,
      errors: 1,
    });

    const res = await request(app, 'POST', '/api/settings/refresh-all-accounts');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.refreshed).toBe(5);
    expect(res.body.errors).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reset
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/reset', () => {
  test('resets all data', async () => {
    db.accounts.findAll.mockReturnValue([{ id: 1 }, { id: 2 }]);
    db.mafiles.findAll.mockReturnValue([]);

    const res = await request(app, 'POST', '/api/reset');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(steamService.logoutAll).toHaveBeenCalled();
    expect(db.logs.cleanup).toHaveBeenCalledWith(0);
  });
});
