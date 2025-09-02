const express = require('express');
const validator = require('validator');
const axios = require('axios');
const Database = require('../database/database');
const logger = require('../utils/logger');

const router = express.Router();
let db = null;

// Function to set database instance from server
const setDatabase = (database) => {
  db = database;
};

// Get notification settings for current user
router.get('/notifications', async (req, res) => {
  try {
    const settings = await db.getNotificationSettings(req.user.id);
    
    if (!settings) {
      return res.json({
        settings: {
          gotifyUrl: '',
          gotifyToken: '',
          isEnabled: false,
          alertThresholds: {
            pendingWarning: 10,
            pendingCritical: 50,
            failedPackets: 1,
            balanceThreshold: 20
          }
        }
      });
    }

    // Parse alert thresholds
    let alertThresholds = {};
    try {
      alertThresholds = settings.alert_thresholds ? JSON.parse(settings.alert_thresholds) : {};
    } catch (e) {
      alertThresholds = {};
    }

    res.json({
      settings: {
        gotifyUrl: settings.gotify_url || '',
        gotifyToken: settings.gotify_token ? '***' : '', // Hide actual token
        isEnabled: settings.is_enabled || false,
        alertThresholds: {
          pendingWarning: alertThresholds.pendingWarning || 10,
          pendingCritical: alertThresholds.pendingCritical || 50,
          failedPackets: alertThresholds.failedPackets || 1,
          balanceThreshold: alertThresholds.balanceThreshold || 20,
          ...alertThresholds
        }
      }
    });

  } catch (error) {
    logger.error('Get notification settings error:', error);
    res.status(500).json({ error: 'Failed to retrieve notification settings' });
  }
});

// Update notification settings for current user
router.put('/notifications', async (req, res) => {
  try {
    const { gotifyUrl, gotifyToken, isEnabled, alertThresholds } = req.body;

    // Validate Gotify URL if provided
    if (gotifyUrl && !validator.isURL(gotifyUrl, { protocols: ['http', 'https'] })) {
      return res.status(400).json({ error: 'Invalid Gotify URL format' });
    }

    // Validate alert thresholds
    if (alertThresholds) {
      const { pendingWarning, pendingCritical, failedPackets, balanceThreshold } = alertThresholds;
      
      if (pendingWarning && (!validator.isInt(String(pendingWarning)) || pendingWarning < 1 || pendingWarning > 10000)) {
        return res.status(400).json({ error: 'Pending warning threshold must be 1-10000' });
      }
      
      if (pendingCritical && (!validator.isInt(String(pendingCritical)) || pendingCritical < 1 || pendingCritical > 10000)) {
        return res.status(400).json({ error: 'Pending critical threshold must be 1-10000' });
      }
      
      if (failedPackets && (!validator.isInt(String(failedPackets)) || failedPackets < 0 || failedPackets > 1000)) {
        return res.status(400).json({ error: 'Failed packets threshold must be 0-1000' });
      }
      
      if (balanceThreshold && (!validator.isInt(String(balanceThreshold)) || balanceThreshold < 1 || balanceThreshold > 100)) {
        return res.status(400).json({ error: 'Balance threshold must be 1-100%' });
      }
      
      if (pendingWarning && pendingCritical && pendingWarning >= pendingCritical) {
        return res.status(400).json({ error: 'Warning threshold must be less than critical threshold' });
      }
    }

    // Get current settings to preserve token if not being updated
    const currentSettings = await db.getNotificationSettings(req.user.id);
    let finalGotifyToken = gotifyToken;
    
    // If token is '***' or empty, keep the existing token
    if (!gotifyToken || gotifyToken === '***') {
      finalGotifyToken = currentSettings?.gotify_token || '';
    }

    const settings = {
      gotifyUrl: gotifyUrl || '',
      gotifyToken: finalGotifyToken,
      isEnabled: isEnabled || false,
      alertThresholds: alertThresholds || {}
    };

    await db.saveNotificationSettings(req.user.id, settings);

    logger.info(`Notification settings updated for user: ${req.user.username}`);

    res.json({
      success: true,
      message: 'Notification settings updated successfully',
      settings: {
        ...settings,
        gotifyToken: settings.gotifyToken ? '***' : '' // Hide token in response
      }
    });

  } catch (error) {
    logger.error('Update notification settings error:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

// Test Gotify notification
router.post('/notifications/test', async (req, res) => {
  try {
    const settings = await db.getNotificationSettings(req.user.id);
    
    if (!settings || !settings.is_enabled || !settings.gotify_url || !settings.gotify_token) {
      return res.status(400).json({ error: 'Gotify notifications not configured or disabled' });
    }

    // Send test notification
    try {
      const response = await axios.post(`${settings.gotify_url}/message`, {
        title: 'IBC Monitor Test',
        message: `Test notification from IBC Monitor.\nUser: ${req.user.username}\nTime: ${new Date().toLocaleString()}`,
        priority: 5
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Gotify-Key': settings.gotify_token
        },
        timeout: 10000
      });

      logger.info(`Test notification sent for user: ${req.user.username}`);

      res.json({
        success: true,
        message: 'Test notification sent successfully',
        gotifyResponse: {
          status: response.status,
          messageId: response.data?.id
        }
      });

    } catch (gotifyError) {
      logger.error('Gotify test notification failed:', gotifyError.message);
      
      let errorMessage = 'Failed to send test notification';
      if (gotifyError.response?.status === 401) {
        errorMessage = 'Invalid Gotify token';
      } else if (gotifyError.response?.status === 404) {
        errorMessage = 'Gotify server not found';
      } else if (gotifyError.code === 'ECONNREFUSED') {
        errorMessage = 'Cannot connect to Gotify server';
      }

      res.status(400).json({
        success: false,
        error: errorMessage,
        details: gotifyError.message
      });
    }

  } catch (error) {
    logger.error('Test notification error:', error);
    res.status(500).json({ error: 'Failed to test notification' });
  }
});

// Get alert history
router.get('/history', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per page
    const offset = (page - 1) * limit;
    
    const severity = req.query.severity;
    const chainName = req.query.chain;
    const acknowledged = req.query.acknowledged;

    // Build query with filters
    let whereConditions = [];
    let params = [];

    if (severity && ['info', 'warning', 'critical'].includes(severity)) {
      whereConditions.push('severity = ?');
      params.push(severity);
    }

    if (chainName) {
      whereConditions.push('chain_name = ?');
      params.push(chainName);
    }

    if (acknowledged !== undefined) {
      whereConditions.push('is_acknowledged = ?');
      params.push(acknowledged === 'true' ? 1 : 0);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Get alerts with pagination
    const alerts = await db.all(`
      SELECT a.*, u.username as acknowledged_by_username
      FROM alert_history a
      LEFT JOIN users u ON a.acknowledged_by = u.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    // Get total count
    const countResult = await db.get(`
      SELECT COUNT(*) as total 
      FROM alert_history a 
      ${whereClause}
    `, params);

    // Parse alert_data JSON for each alert
    const processedAlerts = alerts.map(alert => ({
      ...alert,
      alert_data: alert.alert_data ? JSON.parse(alert.alert_data) : null,
      created_at: new Date(alert.created_at).toISOString(),
      acknowledged_at: alert.acknowledged_at ? new Date(alert.acknowledged_at).toISOString() : null
    }));

    res.json({
      alerts: processedAlerts,
      pagination: {
        page,
        limit,
        total: countResult.total,
        pages: Math.ceil(countResult.total / limit)
      }
    });

  } catch (error) {
    logger.error('Get alert history error:', error);
    res.status(500).json({ error: 'Failed to retrieve alert history' });
  }
});

// Acknowledge alert
router.put('/history/:alertId/acknowledge', async (req, res) => {
  try {
    const { alertId } = req.params;

    if (!validator.isInt(alertId)) {
      return res.status(400).json({ error: 'Invalid alert ID' });
    }

    // Check if alert exists
    const alert = await db.get('SELECT * FROM alert_history WHERE id = ?', [parseInt(alertId)]);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    if (alert.is_acknowledged) {
      return res.status(400).json({ error: 'Alert already acknowledged' });
    }

    // Acknowledge the alert
    await db.acknowledgeAlert(parseInt(alertId), req.user.id);

    logger.info(`Alert acknowledged by ${req.user.username}: Alert ID ${alertId}`);

    res.json({
      success: true,
      message: 'Alert acknowledged successfully'
    });

  } catch (error) {
    logger.error('Acknowledge alert error:', error);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

// Get alert statistics
router.get('/stats', async (req, res) => {
  try {
    const timeframe = req.query.timeframe || '24h'; // 24h, 7d, 30d
    let timeCondition = '';
    
    switch (timeframe) {
      case '24h':
        timeCondition = "created_at > datetime('now', '-24 hours')";
        break;
      case '7d':
        timeCondition = "created_at > datetime('now', '-7 days')";
        break;
      case '30d':
        timeCondition = "created_at > datetime('now', '-30 days')";
        break;
      default:
        timeCondition = "created_at > datetime('now', '-24 hours')";
    }

    // Get total alerts by severity
    const severityStats = await db.all(`
      SELECT severity, COUNT(*) as count
      FROM alert_history 
      WHERE ${timeCondition}
      GROUP BY severity
      ORDER BY 
        CASE severity 
          WHEN 'critical' THEN 1 
          WHEN 'warning' THEN 2 
          WHEN 'info' THEN 3 
        END
    `);

    // Get alerts by chain
    const chainStats = await db.all(`
      SELECT chain_name, COUNT(*) as count
      FROM alert_history 
      WHERE ${timeCondition} AND chain_name IS NOT NULL
      GROUP BY chain_name
      ORDER BY count DESC
      LIMIT 10
    `);

    // Get alert types
    const typeStats = await db.all(`
      SELECT alert_type, COUNT(*) as count
      FROM alert_history 
      WHERE ${timeCondition}
      GROUP BY alert_type
      ORDER BY count DESC
      LIMIT 10
    `);

    // Get acknowledgment stats
    const ackStats = await db.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_acknowledged = 1 THEN 1 ELSE 0 END) as acknowledged,
        SUM(CASE WHEN is_acknowledged = 0 THEN 1 ELSE 0 END) as unacknowledged
      FROM alert_history 
      WHERE ${timeCondition}
    `);

    // Get recent trend (alerts per day for the timeframe)
    let trendQuery = '';
    if (timeframe === '24h') {
      trendQuery = `
        SELECT 
          strftime('%H:00', created_at) as period,
          COUNT(*) as count
        FROM alert_history 
        WHERE ${timeCondition}
        GROUP BY strftime('%H', created_at)
        ORDER BY period
      `;
    } else {
      trendQuery = `
        SELECT 
          date(created_at) as period,
          COUNT(*) as count
        FROM alert_history 
        WHERE ${timeCondition}
        GROUP BY date(created_at)
        ORDER BY period
      `;
    }
    const trendStats = await db.all(trendQuery);

    res.json({
      timeframe,
      severity: severityStats.reduce((acc, stat) => {
        acc[stat.severity] = stat.count;
        return acc;
      }, { critical: 0, warning: 0, info: 0 }),
      chains: chainStats,
      types: typeStats,
      acknowledgment: {
        total: ackStats.total || 0,
        acknowledged: ackStats.acknowledged || 0,
        unacknowledged: ackStats.unacknowledged || 0,
        acknowledgmentRate: ackStats.total ? Math.round((ackStats.acknowledged / ackStats.total) * 100) : 0
      },
      trend: trendStats
    });

  } catch (error) {
    logger.error('Get alert stats error:', error);
    res.status(500).json({ error: 'Failed to retrieve alert statistics' });
  }
});

// Manual alert trigger (admin only)
router.post('/trigger', async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { alertType, chainName, severity, message, alertData } = req.body;

    // Validate required fields
    if (!alertType || !severity || !message) {
      return res.status(400).json({ error: 'Alert type, severity, and message are required' });
    }

    // Validate severity
    if (!['info', 'warning', 'critical'].includes(severity)) {
      return res.status(400).json({ error: 'Severity must be info, warning, or critical' });
    }

    // Save alert to history
    const alertId = await db.saveAlert({
      alertType,
      chainName: chainName || null,
      severity,
      message,
      alertData: alertData || {},
      userId: req.user.id
    });

    // Send notification if enabled (this would be handled by the alert service in a real system)
    const alertService = require('../services/alertManager');
    await alertService.processAlert({
      id: alertId,
      type: alertType,
      chain: chainName,
      severity,
      message,
      data: alertData || {}
    });

    logger.info(`Manual alert triggered by ${req.user.username}: ${alertType} (${severity})`);

    res.json({
      success: true,
      message: 'Alert triggered successfully',
      alertId
    });

  } catch (error) {
    logger.error('Trigger alert error:', error);
    res.status(500).json({ error: 'Failed to trigger alert' });
  }
});

module.exports = { router, setDatabase };