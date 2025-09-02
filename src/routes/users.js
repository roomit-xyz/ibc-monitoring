const express = require('express');
const validator = require('validator');
const { requireRole } = require('../middleware/auth');
const Database = require('../database/database');
const logger = require('../utils/logger');

const router = express.Router();
let db = null;

// Function to set database instance from server
const setDatabase = (database) => {
  db = database;
};

// Get current user profile
router.get('/profile', async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Remove sensitive information
    const { password_hash, ...userProfile } = user;

    res.json({ user: userProfile });

  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

// Update current user profile
router.put('/profile', async (req, res) => {
  try {
    const { email } = req.body;
    const updates = {};

    // Validate email if provided
    if (email !== undefined) {
      if (email && !validator.isEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      updates.email = email;
    }

    // Update user profile
    if (Object.keys(updates).length > 0) {
      await db.updateUser(req.user.id, updates);
      logger.info(`User profile updated: ${req.user.username}`);
    }

    // Get updated user
    const updatedUser = await db.getUserById(req.user.id);
    const { password_hash, ...userProfile } = updatedUser;

    res.json({ 
      success: true, 
      message: 'Profile updated successfully',
      user: userProfile 
    });

  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Admin only routes - get all users
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Get users with pagination
    const users = await db.all(`
      SELECT id, username, email, role, is_active, created_at, updated_at, last_login
      FROM users 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    // Get total count
    const { total } = await db.get('SELECT COUNT(*) as total FROM users');

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    logger.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// Admin only - create new user
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    // Validate required fields
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Validate username
    const sanitizedUsername = validator.escape(username.trim());
    if (!validator.isLength(sanitizedUsername, { min: 1, max: 50 }) || 
        !validator.isAlphanumeric(sanitizedUsername, 'en-US', { ignore: '_-' })) {
      return res.status(400).json({ error: 'Username must be 1-50 characters and contain only letters, numbers, hyphens, and underscores' });
    }

    // Validate email if provided
    if (email && !validator.isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate password
    if (!validator.isLength(password, { min: 8, max: 128 })) {
      return res.status(400).json({ error: 'Password must be 8-128 characters long' });
    }

    // Validate role
    if (role && !['admin', 'monitoring'].includes(role)) {
      return res.status(400).json({ error: 'Role must be either "admin" or "monitoring"' });
    }

    // Check if username already exists
    const existingUser = await db.getUserByUsername(sanitizedUsername);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Check if email already exists
    if (email) {
      const existingEmail = await db.get('SELECT id FROM users WHERE email = ?', [email]);
      if (existingEmail) {
        return res.status(409).json({ error: 'Email already exists' });
      }
    }

    // Create user
    const userId = await db.createUser({
      username: sanitizedUsername,
      email: email || null,
      password,
      role: role || 'monitoring'
    });

    logger.info(`User created by ${req.user.username}: ${sanitizedUsername} (${role || 'monitoring'})`);

    // Get created user (without password)
    const newUser = await db.get(`
      SELECT id, username, email, role, is_active, created_at, updated_at
      FROM users WHERE id = ?
    `, [userId]);

    res.status(201).json({ 
      success: true,
      message: 'User created successfully',
      user: newUser
    });

  } catch (error) {
    logger.error('Create user error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Admin only - get specific user
router.get('/:userId', requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;

    if (!validator.isInt(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = await db.get(`
      SELECT id, username, email, role, is_active, created_at, updated_at, last_login
      FROM users WHERE id = ?
    `, [parseInt(userId)]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user's sessions
    const sessions = await db.all(`
      SELECT id, ip_address, user_agent, created_at, expires_at
      FROM sessions 
      WHERE user_id = ? AND expires_at > datetime('now')
      ORDER BY created_at DESC
    `, [userId]);

    // Get user's notification settings
    const notificationSettings = await db.getNotificationSettings(userId);

    res.json({ 
      user: {
        ...user,
        activeSessions: sessions.length,
        notificationSettings: notificationSettings ? {
          gotifyEnabled: notificationSettings.is_enabled,
          hasGotifyConfig: !!(notificationSettings.gotify_url && notificationSettings.gotify_token)
        } : null
      }
    });

  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

// Admin only - update user
router.put('/:userId', requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { username, email, role, is_active, password } = req.body;

    if (!validator.isInt(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const targetUserId = parseInt(userId);

    // Check if user exists
    const existingUser = await db.getUserById(targetUserId);
    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent admin from deactivating themselves
    if (req.user.id === targetUserId && is_active === false) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    // Prevent admin from changing their own role
    if (req.user.id === targetUserId && role && role !== existingUser.role) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const updates = {};

    // Validate and update username
    if (username !== undefined && username !== existingUser.username) {
      const sanitizedUsername = validator.escape(username.trim());
      if (!validator.isLength(sanitizedUsername, { min: 1, max: 50 }) || 
          !validator.isAlphanumeric(sanitizedUsername, 'en-US', { ignore: '_-' })) {
        return res.status(400).json({ error: 'Invalid username format' });
      }

      // Check if new username already exists
      const usernameExists = await db.getUserByUsername(sanitizedUsername);
      if (usernameExists && usernameExists.id !== targetUserId) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      updates.username = sanitizedUsername;
    }

    // Validate and update email
    if (email !== undefined) {
      if (email && !validator.isEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Check if email already exists
      if (email) {
        const emailExists = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, targetUserId]);
        if (emailExists) {
          return res.status(409).json({ error: 'Email already exists' });
        }
      }

      updates.email = email || null;
    }

    // Validate and update role
    if (role !== undefined && role !== existingUser.role) {
      if (!['admin', 'monitoring'].includes(role)) {
        return res.status(400).json({ error: 'Role must be either "admin" or "monitoring"' });
      }
      updates.role = role;
    }

    // Update active status
    if (is_active !== undefined) {
      updates.is_active = is_active ? 1 : 0;
    }

    // Update password if provided
    if (password !== undefined) {
      if (!validator.isLength(password, { min: 8, max: 128 })) {
        return res.status(400).json({ error: 'Password must be 8-128 characters long' });
      }
      updates.password = password;
    }

    // Update user
    if (Object.keys(updates).length > 0) {
      await db.updateUser(targetUserId, updates);
      
      logger.info(`User updated by ${req.user.username}: ${existingUser.username} -> ${JSON.stringify(updates)}`);

      // If user was deactivated, delete their sessions
      if (updates.is_active === 0) {
        await db.run('DELETE FROM sessions WHERE user_id = ?', [targetUserId]);
        logger.info(`Sessions cleared for deactivated user: ${existingUser.username}`);
      }
    }

    // Get updated user
    const updatedUser = await db.get(`
      SELECT id, username, email, role, is_active, created_at, updated_at, last_login
      FROM users WHERE id = ?
    `, [targetUserId]);

    res.json({ 
      success: true,
      message: 'User updated successfully',
      user: updatedUser
    });

  } catch (error) {
    logger.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Admin only - delete user
router.delete('/:userId', requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;

    if (!validator.isInt(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const targetUserId = parseInt(userId);

    // Check if user exists
    const existingUser = await db.getUserById(targetUserId);
    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent admin from deleting themselves
    if (req.user.id === targetUserId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Soft delete user (set is_active = 0)
    await db.deleteUser(targetUserId);

    // Delete user sessions
    await db.run('DELETE FROM sessions WHERE user_id = ?', [targetUserId]);

    logger.info(`User deleted by ${req.user.username}: ${existingUser.username}`);

    res.json({ 
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    logger.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Admin only - get user statistics
router.get('/stats/overview', requireRole('admin'), async (req, res) => {
  try {
    const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
    const activeUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE is_active = 1');
    const adminUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE role = "admin" AND is_active = 1');
    const monitoringUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE role = "monitoring" AND is_active = 1');
    
    const activeSessions = await db.get('SELECT COUNT(*) as count FROM sessions WHERE expires_at > datetime("now")');
    
    const recentLogins = await db.get(`
      SELECT COUNT(*) as count 
      FROM users 
      WHERE last_login > datetime('now', '-24 hours') AND is_active = 1
    `);

    res.json({
      users: {
        total: totalUsers.count,
        active: activeUsers.count,
        admin: adminUsers.count,
        monitoring: monitoringUsers.count
      },
      sessions: {
        active: activeSessions.count
      },
      activity: {
        recentLogins: recentLogins.count
      }
    });

  } catch (error) {
    logger.error('Get user stats error:', error);
    res.status(500).json({ error: 'Failed to retrieve user statistics' });
  }
});

module.exports = { router, setDatabase };