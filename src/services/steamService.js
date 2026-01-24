const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const db = require('../models/database');
const config = require('../config');
const logger = require('./logger');
const accountManager = require('./accountManager');

class SteamSession {
  constructor(accountId, accountData) {
    this.accountId = accountId;
    this.accountData = accountData;
    this.client = new SteamUser();
    this.isLoggedIn = false;
    this.isIdling = false;
    this.currentGames = [];
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.sessionId = null;

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on('loggedOn', () => {
      this.isLoggedIn = true;
      this.reconnectAttempts = 0;
      logger.info(`Logged in successfully`, this.accountId);
      accountManager.updateStatus(this.accountId, 'online');

      // Set persona state based on account settings
      const personaState = this.accountData.persona_state || 1;
      this.client.setPersona(personaState);
      const stateNames = { 1: 'Online', 3: 'Away', 7: 'Invisible' };
      logger.info(`Set persona state: ${stateNames[personaState] || personaState}`, this.accountId);

      // Get account info
      if (this.client.steamID) {
        db.accounts.update(this.accountId, {
          steam_id: this.client.steamID.toString()
        });
      }
    });

    this.client.on('accountInfo', (name) => {
      logger.info(`Account name: ${name}`, this.accountId);
      db.accounts.update(this.accountId, { display_name: name });
    });

    this.client.on('error', (err) => {
      this.isLoggedIn = false;
      this.isIdling = false;
      const errorMsg = err.message || String(err);
      logger.error(`Steam error: ${errorMsg}`, this.accountId);
      accountManager.updateStatus(this.accountId, 'error', errorMsg);

      // Handle specific errors
      if (err.eresult === SteamUser.EResult.InvalidPassword) {
        logger.error('Invalid password', this.accountId);
        return; // Don't reconnect for invalid password
      }

      if (err.eresult === SteamUser.EResult.AccountLogonDenied) {
        logger.error('Steam Guard code required', this.accountId);
        return;
      }

      // Attempt reconnect for other errors
      this.scheduleReconnect();
    });

    this.client.on('disconnected', (eresult, msg) => {
      this.isLoggedIn = false;
      logger.warn(`Disconnected: ${msg} (${eresult})`, this.accountId);

      if (this.isIdling) {
        accountManager.updateStatus(this.accountId, 'offline');
        this.scheduleReconnect();
      }
    });

    this.client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      if (lastCodeWrong) {
        logger.error('Last Steam Guard code was wrong', this.accountId);
      }

      // Try to generate code from shared_secret
      if (this.accountData.shared_secret) {
        const code = SteamTotp.generateAuthCode(this.accountData.shared_secret);
        logger.info('Generated Steam Guard code from shared_secret', this.accountId);
        callback(code);
      } else {
        logger.error('Steam Guard code required but no shared_secret available', this.accountId);
        accountManager.updateStatus(this.accountId, 'error', 'Steam Guard code required');
      }
    });

    this.client.on('playingState', (blocked, playingApp) => {
      if (blocked) {
        logger.warn(`Playing blocked by another session (game: ${playingApp})`, this.accountId);
      }
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.reconnectAttempts >= config.maxReconnectAttempts) {
      logger.error(`Max reconnect attempts reached`, this.accountId);
      accountManager.updateStatus(this.accountId, 'error', 'Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = config.reconnectDelay * this.reconnectAttempts;

    logger.info(`Scheduling reconnect in ${delay / 1000}s (attempt ${this.reconnectAttempts})`, this.accountId);

    this.reconnectTimeout = setTimeout(() => {
      if (this.isIdling || db.accounts.findById(this.accountId)?.is_idling) {
        this.login().then(() => {
          if (this.currentGames.length > 0) {
            this.playGames(this.currentGames);
          }
        }).catch(err => {
          logger.error(`Reconnect failed: ${err.message}`, this.accountId);
        });
      }
    }, delay);
  }

  async login() {
    return new Promise((resolve, reject) => {
      if (this.isLoggedIn) {
        resolve();
        return;
      }

      logger.info(`Attempting login`, this.accountId);
      accountManager.updateStatus(this.accountId, 'connecting');

      const loginOptions = {
        accountName: this.accountData.username,
        password: this.accountData.password,
        rememberPassword: true,
        machineName: 'hour-boost'
      };

      // Add two-factor code if shared_secret is available
      if (this.accountData.shared_secret) {
        loginOptions.twoFactorCode = SteamTotp.generateAuthCode(this.accountData.shared_secret);
      }

      const onLoggedOn = () => {
        this.client.removeListener('error', onError);
        resolve();
      };

      const onError = (err) => {
        this.client.removeListener('loggedOn', onLoggedOn);
        reject(err);
      };

      this.client.once('loggedOn', onLoggedOn);
      this.client.once('error', onError);

      this.client.logOn(loginOptions);
    });
  }

  playGames(appIds) {
    if (!this.isLoggedIn) {
      throw new Error('Not logged in');
    }

    this.currentGames = appIds;
    this.isIdling = true;

    // Start session tracking
    this.sessionId = db.sessions.start(this.accountId, appIds).lastInsertRowid;

    logger.info(`Starting to idle games: ${appIds.join(', ')}`, this.accountId);
    accountManager.updateStatus(this.accountId, 'idling');
    accountManager.setIdling(this.accountId, true);

    this.client.gamesPlayed(appIds);
  }

  stopGames() {
    if (!this.isLoggedIn) {
      return;
    }

    this.isIdling = false;
    this.currentGames = [];

    // End session tracking
    if (this.sessionId) {
      db.sessions.end(this.sessionId);
      this.sessionId = null;
    }

    logger.info(`Stopped idling`, this.accountId);
    accountManager.updateStatus(this.accountId, 'online');
    accountManager.setIdling(this.accountId, false);

    this.client.gamesPlayed([]);
  }

  logout() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.sessionId) {
      db.sessions.end(this.sessionId);
      this.sessionId = null;
    }

    this.isIdling = false;
    this.isLoggedIn = false;
    this.currentGames = [];

    accountManager.updateStatus(this.accountId, 'offline');
    accountManager.setIdling(this.accountId, false);

    this.client.logOff();
    logger.info(`Logged out`, this.accountId);
  }

  getStatus() {
    return {
      isLoggedIn: this.isLoggedIn,
      isIdling: this.isIdling,
      currentGames: this.currentGames,
      steamId: this.client.steamID?.toString(),
      personaName: this.client.accountInfo?.name
    };
  }

  setPersonaState(state) {
    if (!this.isLoggedIn) {
      return;
    }
    this.client.setPersona(state);
    const stateNames = { 1: 'Online', 3: 'Away', 7: 'Invisible' };
    logger.info(`Changed persona state: ${stateNames[state] || state}`, this.accountId);
  }
}

class SteamService {
  constructor() {
    this.sessions = new Map(); // accountId -> SteamSession
  }

  /**
   * Get or create a session for an account
   */
  getSession(accountId) {
    return this.sessions.get(accountId);
  }

  /**
   * Start idling for an account
   */
  async startIdling(accountId) {
    const account = accountManager.getById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    // Get games to idle
    let games = account.games.map(g => g.app_id);
    if (games.length === 0) {
      games = config.defaultGames;
    }

    // Create or get session
    let session = this.sessions.get(accountId);
    if (!session) {
      session = new SteamSession(accountId, account);
      this.sessions.set(accountId, session);
    }

    // Login if needed
    if (!session.isLoggedIn) {
      await session.login();
    }

    // Start playing games
    session.playGames(games);

    return session.getStatus();
  }

  /**
   * Stop idling for an account
   */
  stopIdling(accountId) {
    const session = this.sessions.get(accountId);
    if (session) {
      session.stopGames();
    }

    accountManager.setIdling(accountId, false);
  }

  /**
   * Logout an account
   */
  logout(accountId) {
    const session = this.sessions.get(accountId);
    if (session) {
      session.logout();
      this.sessions.delete(accountId);
    }
  }

  /**
   * Start idling for all accounts
   */
  async startAll() {
    const accounts = accountManager.getAll();
    const results = [];

    for (const account of accounts) {
      try {
        await this.startIdling(account.id);
        results.push({ id: account.id, success: true });
      } catch (err) {
        results.push({ id: account.id, success: false, error: err.message });
      }
    }

    return results;
  }

  /**
   * Stop idling for all accounts
   */
  stopAll() {
    for (const [accountId, session] of this.sessions) {
      session.stopGames();
    }
  }

  /**
   * Logout all accounts
   */
  logoutAll() {
    for (const [accountId, session] of this.sessions) {
      session.logout();
    }
    this.sessions.clear();
  }

  /**
   * Get status of an account
   */
  getStatus(accountId) {
    const session = this.sessions.get(accountId);
    if (session) {
      return session.getStatus();
    }

    return {
      isLoggedIn: false,
      isIdling: false,
      currentGames: []
    };
  }

  /**
   * Resume idling for accounts that were idling before restart
   */
  async resumeIdling() {
    const idlingAccounts = accountManager.getIdlingAccounts();
    logger.info(`Resuming idling for ${idlingAccounts.length} accounts`);

    for (const account of idlingAccounts) {
      try {
        await this.startIdling(account.id);
        logger.info(`Resumed idling for ${account.username}`, account.id);
      } catch (err) {
        logger.error(`Failed to resume idling for ${account.username}: ${err.message}`, account.id);
      }
    }
  }

  /**
   * Graceful shutdown
   */
  shutdown() {
    logger.info('Shutting down Steam service...');
    this.logoutAll();
  }
}

const steamService = new SteamService();

// Set up circular reference
accountManager.setSteamService(steamService);

module.exports = steamService;
