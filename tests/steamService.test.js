// ---------------------------------------------------------------------------
// Mock: steam-user
// ---------------------------------------------------------------------------
class MockSteamClient {
  constructor() {
    this._listeners = {};
    this.steamID = { toString: () => '76561198000000000' };
    this.accountInfo = { name: 'TestUser' };
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  once(event, handler) {
    this.on(event, handler);
  }

  removeListener(event, handler) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    }
  }

  emit(event, ...args) {
    const handlers = this._listeners[event] || [];
    handlers.forEach(h => h(...args));
  }

  logOn() {}
  logOff() {}
  setPersona() {}
  gamesPlayed() {}
}

MockSteamClient.EResult = {
  InvalidPassword: 5,
  LoggedInElsewhere: 6,
  AccountLogonDenied: 15,
  RateLimitExceeded: 84,
  LogonSessionReplaced: 34,
};

jest.mock('steam-user', () => MockSteamClient);

// ---------------------------------------------------------------------------
// Mock: steam-totp
// ---------------------------------------------------------------------------
jest.mock('steam-totp', () => ({
  generateAuthCode: jest.fn().mockReturnValue('ABC12'),
}));

// ---------------------------------------------------------------------------
// Mock: database
// ---------------------------------------------------------------------------
jest.mock('../src/models/database', () => ({
  accounts: {
    update: jest.fn(),
    findById: jest.fn(),
    incrementFailedLogins: jest.fn(),
    getLockoutInfo: jest.fn().mockReturnValue(null),
    setLockout: jest.fn(),
    resetFailedLogins: jest.fn(),
    isLockedOut: jest.fn().mockReturnValue(false),
  },
  sessions: {
    start: jest.fn().mockReturnValue({ lastInsertRowid: 1 }),
    end: jest.fn(),
    closeOrphaned: jest.fn().mockReturnValue({ changes: 0 }),
  },
  games: {
    findByAccountId: jest.fn().mockReturnValue([]),
  },
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------
jest.mock('../src/services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: accountManager
// ---------------------------------------------------------------------------
jest.mock('../src/services/accountManager', () => ({
  getDecryptedAccount: jest.fn(),
  updateStatus: jest.fn(),
  setIdling: jest.fn(),
  getIdlingAccounts: jest.fn().mockReturnValue([]),
  getAll: jest.fn().mockReturnValue([]),
  setSteamService: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: auth middleware (required inside resumeIdling)
// ---------------------------------------------------------------------------
jest.mock('../src/middleware/auth', () => ({
  getEncryptionKey: jest.fn().mockReturnValue(Buffer.alloc(32)),
  setEncryptionKey: jest.fn(),
  initializeEncryption: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are declared)
// ---------------------------------------------------------------------------
const db = require('../src/models/database');
const logger = require('../src/services/logger');
const accountManager = require('../src/services/accountManager');

// Requiring the module will instantiate the singleton SteamService and call
// accountManager.setSteamService, but for unit-testing we need fresh instances.
// We pull the classes out via a small trick: require the module, grab its
// constructor, then build isolated instances in each test.
//
// The module exports a singleton, but we can access the class through it.
let SteamService;
let SteamSession;

// We need the classes. SteamSession is not exported, so we reconstruct it from
// the module file. However the cleanest approach is to just require the module
// and use Object.getPrototypeOf to get the SteamService class, and instantiate
// SteamSession directly since it is used internally.
//
// Because `steamService.js` exports a singleton and internally creates a
// SteamSession via `new SteamSession(...)`, we can still test SteamSession by
// using `startIdling` or by constructing one through the module's internal
// class. Let's import the module once, extract the prototype, and use the
// SteamSession constructor from the sessions map.

// Actually, let's just require the module – it gives us the singleton.
// For SteamSession tests we will create sessions via startIdling or
// construct them directly. Since SteamSession is not exported, we will
// re-implement a minimal require that gives us the class.

// Simplest: just require the file. The singleton's constructor is accessible.
const steamService = require('../src/services/steamService');
SteamService = steamService.constructor;

// To get SteamSession, we use startIdling to create one and grab the class.
// But that is async and complex. Instead, we can access it by building a
// session via the service and then extracting the constructor from the proto.
// For test isolation, we'll create sessions manually.

// Helper: create a fresh SteamSession by triggering startIdling and extracting it.
// Instead, we read the source and note that SteamSession is only used within
// steamService.js. We can still test all 15 scenarios through the singleton +
// the session objects it holds. Let's define helpers.

const ACCOUNT_ID = 'test-account-1';
const ACCOUNT_DATA = {
  id: ACCOUNT_ID,
  username: 'testuser',
  password: 'testpass',
  shared_secret: null,
  persona_state: 1,
  games: [{ app_id: 730 }],
};

/**
 * Helper: create a SteamSession by making the service create one via startIdling,
 * then return the session object.  We resolve the login by emitting 'loggedOn'.
 */
async function createLoggedInSession() {
  accountManager.getDecryptedAccount.mockReturnValue({ ...ACCOUNT_DATA });

  const promise = steamService.startIdling(ACCOUNT_ID);

  // The session was created; grab it before the login resolves.
  const session = steamService.sessions.get(ACCOUNT_ID);
  // Trigger loggedOn so the login() promise resolves
  session.client.emit('loggedOn');

  await promise;
  return session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  // Clean up sessions from previous tests
  for (const [id, session] of steamService.sessions) {
    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
  }
  steamService.sessions.clear();
  steamService._resuming = false;

  // Reset default mock return values
  db.accounts.isLockedOut.mockReturnValue(false);
  db.accounts.getLockoutInfo.mockReturnValue(null);
  db.accounts.findById.mockReturnValue(null);
  db.sessions.start.mockReturnValue({ lastInsertRowid: 1 });
  db.sessions.closeOrphaned.mockReturnValue({ changes: 0 });
  accountManager.getDecryptedAccount.mockReturnValue({ ...ACCOUNT_DATA });
  accountManager.getIdlingAccounts.mockReturnValue([]);
});

afterEach(() => {
  // Make sure no dangling timers
  for (const [, session] of steamService.sessions) {
    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
  }
  jest.useRealTimers();
});

// ── 1. Login timeout ──────────────────────────────────────────────────────────

describe('SteamSession - login timeout', () => {
  test('rejects with "Login timed out" after 30s and resets isConnecting', async () => {
    jest.useFakeTimers();

    accountManager.getDecryptedAccount.mockReturnValue({ ...ACCOUNT_DATA });

    // Start the idling process (which calls login internally)
    const startPromise = steamService.startIdling(ACCOUNT_ID);
    const session = steamService.sessions.get(ACCOUNT_ID);

    expect(session.isConnecting).toBe(true);

    // Advance timers by 30 seconds to trigger the timeout
    jest.advanceTimersByTime(30000);

    await expect(startPromise).rejects.toThrow('Login timed out');
    expect(session.isConnecting).toBe(false);
  });
});

// ── 2. Already connecting rejection ───────────────────────────────────────────

describe('SteamSession - already connecting rejection', () => {
  test('rejects with "Login already in progress" when isConnecting is true', async () => {
    jest.useFakeTimers();

    accountManager.getDecryptedAccount.mockReturnValue({ ...ACCOUNT_DATA });

    // First call: starts connecting
    const firstPromise = steamService.startIdling(ACCOUNT_ID);
    const session = steamService.sessions.get(ACCOUNT_ID);
    expect(session.isConnecting).toBe(true);

    // Second call: should reject immediately since session already exists & is connecting
    const secondPromise = session.login();
    await expect(secondPromise).rejects.toThrow('Login already in progress');

    // Clean up: resolve the first login
    session.client.emit('loggedOn');
    await firstPromise;

    jest.useRealTimers();
  });
});

// ── 3. Successful login ──────────────────────────────────────────────────────

describe('SteamSession - successful login', () => {
  test('resolves on loggedOn event, sets isLoggedIn=true and isConnecting=false', async () => {
    const session = await createLoggedInSession();

    expect(session.isLoggedIn).toBe(true);
    expect(session.isConnecting).toBe(false);
    expect(accountManager.updateStatus).toHaveBeenCalledWith(ACCOUNT_ID, 'online');
  });
});

// ── 4. Login error ────────────────────────────────────────────────────────────

describe('SteamSession - login error', () => {
  test('rejects on error event and resets isConnecting', async () => {
    accountManager.getDecryptedAccount.mockReturnValue({ ...ACCOUNT_DATA });

    const startPromise = steamService.startIdling(ACCOUNT_ID);
    const session = steamService.sessions.get(ACCOUNT_ID);

    // Emit an error
    const steamError = new Error('Connection refused');
    steamError.eresult = 999; // unknown error code
    session.client.emit('error', steamError);

    await expect(startPromise).rejects.toThrow('Connection refused');
    expect(session.isConnecting).toBe(false);
  });
});

// ── 5. playingState blocked ──────────────────────────────────────────────────

describe('SteamSession - playingState blocked', () => {
  test('sets isPaused=true and updates status to paused', async () => {
    const session = await createLoggedInSession();

    jest.clearAllMocks();

    session.client.emit('playingState', true, 730);

    expect(session.isPaused).toBe(true);
    expect(accountManager.updateStatus).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'paused',
      expect.stringContaining('730')
    );
  });
});

// ── 6. playingState unblocked while idling ───────────────────────────────────

describe('SteamSession - playingState unblocked', () => {
  test('resumes games when unblocked after being paused while idling', async () => {
    const session = await createLoggedInSession();

    // Pause first
    session.client.emit('playingState', true, 730);
    expect(session.isPaused).toBe(true);

    jest.clearAllMocks();
    const gamesPlayedSpy = jest.spyOn(session.client, 'gamesPlayed');

    // Unblock
    session.client.emit('playingState', false, 0);

    expect(session.isPaused).toBe(false);
    expect(gamesPlayedSpy).toHaveBeenCalledWith(session.currentGames);
    expect(accountManager.updateStatus).toHaveBeenCalledWith(ACCOUNT_ID, 'idling');

    gamesPlayedSpy.mockRestore();
  });
});

// ── 7. playingState unblocked when not idling ────────────────────────────────

describe('SteamSession - playingState unblocked when not idling', () => {
  test('does not call gamesPlayed when not idling', async () => {
    const session = await createLoggedInSession();

    // Stop games so isIdling = false
    session.stopGames();

    // Simulate a pause
    session.isPaused = true;

    jest.clearAllMocks();
    const gamesPlayedSpy = jest.spyOn(session.client, 'gamesPlayed');

    // Unblock
    session.client.emit('playingState', false, 0);

    expect(session.isPaused).toBe(false);
    // gamesPlayed should NOT be called because isIdling is false
    // (the handler checks: this.isIdling && this.currentGames.length > 0 && this.isLoggedIn)
    expect(gamesPlayedSpy).not.toHaveBeenCalled();

    gamesPlayedSpy.mockRestore();
  });
});

// ── 8. LoggedInElsewhere error ───────────────────────────────────────────────

describe('SteamSession - LoggedInElsewhere error', () => {
  test('schedules reconnect with 5 minute delay and updates status to paused', async () => {
    jest.useFakeTimers();

    const session = await createLoggedInSession();
    jest.clearAllMocks();

    const scheduleReconnectSpy = jest.spyOn(session, 'scheduleReconnect');

    const err = new Error('LoggedInElsewhere');
    err.eresult = MockSteamClient.EResult.LoggedInElsewhere;

    // Emit the error through the persistent handler (not the login one-shot)
    session.client.emit('error', err);

    expect(scheduleReconnectSpy).toHaveBeenCalledWith(5 * 60 * 1000);
    expect(accountManager.updateStatus).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'paused',
      'User logged in elsewhere'
    );

    scheduleReconnectSpy.mockRestore();
    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
    jest.useRealTimers();
  });
});

// ── 9. LogonSessionReplaced error ────────────────────────────────────────────

describe('SteamSession - LogonSessionReplaced error', () => {
  test('schedules reconnect with 5 minute delay same as LoggedInElsewhere', async () => {
    jest.useFakeTimers();

    const session = await createLoggedInSession();
    jest.clearAllMocks();

    const scheduleReconnectSpy = jest.spyOn(session, 'scheduleReconnect');

    const err = new Error('LogonSessionReplaced');
    err.eresult = MockSteamClient.EResult.LogonSessionReplaced;

    session.client.emit('error', err);

    expect(scheduleReconnectSpy).toHaveBeenCalledWith(5 * 60 * 1000);
    expect(accountManager.updateStatus).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'paused',
      'User logged in elsewhere'
    );

    scheduleReconnectSpy.mockRestore();
    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
    jest.useRealTimers();
  });
});

// ── 10. scheduleReconnect with minDelay ──────────────────────────────────────

describe('SteamSession - scheduleReconnect with minDelay', () => {
  test('delay is at least the minDelay value', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const session = await createLoggedInSession();
    setTimeoutSpy.mockClear();

    const minDelay = 10 * 60 * 1000; // 10 minutes
    session.scheduleReconnect(minDelay);

    // Find the setTimeout call from scheduleReconnect (the last one)
    const reconnectCall = setTimeoutSpy.mock.calls.find(
      call => typeof call[0] === 'function' && call[1] >= minDelay
    );
    expect(reconnectCall).toBeDefined();
    expect(reconnectCall[1]).toBeGreaterThanOrEqual(minDelay);

    if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
    setTimeoutSpy.mockRestore();
    jest.useRealTimers();
  });
});

// ── 11. resumeIdling guard ───────────────────────────────────────────────────

describe('SteamService - resumeIdling guard', () => {
  test('second call while first is running should be skipped', async () => {
    // Simulate an account that is idling
    accountManager.getIdlingAccounts.mockReturnValue([
      { id: ACCOUNT_ID, username: 'testuser' },
    ]);
    accountManager.getDecryptedAccount.mockReturnValue({ ...ACCOUNT_DATA });

    // We need the first resumeIdling to stay in-progress long enough for
    // the second call to arrive. We make startIdling hang by never emitting loggedOn.
    let resolveLogin;
    const hangingLogin = new Promise(resolve => {
      resolveLogin = resolve;
    });

    // Override startIdling temporarily so it hangs
    const originalStartIdling = steamService.startIdling.bind(steamService);
    jest.spyOn(steamService, 'startIdling').mockImplementation(() => hangingLogin);

    const firstResume = steamService.resumeIdling();

    // _resuming should now be true
    expect(steamService._resuming).toBe(true);

    // Second call should return immediately (skip)
    await steamService.resumeIdling();

    // The debug log indicates it was skipped
    expect(logger.debug).toHaveBeenCalledWith(
      'resumeIdling already in progress, skipping'
    );

    // Clean up: resolve the hanging login
    resolveLogin();
    await firstResume;

    steamService.startIdling.mockRestore();
  });
});

// ── 12. resumeIdling orphaned sessions ───────────────────────────────────────

describe('SteamService - resumeIdling orphaned sessions', () => {
  test('calls db.sessions.closeOrphaned() before resuming', async () => {
    accountManager.getIdlingAccounts.mockReturnValue([]);
    db.sessions.closeOrphaned.mockReturnValue({ changes: 3 });

    await steamService.resumeIdling();

    expect(db.sessions.closeOrphaned).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('3 orphaned sessions')
    );
  });
});

// ── 13. stopGames resets isPaused ────────────────────────────────────────────

describe('SteamSession - stopGames resets isPaused', () => {
  test('isPaused is false after stopGames', async () => {
    const session = await createLoggedInSession();

    // Pause via playingState
    session.client.emit('playingState', true, 730);
    expect(session.isPaused).toBe(true);

    session.stopGames();
    expect(session.isPaused).toBe(false);
  });
});

// ── 14. logout resets isPaused ───────────────────────────────────────────────

describe('SteamSession - logout resets isPaused', () => {
  test('isPaused is false after logout', async () => {
    const session = await createLoggedInSession();

    // Pause via playingState
    session.client.emit('playingState', true, 730);
    expect(session.isPaused).toBe(true);

    session.logout();
    expect(session.isPaused).toBe(false);
    expect(session.isLoggedIn).toBe(false);
    expect(session.isIdling).toBe(false);
  });
});

// ── 15. getStatus includes isPaused ──────────────────────────────────────────

describe('SteamSession - getStatus includes isPaused', () => {
  test('status object contains isPaused field', async () => {
    const session = await createLoggedInSession();

    const status = session.getStatus();

    expect(status).toHaveProperty('isPaused');
    expect(typeof status.isPaused).toBe('boolean');
    expect(status.isPaused).toBe(false);

    // After pausing
    session.client.emit('playingState', true, 730);
    const pausedStatus = session.getStatus();
    expect(pausedStatus.isPaused).toBe(true);
  });
});
