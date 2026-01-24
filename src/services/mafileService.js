const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const db = require('../models/database');
const config = require('../config');
const logger = require('./logger');

class MAFileService {
  constructor() {
    this.ensureDirectory();
  }

  ensureDirectory() {
    if (!fs.existsSync(config.mafilesDir)) {
      fs.mkdirSync(config.mafilesDir, { recursive: true });
    }
  }

  /**
   * Parse a MAFile and extract relevant data
   */
  parseMAFile(content) {
    try {
      // Extract SteamID from raw content before JSON.parse to avoid precision loss
      // SteamIDs are 64-bit integers that JavaScript can't handle accurately
      let steamId = null;
      const steamIdMatch = content.match(/"SteamID"\s*:\s*(\d+)/);
      if (steamIdMatch) {
        steamId = steamIdMatch[1]; // Keep as string
      } else {
        // Try alternative field name
        const altMatch = content.match(/"steam_id"\s*:\s*"?(\d+)"?/);
        if (altMatch) {
          steamId = altMatch[1];
        }
      }

      const data = JSON.parse(content);

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

    // Save file to mafiles directory
    const filename = `${parsed.account_name}.maFile`;
    const filePath = path.join(config.mafilesDir, filename);

    fs.writeFileSync(filePath, content);

    // Store metadata in database
    const result = db.mafiles.create({
      account_name: parsed.account_name,
      steam_id: parsed.steam_id,
      file_path: filePath,
      shared_secret: parsed.shared_secret,
      identity_secret: parsed.identity_secret
    });

    logger.info(`Imported MAFile for ${parsed.account_name}`);
    return { id: result.lastInsertRowid, ...parsed };
  }

  /**
   * Import MAFiles from a folder
   */
  importFromFolder(folderPath) {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder not found: ${folderPath}`);
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
   * Import MAFiles from a ZIP file
   */
  importFromZip(zipBuffer) {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

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
   * Get MAFile content by ID
   */
  getContent(id) {
    const mafile = db.mafiles.findById(id);
    if (!mafile) {
      throw new Error('MAFile not found');
    }

    if (!fs.existsSync(mafile.file_path)) {
      throw new Error('MAFile file not found on disk');
    }

    const content = fs.readFileSync(mafile.file_path, 'utf8');
    return this.parseMAFile(content);
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

    // Also update the account with shared_secret and identity_secret
    if (mafile.shared_secret || mafile.identity_secret) {
      logger.debug(`Updating account ${accountId} with secrets from MAFile`);
      db.accounts.update(accountId, {
        shared_secret: mafile.shared_secret,
        identity_secret: mafile.identity_secret
      });

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

    // Delete file from disk
    if (fs.existsSync(mafile.file_path)) {
      fs.unlinkSync(mafile.file_path);
    }

    // Delete from database
    db.mafiles.delete(id);
    logger.info(`Deleted MAFile ${mafile.account_name}`);
  }
}

module.exports = new MAFileService();
