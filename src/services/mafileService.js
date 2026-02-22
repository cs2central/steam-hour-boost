const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const db = require('../models/database');
const config = require('../config');
const logger = require('./logger');
const { encryptAccountCredentials, decryptAccountCredentials } = require('../middleware/auth');
const { readSDAManifest, decryptSDAData, isSDAFolder, importSDAAccounts } = require('../utils/sdaDecrypt');

class MAFileService {
  constructor() {
    // No longer creates mafiles directory - secrets are stored encrypted in database only
  }

  /**
   * Parse a MAFile and extract relevant data
   */
  parseMAFile(content) {
    try {
      // Extract SteamID from raw content before JSON.parse to avoid precision loss
      // SteamIDs are 64-bit integers that JavaScript can't handle accurately
      let steamId = null;
      // Try various field names used by different MAFile formats
      const patterns = [
        /"SteamID"\s*:\s*(\d+)/,           // SteamDesktopAuthenticator format
        /"steamid"\s*:\s*"?(\d+)"?/i,      // steam-authenticator-linux format (lowercase)
        /"steam_id"\s*:\s*"?(\d+)"?/       // Alternative format
      ];
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match) {
          steamId = match[1];
          break;
        }
      }

      const data = JSON.parse(content);

      // Normalize session data: handle both SDA PascalCase and lowercase formats
      let session = null;
      if (data.Session) {
        session = {
          access_token: data.Session.AccessToken || data.Session.access_token || null,
          refresh_token: data.Session.RefreshToken || data.Session.refresh_token || null,
          session_id: data.Session.SessionID || data.Session.session_id || null
        };
      } else if (data.session) {
        session = {
          access_token: data.session.access_token || null,
          refresh_token: data.session.refresh_token || null,
          session_id: data.session.session_id || null
        };
      }

      return {
        account_name: data.account_name,
        steam_id: steamId,
        shared_secret: data.shared_secret,
        identity_secret: data.identity_secret,
        device_id: data.device_id,
        serial_number: data.serial_number,
        token_gid: data.token_gid,
        revocation_code: data.revocation_code,
        uri: data.uri,
        server_time: data.server_time,
        session: session,
        Session: data.Session
      };
    } catch (err) {
      throw new Error(`Invalid MAFile format: ${err.message}`);
    }
  }

  /**
   * Import a single MAFile from content
   */
  importFromContent(content, originalFilename) {
    const parsed = this.parseMAFile(content);

    if (!parsed.account_name) {
      throw new Error('MAFile missing account_name');
    }

    // Check if already exists
    const existing = db.mafiles.findByAccountName(parsed.account_name);
    if (existing) {
      logger.warn(`MAFile for ${parsed.account_name} already exists, skipping`);
      return null;
    }

    // Encrypt secrets before storing in database
    const encryptedSecrets = encryptAccountCredentials({
      shared_secret: parsed.shared_secret,
      identity_secret: parsed.identity_secret
    });

    // Store metadata in database (no file written to disk)
    const result = db.mafiles.create({
      account_name: parsed.account_name,
      steam_id: parsed.steam_id,
      file_path: '',
      shared_secret: encryptedSecrets.shared_secret,
      identity_secret: encryptedSecrets.identity_secret
    });

    const mafileId = result.lastInsertRowid;
    logger.info(`Imported MAFile for ${parsed.account_name}`);

    // Auto-create account from MAFile data
    const account = this.autoCreateAccount(mafileId, parsed);

    return { id: mafileId, accountId: account?.id, ...parsed };
  }

  /**
   * Auto-create an account from MAFile data
   * Account will be incomplete (no password) until user sets it
   */
  autoCreateAccount(mafileId, parsed) {
    try {
      // Check if account already exists with this username
      const existing = db.accounts.findByUsername(parsed.account_name);
      if (existing) {
        logger.info(`Account ${parsed.account_name} already exists, linking MAFile and updating data`);
        db.mafiles.linkToAccount(mafileId, existing.id);

        // Update account with MAFile data (steam_id, secrets, device_id) if not already set
        const updateData = {};
        if (parsed.steam_id && !existing.steam_id) {
          updateData.steam_id = parsed.steam_id;
        }
        if (parsed.shared_secret) {
          updateData.shared_secret = parsed.shared_secret;
        }
        if (parsed.identity_secret) {
          updateData.identity_secret = parsed.identity_secret;
        }
        if (parsed.device_id && !existing.device_id) {
          updateData.device_id = parsed.device_id;
        }
        if (parsed.revocation_code) {
          updateData.revocation_code = parsed.revocation_code;
        }

        if (Object.keys(updateData).length > 0) {
          // Encrypt if needed
          const encryptedData = encryptAccountCredentials(updateData);
          db.accounts.update(existing.id, encryptedData);
          logger.info(`Updated account ${parsed.account_name} with MAFile data`);

          // Trigger Steam API refresh if we now have steam_id
          if (parsed.steam_id) {
            this.refreshAccountData(existing.id, parsed.steam_id);
          }
        }

        return existing;
      }

      // Prepare account data - password is null (incomplete account)
      const accountData = {
        username: parsed.account_name,
        password: null, // User needs to set this
        shared_secret: parsed.shared_secret || null,
        identity_secret: parsed.identity_secret || null,
        steam_id: parsed.steam_id || null,
        device_id: parsed.device_id || null,
        revocation_code: parsed.revocation_code || null,
        display_name: null,
        persona_state: 1
      };

      // Encrypt secrets if available
      const encryptedData = encryptAccountCredentials(accountData);

      // Create account
      const accountResult = db.accounts.create(encryptedData);
      const accountId = accountResult.lastInsertRowid;

      // Set default games (CS2)
      db.games.setGames(accountId, config.defaultGames);

      // Link MAFile to the new account
      db.mafiles.linkToAccount(mafileId, accountId);

      logger.info(`Auto-created account for ${parsed.account_name} (password required)`, accountId);

      // Trigger Steam API refresh if we have steam_id
      if (parsed.steam_id) {
        this.refreshAccountData(accountId, parsed.steam_id);
      }

      return { id: accountId, username: parsed.account_name };
    } catch (err) {
      logger.error(`Failed to auto-create account for ${parsed.account_name}: ${err.message}`);
      return null;
    }
  }

  /**
   * Refresh account data from Steam API (async, non-blocking)
   */
  async refreshAccountData(accountId, steamId) {
    try {
      const steamApiService = require('./steamApiService');
      if (steamApiService.isConfigured()) {
        await steamApiService.refreshAccount(accountId, steamId);
        logger.info(`Refreshed Steam data for auto-created account ${accountId}`, accountId, 'API');
      }
    } catch (err) {
      // Non-fatal - account still created, just without Steam data
      logger.warn(`Could not refresh Steam data for account ${accountId}: ${err.message}`, accountId, 'API');
    }
  }

  /**
   * Import MAFiles from a folder.
   * Auto-detects SDA folders (with manifest.json) and handles encrypted imports.
   * @param {string} folderPath - Path to folder containing maFiles
   * @param {string|null} passkey - SDA encryption passkey (only needed for encrypted SDA folders)
   */
  importFromFolder(folderPath, passkey = null) {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder not found: ${folderPath}`);
    }

    // Auto-detect SDA folder format (has manifest.json with entries)
    if (isSDAFolder(folderPath)) {
      logger.info('Detected SDA folder format, using SDA import');
      return this.importFromSDAFolder(folderPath, passkey);
    }

    const files = fs.readdirSync(folderPath);
    const maFiles = files.filter(f => f.endsWith('.maFile') || f.endsWith('.mafile'));

    if (maFiles.length === 0) {
      throw new Error('No MAFiles found in folder');
    }

    const imported = [];
    const errors = [];

    for (const filename of maFiles) {
      try {
        const content = fs.readFileSync(path.join(folderPath, filename), 'utf8');
        const result = this.importFromContent(content, filename);
        if (result) {
          imported.push(result);
        }
      } catch (err) {
        logger.error(`Failed to import ${filename}: ${err.message}`);
        errors.push({ file: filename, error: err.message });
      }
    }

    return { imported, errors, count: imported.length };
  }

  /**
   * Import MAFiles from a ZIP file.
   * If the ZIP contains a manifest.json (SDA format), handles encrypted maFiles.
   * @param {Buffer} zipBuffer - ZIP file buffer
   * @param {string|null} passkey - SDA encryption passkey (only needed for encrypted SDA ZIPs)
   */
  importFromZip(zipBuffer, passkey = null) {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    // Check for SDA manifest.json in the ZIP
    const manifestEntry = entries.find(e =>
      !e.isDirectory && path.basename(e.entryName) === 'manifest.json'
    );

    if (manifestEntry) {
      try {
        const manifestContent = manifestEntry.getData().toString('utf8');
        const manifest = JSON.parse(manifestContent);
        if (manifest.entries && Array.isArray(manifest.entries)) {
          logger.info('Detected SDA manifest in ZIP, using SDA import');
          return this._importSDAFromZip(zip, entries, manifest, passkey);
        }
      } catch {
        // Not a valid SDA manifest, fall through to normal import
      }
    }

    const maFiles = entries.filter(e =>
      !e.isDirectory &&
      (e.entryName.endsWith('.maFile') || e.entryName.endsWith('.mafile'))
    );

    if (maFiles.length === 0) {
      throw new Error('No MAFiles found in ZIP');
    }

    const imported = [];
    const errors = [];

    for (const entry of maFiles) {
      try {
        const content = entry.getData().toString('utf8');
        const filename = path.basename(entry.entryName);
        const result = this.importFromContent(content, filename);
        if (result) {
          imported.push(result);
        }
      } catch (err) {
        logger.error(`Failed to import ${entry.entryName}: ${err.message}`);
        errors.push({ file: entry.entryName, error: err.message });
      }
    }

    return { imported, errors, count: imported.length };
  }

  /**
   * Import SDA-format maFiles from a ZIP using manifest.json for decryption params.
   * @private
   */
  _importSDAFromZip(zip, entries, manifest, passkey) {
    const isEncrypted = manifest.encrypted || false;
    if (isEncrypted && !passkey) {
      throw new Error('SDA archive is encrypted. Please provide the passkey.');
    }

    const imported = [];
    const errors = [];

    for (const manifestEntry of (manifest.entries || [])) {
      const filename = manifestEntry.filename;
      const salt = manifestEntry.encryption_salt;
      const iv = manifestEntry.encryption_iv;

      const zipEntry = entries.find(e =>
        !e.isDirectory && path.basename(e.entryName) === filename
      );

      if (!zipEntry) {
        errors.push({ file: filename, error: 'File not found in ZIP' });
        continue;
      }

      try {
        let content = zipEntry.getData().toString('utf8').trim();

        if (isEncrypted) {
          if (!salt || !iv) {
            errors.push({ file: filename, error: 'Missing encryption salt/IV in manifest' });
            continue;
          }
          const decrypted = decryptSDAData(passkey, salt, iv, content);
          if (decrypted === null) {
            errors.push({ file: filename, error: 'Decryption failed (bad passkey?)' });
            continue;
          }
          content = decrypted;
        }

        const result = this.importFromContent(content, filename);
        if (result) {
          imported.push(result);
        }
      } catch (err) {
        logger.error(`Failed to import SDA file ${filename}: ${err.message}`);
        errors.push({ file: filename, error: err.message });
      }
    }

    return { imported, errors, count: imported.length };
  }

  /**
   * Import MAFiles from an SDA (Steam Desktop Authenticator) folder.
   * Handles both encrypted and unencrypted SDA maFiles.
   * Reads manifest.json for per-account salt/IV, decrypts in memory (no plaintext to disk).
   */
  importFromSDAFolder(folderPath, passkey = null) {
    if (!isSDAFolder(folderPath)) {
      throw new Error('Not a valid SDA folder (no manifest.json with entries)');
    }

    const { accounts: sdaAccounts, errors: sdaErrors } = importSDAAccounts(folderPath, passkey);

    const imported = [];
    const errors = [...sdaErrors];

    for (const accountData of sdaAccounts) {
      try {
        // Convert the raw SDA account data to our format via parseMAFile
        const content = JSON.stringify(accountData);
        const result = this.importFromContent(content, `${accountData.account_name || 'unknown'}.maFile`);
        if (result) {
          imported.push(result);
        }
      } catch (err) {
        const name = accountData.account_name || 'unknown';
        logger.error(`Failed to import SDA account ${name}: ${err.message}`);
        errors.push({ file: `${name}.maFile`, error: err.message });
      }
    }

    return { imported, errors, count: imported.length };
  }

  /**
   * Check if a folder is an SDA-format maFiles folder.
   */
  isSDAFolder(folderPath) {
    return isSDAFolder(folderPath);
  }

  /**
   * Scan the steam-authenticator-linux shared data directory for new maFiles.
   * Imports any maFiles not already in the database.
   * Supports both plain JSON maFiles and steam-authenticator-linux manifest format.
   * @returns {{imported: object[], skipped: number, errors: string[]}}
   */
  syncFromAuthenticator() {
    const authenticatorDir = config.authenticatorDataDir;

    if (!fs.existsSync(authenticatorDir)) {
      return { imported: [], skipped: 0, errors: [] };
    }

    // Check for steam-authenticator-linux manifest.json format
    const manifestPath = path.join(authenticatorDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestContent);

        // steam-authenticator-linux stores accounts inline in manifest
        if (manifest.accounts && Array.isArray(manifest.accounts) && !manifest.entries) {
          if (manifest.encrypted) {
            logger.info('steam-authenticator-linux manifest is encrypted, skipping auto-sync');
            return { imported: [], skipped: 0, errors: ['Authenticator data is encrypted — import manually with passkey'] };
          }

          const imported = [];
          const errors = [];
          let skipped = 0;

          for (const accountData of manifest.accounts) {
            try {
              const content = JSON.stringify(accountData);
              const result = this.importFromContent(content, `${accountData.account_name || 'unknown'}.maFile`);
              if (result) {
                imported.push(result);
              } else {
                skipped++;
              }
            } catch (err) {
              if (err.message && err.message.includes('already exists')) {
                skipped++;
              } else {
                errors.push(err.message);
              }
            }
          }

          return { imported, skipped, errors };
        }

        // SDA-format manifest (has entries array) — requires passkey for encrypted
        if (manifest.entries && Array.isArray(manifest.entries)) {
          if (manifest.encrypted) {
            return { imported: [], skipped: 0, errors: ['SDA folder is encrypted — import manually with passkey'] };
          }
          const result = this.importFromSDAFolder(authenticatorDir);
          return { imported: result.imported, skipped: 0, errors: result.errors };
        }
      } catch {
        // Not a valid manifest, fall through to individual file scan
      }
    }

    // Fall back to scanning individual .maFile files
    try {
      const result = this.importFromFolder(authenticatorDir);
      return { imported: result.imported, skipped: 0, errors: result.errors || [] };
    } catch (err) {
      return { imported: [], skipped: 0, errors: [err.message] };
    }
  }

  /**
   * Get all stored MAFiles
   */
  getAll() {
    return db.mafiles.findAll();
  }

  /**
   * Get a specific MAFile by ID
   */
  getById(id) {
    return db.mafiles.findById(id);
  }

  /**
   * Get MAFile content by ID (reconstructed from database)
   */
  getContent(id) {
    const mafile = db.mafiles.findById(id);
    if (!mafile) {
      throw new Error('MAFile not found');
    }

    // Decrypt secrets from database for content reconstruction
    const decrypted = decryptAccountCredentials({
      shared_secret: mafile.shared_secret,
      identity_secret: mafile.identity_secret
    });

    return {
      account_name: mafile.account_name,
      steam_id: mafile.steam_id,
      shared_secret: decrypted.shared_secret,
      identity_secret: decrypted.identity_secret
    };
  }

  /**
   * Link a MAFile to an account
   */
  linkToAccount(mafileId, accountId) {
    logger.debug(`linkToAccount called: mafileId=${mafileId}, accountId=${accountId}`);

    const mafile = db.mafiles.findById(mafileId);
    if (!mafile) {
      logger.error(`MAFile not found: ${mafileId}`);
      throw new Error('MAFile not found');
    }

    logger.debug(`Found MAFile: ${mafile.account_name}, has shared_secret: ${!!mafile.shared_secret}`);

    db.mafiles.linkToAccount(mafileId, accountId);
    logger.debug(`Updated mafiles table, linked_account_id set to ${accountId}`);

    // Also update the account with shared_secret and identity_secret (encrypted)
    if (mafile.shared_secret || mafile.identity_secret) {
      logger.debug(`Updating account ${accountId} with secrets from MAFile`);
      const secretData = {};
      if (mafile.shared_secret) secretData.shared_secret = mafile.shared_secret;
      if (mafile.identity_secret) secretData.identity_secret = mafile.identity_secret;
      const encryptedData = encryptAccountCredentials(secretData);
      db.accounts.update(accountId, encryptedData);

      // Verify the update worked
      const updatedAccount = db.accounts.findById(accountId);
      logger.debug(`Account after update: has shared_secret=${!!updatedAccount?.shared_secret}`);
    } else {
      logger.warn(`MAFile ${mafile.account_name} has no shared_secret or identity_secret`);
    }

    logger.info(`Linked MAFile ${mafile.account_name} to account ${accountId}`);
  }

  /**
   * Delete a MAFile
   */
  delete(id) {
    const mafile = db.mafiles.findById(id);
    if (!mafile) {
      throw new Error('MAFile not found');
    }

    // Delete file from disk if it exists (legacy entries may have files)
    if (mafile.file_path && fs.existsSync(mafile.file_path)) {
      fs.unlinkSync(mafile.file_path);
    }

    // Delete from database
    db.mafiles.delete(id);
    logger.info(`Deleted MAFile ${mafile.account_name}`);
  }
}

module.exports = new MAFileService();
