// ─── Mocks ─────────────────────────────────────────────────

jest.mock('../src/models/database', () => ({
  users: {
    create: jest.fn(() => ({ lastInsertRowid: 1 })),
    findByUsername: jest.fn(),
    findById: jest.fn(),
    updatePassword: jest.fn(),
    count: jest.fn(() => 0),
  },
  accounts: {
    findAll: jest.fn(() => []),
    update: jest.fn(),
  },
  mafiles: {
    findAll: jest.fn(() => []),
    updateSecrets: jest.fn(),
  },
  settings: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

jest.mock('../src/services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const db = require('../src/models/database');
const {
  requireAuth,
  checkSetup,
  hashPassword,
  verifyPassword,
  createUser,
  authenticateUser,
  changePassword,
  getEncryptionKey,
  setEncryptionKey,
  initializeEncryption,
  encryptAccountCredentials,
  decryptAccountCredentials,
  clearEncryptionKey,
  isEncryptionInitialized,
  reEncryptAllData,
  ENCRYPTED_FIELDS,
} = require('../src/middleware/auth');
const { isEncrypted } = require('../src/utils/encryption');

// ─── Helpers ───────────────────────────────────────────────

function mockReq(overrides = {}) {
  return {
    session: {},
    path: '/',
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.redirect = jest.fn(() => res);
  return res;
}

// ─── Setup / Teardown ──────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the cached user count by re-requiring? No -- we clear it via
  // db.users.count mock returning specific values per test.
  // Default: count returns 0 (no users).
  db.users.count.mockReturnValue(0);
});

afterEach(() => {
  clearEncryptionKey();
});

// ─── requireAuth ───────────────────────────────────────────

describe('requireAuth', () => {
  test('calls next() when session.userId exists', () => {
    const req = mockReq({ session: { userId: 1 } });
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test('returns 401 JSON for API requests without session', () => {
    const req = mockReq({ path: '/api/accounts' });
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  test('redirects to /login for page requests without session', () => {
    const req = mockReq({ path: '/dashboard' });
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });
});

// ─── checkSetup ────────────────────────────────────────────

describe('checkSetup', () => {
  test('redirects to /setup when no users exist and path is not /setup', () => {
    db.users.count.mockReturnValue(0);

    const req = mockReq({ path: '/login' });
    const res = mockRes();
    const next = jest.fn();

    checkSetup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/setup');
  });

  test('returns 403 JSON with setup:true for API routes when no users', () => {
    db.users.count.mockReturnValue(0);

    const req = mockReq({ path: '/api/accounts' });
    const res = mockRes();
    const next = jest.fn();

    checkSetup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Setup required', setup: true });
  });

  test('allows /setup when no users exist', () => {
    db.users.count.mockReturnValue(0);

    const req = mockReq({ path: '/setup' });
    const res = mockRes();
    const next = jest.fn();

    checkSetup(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('allows /api/setup when no users exist', () => {
    db.users.count.mockReturnValue(0);

    const req = mockReq({ path: '/api/setup' });
    const res = mockRes();
    const next = jest.fn();

    checkSetup(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('redirects /setup to / when setup is complete (count > 0)', async () => {
    // createUser invalidates the internal cachedUserCount
    await createUser('setup-user', 'pass');
    db.users.count.mockReturnValue(1);

    const req = mockReq({ path: '/setup' });
    const res = mockRes();
    const next = jest.fn();

    checkSetup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/');
  });

  test('calls next() for normal routes when setup is done', async () => {
    // createUser invalidates the internal cachedUserCount
    await createUser('setup-user', 'pass');
    db.users.count.mockReturnValue(1);

    const req = mockReq({ path: '/dashboard' });
    const res = mockRes();
    const next = jest.fn();

    checkSetup(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// ─── hashPassword & verifyPassword ─────────────────────────

describe('hashPassword & verifyPassword', () => {
  test('hash and verify round-trip works', async () => {
    const password = 'my-secure-password';
    const hash = await hashPassword(password);

    expect(hash).toBeDefined();
    expect(hash).not.toBe(password);

    const valid = await verifyPassword(password, hash);
    expect(valid).toBe(true);
  });

  test('wrong password fails verification', async () => {
    const hash = await hashPassword('correct-password');
    const valid = await verifyPassword('wrong-password', hash);
    expect(valid).toBe(false);
  });
});

// ─── createUser ────────────────────────────────────────────

describe('createUser', () => {
  test('creates user with hashed password', async () => {
    const result = await createUser('admin', 'test-password');

    expect(db.users.create).toHaveBeenCalledTimes(1);
    const [username, hash] = db.users.create.mock.calls[0];
    expect(username).toBe('admin');
    // The hash should be a bcrypt hash, not the plaintext password
    expect(hash).not.toBe('test-password');
    expect(hash).toMatch(/^\$2[aby]?\$/); // bcrypt hash prefix
    expect(result).toEqual({ lastInsertRowid: 1 });
  });

  test('invalidates the user count cache so checkSetup re-queries', async () => {
    // First, prime the cache with count = 0
    db.users.count.mockReturnValue(0);
    const req1 = mockReq({ path: '/login' });
    const res1 = mockRes();
    checkSetup(req1, res1, jest.fn());
    // count was called once to populate cache
    const callsBefore = db.users.count.mock.calls.length;

    // Create a user (invalidates cachedUserCount)
    await createUser('admin', 'pass');

    // Now change count to 1 to simulate user existing
    db.users.count.mockReturnValue(1);

    // Next checkSetup call should re-query since cache was invalidated
    const req2 = mockReq({ path: '/dashboard' });
    const res2 = mockRes();
    const next2 = jest.fn();
    checkSetup(req2, res2, next2);

    // count should have been called again
    expect(db.users.count.mock.calls.length).toBeGreaterThan(callsBefore);
    // And the route should proceed (setup is done)
    expect(next2).toHaveBeenCalled();
  });
});

// ─── authenticateUser ──────────────────────────────────────

describe('authenticateUser', () => {
  test('returns user on valid credentials', async () => {
    const hash = await hashPassword('correct-password');
    const mockUser = { id: 1, username: 'admin', password_hash: hash };
    db.users.findByUsername.mockReturnValue(mockUser);

    const result = await authenticateUser('admin', 'correct-password');

    expect(result).toEqual(mockUser);
    expect(db.users.findByUsername).toHaveBeenCalledWith('admin');
  });

  test('returns null on wrong password', async () => {
    const hash = await hashPassword('correct-password');
    db.users.findByUsername.mockReturnValue({ id: 1, username: 'admin', password_hash: hash });

    const result = await authenticateUser('admin', 'wrong-password');

    expect(result).toBeNull();
  });

  test('returns null on non-existent username', async () => {
    db.users.findByUsername.mockReturnValue(null);

    const result = await authenticateUser('nobody', 'any-password');

    expect(result).toBeNull();
  });
});

// ─── changePassword ────────────────────────────────────────

describe('changePassword', () => {
  test('changes password for valid user with correct current password', async () => {
    const currentHash = await hashPassword('old-password');
    db.users.findById.mockReturnValue({ id: 1, username: 'admin', password_hash: currentHash });

    await changePassword(1, 'old-password', 'new-password');

    expect(db.users.updatePassword).toHaveBeenCalledTimes(1);
    const [userId, newHash] = db.users.updatePassword.mock.calls[0];
    expect(userId).toBe(1);
    // New hash should be a valid bcrypt hash different from the old one
    expect(newHash).toMatch(/^\$2[aby]?\$/);
    expect(newHash).not.toBe(currentHash);
  });

  test('throws on wrong current password', async () => {
    const currentHash = await hashPassword('old-password');
    db.users.findById.mockReturnValue({ id: 1, username: 'admin', password_hash: currentHash });

    await expect(changePassword(1, 'wrong-password', 'new-password'))
      .rejects.toThrow('Current password is incorrect');
    expect(db.users.updatePassword).not.toHaveBeenCalled();
  });

  test('throws on non-existent user', async () => {
    db.users.findById.mockReturnValue(null);

    await expect(changePassword(999, 'any', 'new'))
      .rejects.toThrow('User not found');
    expect(db.users.updatePassword).not.toHaveBeenCalled();
  });
});

// ─── encryptAccountCredentials & decryptAccountCredentials ──

describe('encryptAccountCredentials & decryptAccountCredentials', () => {
  test('round-trip: decrypt(encrypt(data)) returns original values', async () => {
    db.settings.get.mockReturnValue(null); // no existing salt
    await initializeEncryption('test-password');

    const original = {
      id: 1,
      username: 'steamuser',
      password: 'steam-pass-123',
      shared_secret: 'abc123secret',
      identity_secret: 'id-secret-456',
      revocation_code: 'R12345',
    };

    const encrypted = encryptAccountCredentials(original);
    const decrypted = decryptAccountCredentials(encrypted);

    expect(decrypted.password).toBe(original.password);
    expect(decrypted.shared_secret).toBe(original.shared_secret);
    expect(decrypted.identity_secret).toBe(original.identity_secret);
    expect(decrypted.revocation_code).toBe(original.revocation_code);
    // Non-encrypted fields should pass through unchanged
    expect(decrypted.username).toBe(original.username);
    expect(decrypted.id).toBe(original.id);
  });

  test('returns data unchanged when no encryption key is cached', () => {
    // clearEncryptionKey() is called in afterEach, so key is null
    const data = {
      username: 'steamuser',
      password: 'plain-password',
      shared_secret: 'secret',
    };

    const result = encryptAccountCredentials(data);
    expect(result).toEqual(data);
  });

  test('only encrypts the ENCRYPTED_FIELDS', async () => {
    db.settings.get.mockReturnValue(null);
    await initializeEncryption('test-password');

    const data = {
      id: 42,
      username: 'myaccount',
      password: 'pass123',
      shared_secret: 'ss',
      identity_secret: 'is',
      revocation_code: 'rc',
      display_name: 'My Account',
    };

    const encrypted = encryptAccountCredentials(data);

    // Encrypted fields should have the $ENC$ prefix
    for (const field of ENCRYPTED_FIELDS) {
      expect(isEncrypted(encrypted[field])).toBe(true);
    }

    // Non-encrypted fields should remain plaintext
    expect(encrypted.id).toBe(42);
    expect(encrypted.username).toBe('myaccount');
    expect(encrypted.display_name).toBe('My Account');
  });

  test('does not double-encrypt already encrypted data', async () => {
    db.settings.get.mockReturnValue(null);
    await initializeEncryption('test-password');

    const data = { password: 'plain-pass', shared_secret: 'secret' };

    const encrypted1 = encryptAccountCredentials(data);
    const encrypted2 = encryptAccountCredentials(encrypted1);

    // Encrypting already-encrypted data should not change it
    // (the values are non-deterministic due to random IVs, but the function
    // should detect the $ENC$ prefix and skip re-encryption)
    expect(encrypted2.password).toBe(encrypted1.password);
    expect(encrypted2.shared_secret).toBe(encrypted1.shared_secret);
  });

  test('handles null/missing fields gracefully', async () => {
    db.settings.get.mockReturnValue(null);
    await initializeEncryption('test-password');

    const data = {
      username: 'user1',
      password: null,
      shared_secret: undefined,
      // identity_secret and revocation_code missing entirely
    };

    const encrypted = encryptAccountCredentials(data);

    expect(encrypted.username).toBe('user1');
    expect(encrypted.password).toBeNull();
    expect(encrypted.shared_secret).toBeUndefined();

    // Decrypt should also handle nulls
    const decrypted = decryptAccountCredentials(encrypted);
    expect(decrypted.password).toBeNull();
  });

  test('decryptAccountCredentials returns null/undefined input as-is', () => {
    expect(decryptAccountCredentials(null)).toBeNull();
    expect(decryptAccountCredentials(undefined)).toBeUndefined();
  });
});

// ─── getEncryptionKey / setEncryptionKey / clearEncryptionKey / initializeEncryption ──

describe('encryption key management', () => {
  test('getEncryptionKey returns null initially', () => {
    expect(getEncryptionKey()).toBeNull();
  });

  test('after setEncryptionKey, getEncryptionKey returns the derived key', async () => {
    // We need a salt in settings for setEncryptionKey to work
    const salt = require('crypto').randomBytes(32).toString('base64');
    db.settings.get.mockReturnValue(salt);

    const key = await setEncryptionKey('my-password');

    expect(key).toBeDefined();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32); // AES-256 key
    expect(getEncryptionKey()).toBe(key);
  });

  test('clearEncryptionKey resets to null', async () => {
    const salt = require('crypto').randomBytes(32).toString('base64');
    db.settings.get.mockReturnValue(salt);
    await setEncryptionKey('password');

    expect(getEncryptionKey()).not.toBeNull();

    clearEncryptionKey();

    expect(getEncryptionKey()).toBeNull();
  });

  test('initializeEncryption generates salt, derives key, stores salt in settings', async () => {
    db.settings.get.mockReturnValue(null); // no existing salt

    const key = await initializeEncryption('admin-password');

    expect(key).toBeDefined();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);

    // Should have stored the generated salt
    expect(db.settings.set).toHaveBeenCalledWith('encryption_salt', expect.any(String));
    const storedSalt = db.settings.set.mock.calls.find(c => c[0] === 'encryption_salt')[1];
    // Salt should be a base64 string of 32 bytes
    const saltBuffer = Buffer.from(storedSalt, 'base64');
    expect(saltBuffer.length).toBe(32);

    // The key should now be cached
    expect(getEncryptionKey()).toBe(key);
  });

  test('isEncryptionInitialized returns true when salt exists in settings', () => {
    db.settings.get.mockReturnValue('some-base64-salt-value');

    expect(isEncryptionInitialized()).toBe(true);
  });

  test('isEncryptionInitialized returns false when no salt in settings', () => {
    db.settings.get.mockReturnValue(null);

    expect(isEncryptionInitialized()).toBe(false);
  });

  test('setEncryptionKey throws when no salt exists in settings', async () => {
    db.settings.get.mockReturnValue(null);

    await expect(setEncryptionKey('password'))
      .rejects.toThrow('Encryption salt not found in settings');
  });
});

// ─── reEncryptAllData ──────────────────────────────────────

describe('reEncryptAllData', () => {
  let oldKey;
  let newKey;

  beforeEach(async () => {
    // Derive two different keys for old and new
    const { deriveKey, generateSalt } = require('../src/utils/encryption');
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    oldKey = await deriveKey('old-password', salt1);
    newKey = await deriveKey('new-password', salt2);
  });

  test('re-encrypts all account credentials with new key', async () => {
    const { encrypt } = require('../src/utils/encryption');

    // Set up accounts with encrypted data
    const encryptedPassword = encrypt('steam-pass', oldKey);
    const encryptedSecret = encrypt('shared-secret', oldKey);

    db.accounts.findAll.mockReturnValue([
      {
        id: 1,
        username: 'account1',
        password: encryptedPassword,
        shared_secret: encryptedSecret,
        identity_secret: null,
        revocation_code: null,
      },
    ]);
    db.mafiles.findAll.mockReturnValue([]);
    db.settings.get.mockReturnValue(null); // no API key

    const result = await reEncryptAllData(oldKey, newKey);

    expect(result.success).toBe(1);
    expect(result.errors).toBe(0);

    // Verify db.accounts.update was called with re-encrypted fields
    expect(db.accounts.update).toHaveBeenCalledTimes(1);
    const [accountId, updates] = db.accounts.update.mock.calls[0];
    expect(accountId).toBe(1);
    expect(isEncrypted(updates.password)).toBe(true);
    expect(isEncrypted(updates.shared_secret)).toBe(true);

    // The re-encrypted values should be different from the old encrypted values
    expect(updates.password).not.toBe(encryptedPassword);
    expect(updates.shared_secret).not.toBe(encryptedSecret);

    // Decrypting with the new key should yield the original plaintext
    const { decrypt } = require('../src/utils/encryption');
    expect(decrypt(updates.password, newKey)).toBe('steam-pass');
    expect(decrypt(updates.shared_secret, newKey)).toBe('shared-secret');
  });

  test('re-encrypts mafile secrets', async () => {
    const { encrypt } = require('../src/utils/encryption');

    db.accounts.findAll.mockReturnValue([]);
    db.mafiles.findAll.mockReturnValue([
      {
        id: 10,
        shared_secret: encrypt('mafile-shared', oldKey),
        identity_secret: encrypt('mafile-identity', oldKey),
      },
    ]);
    db.settings.get.mockReturnValue(null);

    const result = await reEncryptAllData(oldKey, newKey);

    expect(db.mafiles.updateSecrets).toHaveBeenCalledTimes(1);
    const [mafileId, updates] = db.mafiles.updateSecrets.mock.calls[0];
    expect(mafileId).toBe(10);
    expect(isEncrypted(updates.shared_secret)).toBe(true);
    expect(isEncrypted(updates.identity_secret)).toBe(true);

    // Verify values decrypt correctly with new key
    const { decrypt } = require('../src/utils/encryption');
    expect(decrypt(updates.shared_secret, newKey)).toBe('mafile-shared');
    expect(decrypt(updates.identity_secret, newKey)).toBe('mafile-identity');
  });

  test('re-encrypts Steam API key', async () => {
    const { encrypt } = require('../src/utils/encryption');
    const encryptedApiKey = encrypt('ABCDEF123456', oldKey);

    db.accounts.findAll.mockReturnValue([]);
    db.mafiles.findAll.mockReturnValue([]);
    db.settings.get.mockReturnValue(encryptedApiKey); // steam_api_key

    await reEncryptAllData(oldKey, newKey);

    // settings.set should be called with the re-encrypted API key
    const apiKeyCall = db.settings.set.mock.calls.find(c => c[0] === 'steam_api_key');
    expect(apiKeyCall).toBeDefined();

    const { decrypt } = require('../src/utils/encryption');
    expect(decrypt(apiKeyCall[1], newKey)).toBe('ABCDEF123456');
  });

  test('reports success/error counts', async () => {
    const { encrypt } = require('../src/utils/encryption');

    // One good account, one that will fail (corrupt encrypted data)
    db.accounts.findAll.mockReturnValue([
      {
        id: 1,
        password: encrypt('good-pass', oldKey),
        shared_secret: null,
        identity_secret: null,
        revocation_code: null,
      },
      {
        id: 2,
        password: '$ENC$corrupted:data',
        shared_secret: null,
        identity_secret: null,
        revocation_code: null,
      },
    ]);
    db.mafiles.findAll.mockReturnValue([]);
    db.settings.get.mockReturnValue(null);

    const result = await reEncryptAllData(oldKey, newKey);

    expect(result.success).toBe(1);
    expect(result.errors).toBe(1);
  });

  test('updates the cached encryption key to the new key', async () => {
    db.accounts.findAll.mockReturnValue([]);
    db.mafiles.findAll.mockReturnValue([]);
    db.settings.get.mockReturnValue(null);

    await reEncryptAllData(oldKey, newKey);

    expect(getEncryptionKey()).toBe(newKey);
  });

  test('handles accounts with plaintext fields (first-time encryption)', async () => {
    db.accounts.findAll.mockReturnValue([
      {
        id: 1,
        password: 'plaintext-password',
        shared_secret: 'plaintext-secret',
        identity_secret: null,
        revocation_code: null,
      },
    ]);
    db.mafiles.findAll.mockReturnValue([]);
    db.settings.get.mockReturnValue(null);

    const result = await reEncryptAllData(oldKey, newKey);

    expect(result.success).toBe(1);
    expect(result.errors).toBe(0);

    const [, updates] = db.accounts.update.mock.calls[0];
    expect(isEncrypted(updates.password)).toBe(true);
    expect(isEncrypted(updates.shared_secret)).toBe(true);

    // Plaintext fields get encrypted with the new key
    const { decrypt } = require('../src/utils/encryption');
    expect(decrypt(updates.password, newKey)).toBe('plaintext-password');
    expect(decrypt(updates.shared_secret, newKey)).toBe('plaintext-secret');
  });
});
