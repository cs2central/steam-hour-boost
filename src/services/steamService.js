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
    this.client = new SteamUser({ autoRelogin: false });
    this.isLoggedIn = false;
    this.isIdling = false;
    this.currentGames = [];
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.isConnecting = false;
    this.sessionId = null;

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on('loggedOn', () => {
      try {
        this.isLoggedIn = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        // Cancel any pending reconnect timer
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        // Reset failed login counter on successful login
        this.resetLockout();

        logger.info(`Logged in successfully`, this.accountId, 'STEAM');
        accountManager.updateStatus(this.accountId, 'online');

        // Set persona state based on account settings
        const personaState = this.accountData.persona_state ?? 1;
        this.client.setPersona(personaState);
        const stateNames = { 1: 'Online', 3: 'Away', 7: 'Invisible' };
        logger.info(`Set persona state: ${stateNames[personaState] || personaState}`, this.accountId);

        // Get account info
        if (this.client.steamID) {
          db.accounts.update(this.accountId, {
            steam_id: this.client.steamID.toString()
          });
        }

        // Resume idling if we were idling before disconnect/error
        if (this.currentGames.length > 0) {
          const shouldIdle = this.isIdling || db.accounts.findById(this.accountId)?.is_idling;
          if (shouldIdle) {
            this.isIdling = true;
            this.sessionId = db.sessions.start(this.accountId, this.currentGames).lastInsertRowid;
            logger.info(`Resuming idle for games: ${this.currentGames.join(', ')}`, this.accountId);
            accountManager.updateStatus(this.accountId, 'idling');
            accountManager.setIdling(this.accountId, true);
            this.client.gamesPlayed(this.currentGames);
          }
        }
      } catch (err) {
        logger.error(`Error in loggedOn handler: ${err.message}`, this.accountId, 'STEAM');
      }
    });

    this.client.on('accountInfo', (name) => {
      try {
        logger.info(`Account name: ${name}`, this.accountId);
        db.accounts.update(this.accountId, { display_name: name });
      } catch (err) {
        // Non-critical: display name update failed
      }
    });

    this.client.on('error', (err) => {
      this.isLoggedIn = false;
      this.isConnecting = false;

      try {
        const errorMsg = err.message || String(err);
        logger.error(`Steam error: ${errorMsg}`, this.accountId, 'STEAM');
        accountManager.updateStatus(this.accountId, 'error', errorMsg);
      } catch (logErr) {
        // DB write failed, continue with reconnect logic anyway
      }

      // Handle specific errors that should NOT reconnect
      try {
        if (err.eresult === SteamUser.EResult.InvalidPassword) {
          logger.error('Invalid password', this.accountId, 'STEAM');
          this.isIdling = false;
          this.handleFailedLogin();
          return;
        }

        if (err.eresult === SteamUser.EResult.AccountLogonDenied) {
          logger.error('Steam Guard code required', this.accountId, 'STEAM');
          this.isIdling = false;
          return;
        }

        if (err.eresult === SteamUser.EResult.RateLimitExceeded) {
          logger.error('Steam rate limit exceeded', this.accountId, 'STEAM');
          this.isIdling = false;
          this.handleRateLimited();
          return;
        }
      } catch (termErr) {
        // Terminal error handling failed, fall through to reconnect
      }

      // End current session tracking (we'll start a new one on reconnect)
      try {
        if (this.sessionId) {
          db.sessions.end(this.sessionId);
          this.sessionId = null;
        }
      } catch (sessErr) {
        this.sessionId = null;
      }

      // Always attempt reconnect for non-terminal errors
      this.scheduleReconnect();
    });

    this.client.on('disconnected', (eresult, msg) => {
      this.isLoggedIn = false;
      this.isConnecting = false;

      try {
        logger.warn(`Disconnected: ${msg} (${eresult})`, this.accountId);
      } catch (logErr) {
        // DB write failed, continue anyway
      }

      // End current session tracking to prevent orphaned sessions
      try {
        if (this.sessionId) {
          db.sessions.end(this.sessionId);
          this.sessionId = null;
        }
      } catch (sessErr) {
        this.sessionId = null;
      }

      if (this.isIdling) {
        try {
          accountManager.updateStatus(this.accountId, 'offline');
        } catch (statusErr) {
          // DB write failed, continue to reconnect anyway
        }
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

    this.reconnectAttempts++;

    // After max attempts, use a longer retry interval (5 minutes) instead of giving up
    let delay;
    if (this.reconnectAttempts > config.maxReconnectAttempts) {
      delay = 5 * 60 * 1000; // 5 minutes between retries after max attempts
    } else {
      delay = config.reconnectDelay * this.reconnectAttempts;
    }

    // Log and update status - wrapped so DB failures can't prevent the setTimeout
    try {
      if (this.reconnectAttempts === config.maxReconnectAttempts + 1) {
        logger.warn(`Max reconnect attempts reached, switching to 5-minute retry interval`, this.accountId);
        accountManager.updateStatus(this.accountId, 'error', 'Reconnecting (extended interval)');
      }
      logger.info(`Scheduling reconnect in ${delay / 1000}s (attempt ${this.reconnectAttempts})`, this.accountId);
    } catch (err) {
      // DB write failed, still proceed with scheduling the reconnect
    }

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      // Skip if already logged in or connecting
      if (this.isLoggedIn || this.isConnecting) {
        return;
      }

      try {
        const shouldIdle = this.isIdling || db.accounts.findById(this.accountId)?.is_idling;
        if (!shouldIdle) return;
      } catch (err) {
        logger.error(`Error checking idle state: ${err.message}`, this.accountId);
      }

      try {
        await this.login();
        // loggedOn handler will resume games automatically
      } catch (err) {
        logger.error(`Reconnect failed: ${err.message}`, this.accountId);
        // Only reschedule if the persistent error handler hasn't already done so
        if (!this.reconnectTimeout) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  async login() {
    return new Promise((resolve, reject) => {
      if (this.isLoggedIn) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        logger.debug(`Already connecting, skipping duplicate login`, this.accountId, 'STEAM');
        resolve();
        return;
      }

      // Check if account is locked out
      if (this.isLockedOut()) {
        const lockoutInfo = this.getLockoutInfo();
        const lockoutUntil = new Date(lockoutInfo.lockout_until);
        const remainingMs = lockoutUntil - Date.now();
        const remainingMin = Math.ceil(remainingMs / 60000);

        const error = new Error(`Account locked out for ${remainingMin} more minutes`);
        logger.warn(error.message, this.accountId, 'STEAM');
        reject(error);
        return;
      }

      this.isConnecting = true;

      // Prepare login options - if anything here throws, reset isConnecting
      let loginOptions;
      try {
        logger.info(`Attempting login`, this.accountId, 'STEAM');
        accountManager.updateStatus(this.accountId, 'connecting');

        loginOptions = {
          accountName: this.accountData.username,
          password: this.accountData.password,
          rememberPassword: true,
          machineName: 'hour-boost'
        };

        // Add two-factor code if shared_secret is available
        if (this.accountData.shared_secret) {
          loginOptions.twoFactorCode = SteamTotp.generateAuthCode(this.accountData.shared_secret);
        }
      } catch (prepErr) {
        this.isConnecting = false;
        reject(prepErr);
        return;
      }

      const onLoggedOn = () => {
        this.client.removeListener('error', onError);
        resolve();
      };

      const onError = (err) => {
        this.isConnecting = false;
        this.client.removeListener('loggedOn', onLoggedOn);
        reject(err);
      };

      this.client.once('loggedOn', onLoggedOn);
      this.client.once('error', onError);

      try {
        this.client.logOn(loginOptions);
      } catch (err) {
        this.isConnecting = false;
        this.client.removeListener('loggedOn', onLoggedOn);
        this.client.removeListener('error', onError);
        reject(err);
      }
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
    this.isIdling = false;
    this.currentGames = [];

    // Cancel pending reconnect since we're intentionally stopping
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // End session tracking
    if (this.sessionId) {
      db.sessions.end(this.sessionId);
      this.sessionId = null;
    }

    accountManager.updateStatus(this.accountId, this.isLoggedIn ? 'online' : 'offline');
    accountManager.setIdling(this.accountId, false);

    if (this.isLoggedIn) {
      this.client.gamesPlayed([]);
      logger.info(`Stopped idling`, this.accountId);
    } else {
      logger.info(`Stopped idling (while disconnected)`, this.accountId);
    }
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
    this.isConnecting = false;
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
    logger.info(`Changed persona state: ${stateNames[state] || state}`, this.accountId, 'STEAM');
  }

  /**
   * Handle failed Steam login (for lockout tracking)
   */
  handleFailedLogin() {
    db.accounts.incrementFailedLogins(this.accountId);

    const lockoutInfo = db.accounts.getLockoutInfo(this.accountId);
    const failedLogins = lockoutInfo?.failed_logins || 0;

    if (failedLogins >= config.lockout.maxFailedLogins) {
      // Calculate lockout duration with exponential backoff
      const multiplier = Math.pow(2, failedLogins - config.lockout.maxFailedLogins);
      const duration = Math.min(
        config.lockout.baseDuration * multiplier,
        config.lockout.maxDuration
      );

      const lockoutUntil = new Date(Date.now() + duration).toISOString();
      db.accounts.setLockout(this.accountId, lockoutUntil);

      logger.warn(
        `Account locked out until ${lockoutUntil} (${failedLogins} failed attempts)`,
        this.accountId,
        'STEAM'
      );

      accountManager.updateStatus(this.accountId, 'locked', `Locked until ${lockoutUntil}`);
    }
  }

  /**
   * Handle Steam rate limiting
   */
  handleRateLimited() {
    // Set a 1-hour lockout for rate limiting
    const lockoutUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.accounts.setLockout(this.accountId, lockoutUntil);

    logger.warn(
      `Account rate limited, locked until ${lockoutUntil}`,
      this.accountId,
      'STEAM'
    );

    accountManager.updateStatus(this.accountId, 'locked', 'Rate limited by Steam');
  }

  /**
   * Reset lockout on successful login
   */
  resetLockout() {
    db.accounts.resetFailedLogins(this.accountId);
    logger.debug('Reset failed login counter', this.accountId, 'STEAM');
  }

  /**
   * Check if account is locked out
   */
  isLockedOut() {
    return db.accounts.isLockedOut(this.accountId);
  }

  /**
   * Get lockout information
   */
  getLockoutInfo() {
    return db.accounts.getLockoutInfo(this.accountId);
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
    // Get account with decrypted credentials for Steam login
    const account = accountManager.getDecryptedAccount(accountId);
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
    } else {
      // Update account data in case credentials changed
      session.accountData = account;
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
    const results = await Promise.allSettled(
      accounts.map(account => this.startIdling(account.id))
    );

    return results.map((result, i) => ({
      id: accounts[i].id,
      success: result.status === 'fulfilled',
      error: result.status === 'rejected' ? result.reason.message : undefined
    }));
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

    if (idlingAccounts.length > 0 && !require('../middleware/auth').getEncryptionKey()) {
      logger.info('Encryption key not available yet, deferring resume until login');
      return;
    }

    const results = await Promise.allSettled(
      idlingAccounts.map(account =>
        this.startIdling(account.id).then(() => {
          logger.info(`Resumed idling for ${account.username}`, account.id);
        })
      )
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const account = idlingAccounts[i];
        logger.error(`Failed to resume idling for ${account.username}: ${results[i].reason.message}`, account.id);
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
