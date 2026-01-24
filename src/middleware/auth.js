const bcrypt = require('bcryptjs');
const db = require('../models/database');

const SALT_ROUNDS = 10;

/**
 * Authentication middleware
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  // Check if this is an API request
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Redirect to login for page requests
  return res.redirect('/login');
}

/**
 * Check if setup is needed (no users exist)
 */
function checkSetup(req, res, next) {
  const userCount = db.users.count();

  if (userCount === 0) {
    // Allow access to setup page
    if (req.path === '/setup' || req.path === '/api/setup') {
      return next();
    }
    // Redirect to setup
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Setup required', setup: true });
    }
    return res.redirect('/setup');
  }

  // Setup already done, don't allow setup page
  if (req.path === '/setup' || req.path === '/api/setup') {
    return res.redirect('/');
  }

  next();
}

/**
 * Hash a password
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password
 */
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Create a new user
 */
async function createUser(username, password) {
  const hash = await hashPassword(password);
  return db.users.create(username, hash);
}

/**
 * Authenticate a user
 */
async function authenticateUser(username, password) {
  const user = db.users.findByUsername(username);
  if (!user) {
    return null;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return null;
  }

  return user;
}

/**
 * Change user password
 */
async function changePassword(userId, currentPassword, newPassword) {
  const user = db.users.findById(userId);

  if (!user) {
    throw new Error('User not found');
  }

  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) {
    throw new Error('Current password is incorrect');
  }

  const hash = await hashPassword(newPassword);
  db.users.updatePassword(userId, hash);
}

module.exports = {
  requireAuth,
  checkSetup,
  hashPassword,
  verifyPassword,
  createUser,
  authenticateUser,
  changePassword
};
