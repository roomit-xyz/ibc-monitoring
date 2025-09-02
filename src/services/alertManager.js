const axios = require('axios');
const cron = require('node-cron');
const logger = require('../utils/logger');

class AlertManager {
  constructor(database, websocketServer) {
    this.db = database;
    this.wss = websocketServer;
    this.alertHistory = new Map(); // Track sent alerts to avoid duplicates
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Alert manager is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting alert management service...');

    // Start periodic cleanup of old alerts
    this.startAlertCleanup();

    logger.info('Alert management service started');
  }

  stop() {
    this.isRunning = false;
    logger.info('Alert management service stopped');
  }

  async processAlert(alert) {
    try {
      // Generate unique alert key to prevent duplicates
      const alertKey = this.generateAlertKey(alert);
      const now = Date.now();
      
      // Check if we've recently sent this alert (within last 5 minutes)
      const lastSent = this.alertHistory.get(alertKey);
      if (lastSent && (now - lastSent) < 5 * 60 * 1000) {
        logger.debug(`Skipping duplicate alert: ${alertKey}`);
        return false;
      }

      // Save alert to database
      const alertData = {
        alertType: alert.type,
        chainName: alert.chain || null,
        severity: alert.severity,
        message: alert.message,
        alertData: alert.data || {},
        userId: null // System generated alert
      };

      const alertId = await this.db.saveAlert(alertData);
      alert.id = alertId;

      // Send notifications to users
      await this.sendNotifications(alert);

      // Broadcast via WebSocket
      this.broadcastAlert(alert);

      // Update alert history
      this.alertHistory.set(alertKey, now);

      logger.logAlert(alert, true);
      return true;

    } catch (error) {
      logger.logAlert(alert, false, error);
      return false;
    }
  }

  async sendNotifications(alert) {
    try {
      // Get all users with notification settings
      const users = await this.db.all(`
        SELECT u.id, u.username, u.email, n.gotify_url, n.gotify_token, n.is_enabled, n.alert_thresholds
        FROM users u
        LEFT JOIN notification_settings n ON u.id = n.user_id
        WHERE u.is_active = 1
      `);

      for (const user of users) {
        try {
          // Check if user should receive this alert based on their settings
          if (this.shouldSendAlert(alert, user)) {
            await this.sendGotifyNotification(alert, user);
          }
        } catch (userError) {
          logger.error(`Failed to send alert to user ${user.username}:`, userError);
        }
      }

    } catch (error) {
      logger.error('Error sending notifications:', error);
    }
  }

  shouldSendAlert(alert, user) {
    // If user has no notification settings, don't send
    if (!user.is_enabled || !user.gotify_url || !user.gotify_token) {
      return false;
    }

    // Parse user's alert thresholds
    let thresholds = {};
    try {
      thresholds = user.alert_thresholds ? JSON.parse(user.alert_thresholds) : {};
    } catch (e) {
      thresholds = {};
    }

    // Check severity level preferences
    const minSeverity = thresholds.minSeverity || 'warning';
    const severityLevels = { 'info': 1, 'warning': 2, 'critical': 3 };
    
    if (severityLevels[alert.severity] < severityLevels[minSeverity]) {
      return false;
    }

    // Check alert type preferences
    if (thresholds.disabledTypes && Array.isArray(thresholds.disabledTypes)) {
      if (thresholds.disabledTypes.includes(alert.type)) {
        return false;
      }
    }

    // Check chain-specific preferences
    if (alert.chain && thresholds.disabledChains && Array.isArray(thresholds.disabledChains)) {
      if (thresholds.disabledChains.includes(alert.chain)) {
        return false;
      }
    }

    return true;
  }

  async sendGotifyNotification(alert, user) {
    try {
      const title = this.formatAlertTitle(alert);
      const message = this.formatAlertMessage(alert);
      const priority = this.getGotifyPriority(alert.severity);

      const payload = {
        title,
        message,
        priority,
        extras: {
          'client::display': {
            'contentType': 'text/markdown'
          },
          'client::notification': {
            'click': { 'url': `${process.env.BASE_URL || 'http://localhost:3000'}/alerts` }
          }
        }
      };

      const response = await axios.post(`${user.gotify_url}/message`, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Gotify-Key': user.gotify_token
        },
        timeout: 10000
      });

      logger.debug(`Gotify notification sent to ${user.username}: ${alert.type}`);
      return true;

    } catch (error) {
      logger.error(`Failed to send Gotify notification to ${user.username}:`, error.message);
      return false;
    }
  }

  broadcastAlert(alert) {
    if (!this.wss) return;

    const alertMessage = {
      type: 'new_alert',
      data: {
        id: alert.id,
        type: alert.type,
        chain: alert.chain,
        severity: alert.severity,
        message: alert.message,
        timestamp: new Date().toISOString(),
        formatted: {
          title: this.formatAlertTitle(alert),
          message: this.formatAlertMessage(alert),
          icon: this.getAlertIcon(alert.severity)
        }
      }
    };

    // Broadcast to all users subscribed to alerts
    this.wss.broadcast(alertMessage, (client) => {
      return client.subscriptions.has('alerts');
    });

    // Send to admin users for system alerts
    if (alert.severity === 'critical') {
      this.wss.broadcastToRole({
        type: 'critical_alert',
        data: alertMessage.data
      }, 'admin');
    }
  }

  formatAlertTitle(alert) {
    const severityEmoji = {
      'info': 'ℹ️',
      'warning': '⚠️',
      'critical': '🚨'
    };

    const emoji = severityEmoji[alert.severity] || '📊';
    const chainPart = alert.chain ? ` [${alert.chain}]` : '';
    
    return `${emoji} IBC Monitor Alert${chainPart}`;
  }

  formatAlertMessage(alert) {
    let message = `**${alert.type}**\n`;
    
    if (alert.chain) {
      message += `**Chain:** ${alert.chain}\n`;
    }
    
    message += `**Severity:** ${alert.severity.toUpperCase()}\n`;
    message += `**Details:** ${alert.message}\n`;
    message += `**Time:** ${new Date().toLocaleString()}`;

    // Add specific data based on alert type
    if (alert.data) {
      if (alert.type === 'client_misbehaviour' && alert.data.object) {
        message += `\n**Client:** ${alert.data.object.dst_client_id}`;
      }
      
      if (alert.type === 'high_pending_packets' && alert.data.count) {
        message += `\n**Count:** ${alert.data.count} packets`;
      }
    }

    return message;
  }

  getGotifyPriority(severity) {
    switch (severity) {
      case 'critical': return 8; // High priority
      case 'warning': return 5;  // Normal priority
      case 'info': return 2;     // Low priority
      default: return 5;
    }
  }

  getAlertIcon(severity) {
    switch (severity) {
      case 'critical': return '🚨';
      case 'warning': return '⚠️';
      case 'info': return 'ℹ️';
      default: return '📊';
    }
  }

  generateAlertKey(alert) {
    // Create a unique key for alert deduplication
    const parts = [
      alert.type,
      alert.chain || 'global',
      alert.severity
    ];
    
    // Add specific identifiers based on alert type
    if (alert.data) {
      if (alert.data.object && alert.data.object.dst_client_id) {
        parts.push(alert.data.object.dst_client_id);
      }
    }
    
    return parts.join(':');
  }

  startAlertCleanup() {
    // Clean up old alert history every hour
    cron.schedule('0 * * * *', () => {
      if (!this.isRunning) return;

      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      for (const [key, timestamp] of this.alertHistory.entries()) {
        if (now - timestamp > maxAge) {
          this.alertHistory.delete(key);
        }
      }

      logger.debug(`Alert history cleanup completed. Entries: ${this.alertHistory.size}`);
    });
  }

  // Predefined alert generators
  async checkPendingPackets(metricsData, source) {
    try {
      if (!metricsData.state?.result?.workers?.Packet) return;

      const packetWorkers = metricsData.state.result.workers.Packet;
      const pendingCount = packetWorkers.length; // Simplified - in reality you'd calculate actual pending packets

      // Get default thresholds or source-specific ones
      const warningThreshold = 10;
      const criticalThreshold = 50;

      if (pendingCount >= criticalThreshold) {
        await this.processAlert({
          type: 'high_pending_packets',
          chain: 'all',
          severity: 'critical',
          message: `${pendingCount} packets pending (critical threshold: ${criticalThreshold})`,
          data: { count: pendingCount, threshold: criticalThreshold, source: source.name }
        });
      } else if (pendingCount >= warningThreshold) {
        await this.processAlert({
          type: 'moderate_pending_packets',
          chain: 'all',
          severity: 'warning',
          message: `${pendingCount} packets pending (warning threshold: ${warningThreshold})`,
          data: { count: pendingCount, threshold: warningThreshold, source: source.name }
        });
      }

    } catch (error) {
      logger.error('Error checking pending packets:', error);
    }
  }

  async checkWorkerHealth(metricsData, source) {
    try {
      if (!metricsData.state?.result?.workers) return;

      const workers = metricsData.state.result.workers;

      // Check client workers for misbehaviour
      if (workers.Client) {
        for (const worker of workers.Client) {
          if (worker.data?.misbehaviour) {
            await this.processAlert({
              type: 'client_misbehaviour',
              chain: worker.object?.src_chain_id,
              severity: 'warning',
              message: `Client misbehaviour detected: ${worker.object?.dst_chain_id}`,
              data: worker
            });
          }
        }
      }

    } catch (error) {
      logger.error('Error checking worker health:', error);
    }
  }

  async checkSourceConnectivity(source, error) {
    await this.processAlert({
      type: 'source_connectivity',
      chain: null,
      severity: 'critical',
      message: `Failed to connect to metrics source: ${source.name} (${error.message})`,
      data: { source: source.name, url: source.url, error: error.message }
    });
  }

  // Public methods for external use
  async manualAlert(alertData) {
    return await this.processAlert(alertData);
  }

  getAlertHistory() {
    return Array.from(this.alertHistory.entries()).map(([key, timestamp]) => ({
      key,
      timestamp: new Date(timestamp).toISOString()
    }));
  }
}

// Factory function to create and start alert manager
async function initializeAlerts(database, websocketServer) {
  const alertManager = new AlertManager(database, websocketServer);
  await alertManager.start();
  return alertManager;
}

module.exports = {
  AlertManager,
  initializeAlerts
};