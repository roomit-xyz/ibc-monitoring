const express = require('express');
const validator = require('validator');
const { authenticate, generateToken, rateLimitAuth } = require('../middleware/auth');
const Database = require('../database/database');
const logger = require('../utils/logger');

const router = express.Router();
let db = null;

// Function to set database instance from server
const setDatabase = (database) => {
  db = database;
};

// Apply rate limiting to all auth routes
router.use(rateLimitAuth);

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;

    // Validate input
    if (!username || !password) {
      req.addAuthAttempt();
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Sanitize username
    const sanitizedUsername = validator.escape(username.trim());
    
    if (!validator.isLength(sanitizedUsername, { min: 1, max: 50 })) {
      req.addAuthAttempt();
      return res.status(400).json({ error: 'Invalid username format' });
    }

    // Authenticate user
    const result = await authenticate(sanitizedUsername, password, req);

    if (!result.success) {
      req.addAuthAttempt();
      return res.status(401).json({ error: result.error || 'Authentication failed' });
    }

    // Clear auth attempts on successful login
    req.clearAuthAttempts();

    // Create session
    req.session.userId = result.user.id;
    req.session.username = result.user.username;
    req.session.role = result.user.role;

    // Set session timeout based on rememberMe
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    } else {
      req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 24 hours
    }

    // Generate JWT token for API access
    const token = generateToken(result.user);

    // Save session to database for tracking
    const sessionId = req.sessionID;
    const expiresAt = new Date(Date.now() + req.session.cookie.maxAge).toISOString();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    try {
      await db.createSession(sessionId, result.user.id, expiresAt, ipAddress, userAgent);
    } catch (sessionError) {
      logger.warn('Failed to save session to database:', sessionError);
    }

    res.json({
      success: true,
      user: {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role,
        email: result.user.email
      },
      token,
      sessionId
    });

  } catch (error) {
    logger.error('Login error:', error);
    req.addAuthAttempt();
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout endpoint
router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.sessionID;
    const userId = req.session?.userId;

    // Delete session from database
    if (sessionId) {
      try {
        await db.deleteSession(sessionId);
      } catch (sessionError) {
        logger.warn('Failed to delete session from database:', sessionError);
      }
    }

    // Log logout
    if (userId) {
      const user = await db.getUserById(userId);
      if (user) {
        logger.logAuth('logout', user.username, req, true);
      }
    }

    // Destroy session
    req.session.destroy((err) => {
      if (err) {
        logger.error('Session destruction failed:', err);
        return res.status(500).json({ error: 'Failed to logout' });
      }

      res.clearCookie('ibc-monitor-session');
      res.json({ success: true, message: 'Logged out successfully' });
    });

  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Check authentication status
router.get('/status', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.json({ authenticated: false });
    }

    const user = await db.getUserById(req.session.userId);
    if (!user) {
      // Clean up invalid session
      req.session.destroy(() => {});
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        email: user.email
      }
    });

  } catch (error) {
    logger.error('Auth status check error:', error);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// Refresh token endpoint
router.post('/refresh', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'No active session' });
    }

    const user = await db.getUserById(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Generate new token
    const token = generateToken(user);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        email: user.email
      }
    });

  } catch (error) {
    logger.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Change password endpoint
router.post('/change-password', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { currentPassword, newPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    if (!validator.isLength(newPassword, { min: 8, max: 128 })) {
      return res.status(400).json({ error: 'New password must be 8-128 characters long' });
    }

    // Check if using LDAP authentication
    const authMethod = await db.getConfig('auth_method');
    if (authMethod === 'ldap') {
      return res.status(400).json({ error: 'Password change not available for LDAP users' });
    }

    // Get current user
    const user = await db.getUserById(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const authResult = await authenticate(user.username, currentPassword, req);
    if (!authResult.success) {
      logger.logAuth('password-change-failed', user.username, req, false, new Error('Invalid current password'));
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password
    await db.updateUser(user.id, { password: newPassword });

    logger.logAuth('password-changed', user.username, req, true);

    res.json({ success: true, message: 'Password changed successfully' });

  } catch (error) {
    logger.error('Password change error:', error);
    res.status(500).json({ error: 'Password change failed' });
  }
});

// Get active sessions
router.get('/sessions', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get all active sessions for the current user
    const sessions = await db.all(`
      SELECT id, ip_address, user_agent, created_at, expires_at
      FROM sessions 
      WHERE user_id = ? AND expires_at > datetime('now')
      ORDER BY created_at DESC
    `, [req.session.userId]);

    // Mark current session
    const currentSessionId = req.sessionID;
    const processedSessions = sessions.map(session => ({
      ...session,
      isCurrent: session.id === currentSessionId
    }));

    res.json({ sessions: processedSessions });

  } catch (error) {
    logger.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to retrieve sessions' });
  }
});

// Revoke session
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { sessionId } = req.params;

    // Verify the session belongs to the current user
    const session = await db.get(`
      SELECT id FROM sessions 
      WHERE id = ? AND user_id = ?
    `, [sessionId, req.session.userId]);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Delete the session
    await db.deleteSession(sessionId);

    // If it's the current session, destroy it
    if (sessionId === req.sessionID) {
      req.session.destroy(() => {});
      res.clearCookie('ibc-monitor-session');
    }

    res.json({ success: true, message: 'Session revoked successfully' });

  } catch (error) {
    logger.error('Revoke session error:', error);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

module.exports = { router, setDatabase };