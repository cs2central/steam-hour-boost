const path = require('path');
const fs = require('fs');
const os = require('os');

// Point config at a temp directory so database.js never touches real data
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shb-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../src/models/database');

// ─── Bootstrap ──────────────────────────────────────────────

beforeAll(async () => {
  await db.initializeDatabase();
});

afterAll(() => {
  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────

let accountSeq = 0;

function createTestAccount(overrides = {}) {
  accountSeq++;
  const data = {
    username: `testuser_${accountSeq}_${Date.now()}`,
    password: 'testpass',
    ...overrides
  };
  const result = db.accounts.create(data);
  return { id: result.lastInsertRowid, ...data };
}

// ─── Session methods ────────────────────────────────────────

describe('sessions', () => {
  let account;

  beforeEach(() => {
    account = createTestAccount();
  });

  afterEach(() => {
    // Clean up sessions and accounts created in each test
    db.sessions.closeOrphaned();
    db.accounts.delete(account.id);
  });

  describe('start()', () => {
    test('should create a session record', () => {
      const games = [730, 440];
      const result = db.sessions.start(account.id, games);

      expect(result.lastInsertRowid).toBeGreaterThan(0);

      const session = db.sessions.getActive(account.id);
      expect(session).not.toBeNull();
      expect(session.account_id).toBe(account.id);
      expect(JSON.parse(session.games_played)).toEqual(games);
      expect(session.started_at).toBeDefined();
      expect(session.ended_at).toBeNull();

      // Clean up
      db.sessions.end(session.id);
    });

    test('should store games_played as JSON', () => {
      const games = [{ app_id: 730, app_name: 'CS2' }];
      db.sessions.start(account.id, games);

      const session = db.sessions.getActive(account.id);
      expect(JSON.parse(session.games_played)).toEqual(games);

      db.sessions.end(session.id);
    });
  });

  describe('end()', () => {
    test('should set ended_at on a session', () => {
      const { lastInsertRowid: sessionId } = db.sessions.start(account.id, [730]);

      db.sessions.end(sessionId);

      // No longer returned by getActive
      const active = db.sessions.getActive(account.id);
      expect(active).toBeNull();

      // But appears in history with ended_at set
      const history = db.sessions.getHistory(account.id);
      const ended = history.find(s => s.id === sessionId);
      expect(ended).toBeDefined();
      expect(ended.ended_at).not.toBeNull();
    });

    test('should not affect other sessions', () => {
      const { lastInsertRowid: s1 } = db.sessions.start(account.id, [730]);
      db.sessions.end(s1);

      const { lastInsertRowid: s2 } = db.sessions.start(account.id, [440]);

      const active = db.sessions.getActive(account.id);
      expect(active).not.toBeNull();
      expect(active.id).toBe(s2);

      db.sessions.end(s2);
    });
  });

  describe('getActive()', () => {
    test('should return only sessions without ended_at', () => {
      const { lastInsertRowid: s1 } = db.sessions.start(account.id, [730]);
      db.sessions.end(s1);

      const { lastInsertRowid: s2 } = db.sessions.start(account.id, [440]);

      const active = db.sessions.getActive(account.id);
      expect(active).not.toBeNull();
      expect(active.id).toBe(s2);
      expect(active.ended_at).toBeNull();

      db.sessions.end(s2);
    });

    test('should return null when no active sessions exist', () => {
      const active = db.sessions.getActive(account.id);
      expect(active).toBeNull();
    });

    test('should return an active session when multiple exist (DESC + LIMIT 1)', () => {
      // Start two sessions without ending either
      const { lastInsertRowid: s1 } = db.sessions.start(account.id, [730]);
      const { lastInsertRowid: s2 } = db.sessions.start(account.id, [440]);

      const active = db.sessions.getActive(account.id);
      expect(active).not.toBeNull();
      expect(active.ended_at).toBeNull();
      // Should return one of the active sessions (ORDER BY started_at DESC LIMIT 1)
      expect([s1, s2]).toContain(active.id);
    });
  });

  describe('closeOrphaned()', () => {
    test('should close all sessions that have no ended_at', () => {
      const account2 = createTestAccount();

      db.sessions.start(account.id, [730]);
      db.sessions.start(account2.id, [440]);

      // Both should be active
      expect(db.sessions.getActive(account.id)).not.toBeNull();
      expect(db.sessions.getActive(account2.id)).not.toBeNull();

      const result = db.sessions.closeOrphaned();
      expect(result.changes).toBeGreaterThanOrEqual(2);

      // Now neither should be active
      expect(db.sessions.getActive(account.id)).toBeNull();
      expect(db.sessions.getActive(account2.id)).toBeNull();

      db.accounts.delete(account2.id);
    });

    test('should not affect already-ended sessions', () => {
      const { lastInsertRowid: s1 } = db.sessions.start(account.id, [730]);
      db.sessions.end(s1);

      const historyBefore = db.sessions.getHistory(account.id);
      const endedAtBefore = historyBefore[0].ended_at;

      db.sessions.closeOrphaned();

      const historyAfter = db.sessions.getHistory(account.id);
      // ended_at should remain unchanged since it was already set
      expect(historyAfter[0].ended_at).toBe(endedAtBefore);
    });
  });

  describe('getAllActive()', () => {
    test('should return all active sessions across accounts', () => {
      const account2 = createTestAccount();

      db.sessions.start(account.id, [730]);
      db.sessions.start(account2.id, [440]);

      const allActive = db.sessions.getAllActive();
      const ids = allActive.map(s => s.account_id);

      expect(ids).toContain(account.id);
      expect(ids).toContain(account2.id);

      db.accounts.delete(account2.id);
    });

    test('should not include ended sessions', () => {
      const { lastInsertRowid: s1 } = db.sessions.start(account.id, [730]);
      db.sessions.end(s1);

      const allActive = db.sessions.getAllActive();
      const ids = allActive.map(s => s.account_id);

      expect(ids).not.toContain(account.id);
    });

    test('should return empty array when no sessions are active', () => {
      db.sessions.closeOrphaned();
      const allActive = db.sessions.getAllActive();
      expect(allActive).toEqual([]);
    });
  });

  describe('getHistory()', () => {
    test('should return session history for an account', () => {
      const { lastInsertRowid: s1 } = db.sessions.start(account.id, [730]);
      db.sessions.end(s1);
      const { lastInsertRowid: s2 } = db.sessions.start(account.id, [440]);
      db.sessions.end(s2);

      const history = db.sessions.getHistory(account.id);
      expect(history.length).toBe(2);
      // Both sessions should be present
      const historyIds = history.map(s => s.id);
      expect(historyIds).toContain(s1);
      expect(historyIds).toContain(s2);
      // Ordered by started_at DESC -- the most recent should be first
      // Both may share the same started_at, but the first entry should have
      // a started_at >= the second entry's started_at
      expect(history[0].started_at >= history[1].started_at).toBe(true);
    });

    test('should include both active and ended sessions', () => {
      const { lastInsertRowid: s1 } = db.sessions.start(account.id, [730]);
      db.sessions.end(s1);
      db.sessions.start(account.id, [440]);

      const history = db.sessions.getHistory(account.id);
      expect(history.length).toBe(2);

      const endedCount = history.filter(s => s.ended_at !== null).length;
      const activeCount = history.filter(s => s.ended_at === null).length;
      expect(endedCount).toBe(1);
      expect(activeCount).toBe(1);
    });

    test('should respect the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const { lastInsertRowid: sid } = db.sessions.start(account.id, [730]);
        db.sessions.end(sid);
      }

      const limited = db.sessions.getHistory(account.id, 3);
      expect(limited.length).toBe(3);
    });

    test('should not include sessions from other accounts', () => {
      const account2 = createTestAccount();
      db.sessions.start(account.id, [730]);
      db.sessions.start(account2.id, [440]);

      const history = db.sessions.getHistory(account.id);
      expect(history.every(s => s.account_id === account.id)).toBe(true);

      db.accounts.delete(account2.id);
    });
  });
});

// ─── Web session methods ────────────────────────────────────

describe('webSessions', () => {
  const testSid = 'test-session-id';
  const testSess = JSON.stringify({ user: 'testuser', role: 'admin' });

  afterEach(() => {
    db.webSessions.destroy(testSid);
    db.webSessions.destroy('other-sid');
    db.webSessions.destroy('expired-1');
    db.webSessions.destroy('expired-2');
    db.webSessions.destroy('valid-1');
    // Run cleanup to remove any stragglers
    db.webSessions.cleanup();
  });

  describe('set()', () => {
    test('should store a session', () => {
      const expires = Date.now() + 3600000; // 1 hour from now
      db.webSessions.set(testSid, testSess, expires);

      const row = db.webSessions.get(testSid);
      expect(row).not.toBeNull();
      expect(row.sess).toBe(testSess);
    });

    test('should overwrite an existing session with the same sid', () => {
      const expires = Date.now() + 3600000;
      db.webSessions.set(testSid, testSess, expires);

      const updatedSess = JSON.stringify({ user: 'updated' });
      db.webSessions.set(testSid, updatedSess, expires);

      const row = db.webSessions.get(testSid);
      expect(row.sess).toBe(updatedSess);
    });
  });

  describe('get()', () => {
    test('should retrieve a non-expired session', () => {
      const expires = Date.now() + 3600000;
      db.webSessions.set(testSid, testSess, expires);

      const row = db.webSessions.get(testSid);
      expect(row).not.toBeNull();
      expect(row.sess).toBe(testSess);
    });

    test('should return null for expired sessions', () => {
      const expires = Date.now() - 1000; // Already expired
      db.webSessions.set(testSid, testSess, expires);

      const row = db.webSessions.get(testSid);
      expect(row).toBeNull();
    });

    test('should return null for non-existent session', () => {
      const row = db.webSessions.get('does-not-exist');
      expect(row).toBeNull();
    });
  });

  describe('destroy()', () => {
    test('should remove a session', () => {
      const expires = Date.now() + 3600000;
      db.webSessions.set(testSid, testSess, expires);

      db.webSessions.destroy(testSid);

      const row = db.webSessions.get(testSid);
      expect(row).toBeNull();
    });

    test('should not throw when destroying a non-existent session', () => {
      expect(() => db.webSessions.destroy('non-existent')).not.toThrow();
    });
  });

  describe('touch()', () => {
    test('should update the expiry', () => {
      const originalExpires = Date.now() + 1000; // 1 second from now
      db.webSessions.set(testSid, testSess, originalExpires);

      const newExpires = Date.now() + 7200000; // 2 hours from now
      db.webSessions.touch(testSid, newExpires);

      // Session should still be retrievable even though original would have been close to expiry
      const row = db.webSessions.get(testSid);
      expect(row).not.toBeNull();
      expect(row.sess).toBe(testSess);
    });
  });

  describe('cleanup()', () => {
    test('should remove all expired sessions', () => {
      const pastExpires = Date.now() - 1000;
      const futureExpires = Date.now() + 3600000;

      db.webSessions.set('expired-1', '{}', pastExpires);
      db.webSessions.set('expired-2', '{}', pastExpires);
      db.webSessions.set('valid-1', '{}', futureExpires);

      const result = db.webSessions.cleanup();
      expect(result.changes).toBe(2);

      // Valid session should still be there
      expect(db.webSessions.get('valid-1')).not.toBeNull();
      // Expired sessions should be gone (they were already not gettable, but now physically deleted)
      expect(db.webSessions.get('expired-1')).toBeNull();
      expect(db.webSessions.get('expired-2')).toBeNull();
    });

    test('should not remove sessions that have not yet expired', () => {
      const futureExpires = Date.now() + 3600000;
      db.webSessions.set(testSid, testSess, futureExpires);

      db.webSessions.cleanup();

      const row = db.webSessions.get(testSid);
      expect(row).not.toBeNull();
    });
  });
});

// ─── Batch mode ─────────────────────────────────────────────

describe('batch()', () => {
  test('should only save database once at the end, not per statement', () => {
    // Spy on fs.writeFileSync since saveDatabase calls it internally.
    // jest.spyOn(db, 'saveDatabase') cannot intercept the module-internal
    // reference to the local saveDatabase function.
    const writeSpy = jest.spyOn(fs, 'writeFileSync');

    const account = createTestAccount();

    // Clear calls from createTestAccount
    writeSpy.mockClear();

    db.batch(() => {
      // Each of these run() calls would normally trigger saveDatabase -> writeFileSync
      db.sessions.start(account.id, [730]);
      db.sessions.start(account.id, [440]);
      db.sessions.start(account.id, [570]);
    });

    // writeFileSync should have been called exactly once (at the end of batch),
    // not three times (once per statement)
    const dbWrites = writeSpy.mock.calls.filter(
      call => String(call[0]).endsWith('.db')
    );
    expect(dbWrites.length).toBe(1);

    writeSpy.mockRestore();

    // Clean up
    db.sessions.closeOrphaned();
    db.accounts.delete(account.id);
  });

  test('should still save even if the batch function throws', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    writeSpy.mockClear();

    expect(() => {
      db.batch(() => {
        throw new Error('something went wrong');
      });
    }).toThrow('something went wrong');

    // saveDatabase should still be called in the finally block
    const dbWrites = writeSpy.mock.calls.filter(
      call => String(call[0]).endsWith('.db')
    );
    expect(dbWrites.length).toBe(1);

    writeSpy.mockRestore();
  });

  test('should restore batchMode to false after completion', () => {
    const account = createTestAccount();

    db.batch(() => {
      db.sessions.start(account.id, [730]);
    });

    // After batch, individual run() calls should trigger saveDatabase again
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    writeSpy.mockClear();

    db.sessions.start(account.id, [440]);

    const dbWrites = writeSpy.mock.calls.filter(
      call => String(call[0]).endsWith('.db')
    );
    expect(dbWrites.length).toBe(1);

    writeSpy.mockRestore();
    db.sessions.closeOrphaned();
    db.accounts.delete(account.id);
  });
});

describe('games.setGames()', () => {
  test('should use batch mode (delete+insert atomically)', () => {
    const account = createTestAccount();

    // Set initial games
    db.games.setGames(account.id, [
      { app_id: 730, app_name: 'CS2' },
      { app_id: 440, app_name: 'TF2' }
    ]);

    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    writeSpy.mockClear();

    // Replace games - setGames internally uses batch()
    db.games.setGames(account.id, [
      { app_id: 570, app_name: 'Dota 2' },
      { app_id: 304930, app_name: 'Unturned' },
      { app_id: 252490, app_name: 'Rust' }
    ]);

    // batch() saves once at the end: 1 delete + 3 inserts = 4 run() calls, but only 1 save
    const dbWrites = writeSpy.mock.calls.filter(
      call => String(call[0]).endsWith('.db')
    );
    expect(dbWrites.length).toBe(1);

    // Verify the games were actually replaced
    const games = db.games.getGames(account.id);
    expect(games.length).toBe(3);
    const appIds = games.map(g => g.app_id);
    expect(appIds).toContain(570);
    expect(appIds).toContain(304930);
    expect(appIds).toContain(252490);
    expect(appIds).not.toContain(730);
    expect(appIds).not.toContain(440);

    writeSpy.mockRestore();
    db.accounts.delete(account.id);
  });

  test('should handle plain app_id numbers as well as objects', () => {
    const account = createTestAccount();

    db.games.setGames(account.id, [730, 440, 570]);

    const games = db.games.getGames(account.id);
    expect(games.length).toBe(3);
    expect(games.map(g => g.app_id)).toEqual(expect.arrayContaining([730, 440, 570]));
    // app_name should be null for plain integers
    expect(games.every(g => g.app_name === null)).toBe(true);

    db.accounts.delete(account.id);
  });
});

// ─── Account methods ────────────────────────────────────────

describe('accounts', () => {
  describe('search() with LIKE escape', () => {
    let accountPercent, accountUnderscore, accountBackslash, normalAccount;

    beforeEach(() => {
      accountPercent = createTestAccount({ username: 'user%special' });
      accountUnderscore = createTestAccount({ username: 'user_wild' });
      accountBackslash = createTestAccount({ username: 'user\\backslash' });
      normalAccount = createTestAccount({ username: 'normaluser123' });
    });

    afterEach(() => {
      db.accounts.delete(accountPercent.id);
      db.accounts.delete(accountUnderscore.id);
      db.accounts.delete(accountBackslash.id);
      db.accounts.delete(normalAccount.id);
    });

    test('should escape % in search queries', () => {
      const results = db.accounts.search({ q: '%special' });

      // Should find the account with literal % in the name
      expect(results.some(a => a.username === 'user%special')).toBe(true);
      // Should NOT match accounts that don't have a literal %
      expect(results.some(a => a.username === 'normaluser123')).toBe(false);
    });

    test('should escape _ in search queries', () => {
      const results = db.accounts.search({ q: 'user_wild' });

      // Should find the exact account
      expect(results.some(a => a.username === 'user_wild')).toBe(true);
      // _ without escaping would match any single character, so 'user%wild' or 'userXwild' would also match
      // With escaping, only literal _ matches
    });

    test('should escape \\ in search queries', () => {
      const results = db.accounts.search({ q: '\\backslash' });

      expect(results.some(a => a.username === 'user\\backslash')).toBe(true);
    });

    test('should return all accounts when no query is specified', () => {
      const results = db.accounts.search({});
      expect(results.length).toBeGreaterThanOrEqual(4);
    });

    test('should filter by status', () => {
      db.accounts.updateStatus(normalAccount.id, 'online');

      const results = db.accounts.search({ status: 'online' });
      expect(results.every(a => a.status === 'online')).toBe(true);
      expect(results.some(a => a.id === normalAccount.id)).toBe(true);
    });

    test('should sort by allowed columns', () => {
      const results = db.accounts.search({ sortBy: 'username', order: 'asc' });
      for (let i = 1; i < results.length; i++) {
        expect(results[i].username >= results[i - 1].username).toBe(true);
      }
    });

    test('should ignore disallowed sort columns', () => {
      // Attempting SQL injection via sortBy should fall back to default
      expect(() => {
        db.accounts.search({ sortBy: 'username; DROP TABLE accounts; --' });
      }).not.toThrow();
    });
  });

  describe('update()', () => {
    let account;

    beforeEach(() => {
      account = createTestAccount();
    });

    afterEach(() => {
      db.accounts.delete(account.id);
    });

    test('should only allow whitelisted columns', () => {
      // Attempt to update a non-whitelisted column
      db.accounts.update(account.id, {
        id: 9999,
        created_at: '2000-01-01',
        status: 'online'
      });

      const updated = db.accounts.findById(account.id);
      // id should not have changed
      expect(updated.id).toBe(account.id);
      // created_at is not whitelisted, so it should remain unchanged
      expect(updated.created_at).not.toBe('2000-01-01');
      // status IS whitelisted, so it should be updated
      expect(updated.status).toBe('online');
    });

    test('should update whitelisted columns', () => {
      db.accounts.update(account.id, {
        display_name: 'New Display Name',
        avatar_url: 'https://example.com/avatar.png',
        steam_id: '76561198000000000',
        persona_state: 3
      });

      const updated = db.accounts.findById(account.id);
      expect(updated.display_name).toBe('New Display Name');
      expect(updated.avatar_url).toBe('https://example.com/avatar.png');
      expect(updated.steam_id).toBe('76561198000000000');
      expect(updated.persona_state).toBe(3);
    });

    test('should set updated_at via CURRENT_TIMESTAMP in the SET clause', () => {
      // The update() method always appends `updated_at = CURRENT_TIMESTAMP`.
      // Verify this by checking the column is a valid timestamp string after update.
      db.accounts.update(account.id, { status: 'online' });

      const after = db.accounts.findById(account.id);
      // updated_at should be a non-null timestamp string
      expect(after.updated_at).toBeDefined();
      expect(after.updated_at).not.toBeNull();
      // Should be parseable as a date
      expect(new Date(after.updated_at).toString()).not.toBe('Invalid Date');
    });

    test('should skip update when no valid columns are provided', () => {
      const result = db.accounts.update(account.id, {
        not_a_column: 'value',
        also_fake: 123
      });

      // Should return undefined because no fields matched
      expect(result).toBeUndefined();
    });

    test('should skip undefined values', () => {
      db.accounts.update(account.id, {
        status: 'online',
        display_name: undefined
      });

      const updated = db.accounts.findById(account.id);
      expect(updated.status).toBe('online');
      // display_name should remain as original (null from creation)
      expect(updated.display_name).toBeNull();
    });

    test('should allow updating lockout-related columns', () => {
      db.accounts.update(account.id, {
        failed_logins: 3,
        lockout_until: '2099-01-01T00:00:00Z'
      });

      const updated = db.accounts.findById(account.id);
      expect(updated.failed_logins).toBe(3);
      expect(updated.lockout_until).toBe('2099-01-01T00:00:00Z');
    });

    test('should allow updating Steam API data columns', () => {
      db.accounts.update(account.id, {
        profile_visibility: 3,
        vac_banned: 1,
        trade_banned: 0,
        game_bans: 2,
        total_games: 150
      });

      const updated = db.accounts.findById(account.id);
      expect(updated.profile_visibility).toBe(3);
      expect(updated.vac_banned).toBe(1);
      expect(updated.trade_banned).toBe(0);
      expect(updated.game_bans).toBe(2);
      expect(updated.total_games).toBe(150);
    });
  });
});
