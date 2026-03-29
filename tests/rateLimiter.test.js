// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------
jest.mock('../src/services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers: mock Express req / res / next
// ---------------------------------------------------------------------------
function mockReq(ip = '1.2.3.4', method = 'GET', path = '/api/test') {
  return { ip, method, path, connection: { remoteAddress: ip } };
}

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    statusCode: 200,
    end: jest.fn(),
  };
  return res;
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
const {
  createRateLimiter,
  createEndpointRateLimiter,
  blockKey,
  resetKey,
  getStatus,
  clearAll,
  stopCleanup,
  rateLimiters,
} = require('../src/middleware/rateLimiter');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('rateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearAll();
  });

  afterEach(() => {
    clearAll();
    jest.useRealTimers();
  });

  afterAll(() => {
    stopCleanup();
  });

  // ========================================================================
  // createRateLimiter
  // ========================================================================
  describe('createRateLimiter', () => {
    test('allows requests under the limit', () => {
      const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60000 });
      const req = mockReq();
      const res = mockRes();
      const next = jest.fn();

      limiter(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('returns 429 when tokens are exhausted', () => {
      const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60000 });
      const next = jest.fn();

      // Exhaust all tokens
      limiter(mockReq(), mockRes(), next);
      limiter(mockReq(), mockRes(), next);

      // Third request should be rejected
      const res = mockRes();
      limiter(mockReq(), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.any(String),
          retryAfter: expect.any(Number),
        })
      );
      expect(next).toHaveBeenCalledTimes(2);
    });

    test('returns Retry-After header when rate limited', () => {
      const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60000 });
      const next = jest.fn();

      // Exhaust token
      limiter(mockReq(), mockRes(), next);

      // Should get Retry-After header
      const res = mockRes();
      limiter(mockReq(), res, jest.fn());

      expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(Number));
      const retryAfter = res.set.mock.calls[0][1];
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    test('tokens refill after window passes', () => {
      const windowMs = 60000;
      const limiter = createRateLimiter({ maxAttempts: 2, windowMs });
      const next = jest.fn();

      // Exhaust all tokens
      limiter(mockReq(), mockRes(), next);
      limiter(mockReq(), mockRes(), next);

      // Should be rate limited now
      const blocked = mockRes();
      limiter(mockReq(), blocked, jest.fn());
      expect(blocked.status).toHaveBeenCalledWith(429);

      // Advance time past the window
      jest.advanceTimersByTime(windowMs);

      // Should be allowed again
      const res = mockRes();
      const nextAfter = jest.fn();
      limiter(mockReq(), res, nextAfter);

      expect(nextAfter).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('different IPs have independent buckets', () => {
      const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60000 });
      const next = jest.fn();

      // Exhaust tokens for IP A
      limiter(mockReq('10.0.0.1'), mockRes(), next);

      // IP A is rate limited
      const resA = mockRes();
      limiter(mockReq('10.0.0.1'), resA, jest.fn());
      expect(resA.status).toHaveBeenCalledWith(429);

      // IP B should still be allowed
      const resB = mockRes();
      const nextB = jest.fn();
      limiter(mockReq('10.0.0.2'), resB, nextB);
      expect(nextB).toHaveBeenCalledTimes(1);
      expect(resB.status).not.toHaveBeenCalled();
    });

    test('skipSuccessfulRequests restores token when response status < 400', () => {
      const limiter = createRateLimiter({
        maxAttempts: 2,
        windowMs: 60000,
        skipSuccessfulRequests: true,
      });
      const next = jest.fn();

      // Make 5 requests, each succeeding (status < 400)
      for (let i = 0; i < 5; i++) {
        const res = mockRes();
        res.statusCode = 200;
        limiter(mockReq(), res, next);
        // Simulate Express calling res.end() after a successful response
        res.end();
      }

      // All 5 should have been allowed because successful requests restore tokens
      expect(next).toHaveBeenCalledTimes(5);
    });

    test('skipSuccessfulRequests does NOT restore token when status >= 400', () => {
      const limiter = createRateLimiter({
        maxAttempts: 2,
        windowMs: 60000,
        skipSuccessfulRequests: true,
      });
      const next = jest.fn();

      // Make requests that fail (status 400+)
      for (let i = 0; i < 3; i++) {
        const res = mockRes();
        res.statusCode = 401;
        limiter(mockReq(), res, next);
        res.end();
      }

      // Only 2 should have been allowed (tokens not restored for failures)
      expect(next).toHaveBeenCalledTimes(2);
    });
  });

  // ========================================================================
  // createEndpointRateLimiter
  // ========================================================================
  describe('createEndpointRateLimiter', () => {
    test('uses method:path:ip as key so different endpoints have separate limits', () => {
      const limiter = createEndpointRateLimiter({ maxAttempts: 1, windowMs: 60000 });
      const next = jest.fn();

      // Exhaust limit for GET /api/test
      limiter(mockReq('1.2.3.4', 'GET', '/api/test'), mockRes(), next);

      // GET /api/test is now rate limited
      const blockedRes = mockRes();
      limiter(mockReq('1.2.3.4', 'GET', '/api/test'), blockedRes, jest.fn());
      expect(blockedRes.status).toHaveBeenCalledWith(429);

      // POST /api/test should still work (different method)
      const postRes = mockRes();
      const postNext = jest.fn();
      limiter(mockReq('1.2.3.4', 'POST', '/api/test'), postRes, postNext);
      expect(postNext).toHaveBeenCalledTimes(1);
      expect(postRes.status).not.toHaveBeenCalled();

      // GET /api/other should still work (different path)
      const otherRes = mockRes();
      const otherNext = jest.fn();
      limiter(mockReq('1.2.3.4', 'GET', '/api/other'), otherRes, otherNext);
      expect(otherNext).toHaveBeenCalledTimes(1);
      expect(otherRes.status).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // blockKey
  // ========================================================================
  describe('blockKey', () => {
    test('blocked key returns 429 immediately', () => {
      const limiter = createRateLimiter({ maxAttempts: 100, windowMs: 60000 });
      const ip = '5.5.5.5';

      // First request to create the bucket
      limiter(mockReq(ip), mockRes(), jest.fn());

      // Block this IP
      blockKey(ip, 30000);

      // Should be blocked immediately despite having tokens
      const res = mockRes();
      limiter(mockReq(ip), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    });

    test('block expires after duration', () => {
      const limiter = createRateLimiter({ maxAttempts: 100, windowMs: 60000 });
      const ip = '6.6.6.6';

      // Create the bucket
      limiter(mockReq(ip), mockRes(), jest.fn());

      // Block for 10 seconds
      blockKey(ip, 10000);

      // Still blocked
      const blockedRes = mockRes();
      limiter(mockReq(ip), blockedRes, jest.fn());
      expect(blockedRes.status).toHaveBeenCalledWith(429);

      // Advance past block duration
      jest.advanceTimersByTime(10001);

      // Should be allowed now (bucket was reset by blockKey, but window has not
      // passed so refill logic depends on implementation -- the block flag clears)
      const res = mockRes();
      const next = jest.fn();
      limiter(mockReq(ip), res, next);

      // After block expiry the blockedUntil is removed. Tokens were set to 0 by
      // blockKey, but the refill may not add tokens since only 10s passed in a
      // 60s window. Verify it's no longer a 429 from *blocking* by checking that
      // either next was called OR that any 429 comes from token exhaustion (not block).
      // Since blockKey sets tokens to 0 and only 10s passed in a 60s window,
      // tokens won't refill. The key behaviour is that the block itself expires.
      // Let's advance the full window to also allow token refill.
      jest.advanceTimersByTime(60000);

      const res2 = mockRes();
      const next2 = jest.fn();
      limiter(mockReq(ip), res2, next2);
      expect(next2).toHaveBeenCalledTimes(1);
      expect(res2.status).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // resetKey
  // ========================================================================
  describe('resetKey', () => {
    test('resetting a key allows requests again', () => {
      const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60000 });
      const ip = '7.7.7.7';
      const next = jest.fn();

      // Exhaust tokens
      limiter(mockReq(ip), mockRes(), next);

      // Rate limited
      const blockedRes = mockRes();
      limiter(mockReq(ip), blockedRes, jest.fn());
      expect(blockedRes.status).toHaveBeenCalledWith(429);

      // Reset the key
      resetKey(ip);

      // Should be allowed again
      const res = mockRes();
      const nextAfter = jest.fn();
      limiter(mockReq(ip), res, nextAfter);
      expect(nextAfter).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // getStatus
  // ========================================================================
  describe('getStatus', () => {
    test('returns tokens and maxAttempts for tracked key', () => {
      const limiter = createRateLimiter({ maxAttempts: 5, windowMs: 60000 });
      const ip = '8.8.8.8';

      // Make 2 requests to consume 2 tokens
      limiter(mockReq(ip), mockRes(), jest.fn());
      limiter(mockReq(ip), mockRes(), jest.fn());

      const status = getStatus(ip);
      expect(status).not.toBeNull();
      expect(status.tokens).toBe(3); // 5 - 2 = 3
      expect(status.maxAttempts).toBe(5);
      expect(status.resetsAt).toEqual(expect.any(Number));
    });

    test('returns null for unknown key', () => {
      const status = getStatus('nonexistent-key');
      expect(status).toBeNull();
    });
  });

  // ========================================================================
  // clearAll
  // ========================================================================
  describe('clearAll', () => {
    test('clears all buckets', () => {
      const limiter = createRateLimiter({ maxAttempts: 5, windowMs: 60000 });

      // Create buckets for multiple IPs
      limiter(mockReq('10.0.0.1'), mockRes(), jest.fn());
      limiter(mockReq('10.0.0.2'), mockRes(), jest.fn());
      limiter(mockReq('10.0.0.3'), mockRes(), jest.fn());

      expect(getStatus('10.0.0.1')).not.toBeNull();
      expect(getStatus('10.0.0.2')).not.toBeNull();
      expect(getStatus('10.0.0.3')).not.toBeNull();

      clearAll();

      expect(getStatus('10.0.0.1')).toBeNull();
      expect(getStatus('10.0.0.2')).toBeNull();
      expect(getStatus('10.0.0.3')).toBeNull();
    });
  });

  // ========================================================================
  // Pre-configured rateLimiters
  // ========================================================================
  describe('pre-configured rateLimiters', () => {
    test('rateLimiters.login: allows 5 attempts, then blocks', () => {
      const next = jest.fn();

      for (let i = 0; i < 5; i++) {
        rateLimiters.login(mockReq('20.0.0.1'), mockRes(), next);
      }
      expect(next).toHaveBeenCalledTimes(5);

      // 6th attempt should be blocked
      const res = mockRes();
      rateLimiters.login(mockReq('20.0.0.1'), res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('login'),
        })
      );
    });

    test('rateLimiters.setup: allows 3 attempts, then blocks', () => {
      const next = jest.fn();

      for (let i = 0; i < 3; i++) {
        rateLimiters.setup(mockReq('21.0.0.1'), mockRes(), next);
      }
      expect(next).toHaveBeenCalledTimes(3);

      // 4th attempt should be blocked
      const res = mockRes();
      rateLimiters.setup(mockReq('21.0.0.1'), res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('setup'),
        })
      );
    });

    test('rateLimiters.api: allows 100 attempts, skips successful requests', () => {
      const next = jest.fn();

      // Make 150 "successful" requests -- skipSuccessfulRequests should keep the bucket alive
      for (let i = 0; i < 150; i++) {
        const res = mockRes();
        res.statusCode = 200;
        rateLimiters.api(mockReq('22.0.0.1'), res, next);
        res.end();
      }

      // All 150 should succeed because tokens are restored for 2xx responses
      expect(next).toHaveBeenCalledTimes(150);
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================
  describe('edge cases', () => {
    test('handles missing IP gracefully (falls back to unknown)', () => {
      const limiter = createRateLimiter({ maxAttempts: 5, windowMs: 60000 });
      const req = { ip: undefined, method: 'GET', path: '/', connection: { remoteAddress: undefined } };
      const res = mockRes();
      const next = jest.fn();

      limiter(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      // The fallback key should be 'unknown'
      const status = getStatus('unknown');
      expect(status).not.toBeNull();
      expect(status.tokens).toBe(4); // 5 - 1 = 4
    });

    test('custom keyGenerator function works', () => {
      const limiter = createRateLimiter({
        maxAttempts: 2,
        windowMs: 60000,
        keyGenerator: (req) => `user:${req.userId}`,
      });
      const next = jest.fn();

      const req1 = { ...mockReq('10.0.0.1'), userId: 'abc123' };
      const req2 = { ...mockReq('10.0.0.2'), userId: 'abc123' };

      // Same userId, different IPs -- should share the same bucket
      limiter(req1, mockRes(), next);
      limiter(req2, mockRes(), next);
      expect(next).toHaveBeenCalledTimes(2);

      // 3rd attempt for same userId should be rate limited
      const res = mockRes();
      limiter(req1, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(429);

      // Verify the key is tracked correctly
      const status = getStatus('user:abc123');
      expect(status).not.toBeNull();
      expect(status.tokens).toBe(0);
    });

    test('custom error message is used in response', () => {
      const customMessage = 'Slow down, partner!';
      const limiter = createRateLimiter({
        maxAttempts: 1,
        windowMs: 60000,
        message: customMessage,
      });

      // Exhaust the single token
      limiter(mockReq('30.0.0.1'), mockRes(), jest.fn());

      // Verify custom message is returned
      const res = mockRes();
      limiter(mockReq('30.0.0.1'), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: customMessage,
        })
      );
    });
  });
});
