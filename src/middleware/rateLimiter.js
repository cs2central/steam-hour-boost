/**
 * Token Bucket Rate Limiter
 * In-memory rate limiting with automatic cleanup
 */

// Store for rate limit buckets: Map<key, { tokens, lastRefill, blocked_until }>
const buckets = new Map();

// Cleanup interval reference
let cleanupInterval = null;

/**
 * Create a rate limiter middleware
 * @param {Object} options - Rate limiter options
 * @param {number} options.maxAttempts - Maximum attempts allowed in the window
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {string} [options.keyGenerator] - Function to generate key from request (default: IP)
 * @param {string} [options.message] - Error message when rate limited
 * @param {boolean} [options.skipSuccessfulRequests] - Don't count successful requests
 * @returns {Function} Express middleware
 */
function createRateLimiter(options) {
  const {
    maxAttempts = 10,
    windowMs = 60000, // 1 minute default
    keyGenerator = (req) => req.ip || req.connection.remoteAddress || 'unknown',
    message = 'Too many requests, please try again later',
    skipSuccessfulRequests = false
  } = options;

  // Start cleanup job if not already running
  startCleanup();

  return (req, res, next) => {
    const key = typeof keyGenerator === 'function' ? keyGenerator(req) : keyGenerator;
    const now = Date.now();

    // Get or create bucket
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: maxAttempts,
        lastRefill: now,
        windowMs,
        maxAttempts
      };
      buckets.set(key, bucket);
    }

    // Refill tokens based on time elapsed
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(timePassed / windowMs) * maxAttempts;

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(maxAttempts, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }

    // Check if rate limited
    if (bucket.tokens <= 0) {
      const retryAfter = Math.ceil((windowMs - (now - bucket.lastRefill)) / 1000);

      // Log rate limit event
      const logger = require('../services/logger');
      logger.warn(`Rate limit exceeded for ${key}`, null, 'RATE_LIMIT');

      res.set('Retry-After', retryAfter);
      return res.status(429).json({
        success: false,
        error: message,
        retryAfter
      });
    }

    // Consume a token
    bucket.tokens--;

    // If skipSuccessfulRequests, restore token on successful response
    if (skipSuccessfulRequests) {
      const originalEnd = res.end;
      res.end = function(...args) {
        if (res.statusCode < 400) {
          bucket.tokens = Math.min(maxAttempts, bucket.tokens + 1);
        }
        return originalEnd.apply(this, args);
      };
    }

    next();
  };
}

/**
 * Create a rate limiter that tracks by endpoint + IP
 * @param {Object} options - Rate limiter options
 * @returns {Function} Express middleware
 */
function createEndpointRateLimiter(options) {
  return createRateLimiter({
    ...options,
    keyGenerator: (req) => {
      const ip = req.ip || req.connection.remoteAddress || 'unknown';
      return `${req.method}:${req.path}:${ip}`;
    }
  });
}

/**
 * Manually block a key for a duration
 * @param {string} key - The key to block
 * @param {number} durationMs - Duration to block in milliseconds
 */
function blockKey(key, durationMs) {
  const bucket = buckets.get(key) || { tokens: 0, lastRefill: Date.now() };
  bucket.tokens = 0;
  bucket.blockedUntil = Date.now() + durationMs;
  buckets.set(key, bucket);
}

/**
 * Reset rate limit for a key
 * @param {string} key - The key to reset
 */
function resetKey(key) {
  buckets.delete(key);
}

/**
 * Get current rate limit status for a key
 * @param {string} key - The key to check
 * @returns {Object|null} Status object or null if not tracked
 */
function getStatus(key) {
  const bucket = buckets.get(key);
  if (!bucket) return null;

  return {
    tokens: bucket.tokens,
    maxAttempts: bucket.maxAttempts,
    resetsAt: bucket.lastRefill + bucket.windowMs
  };
}

/**
 * Start the cleanup job to remove expired entries
 */
function startCleanup() {
  if (cleanupInterval) return;

  // Clean up every 5 minutes
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const expireTime = 30 * 60 * 1000; // 30 minutes

    for (const [key, bucket] of buckets.entries()) {
      // Remove buckets that haven't been accessed in 30 minutes
      // and have full tokens (not rate limited)
      if (now - bucket.lastRefill > expireTime && bucket.tokens >= bucket.maxAttempts) {
        buckets.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  // Don't prevent process from exiting
  cleanupInterval.unref();
}

/**
 * Stop the cleanup job
 */
function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Clear all rate limit data
 */
function clearAll() {
  buckets.clear();
}

// Pre-configured rate limiters for common use cases
const rateLimiters = {
  /**
   * Login rate limiter: 5 attempts per 15 minutes
   */
  login: createRateLimiter({
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    message: 'Too many login attempts. Please try again in 15 minutes.'
  }),

  /**
   * Setup rate limiter: 3 attempts per hour
   */
  setup: createRateLimiter({
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    message: 'Too many setup attempts. Please try again in an hour.'
  }),

  /**
   * General API rate limiter: 100 requests per minute
   */
  api: createRateLimiter({
    maxAttempts: 100,
    windowMs: 60 * 1000, // 1 minute
    message: 'Too many requests. Please slow down.',
    skipSuccessfulRequests: true
  }),

  /**
   * Strict rate limiter for sensitive operations: 10 per hour
   */
  strict: createRateLimiter({
    maxAttempts: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
    message: 'Rate limit exceeded for this operation.'
  })
};

module.exports = {
  createRateLimiter,
  createEndpointRateLimiter,
  blockKey,
  resetKey,
  getStatus,
  startCleanup,
  stopCleanup,
  clearAll,
  rateLimiters
};
