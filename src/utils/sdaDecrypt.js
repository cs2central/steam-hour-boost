/**
 * SDA (Steam Desktop Authenticator) compatibility module.
 *
 * Reads and decrypts maFiles encrypted by jessecar96's SteamDesktopAuthenticator.
 * Encryption scheme: PBKDF2(SHA1, 50k iterations, 8-byte salt) -> AES-256-CBC (PKCS7).
 * Salt and IV are stored per-account in manifest.json.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SDA_PBKDF2_ITERATIONS = 50000;
const SDA_KEY_SIZE = 32; // 256 bits
const SDA_DIGEST = 'sha1'; // SDA uses Rfc2898DeriveBytes which defaults to SHA1

/**
 * Derive encryption key using SDA's scheme: PBKDF2-HMAC-SHA1, 50k iterations.
 * @param {string} passkey - The encryption passkey
 * @param {Buffer} salt - Salt bytes (from base64 in manifest)
 * @returns {Buffer} 32-byte derived key
 */
function deriveSDAKey(passkey, salt) {
  return crypto.pbkdf2Sync(passkey, salt, SDA_PBKDF2_ITERATIONS, SDA_KEY_SIZE, SDA_DIGEST);
}

/**
 * Decrypt data encrypted by SDA's FileEncryptor.
 * @param {string} passkey - The encryption passkey
 * @param {string} saltB64 - Base64-encoded 8-byte salt from manifest entry
 * @param {string} ivB64 - Base64-encoded 16-byte IV from manifest entry
 * @param {string} encryptedB64 - Base64-encoded ciphertext (the .maFile contents)
 * @returns {string|null} Decrypted JSON string, or null if passkey is invalid
 */
function decryptSDAData(passkey, saltB64, ivB64, encryptedB64) {
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const ciphertext = Buffer.from(encryptedB64, 'base64');
    const key = deriveSDAKey(passkey, salt);

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    // PKCS7 padding is handled automatically by Node.js (setAutoPadding true by default)
    let plaintext = decipher.update(ciphertext, null, 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  } catch (err) {
    return null;
  }
}

/**
 * Read and parse an SDA manifest.json file.
 * @param {string} folderPath - Path to the SDA maFiles directory
 * @returns {object|null} Parsed manifest or null if not found/invalid
 */
function readSDAManifest(folderPath) {
  const manifestPath = path.join(folderPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    const data = JSON.parse(content);

    // Validate it looks like an SDA manifest (has entries array)
    if (!data.entries || !Array.isArray(data.entries)) {
      return null;
    }

    return data;
  } catch (err) {
    return null;
  }
}

/**
 * Check if a folder contains SDA-format maFiles (has manifest.json with entries).
 * @param {string} folderPath - Path to check
 * @returns {boolean}
 */
function isSDAFolder(folderPath) {
  const manifest = readSDAManifest(folderPath);
  return manifest !== null;
}

/**
 * Verify an SDA passkey by attempting to decrypt the first account.
 * @param {string} folderPath - Path to the SDA maFiles directory
 * @param {string} passkey - Passkey to verify
 * @returns {boolean} True if passkey is valid (or not needed)
 */
function verifySDAPasskey(folderPath, passkey) {
  const manifest = readSDAManifest(folderPath);
  if (!manifest || !manifest.encrypted) {
    return true; // Not encrypted
  }

  const entries = manifest.entries || [];
  if (entries.length === 0) {
    return true;
  }

  const entry = entries[0];
  if (!entry.encryption_salt || !entry.encryption_iv || !entry.filename) {
    return false;
  }

  const filePath = path.join(folderPath, entry.filename);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const encrypted = fs.readFileSync(filePath, 'utf8').trim();
    const result = decryptSDAData(passkey, entry.encryption_salt, entry.encryption_iv, encrypted);
    if (result === null) return false;
    JSON.parse(result); // Verify it's valid JSON
    return true;
  } catch {
    return false;
  }
}

/**
 * Import all accounts from an SDA maFiles folder.
 * @param {string} folderPath - Path to the SDA maFiles directory
 * @param {string|null} passkey - Encryption passkey (required if encrypted)
 * @returns {{accounts: object[], errors: string[]}}
 */
function importSDAAccounts(folderPath, passkey = null) {
  const manifest = readSDAManifest(folderPath);
  const accounts = [];
  const errors = [];

  if (!manifest) {
    errors.push('No valid SDA manifest.json found');
    return { accounts, errors };
  }

  const isEncrypted = manifest.encrypted || false;
  if (isEncrypted && !passkey) {
    errors.push('Manifest is encrypted but no passkey provided');
    return { accounts, errors };
  }

  const entries = manifest.entries || [];
  if (entries.length === 0) {
    errors.push('No account entries in manifest');
    return { accounts, errors };
  }

  for (const entry of entries) {
    const filename = entry.filename || '';
    const salt = entry.encryption_salt;
    const iv = entry.encryption_iv;

    const filePath = path.join(folderPath, filename);
    if (!fs.existsSync(filePath)) {
      errors.push(`File not found: ${filename}`);
      continue;
    }

    try {
      let fileContent = fs.readFileSync(filePath, 'utf8').trim();

      if (isEncrypted) {
        if (!salt || !iv) {
          errors.push(`Missing salt/IV for ${filename}`);
          continue;
        }
        const decrypted = decryptSDAData(passkey, salt, iv, fileContent);
        if (decrypted === null) {
          errors.push(`Failed to decrypt ${filename} (bad passkey?)`);
          continue;
        }
        fileContent = decrypted;
      }

      const accountData = JSON.parse(fileContent);
      accounts.push(accountData);
    } catch (err) {
      errors.push(`Error reading ${filename}: ${err.message}`);
    }
  }

  return { accounts, errors };
}

/**
 * Encrypt data using SDA's FileEncryptor scheme (AES-256-CBC, PKCS7).
 * @param {string} passkey - The encryption passkey
 * @param {string} saltB64 - Base64-encoded 8-byte salt
 * @param {string} ivB64 - Base64-encoded 16-byte IV
 * @param {string} plaintext - The JSON string to encrypt
 * @returns {string} Base64-encoded ciphertext
 */
function encryptSDAData(passkey, saltB64, ivB64, plaintext) {
  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const key = deriveSDAKey(passkey, salt);

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  // PKCS7 padding is handled automatically by Node.js
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  return encrypted.toString('base64');
}

/**
 * Generate a random 8-byte salt as base64.
 * @returns {string}
 */
function generateSDASalt() {
  return crypto.randomBytes(8).toString('base64');
}

/**
 * Generate a random 16-byte IV as base64.
 * @returns {string}
 */
function generateSDAIV() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Export accounts as SDA-compatible manifest + encrypted/plain .maFile data.
 * @param {object[]} accounts - Array of account objects
 * @param {string|null} passkey - If provided, encrypt files with this passkey
 * @returns {{manifest: object, files: Object<string, string>}}
 */
function exportSDAAccounts(accounts, passkey = null) {
  const isEncrypted = passkey !== null && passkey.length > 0;
  const entries = [];
  const files = {};

  for (const accountData of accounts) {
    const steamid = String(accountData.steamid || accountData.account_name || 'unknown');
    const filename = `${steamid}.maFile`;
    const plaintext = JSON.stringify(accountData, null, 2);

    if (isEncrypted) {
      const saltB64 = generateSDASalt();
      const ivB64 = generateSDAIV();
      const encrypted = encryptSDAData(passkey, saltB64, ivB64, plaintext);
      files[filename] = encrypted;
      entries.push({
        encryption_iv: ivB64,
        encryption_salt: saltB64,
        filename,
        steamid: /^\d+$/.test(steamid) ? parseInt(steamid) : 0
      });
    } else {
      files[filename] = plaintext;
      entries.push({
        encryption_iv: null,
        encryption_salt: null,
        filename,
        steamid: /^\d+$/.test(steamid) ? parseInt(steamid) : 0
      });
    }
  }

  const manifest = {
    encrypted: isEncrypted,
    first_run: true,
    entries,
    periodic_checking: false,
    periodic_checking_interval: 5,
    periodic_checking_checkall: false,
    auto_confirm_market_transactions: false,
    auto_confirm_trades: false
  };

  return { manifest, files };
}

module.exports = {
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
};
