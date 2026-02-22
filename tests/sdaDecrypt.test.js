const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  deriveSDAKey,
  decryptSDAData,
  encryptSDAData,
  generateSDASalt,
  generateSDAIV,
  exportSDAAccounts,
  readSDAManifest,
  isSDAFolder,
  verifySDAPasskey,
  importSDAAccounts
} = require('../src/utils/sdaDecrypt');

// ─── deriveSDAKey ────────────────────────────────────────────

describe('deriveSDAKey', () => {
  test('returns a 32-byte buffer', () => {
    const salt = crypto.randomBytes(8);
    const key = deriveSDAKey('testpassword', salt);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  test('same passkey + salt produces same key (deterministic)', () => {
    const salt = Buffer.from('AAAAAAAAAAA=', 'base64');
    const key1 = deriveSDAKey('mypasskey', salt);
    const key2 = deriveSDAKey('mypasskey', salt);
    expect(key1.equals(key2)).toBe(true);
  });

  test('different passkeys produce different keys', () => {
    const salt = crypto.randomBytes(8);
    const key1 = deriveSDAKey('password1', salt);
    const key2 = deriveSDAKey('password2', salt);
    expect(key1.equals(key2)).toBe(false);
  });

  test('different salts produce different keys', () => {
    const salt1 = Buffer.alloc(8, 0);
    const salt2 = Buffer.alloc(8, 1);
    const key1 = deriveSDAKey('samepassword', salt1);
    const key2 = deriveSDAKey('samepassword', salt2);
    expect(key1.equals(key2)).toBe(false);
  });
});

// ─── encrypt / decrypt round-trip ────────────────────────────

describe('encryptSDAData / decryptSDAData round-trip', () => {
  test('decrypt(encrypt(plaintext)) === plaintext', () => {
    const passkey = 'test-passkey-123';
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const plaintext = JSON.stringify({ shared_secret: 'abc123', account_name: 'testuser' });

    const encrypted = encryptSDAData(passkey, saltB64, ivB64, plaintext);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toBe(plaintext);

    const decrypted = decryptSDAData(passkey, saltB64, ivB64, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test('encrypts to valid base64', () => {
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const encrypted = encryptSDAData('pass', saltB64, ivB64, 'hello world');
    expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
    // Verify it's not empty
    expect(Buffer.from(encrypted, 'base64').length).toBeGreaterThan(0);
  });

  test('handles unicode content', () => {
    const passkey = 'unicode-test';
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const plaintext = '{"account_name": "тестuser", "shared_secret": "日本語"}';

    const encrypted = encryptSDAData(passkey, saltB64, ivB64, plaintext);
    const decrypted = decryptSDAData(passkey, saltB64, ivB64, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test('handles large payloads', () => {
    const passkey = 'bigdata';
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const plaintext = JSON.stringify({ data: 'x'.repeat(100000) });

    const encrypted = encryptSDAData(passkey, saltB64, ivB64, plaintext);
    const decrypted = decryptSDAData(passkey, saltB64, ivB64, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test('handles empty string', () => {
    const passkey = 'emptytest';
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();

    const encrypted = encryptSDAData(passkey, saltB64, ivB64, '');
    const decrypted = decryptSDAData(passkey, saltB64, ivB64, encrypted);
    expect(decrypted).toBe('');
  });
});

// ─── decryptSDAData failure cases ────────────────────────────

describe('decryptSDAData failure cases', () => {
  test('returns null for wrong passkey', () => {
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const encrypted = encryptSDAData('correct-password', saltB64, ivB64, '{"test": true}');

    const result = decryptSDAData('wrong-password', saltB64, ivB64, encrypted);
    expect(result).toBeNull();
  });

  test('returns null for wrong salt', () => {
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const encrypted = encryptSDAData('password', saltB64, ivB64, '{"test": true}');

    const wrongSalt = generateSDASalt();
    const result = decryptSDAData('password', wrongSalt, ivB64, encrypted);
    expect(result).toBeNull();
  });

  test('returns null for wrong IV', () => {
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const encrypted = encryptSDAData('password', saltB64, ivB64, '{"test": true}');

    const wrongIV = generateSDAIV();
    const result = decryptSDAData('password', saltB64, wrongIV, encrypted);
    expect(result).toBeNull();
  });

  test('returns null for corrupted ciphertext', () => {
    const result = decryptSDAData('password', generateSDASalt(), generateSDAIV(), 'not-valid-base64!!!');
    expect(result).toBeNull();
  });

  test('returns null for truncated ciphertext', () => {
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const encrypted = encryptSDAData('password', saltB64, ivB64, '{"test": true}');

    // Truncate the ciphertext
    const truncated = encrypted.substring(0, encrypted.length / 2);
    const result = decryptSDAData('password', saltB64, ivB64, truncated);
    expect(result).toBeNull();
  });
});

// ─── generateSDASalt / generateSDAIV ─────────────────────────

describe('generateSDASalt', () => {
  test('returns base64 string', () => {
    const salt = generateSDASalt();
    expect(typeof salt).toBe('string');
    expect(Buffer.from(salt, 'base64').length).toBe(8);
  });

  test('generates unique values', () => {
    const salts = new Set();
    for (let i = 0; i < 50; i++) {
      salts.add(generateSDASalt());
    }
    expect(salts.size).toBe(50);
  });
});

describe('generateSDAIV', () => {
  test('returns base64 string with 16-byte value', () => {
    const iv = generateSDAIV();
    expect(typeof iv).toBe('string');
    expect(Buffer.from(iv, 'base64').length).toBe(16);
  });

  test('generates unique values', () => {
    const ivs = new Set();
    for (let i = 0; i < 50; i++) {
      ivs.add(generateSDAIV());
    }
    expect(ivs.size).toBe(50);
  });
});

// ─── readSDAManifest / isSDAFolder ───────────────────────────

describe('readSDAManifest / isSDAFolder', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sda-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns null for missing manifest', () => {
    expect(readSDAManifest(tmpDir)).toBeNull();
    expect(isSDAFolder(tmpDir)).toBe(false);
  });

  test('returns null for invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), 'not json');
    expect(readSDAManifest(tmpDir)).toBeNull();
    expect(isSDAFolder(tmpDir)).toBe(false);
  });

  test('returns null for manifest without entries array', () => {
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({ encrypted: false }));
    expect(readSDAManifest(tmpDir)).toBeNull();
    expect(isSDAFolder(tmpDir)).toBe(false);
  });

  test('parses valid SDA manifest', () => {
    const manifest = {
      encrypted: false,
      entries: [
        { filename: '76561198012345678.maFile', steamid: 76561198012345678, encryption_salt: null, encryption_iv: null }
      ]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));

    const result = readSDAManifest(tmpDir);
    expect(result).not.toBeNull();
    expect(result.entries).toHaveLength(1);
    expect(result.encrypted).toBe(false);
    expect(isSDAFolder(tmpDir)).toBe(true);
  });

  test('parses encrypted SDA manifest', () => {
    const manifest = {
      encrypted: true,
      entries: [
        { filename: 'test.maFile', steamid: 123, encryption_salt: 'AAAA', encryption_iv: 'BBBB' }
      ]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));

    const result = readSDAManifest(tmpDir);
    expect(result.encrypted).toBe(true);
    expect(result.entries[0].encryption_salt).toBe('AAAA');
  });
});

// ─── verifySDAPasskey ────────────────────────────────────────

describe('verifySDAPasskey', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sda-verify-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns true for unencrypted manifest', () => {
    const manifest = { encrypted: false, entries: [{ filename: 'test.maFile' }] };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    expect(verifySDAPasskey(tmpDir, 'anything')).toBe(true);
  });

  test('returns true for no manifest', () => {
    expect(verifySDAPasskey(tmpDir, 'anything')).toBe(true);
  });

  test('returns true for correct passkey on encrypted files', () => {
    const passkey = 'correctpasskey';
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const plaintext = JSON.stringify({ account_name: 'test', shared_secret: 'abc' });
    const encrypted = encryptSDAData(passkey, saltB64, ivB64, plaintext);

    const manifest = {
      encrypted: true,
      entries: [{ filename: 'test.maFile', encryption_salt: saltB64, encryption_iv: ivB64, steamid: 123 }]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'test.maFile'), encrypted);

    expect(verifySDAPasskey(tmpDir, passkey)).toBe(true);
  });

  test('returns false for wrong passkey on encrypted files', () => {
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const plaintext = JSON.stringify({ account_name: 'test', shared_secret: 'abc' });
    const encrypted = encryptSDAData('correct', saltB64, ivB64, plaintext);

    const manifest = {
      encrypted: true,
      entries: [{ filename: 'test.maFile', encryption_salt: saltB64, encryption_iv: ivB64 }]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'test.maFile'), encrypted);

    expect(verifySDAPasskey(tmpDir, 'wrong')).toBe(false);
  });

  test('returns false when encrypted file is missing', () => {
    const manifest = {
      encrypted: true,
      entries: [{ filename: 'missing.maFile', encryption_salt: 'AAAA', encryption_iv: 'BBBB' }]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    expect(verifySDAPasskey(tmpDir, 'pass')).toBe(false);
  });
});

// ─── importSDAAccounts ───────────────────────────────────────

describe('importSDAAccounts', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sda-import-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns error when no manifest found', () => {
    const result = importSDAAccounts(tmpDir);
    expect(result.accounts).toHaveLength(0);
    expect(result.errors).toContain('No valid SDA manifest.json found');
  });

  test('returns error when encrypted but no passkey', () => {
    const manifest = { encrypted: true, entries: [{ filename: 'test.maFile' }] };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));

    const result = importSDAAccounts(tmpDir);
    expect(result.accounts).toHaveLength(0);
    expect(result.errors).toContain('Manifest is encrypted but no passkey provided');
  });

  test('returns error for empty entries', () => {
    const manifest = { encrypted: false, entries: [] };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));

    const result = importSDAAccounts(tmpDir);
    expect(result.accounts).toHaveLength(0);
    expect(result.errors).toContain('No account entries in manifest');
  });

  test('imports unencrypted accounts', () => {
    const account1 = { account_name: 'user1', shared_secret: 'secret1', identity_secret: 'id1' };
    const account2 = { account_name: 'user2', shared_secret: 'secret2', identity_secret: 'id2' };

    const manifest = {
      encrypted: false,
      entries: [
        { filename: 'user1.maFile', steamid: 111, encryption_salt: null, encryption_iv: null },
        { filename: 'user2.maFile', steamid: 222, encryption_salt: null, encryption_iv: null }
      ]
    };

    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'user1.maFile'), JSON.stringify(account1));
    fs.writeFileSync(path.join(tmpDir, 'user2.maFile'), JSON.stringify(account2));

    const result = importSDAAccounts(tmpDir);
    expect(result.accounts).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.accounts[0].account_name).toBe('user1');
    expect(result.accounts[1].account_name).toBe('user2');
  });

  test('imports encrypted accounts with correct passkey', () => {
    const passkey = 'mypasskey';
    const account = { account_name: 'encrypted_user', shared_secret: 'enc_secret' };

    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const encrypted = encryptSDAData(passkey, saltB64, ivB64, JSON.stringify(account));

    const manifest = {
      encrypted: true,
      entries: [{ filename: 'enc.maFile', encryption_salt: saltB64, encryption_iv: ivB64, steamid: 333 }]
    };

    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'enc.maFile'), encrypted);

    const result = importSDAAccounts(tmpDir, passkey);
    expect(result.accounts).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.accounts[0].account_name).toBe('encrypted_user');
    expect(result.accounts[0].shared_secret).toBe('enc_secret');
  });

  test('reports error for missing files', () => {
    const manifest = {
      encrypted: false,
      entries: [{ filename: 'missing.maFile', steamid: 444 }]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));

    const result = importSDAAccounts(tmpDir);
    expect(result.accounts).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('File not found');
  });

  test('reports error for bad passkey on encrypted files', () => {
    const saltB64 = generateSDASalt();
    const ivB64 = generateSDAIV();
    const encrypted = encryptSDAData('correct', saltB64, ivB64, '{"account_name":"x"}');

    const manifest = {
      encrypted: true,
      entries: [{ filename: 'bad.maFile', encryption_salt: saltB64, encryption_iv: ivB64 }]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'bad.maFile'), encrypted);

    const result = importSDAAccounts(tmpDir, 'wrong');
    expect(result.accounts).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('decrypt');
  });

  test('reports error for missing salt/IV on encrypted entries', () => {
    const manifest = {
      encrypted: true,
      entries: [{ filename: 'nosalt.maFile', encryption_salt: null, encryption_iv: null }]
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'nosalt.maFile'), 'encrypted-content');

    const result = importSDAAccounts(tmpDir, 'pass');
    expect(result.accounts).toHaveLength(0);
    expect(result.errors[0]).toContain('Missing salt/IV');
  });

  test('handles mix of valid and invalid files', () => {
    const account = { account_name: 'good', shared_secret: 's1' };
    const manifest = {
      encrypted: false,
      entries: [
        { filename: 'good.maFile', steamid: 1 },
        { filename: 'missing.maFile', steamid: 2 },
        { filename: 'bad.maFile', steamid: 3 }
      ]
    };

    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'good.maFile'), JSON.stringify(account));
    fs.writeFileSync(path.join(tmpDir, 'bad.maFile'), 'not valid json');

    const result = importSDAAccounts(tmpDir);
    expect(result.accounts).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
    expect(result.accounts[0].account_name).toBe('good');
  });
});

// ─── exportSDAAccounts ───────────────────────────────────────

describe('exportSDAAccounts', () => {
  const sampleAccounts = [
    { account_name: 'user1', shared_secret: 'ss1', steamid: '76561198000000001' },
    { account_name: 'user2', shared_secret: 'ss2', steamid: '76561198000000002' }
  ];

  test('exports unencrypted accounts (no passkey)', () => {
    const { manifest, files } = exportSDAAccounts(sampleAccounts);

    // Manifest checks
    expect(manifest.encrypted).toBe(false);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0].encryption_salt).toBeNull();
    expect(manifest.entries[0].encryption_iv).toBeNull();
    expect(manifest.entries[0].filename).toBe('76561198000000001.maFile');

    // File checks — plaintext JSON
    expect(Object.keys(files)).toHaveLength(2);
    const parsed = JSON.parse(files['76561198000000001.maFile']);
    expect(parsed.account_name).toBe('user1');
    expect(parsed.shared_secret).toBe('ss1');
  });

  test('exports encrypted accounts with passkey', () => {
    const passkey = 'export-passkey';
    const { manifest, files } = exportSDAAccounts(sampleAccounts, passkey);

    // Manifest checks
    expect(manifest.encrypted).toBe(true);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0].encryption_salt).toBeTruthy();
    expect(manifest.entries[0].encryption_iv).toBeTruthy();

    // File should NOT be valid JSON (it's encrypted base64)
    const fileContent = files['76561198000000001.maFile'];
    expect(() => JSON.parse(fileContent)).toThrow();

    // Should be decryptable
    const entry = manifest.entries[0];
    const decrypted = decryptSDAData(passkey, entry.encryption_salt, entry.encryption_iv, fileContent);
    expect(decrypted).not.toBeNull();
    const parsed = JSON.parse(decrypted);
    expect(parsed.account_name).toBe('user1');
  });

  test('manifest has all expected SDA fields', () => {
    const { manifest } = exportSDAAccounts(sampleAccounts);
    expect(manifest).toHaveProperty('encrypted');
    expect(manifest).toHaveProperty('first_run');
    expect(manifest).toHaveProperty('entries');
    expect(manifest).toHaveProperty('periodic_checking');
    expect(manifest).toHaveProperty('periodic_checking_interval');
    expect(manifest).toHaveProperty('periodic_checking_checkall');
    expect(manifest).toHaveProperty('auto_confirm_market_transactions');
    expect(manifest).toHaveProperty('auto_confirm_trades');
  });

  test('uses account_name as filename when steamid is missing', () => {
    const accounts = [{ account_name: 'nosteamid', shared_secret: 'ss' }];
    const { manifest, files } = exportSDAAccounts(accounts);

    expect(manifest.entries[0].filename).toBe('nosteamid.maFile');
    expect(files['nosteamid.maFile']).toBeDefined();
  });

  test('each encrypted entry gets unique salt and IV', () => {
    const { manifest } = exportSDAAccounts(sampleAccounts, 'pass');
    const salts = manifest.entries.map(e => e.encryption_salt);
    const ivs = manifest.entries.map(e => e.encryption_iv);

    expect(new Set(salts).size).toBe(2);
    expect(new Set(ivs).size).toBe(2);
  });

  test('empty passkey string exports unencrypted', () => {
    const { manifest } = exportSDAAccounts(sampleAccounts, '');
    expect(manifest.encrypted).toBe(false);
  });

  test('null passkey exports unencrypted', () => {
    const { manifest } = exportSDAAccounts(sampleAccounts, null);
    expect(manifest.encrypted).toBe(false);
  });
});

// ─── Full round-trip: export → import ────────────────────────

describe('full export → import round-trip', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sda-roundtrip-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('unencrypted: export then import recovers all accounts', () => {
    const accounts = [
      { account_name: 'alice', shared_secret: 'ss_alice', identity_secret: 'id_alice', steamid: '111' },
      { account_name: 'bob', shared_secret: 'ss_bob', identity_secret: 'id_bob', steamid: '222' }
    ];

    // Export
    const { manifest, files } = exportSDAAccounts(accounts);
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmpDir, filename), content);
    }

    // Import
    const result = importSDAAccounts(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0].account_name).toBe('alice');
    expect(result.accounts[0].shared_secret).toBe('ss_alice');
    expect(result.accounts[1].account_name).toBe('bob');
    expect(result.accounts[1].shared_secret).toBe('ss_bob');
  });

  test('encrypted: export then import with correct passkey recovers all accounts', () => {
    const passkey = 'roundtrip-passkey';
    const accounts = [
      { account_name: 'charlie', shared_secret: 'ss_charlie', steamid: '333' },
      { account_name: 'dave', shared_secret: 'ss_dave', steamid: '444' }
    ];

    // Export encrypted
    const { manifest, files } = exportSDAAccounts(accounts, passkey);
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmpDir, filename), content);
    }

    // Import with correct passkey
    const result = importSDAAccounts(tmpDir, passkey);
    expect(result.errors).toHaveLength(0);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0].account_name).toBe('charlie');
    expect(result.accounts[0].shared_secret).toBe('ss_charlie');
  });

  test('encrypted: import with wrong passkey fails gracefully', () => {
    const accounts = [{ account_name: 'eve', shared_secret: 'ss', steamid: '555' }];

    const { manifest, files } = exportSDAAccounts(accounts, 'correct');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmpDir, filename), content);
    }

    const result = importSDAAccounts(tmpDir, 'wrong');
    expect(result.accounts).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
