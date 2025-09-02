/**
 * IBC Monitor - Enterprise Blockchain Monitoring Solution
 * Developed by PT Roomit Trimiko Digital
 * Website: https://roomit.xyz
 * Email: info@roomit.xyz
 * 
 * Copyright (c) 2024 PT Roomit Trimiko Digital
 * Licensed under MIT License
 */

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');
const cron = require('node-cron');

// Load environment variables
require('dotenv').config();

// Import custom modules
const logger = require('./src/utils/logger');
const Database = require('./src/database/database');
const { router: authRoutes, setDatabase: setAuthDatabase } = require('./src/routes/auth');
const { router: userRoutes, setDatabase: setUserDatabase } = require('./src/routes/users');
const { router: metricsRoutes, setDatabase: setMetricsDatabase } = require('./src/routes/metrics');
const { router: configRoutes, setDatabase: setConfigDatabase } = require('./src/routes/config');
const { router: alertRoutes, setDatabase: setAlertDatabase } = require('./src/routes/alerts');
const { router: walletRoutes, setDatabase: setWalletDatabase } = require('./src/routes/wallets');
const { authenticateToken, requireRole, setDatabase: setAuthMiddlewareDatabase } = require('./src/middleware/auth');
const { setupWebSocket } = require('./src/services/websocket');
const { startMetricsCollection } = require('./src/services/metricsCollector');
const { initializeAlerts } = require('./src/services/alertManager');
const { startWalletMonitoring } = require('./src/services/walletMonitor');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Initialize database
const db = new Database();

// Trust proxy if behind reverse proxy
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGINS?.split(',') || '*',
  methods: process.env.CORS_METHODS?.split(',') || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: process.env.CORS_HEADERS?.split(',') || ['Content-Type', 'Authorization'],
  credentials: true
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Compression
app.use(compression());

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
}

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: parseInt(process.env.SESSION_TIMEOUT || 24) * 60 * 60 * 1000, // 24 hours default
  },
  name: 'ibc-monitor-session'
}));

// Static files
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/img', express.static(path.join(__dirname, 'public/img')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || '1.0.0',
    uptime: process.uptime()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/metrics', authenticateToken, metricsRoutes);
app.use('/api/wallets', authenticateToken, walletRoutes);
app.use('/api/config', authenticateToken, requireRole('admin'), configRoutes);
app.use('/api/alerts', authenticateToken, alertRoutes);

// Serve the main application
app.get('/', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Login page
app.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Admin panel (admin only)
app.get('/admin', authenticateToken, requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Session destruction failed:', err);
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('ibc-monitor-session');
    res.json({ message: 'Logged out successfully' });
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(err.status || 500).json({ 
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error' 
  });
});

// Initialize application
async function initializeApp() {
  try {
    // Initialize database
    await db.initialize();
    logger.info('Database initialized successfully');
    
    // Set database instance for middleware and routes
    setAuthMiddlewareDatabase(db);
    setAuthDatabase(db);
    setUserDatabase(db);
    setMetricsDatabase(db);
    setWalletDatabase(db);
    setConfigDatabase(db);
    setAlertDatabase(db);

    // Setup WebSocket server
    const wss = setupWebSocket(server, db);
    logger.info('WebSocket server initialized');

    // Start metrics collection
    await startMetricsCollection(db, wss);
    logger.info('Metrics collection started');

    // Initialize alert system
    await initializeAlerts(db, wss);
    logger.info('Alert system initialized');

    // Start wallet monitoring
    await startWalletMonitoring(db, wss);
    logger.info('Wallet monitoring system initialized');

    // Setup cleanup cron jobs
    const cleanupInterval = parseInt(process.env.CLEANUP_INTERVAL_HOURS) || 24;
    cron.schedule(`0 */${cleanupInterval} * * *`, async () => {
      try {
        await db.cleanup();
        logger.info('Database cleanup completed');
      } catch (error) {
        logger.error('Database cleanup failed:', error);
      }
    });

    // Start server
    server.listen(PORT, HOST, () => {
      logger.info(`🚀 IBC Monitor server running on ${HOST}:${PORT}`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🔐 Auth method: ${process.env.AUTH_METHOD || 'sqlite'}`);
      logger.info(`📊 Metrics collection: enabled`);
      logger.info(`🔔 WebSocket server: enabled`);
    });

  } catch (error) {
    logger.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    db.close();
    process.exit(0);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Initialize the application
if (require.main === module) {
  initializeApp();
}

module.exports = { app, server };