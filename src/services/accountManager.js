const db = require('../models/database');
const config = require('../config');
const logger = require('./logger');
const { encryptAccountCredentials, decryptAccountCredentials, getEncryptionKey } = require('../middleware/auth');

class AccountManager {
  constructor() {
    this.steamSessions = new Map(); // accountId -> SteamSession instance
  }

  /**
   * Set the steam service reference (to avoid circular dependency)
   */
  setSteamService(steamService) {
    this.steamService = steamService;
  }

  /**
   * Create a new Steam account
   */
  create(data) {
    logger.debug(`create() called with username: ${data.username}, mafile_id: ${data.mafile_id}`);

    // Validate required fields
    if (!data.username || !data.password) {
      throw new Error('Username and password are required');
    }

    // Check for duplicate username
    const existing = db.accounts.findByUsername(data.username);
    if (existing) {
      throw new Error('Account with this username already exists');
    }

    // Prepare account data with encryption
    const accountData = {
      username: data.username,
      password: data.password,
      shared_secret: data.shared_secret || null,
      identity_secret: data.identity_secret || null,
      steam_id: data.steam_id || null,
      display_name: data.display_name || null,
      persona_state: data.persona_state || 1
    };

    // Encrypt sensitive fields
    const encryptedData = encryptAccountCredentials(accountData);

    // Create account
    const result = db.accounts.create(encryptedData);

    const accountId = result.lastInsertRowid;
    logger.debug(`Account created with ID: ${accountId}`);

    // Set games (default to CS2 if not specified)
    const games = data.games && data.games.length > 0 ? data.games : config.defaultGames;
    db.games.setGames(accountId, games);
    logger.debug(`Set ${games.length} games for account`);

    // Link MAFile if provided
    if (data.mafile_id) {
      logger.debug(`Linking MAFile ${data.mafile_id} to account ${accountId}`);
      const mafile = db.mafiles.findById(data.mafile_id);
      if (mafile) {
        logger.debug(`Found MAFile: ${mafile.account_name}, shared_secret exists: ${!!mafile.shared_secret}`);
        db.mafiles.linkToAccount(data.mafile_id, accountId);
        // Update account with MAFile secrets (encrypted) and steam_id
        const secretsData = encryptAccountCredentials({
          shared_secret: mafile.shared_secret,
          identity_secret: mafile.identity_secret
        });
        // Also copy steam_id from MAFile if available
        if (mafile.steam_id) {
          secretsData.steam_id = mafile.steam_id;
        }
        db.accounts.update(accountId, secretsData);
        logger.debug(`Updated account with MAFile secrets`);
      } else {
        logger.warn(`MAFile ${data.mafile_id} not found`);
      }
    }

    logger.info(`Created account: ${data.username}`);

    // Get the created account - try by ID first, fallback to username
    let account = this.getById(accountId);
    logger.debug(`getById(${accountId}) returned: ${account ? 'found' : 'null'}`);

    if (!account) {
      // Fallback: find by username
      logger.debug(`Fallback: finding by username ${data.username}`);
      account = db.accounts.findByUsername(data.username);
      if (account) {
        account.games = db.games.getGames(account.id);
        logger.debug(`Found account by username, id: ${account.id}`);
      }
    }

    if (!account) {
      logger.error(`Failed to retrieve created account for ${data.username}`);
      throw new Error('Failed to create account');
    }

    logger.debug(`Returning account: id=${account.id}, shared_secret=${!!account.shared_secret}`);
    return account;
  }

  /**
   * Get account by ID with games
   */
  getById(id) {
    const account = db.accounts.findById(id);
    if (!account) return null;

    account.games = db.games.getGames(id);
    return account;
  }

  /**
   * Get all accounts with games
   */
  getAll() {
    const accounts = db.accounts.findAll();
    return accounts.map(acc => {
      acc.games = db.games.getGames(acc.id);
      return acc;
    });
  }

  /**
   * Update account
   */
  update(id, data) {
    const account = db.accounts.findById(id);
    if (!account) {
      throw new Error('Account not found');
    }

    // Update account fields
    const updateData = {};
    if (data.username) updateData.username = data.username;
    if (data.password) updateData.password = data.password;
    if (data.shared_secret !== undefined) updateData.shared_secret = data.shared_secret;
    if (data.identity_secret !== undefined) updateData.identity_secret = data.identity_secret;
    if (data.display_name !== undefined) updateData.display_name = data.display_name;
    if (data.persona_state !== undefined) updateData.persona_state = data.persona_state;

    if (Object.keys(updateData).length > 0) {
      // Encrypt sensitive fields before saving
      const encryptedData = encryptAccountCredentials(updateData);
      db.accounts.update(id, encryptedData);
    }

    // Update games if provided
    if (data.games) {
      db.games.setGames(id, data.games);
    }

    logger.info(`Updated account: ${account.username}`, id);
    return this.getById(id);
  }

  /**
   * Delete account
   */
  delete(id) {
    const account = db.accounts.findById(id);
    if (!account) {
      throw new Error('Account not found');
    }

    // Stop idling if active
    if (this.steamService && account.is_idling) {
      this.steamService.stopIdling(id);
    }

    db.accounts.delete(id);
    logger.info(`Deleted account: ${account.username}`);
  }

  /**
   * Update account status
   */
  updateStatus(id, status, lastError = null) {
    db.accounts.updateStatus(id, status, lastError);
  }

  /**
   * Set idling state
   */
  setIdling(id, isIdling) {
    db.accounts.setIdling(id, isIdling);
  }

  /**
   * Get account games
   */
  getGames(id) {
    return db.games.getGames(id);
  }

  /**
   * Add game to account
   */
  addGame(accountId, appId, appName = null) {
    const games = db.games.getGames(accountId);
    if (games.length >= config.maxGamesPerAccount) {
      throw new Error(`Maximum ${config.maxGamesPerAccount} games per account`);
    }

    db.games.addGame(accountId, appId, appName);
    logger.info(`Added game ${appId} to account ${accountId}`, accountId);
  }

  /**
   * Remove game from account
   */
  removeGame(accountId, appId) {
    db.games.removeGame(accountId, appId);
    logger.info(`Removed game ${appId} from account ${accountId}`, accountId);
  }

  /**
   * Set account games
   */
  setGames(accountId, games) {
    if (games.length > config.maxGamesPerAccount) {
      throw new Error(`Maximum ${config.maxGamesPerAccount} games per account`);
    }

    db.games.setGames(accountId, games);
    logger.info(`Set ${games.length} games for account ${accountId}`, accountId);
  }

  /**
   * Get dashboard stats
   */
  getStats() {
    return {
      totalAccounts: db.accounts.count(),
      activeIdling: db.accounts.countByStatus('idling'),
      online: db.accounts.countByStatus('online'),
      errors: db.accounts.countByStatus('error')
    };
  }

  /**
   * Get accounts that should be idling (for recovery)
   */
  getIdlingAccounts() {
    return db.accounts.getIdlingAccounts();
  }

  /**
   * Get account with decrypted credentials (for Steam login)
   * This should only be used internally by steamService
   */
  getDecryptedAccount(id) {
    const account = db.accounts.findById(id);
    if (!account) return null;

    // Decrypt credentials
    const decrypted = decryptAccountCredentials(account);
    decrypted.games = db.games.getGames(id);
    return decrypted;
  }

  /**
   * Search accounts with filters
   */
  search(query) {
    const accounts = db.accounts.search(query);
    return accounts.map(acc => {
      acc.games = db.games.getGames(acc.id);
      return acc;
    });
  }
}

module.exports = new AccountManager();
