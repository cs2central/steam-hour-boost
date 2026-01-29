const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const config = require('./config');

// Create Express app
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: config.sessionMaxAge
  }
}));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// View helpers
function sendView(res, viewName) {
  const viewPath = path.join(__dirname, '..', 'views', `${viewName}.html`);
  res.sendFile(viewPath);
}

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server after database is ready
async function startServer() {
  // Initialize database
  const db = require('./models/database');
  await db.initializeDatabase();

  // Load services after DB is ready
  const logger = require('./services/logger');
  const steamService = require('./services/steamService');
  const { requireAuth, checkSetup } = require('./middleware/auth');

  // Routes - Auth (no auth required)
  const authRoutes = require('./routes/auth');
  app.use(authRoutes);

  // Dashboard routes
  const dashboardRoutes = require('./routes/dashboard');

  // Setup check middleware
  app.use(checkSetup);

  // Public pages
  app.get('/login', (req, res) => {
    if (req.session && req.session.userId) {
      return res.redirect('/');
    }
    sendView(res, 'login');
  });

  app.get('/setup', (req, res) => {
    sendView(res, 'setup');
  });

  // Protected routes - require authentication
  app.use(requireAuth);

  // Protected API routes
  const accountRoutes = require('./routes/accounts');
  const gameRoutes = require('./routes/games');
  const mafileRoutes = require('./routes/mafiles');
  const settingsRoutes = require('./routes/settings');

  app.use(dashboardRoutes);
  app.use(accountRoutes);
  app.use(gameRoutes);
  app.use(mafileRoutes);
  app.use(settingsRoutes);

  // Protected pages
  app.get('/', (req, res) => {
    sendView(res, 'dashboard');
  });

  app.get('/accounts', (req, res) => {
    sendView(res, 'accounts');
  });

  app.get('/mafiles', (req, res) => {
    sendView(res, 'mafiles');
  });

  app.get('/settings', (req, res) => {
    sendView(res, 'settings');
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, next) => {
    logger.error(`Server error: ${err.message}`);
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Graceful shutdown
  function shutdown() {
    logger.info('Shutting down...');
    steamService.shutdown();
    db.saveDatabase();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Prevent crashes from unhandled errors
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    console.error('Uncaught exception:', err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error(`Unhandled rejection: ${msg}`);
    console.error('Unhandled rejection:', reason);
  });

  // Start server
  const server = app.listen(config.port, config.host, () => {
    logger.info(`Hour Boost started on http://${config.host}:${config.port}`);

    // Start log cleanup job
    logger.startCleanupJob();

    // Resume idling for accounts that were active before restart
    setTimeout(() => {
      steamService.resumeIdling().catch(err => {
        logger.error(`Failed to resume idling: ${err.message}`);
      });
    }, 2000);
  });

  // Handle server errors
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${config.port} is already in use`);
    } else {
      logger.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });
}

// Start the application
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
