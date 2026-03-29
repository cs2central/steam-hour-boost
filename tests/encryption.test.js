const {
  generateSalt,
  deriveKey,
  deriveKeySync,
  encrypt,
  decrypt,
  isEncrypted,
  encryptFields,
  decryptFields,
  reEncrypt,
  ENCRYPTED_PREFIX,
} = require('../src/utils/encryption');

// ---------------------------------------------------------------------------
// Shared test keys
// ---------------------------------------------------------------------------
const salt = generateSalt();
const key = deriveKeySync('test-password', salt);
const key2 = deriveKeySync('other-password', salt);

// ---------------------------------------------------------------------------
// generateSalt()
// ---------------------------------------------------------------------------
describe('generateSalt', () => {
  test('returns a base64 string', () => {
    const s = generateSalt();
    expect(typeof s).toBe('string');
    // Valid base64 re-encodes to the same value
    expect(Buffer.from(s, 'base64').toString('base64')).toBe(s);
  });

  test('different calls produce different salts', () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).not.toBe(b);
  });

  test('salt decodes to 32 bytes', () => {
    const s = generateSalt();
    const buf = Buffer.from(s, 'base64');
    expect(buf.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// deriveKey(password, salt)
// ---------------------------------------------------------------------------
describe('deriveKey', () => {
  test('returns a 32-byte Buffer', async () => {
    const k = await deriveKey('password', salt);
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(32);
  });

  test('same password and salt produces the same key (deterministic)', async () => {
    const k1 = await deriveKey('password', salt);
    const k2 = await deriveKey('password', salt);
    expect(k1.equals(k2)).toBe(true);
  });

  test('different passwords produce different keys', async () => {
    const k1 = await deriveKey('password-a', salt);
    const k2 = await deriveKey('password-b', salt);
    expect(k1.equals(k2)).toBe(false);
  });

  test('different salts produce different keys', async () => {
    const salt2 = generateSalt();
    const k1 = await deriveKey('password', salt);
    const k2 = await deriveKey('password', salt2);
    expect(k1.equals(k2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveKeySync(password, salt)
// ---------------------------------------------------------------------------
describe('deriveKeySync', () => {
  test('returns same key as async deriveKey', async () => {
    const syncKey = deriveKeySync('my-password', salt);
    const asyncKey = await deriveKey('my-password', salt);
    expect(syncKey.equals(asyncKey)).toBe(true);
  });

  test('returns a 32-byte Buffer', () => {
    const k = deriveKeySync('password', salt);
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// encrypt(plaintext, key)
// ---------------------------------------------------------------------------
describe('encrypt', () => {
  test('returns string starting with "$ENC$"', () => {
    const result = encrypt('hello', key);
    expect(result.startsWith(ENCRYPTED_PREFIX)).toBe(true);
  });

  test('returns format "$ENC$<iv>:<authTag>:<ciphertext>"', () => {
    const result = encrypt('hello', key);
    const withoutPrefix = result.slice(ENCRYPTED_PREFIX.length);
    const parts = withoutPrefix.split(':');
    expect(parts).toHaveLength(3);
    // Each part should be valid base64
    for (const part of parts) {
      expect(Buffer.from(part, 'base64').toString('base64')).toBe(part);
    }
  });

  test('returns null unchanged for falsy input', () => {
    expect(encrypt(null, key)).toBeNull();
  });

  test('returns undefined unchanged for falsy input', () => {
    expect(encrypt(undefined, key)).toBeUndefined();
  });

  test('returns empty string unchanged (falsy)', () => {
    expect(encrypt('', key)).toBe('');
  });

  test('throws on invalid key length (not 32 bytes)', () => {
    const shortKey = Buffer.alloc(16, 0);
    expect(() => encrypt('hello', shortKey)).toThrow('Invalid encryption key');
  });

  test('throws when key is null', () => {
    expect(() => encrypt('hello', null)).toThrow('Invalid encryption key');
  });

  test('different encrypt calls produce different ciphertext (random IV)', () => {
    const a = encrypt('same-text', key);
    const b = encrypt('same-text', key);
    expect(a).not.toBe(b);
  });

  test('handles unicode content', () => {
    const unicode = 'Hello \u{1F30D} \u00E9\u00E8\u00EA \u4F60\u597D \u043F\u0440\u0438\u0432\u0435\u0442';
    const encrypted = encrypt(unicode, key);
    expect(encrypted.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    // Verify round-trip preserves unicode
    expect(decrypt(encrypted, key)).toBe(unicode);
  });
});

// ---------------------------------------------------------------------------
// decrypt(encryptedText, key)
// ---------------------------------------------------------------------------
describe('decrypt', () => {
  test('correctly decrypts an encrypted string', () => {
    const encrypted = encrypt('secret message', key);
    expect(decrypt(encrypted, key)).toBe('secret message');
  });

  test('round-trip: decrypt(encrypt(text)) === text', () => {
    const texts = [
      'simple',
      'with spaces and punctuation!@#$%',
      'multi\nline\ntext',
      'a'.repeat(10000),
      '\t\r\n',
    ];
    for (const text of texts) {
      expect(decrypt(encrypt(text, key), key)).toBe(text);
    }
  });

  test('returns non-encrypted strings unchanged (no $ENC$ prefix)', () => {
    expect(decrypt('plain text', key)).toBe('plain text');
  });

  test('returns null unchanged for falsy input', () => {
    expect(decrypt(null, key)).toBeNull();
  });

  test('returns undefined unchanged for falsy input', () => {
    expect(decrypt(undefined, key)).toBeUndefined();
  });

  test('throws on wrong key (auth tag mismatch)', () => {
    const encrypted = encrypt('secret', key);
    expect(() => decrypt(encrypted, key2)).toThrow();
  });

  test('throws on corrupted data (wrong format)', () => {
    // Only two parts instead of three
    const bad = `${ENCRYPTED_PREFIX}abc:def`;
    expect(() => decrypt(bad, key)).toThrow('Invalid encrypted data format');
  });

  test('throws on invalid key length', () => {
    const encrypted = encrypt('hello', key);
    const shortKey = Buffer.alloc(8, 0);
    expect(() => decrypt(encrypted, shortKey)).toThrow('Invalid encryption key');
  });
});

// ---------------------------------------------------------------------------
// isEncrypted(text)
// ---------------------------------------------------------------------------
describe('isEncrypted', () => {
  test('returns true for strings starting with "$ENC$"', () => {
    expect(isEncrypted('$ENC$abc:def:ghi')).toBe(true);
    expect(isEncrypted(encrypt('test', key))).toBe(true);
  });

  test('returns false for plain text', () => {
    expect(isEncrypted('hello world')).toBe(false);
    expect(isEncrypted('not encrypted')).toBe(false);
  });

  test('returns false for null/undefined/non-string', () => {
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(12345)).toBe(false);
    expect(isEncrypted({})).toBe(false);
    expect(isEncrypted(true)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isEncrypted('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// encryptFields(data, fields, key)
// ---------------------------------------------------------------------------
describe('encryptFields', () => {
  test('encrypts only specified fields', () => {
    const data = { username: 'alice', password: 'secret', token: 'abc123' };
    const result = encryptFields(data, ['password', 'token'], key);

    expect(isEncrypted(result.password)).toBe(true);
    expect(isEncrypted(result.token)).toBe(true);
    expect(result.username).toBe('alice');
  });

  test('leaves other fields unchanged', () => {
    const data = { a: 'keep', b: 'encrypt-me', c: 42, d: null };
    const result = encryptFields(data, ['b'], key);

    expect(result.a).toBe('keep');
    expect(result.c).toBe(42);
    expect(result.d).toBeNull();
    expect(isEncrypted(result.b)).toBe(true);
  });

  test('does not double-encrypt already encrypted fields', () => {
    const data = { secret: encrypt('hello', key) };
    const result = encryptFields(data, ['secret'], key);

    // Should still be decryptable in one pass
    expect(decrypt(result.secret, key)).toBe('hello');
  });

  test('handles missing fields gracefully', () => {
    const data = { a: 'value' };
    const result = encryptFields(data, ['nonexistent', 'alsoMissing'], key);

    expect(result.a).toBe('value');
    expect(result.nonexistent).toBeUndefined();
    expect(result.alsoMissing).toBeUndefined();
  });

  test('does not mutate the original object', () => {
    const data = { password: 'secret' };
    encryptFields(data, ['password'], key);
    expect(data.password).toBe('secret');
  });
});

// ---------------------------------------------------------------------------
// decryptFields(data, fields, key)
// ---------------------------------------------------------------------------
describe('decryptFields', () => {
  test('decrypts only specified encrypted fields', () => {
    const data = {
      username: 'alice',
      password: encrypt('secret', key),
      token: encrypt('abc123', key),
    };
    const result = decryptFields(data, ['password', 'token'], key);

    expect(result.password).toBe('secret');
    expect(result.token).toBe('abc123');
    expect(result.username).toBe('alice');
  });

  test('leaves non-encrypted fields unchanged', () => {
    const data = { plain: 'not-encrypted', num: 99 };
    const result = decryptFields(data, ['plain', 'num'], key);

    expect(result.plain).toBe('not-encrypted');
    expect(result.num).toBe(99);
  });

  test('handles missing fields gracefully', () => {
    const data = { a: 'value' };
    const result = decryptFields(data, ['nonexistent'], key);

    expect(result.a).toBe('value');
    expect(result.nonexistent).toBeUndefined();
  });

  test('does not mutate the original object', () => {
    const encrypted = encrypt('secret', key);
    const data = { password: encrypted };
    decryptFields(data, ['password'], key);
    expect(data.password).toBe(encrypted);
  });
});

// ---------------------------------------------------------------------------
// reEncrypt(encryptedText, oldKey, newKey)
// ---------------------------------------------------------------------------
describe('reEncrypt', () => {
  test('re-encrypted text can be decrypted with newKey', () => {
    const encrypted = encrypt('my data', key);
    const reEncrypted = reEncrypt(encrypted, key, key2);
    expect(decrypt(reEncrypted, key2)).toBe('my data');
  });

  test('re-encrypted text cannot be decrypted with oldKey', () => {
    const encrypted = encrypt('my data', key);
    const reEncrypted = reEncrypt(encrypted, key, key2);
    expect(() => decrypt(reEncrypted, key)).toThrow();
  });

  test('returns falsy input unchanged', () => {
    expect(reEncrypt(null, key, key2)).toBeNull();
    expect(reEncrypt(undefined, key, key2)).toBeUndefined();
    expect(reEncrypt('', key, key2)).toBe('');
  });
});
