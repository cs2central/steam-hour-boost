const config = require('../config');
const logger = require('./logger');

/**
 * Steam Web API Service
 * Fetches player data, game info, and ban status from Steam's public API
 */
class SteamApiService {
  constructor() {
    this.apiKey = null;
    this.encryptionKey = null;
    this.refreshInterval = null;
    this.db = null;
  }

  /**
   * Initialize the service with database reference and encryption key
   * @param {Object} db - Database instance
   * @param {Buffer} encryptionKey - Encryption key for API key
   */
  async initialize(db, encryptionKey) {
    this.db = db;
    this.encryptionKey = encryptionKey;

    // Load API key from settings
    await this.loadApiKey();

    logger.info('Steam API service initialized', null, 'API');
  }

  /**
   * Load and decrypt the API key from settings
   */
  async loadApiKey() {
    if (!this.db) return;

    const encryptedKey = this.db.settings.get('steam_api_key');
    if (encryptedKey && this.encryptionKey) {
      try {
        const { decrypt, isEncrypted } = require('../utils/encryption');
        this.apiKey = isEncrypted(encryptedKey)
          ? decrypt(encryptedKey, this.encryptionKey)
          : encryptedKey;
      } catch (err) {
        logger.error(`Failed to decrypt Steam API key: ${err.message}`, null, 'API');
        this.apiKey = null;
      }
    }
  }

  /**
   * Set the API key (encrypts and saves to settings)
   * @param {string} apiKey - Steam Web API key
   */
  async setApiKey(apiKey) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (apiKey && this.encryptionKey) {
      const { encrypt } = require('../utils/encryption');
      const encryptedKey = encrypt(apiKey, this.encryptionKey);
      this.db.settings.set('steam_api_key', encryptedKey);
      this.apiKey = apiKey;
      logger.info('Steam API key updated', null, 'API');
    } else if (!apiKey) {
      this.db.settings.set('steam_api_key', null);
      this.apiKey = null;
      logger.info('Steam API key removed', null, 'API');
    }
  }

  /**
   * Update the encryption key (for password changes)
   * @param {Buffer} newKey - New encryption key
   */
  updateEncryptionKey(newKey) {
    this.encryptionKey = newKey;
  }

  /**
   * Check if the API is configured and ready
   * @returns {boolean}
   */
  isConfigured() {
    return !!this.apiKey;
  }

  /**
   * Make a request to the Steam Web API
   * @param {string} endpoint - API endpoint path
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} API response
   */
  async makeRequest(endpoint, params = {}) {
    if (!this.apiKey) {
      throw new Error('Steam API key not configured');
    }

    const url = new URL(`${config.steamApi.baseUrl}${endpoint}`);
    url.searchParams.append('key', this.apiKey);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }

    try {
      const response = await fetch(url.toString());

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('Invalid Steam API key');
        }
        throw new Error(`Steam API error: ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      logger.error(`Steam API request failed: ${err.message}`, null, 'API');
      throw err;
    }
  }

  /**
   * Get player summary information
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {Promise<Object|null>} Player summary or null
   */
  async getPlayerSummary(steamId) {
    if (!steamId) return null;

    try {
      const data = await this.makeRequest('/ISteamUser/GetPlayerSummaries/v2/', {
        steamids: steamId
      });

      const player = data?.response?.players?.[0];
      if (!player) return null;

      return {
        steamId: player.steamid,
        displayName: player.personaname,
        avatarUrl: player.avatarfull || player.avatar,
        profileUrl: player.profileurl,
        visibility: player.communityvisibilitystate, // 1=private, 3=public
        profileState: player.profilestate,
        lastLogoff: player.lastlogoff ? new Date(player.lastlogoff * 1000) : null,
        timeCreated: player.timecreated ? new Date(player.timecreated * 1000) : null,
        personaState: player.personastate,
        countryCode: player.loccountrycode
      };
    } catch (err) {
      logger.warn(`Failed to get player summary for ${steamId}: ${err.message}`, null, 'API');
      return null;
    }
  }

  /**
   * Get player's owned games with playtime
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {Promise<Object[]>} Array of games with playtime
   */
  async getOwnedGames(steamId) {
    if (!steamId) return [];

    try {
      const data = await this.makeRequest('/IPlayerService/GetOwnedGames/v1/', {
        steamid: steamId,
        include_appinfo: 1,
        include_played_free_games: 1
      });

      const games = data?.response?.games || [];

      return games.map(game => ({
        appId: game.appid,
        name: game.name,
        playtimeForever: game.playtime_forever || 0, // minutes
        playtime2Weeks: game.playtime_2weeks || 0, // minutes
        imgIconUrl: game.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
          : null,
        lastPlayed: game.rtime_last_played
          ? new Date(game.rtime_last_played * 1000)
          : null
      }));
    } catch (err) {
      logger.warn(`Failed to get owned games for ${steamId}: ${err.message}`, null, 'API');
      return [];
    }
  }

  /**
   * Get player ban status
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {Promise<Object|null>} Ban information or null
   */
  async getPlayerBans(steamId) {
    if (!steamId) return null;

    try {
      const data = await this.makeRequest('/ISteamUser/GetPlayerBans/v1/', {
        steamids: steamId
      });

      const player = data?.players?.[0];
      if (!player) return null;

      return {
        steamId: player.SteamId,
        communityBanned: player.CommunityBanned,
        vacBanned: player.VACBanned,
        vacBans: player.NumberOfVACBans,
        daysSinceLastBan: player.DaysSinceLastBan,
        gameBans: player.NumberOfGameBans,
        economyBan: player.EconomyBan // 'none', 'probation', 'banned'
      };
    } catch (err) {
      logger.warn(`Failed to get ban status for ${steamId}: ${err.message}`, null, 'API');
      return null;
    }
  }

  /**
   * Fetch all available data for a player
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {Promise<Object>} Combined player data
   */
  async fetchAllPlayerData(steamId) {
    if (!steamId) {
      return { summary: null, games: [], bans: null };
    }

    // Fetch all data in parallel
    const [summary, games, bans] = await Promise.all([
      this.getPlayerSummary(steamId),
      this.getOwnedGames(steamId),
      this.getPlayerBans(steamId)
    ]);

    return { summary, games, bans };
  }

  /**
   * Update account with fetched Steam API data
   * @param {number} accountId - Account ID in database
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {Promise<Object>} Updated data
   */
  async refreshAccount(accountId, steamId) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const data = await this.fetchAllPlayerData(steamId);

    // Update account with summary data
    if (data.summary) {
      this.db.accounts.update(accountId, {
        display_name: data.summary.displayName,
        avatar_url: data.summary.avatarUrl,
        profile_visibility: data.summary.visibility,
        account_created: data.summary.timeCreated ? data.summary.timeCreated.toISOString() : null
      });
    }

    // Update ban status
    if (data.bans) {
      this.db.accounts.update(accountId, {
        vac_banned: data.bans.vacBanned ? 1 : 0,
        trade_banned: data.bans.economyBan === 'banned' ? 1 : 0,
        game_bans: data.bans.gameBans
      });
    }

    // Update playtime data
    if (data.games.length > 0) {
      this.db.accounts.update(accountId, {
        total_games: data.games.length
      });

      // Store detailed playtime
      for (const game of data.games) {
        this.db.playtime.upsert(accountId, {
          app_id: game.appId,
          playtime_forever: game.playtimeForever,
          playtime_2weeks: game.playtime2Weeks,
          last_played: game.lastPlayed ? game.lastPlayed.toISOString() : null
        });
      }
    }

    // Update last refresh timestamp
    this.db.accounts.update(accountId, {
      api_last_refresh: new Date().toISOString()
    });

    logger.info(`Refreshed Steam API data for account ${accountId}`, accountId, 'API');

    return data;
  }

  /**
   * Refresh all accounts that have a steam_id
   * @returns {Promise<Object>} Refresh results
   */
  async refreshAllAccounts() {
    if (!this.db || !this.isConfigured()) {
      return { refreshed: 0, errors: 0 };
    }

    const accounts = this.db.accounts.findAll().filter(acc => acc.steam_id);
    let refreshed = 0;
    let errors = 0;

    for (const account of accounts) {
      try {
        await this.refreshAccount(account.id, account.steam_id);
        refreshed++;
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        errors++;
        logger.error(`Failed to refresh account ${account.id}: ${err?.message || String(err)}`, account.id, 'API');
      }
    }

    logger.info(`Refreshed ${refreshed} accounts, ${errors} errors`, null, 'API');
    return { refreshed, errors };
  }

  /**
   * Start periodic refresh of all accounts
   * @param {number} intervalMs - Refresh interval in milliseconds
   */
  startPeriodicRefresh(intervalMs = config.steamApi.defaultRefreshInterval) {
    // Stop existing interval
    this.stopPeriodicRefresh();

    if (!this.isConfigured()) {
      logger.warn('Cannot start periodic refresh: API key not configured', null, 'API');
      return;
    }

    // Save interval setting
    if (this.db) {
      this.db.settings.set('api_refresh_interval', intervalMs);
    }

    this.refreshInterval = setInterval(async () => {
      try {
        await this.refreshAllAccounts();
      } catch (err) {
        logger.error(`Periodic refresh failed: ${err.message}`, null, 'API');
      }
    }, intervalMs);

    // Don't prevent process from exiting
    this.refreshInterval.unref();

    logger.info(`Started periodic refresh every ${Math.round(intervalMs / 60000)} minutes`, null, 'API');
  }

  /**
   * Stop periodic refresh
   */
  stopPeriodicRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      logger.info('Stopped periodic refresh', null, 'API');
    }
  }

  /**
   * Get the configured refresh interval
   * @returns {number|null} Interval in milliseconds or null if disabled
   */
  getRefreshInterval() {
    if (!this.db) return null;
    return this.db.settings.get('api_refresh_interval', null);
  }

  /**
   * Set refresh interval (0 to disable)
   * @param {number} intervalMs - Interval in milliseconds, 0 to disable
   */
  setRefreshInterval(intervalMs) {
    if (!this.db) return;

    this.db.settings.set('api_refresh_interval', intervalMs);

    if (intervalMs > 0) {
      this.startPeriodicRefresh(intervalMs);
    } else {
      this.stopPeriodicRefresh();
    }
  }

  /**
   * Shutdown the service
   */
  shutdown() {
    this.stopPeriodicRefresh();
    logger.info('Steam API service shut down', null, 'API');
  }
}

// Export singleton instance
module.exports = new SteamApiService();
