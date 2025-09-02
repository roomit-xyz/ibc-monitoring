const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const logger = require('../utils/logger');

class Database {
  constructor() {
    this.db = null;
    this.dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../database/ibc_monitor.db');
  }

  async initialize() {
    try {
      // Ensure database directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Create database connection
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          logger.error('Error opening database:', err);
          throw err;
        }
      });

      // Enable foreign keys
      await this.run('PRAGMA foreign_keys = ON');

      // Initialize schema
      await this.initializeSchema();

      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Database initialization failed:', error);
      throw error;
    }
  }

  async initializeSchema() {
    // Initialize main schema
    const schemaPath = path.join(__dirname, '../../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    const statements = schema.split(';').filter(stmt => stmt.trim().length > 0);
    
    for (const statement of statements) {
      await this.run(statement);
    }

    // Initialize wallet schema
    const walletSchemaPath = path.join(__dirname, '../../database/wallet_schema.sql');
    if (fs.existsSync(walletSchemaPath)) {
      const walletSchema = fs.readFileSync(walletSchemaPath, 'utf8');
      const walletStatements = walletSchema.split(';').filter(stmt => stmt.trim().length > 0);
      
      for (const statement of walletStatements) {
        await this.run(statement);
      }
      logger.info('Wallet schema initialized successfully');
    }
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          logger.error('Database run error:', err, 'SQL:', sql);
          reject(err);
        } else {
          resolve({ id: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          logger.error('Database get error:', err, 'SQL:', sql);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          logger.error('Database all error:', err, 'SQL:', sql);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // User management methods
  async createUser(userData) {
    const { username, email, password, role = 'monitoring' } = userData;
    const hashedPassword = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    
    const result = await this.run(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [username, email, hashedPassword, role]
    );
    
    return result.id;
  }

  async getUserByUsername(username) {
    return await this.get('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
  }

  async getUserById(id) {
    return await this.get('SELECT * FROM users WHERE id = ? AND is_active = 1', [id]);
  }

  async updateUserLastLogin(userId) {
    await this.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
  }

  async updateUser(userId, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    
    if (updates.password) {
      updates.password_hash = await bcrypt.hash(updates.password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
      delete updates.password;
    }
    
    await this.run(
      `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, userId]
    );
  }

  async deleteUser(userId) {
    await this.run('UPDATE users SET is_active = 0 WHERE id = ?', [userId]);
  }

  async getAllUsers() {
    return await this.all(`
      SELECT id, username, email, role, is_active, created_at, updated_at, last_login 
      FROM users 
      ORDER BY created_at DESC
    `);
  }

  // Session management
  async createSession(sessionId, userId, expiresAt, ipAddress, userAgent) {
    await this.run(
      'INSERT INTO sessions (id, user_id, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
      [sessionId, userId, expiresAt, ipAddress, userAgent]
    );
  }

  async getSession(sessionId) {
    return await this.get(`
      SELECT s.*, u.username, u.role 
      FROM sessions s 
      JOIN users u ON s.user_id = u.id 
      WHERE s.id = ? AND s.expires_at > datetime('now') AND u.is_active = 1
    `, [sessionId]);
  }

  async deleteSession(sessionId) {
    await this.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  async cleanupExpiredSessions() {
    const result = await this.run('DELETE FROM sessions WHERE expires_at <= datetime("now")');
    return result.changes;
  }

  // Configuration management
  async getConfig(key) {
    const config = await this.get('SELECT * FROM app_config WHERE config_key = ?', [key]);
    if (!config) return null;
    
    let value = config.config_value;
    switch (config.config_type) {
      case 'number':
        value = parseFloat(value);
        break;
      case 'boolean':
        value = value === 'true';
        break;
      case 'json':
        try {
          value = JSON.parse(value);
        } catch (e) {
          logger.error('Failed to parse JSON config:', key, e);
          value = null;
        }
        break;
    }
    
    return value;
  }

  async setConfig(key, value, type = 'string', updatedBy = null) {
    let stringValue = value;
    if (type === 'json') {
      stringValue = JSON.stringify(value);
    } else {
      stringValue = String(value);
    }
    
    await this.run(`
      INSERT OR REPLACE INTO app_config (config_key, config_value, config_type, updated_by, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [key, stringValue, type, updatedBy]);
  }

  async getAllConfig() {
    const configs = await this.all('SELECT * FROM app_config ORDER BY config_key');
    const result = {};
    
    for (const config of configs) {
      let value = config.config_value;
      switch (config.config_type) {
        case 'number':
          value = parseFloat(value);
          break;
        case 'boolean':
          value = value === 'true';
          break;
        case 'json':
          try {
            value = JSON.parse(value);
          } catch (e) {
            value = null;
          }
          break;
      }
      result[config.config_key] = value;
    }
    
    return result;
  }

  // Metrics sources management
  async createMetricsSource(sourceData) {
    const { name, url, type, authType, authCredentials, refreshInterval, timeout, createdBy } = sourceData;
    
    const result = await this.run(`
      INSERT INTO metrics_sources (name, url, type, auth_type, auth_credentials, refresh_interval, timeout, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, url, type, authType, authCredentials, refreshInterval, timeout, createdBy]);
    
    return result.id;
  }

  async getMetricsSource(id) {
    return await this.get('SELECT * FROM metrics_sources WHERE id = ?', [id]);
  }

  async getAllMetricsSources() {
    return await this.all('SELECT * FROM metrics_sources ORDER BY name');
  }

  async getActiveMetricsSources() {
    return await this.all('SELECT * FROM metrics_sources WHERE is_active = 1 ORDER BY name');
  }

  async updateMetricsSource(id, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    
    await this.run(
      `UPDATE metrics_sources SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, id]
    );
  }

  async deleteMetricsSource(id) {
    await this.run('UPDATE metrics_sources SET is_active = 0 WHERE id = ?', [id]);
  }

  // Notification settings
  async getNotificationSettings(userId) {
    return await this.get('SELECT * FROM notification_settings WHERE user_id = ?', [userId]);
  }

  async saveNotificationSettings(userId, settings) {
    const { gotifyUrl, gotifyToken, isEnabled, alertThresholds } = settings;
    
    await this.run(`
      INSERT OR REPLACE INTO notification_settings 
      (user_id, gotify_url, gotify_token, is_enabled, alert_thresholds, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [userId, gotifyUrl, gotifyToken, isEnabled, JSON.stringify(alertThresholds)]);
  }

  // Alert history
  async saveAlert(alertData) {
    const { alertType, chainName, severity, message, alertData: data, userId } = alertData;
    
    const result = await this.run(`
      INSERT INTO alert_history (alert_type, chain_name, severity, message, alert_data)
      VALUES (?, ?, ?, ?, ?)
    `, [alertType, chainName, severity, message, JSON.stringify(data)]);
    
    return result.id;
  }

  async getAlerts(limit = 100, offset = 0) {
    return await this.all(`
      SELECT * FROM alert_history 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `, [limit, offset]);
  }

  async acknowledgeAlert(alertId, userId) {
    await this.run(`
      UPDATE alert_history 
      SET is_acknowledged = 1, acknowledged_by = ?, acknowledged_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [userId, alertId]);
  }

  // Wallet management methods
  async createWalletAddress(walletData) {
    const { chainId, chainName, address, addressType = 'relayer' } = walletData;
    
    const result = await this.run(`
      INSERT INTO wallet_addresses (chain_id, chain_name, address, address_type)
      VALUES (?, ?, ?, ?)
    `, [chainId, chainName, address, addressType]);
    
    return result.id;
  }

  async getWalletAddresses(chainId = null) {
    if (chainId) {
      return await this.all('SELECT * FROM wallet_addresses WHERE chain_id = ? AND is_active = 1', [chainId]);
    }
    return await this.all('SELECT * FROM wallet_addresses WHERE is_active = 1 ORDER BY chain_name');
  }

  async updateWalletBalance(walletId, denom, balance, blockHeight = null) {
    // Get current balance
    const currentBalance = await this.get(`
      SELECT balance FROM wallet_balances WHERE wallet_id = ? AND denom = ?
    `, [walletId, denom]);

    const oldBalance = currentBalance ? parseFloat(currentBalance.balance) : 0;
    const newBalance = parseFloat(balance);
    const changeAmount = newBalance - oldBalance;

    // Update or insert balance
    await this.run(`
      INSERT OR REPLACE INTO wallet_balances (wallet_id, denom, balance, last_updated, block_height)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    `, [walletId, denom, balance, blockHeight]);

    // Record history if there's a change
    if (Math.abs(changeAmount) > 0.000001) { // Avoid tiny floating point differences
      const changeType = changeAmount > 0 ? 'increase' : 'decrease';
      await this.run(`
        INSERT INTO balance_history (wallet_id, denom, old_balance, new_balance, change_amount, change_type, block_height)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [walletId, denom, oldBalance, newBalance, Math.abs(changeAmount), changeType, blockHeight]);
    }

    return { oldBalance, newBalance, changeAmount };
  }

  async getWalletBalances(walletId = null) {
    let query = `
      SELECT 
        wa.id as wallet_id,
        wa.chain_id,
        wa.chain_name,
        wa.address,
        wa.address_type,
        wb.denom,
        wb.balance,
        wb.balance_usd,
        wb.last_updated,
        wb.block_height,
        tp.symbol,
        tp.name as token_name,
        tp.price_usd,
        (wb.balance * tp.price_usd) as calculated_usd_value
      FROM wallet_addresses wa
      LEFT JOIN wallet_balances wb ON wa.id = wb.wallet_id
      LEFT JOIN token_prices tp ON wb.denom = tp.denom
      WHERE wa.is_active = 1
    `;
    
    const params = [];
    if (walletId) {
      query += ' AND wa.id = ?';
      params.push(walletId);
    }
    
    query += ' ORDER BY wa.chain_name, wb.denom';
    
    return await this.all(query, params);
  }

  async getTotalBalancesByChain() {
    return await this.all(`
      SELECT 
        wa.chain_id,
        wa.chain_name,
        COUNT(DISTINCT wa.id) as wallet_count,
        COUNT(DISTINCT wb.denom) as token_count,
        SUM(wb.balance * tp.price_usd) as total_usd_value,
        GROUP_CONCAT(DISTINCT wb.denom) as tokens
      FROM wallet_addresses wa
      LEFT JOIN wallet_balances wb ON wa.id = wb.wallet_id
      LEFT JOIN token_prices tp ON wb.denom = tp.denom
      WHERE wa.is_active = 1
      GROUP BY wa.chain_id, wa.chain_name
      ORDER BY total_usd_value DESC
    `);
  }

  async getBalanceHistory(walletId, denom = null, limit = 100) {
    let query = `
      SELECT bh.*, wa.chain_name, wa.address
      FROM balance_history bh
      JOIN wallet_addresses wa ON bh.wallet_id = wa.id
      WHERE bh.wallet_id = ?
    `;
    
    const params = [walletId];
    if (denom) {
      query += ' AND bh.denom = ?';
      params.push(denom);
    }
    
    query += ` ORDER BY bh.created_at DESC LIMIT ?`;
    params.push(limit);
    
    return await this.all(query, params);
  }

  async updateTokenPrice(denom, priceData) {
    const { symbol, name, priceUsd, marketCapUsd, volume24hUsd, change24h } = priceData;
    
    await this.run(`
      INSERT OR REPLACE INTO token_prices 
      (denom, symbol, name, price_usd, market_cap_usd, volume_24h_usd, change_24h, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [denom, symbol, name, priceUsd, marketCapUsd, volume24hUsd, change24h]);

    // Update USD values in wallet_balances
    await this.run(`
      UPDATE wallet_balances 
      SET balance_usd = balance * ? 
      WHERE denom = ?
    `, [priceUsd, denom]);
  }

  async getLowBalanceAlerts(threshold = null) {
    const defaultThreshold = threshold || parseFloat(process.env.ALERT_BALANCE_THRESHOLD) || 20;
    
    return await this.all(`
      SELECT 
        wa.chain_id,
        wa.chain_name,
        wa.address,
        wa.address_type,
        wb.denom,
        wb.balance,
        tp.symbol,
        (wb.balance * tp.price_usd) as usd_value,
        tp.price_usd
      FROM wallet_addresses wa
      JOIN wallet_balances wb ON wa.id = wb.wallet_id
      LEFT JOIN token_prices tp ON wb.denom = tp.denom
      WHERE wa.is_active = 1 
        AND (wb.balance * tp.price_usd) < ?
        AND (wb.balance * tp.price_usd) > 0
      ORDER BY usd_value ASC
    `, [defaultThreshold]);
  }

  // Token decimals management
  async getTokenDecimals(chainId, denom) {
    const result = await this.get(
      'SELECT decimals FROM token_decimals WHERE chain_id = ? AND denom = ?',
      [chainId, denom]
    );
    return result ? result.decimals : null;
  }

  async saveTokenDecimals(chainId, denom, decimals) {
    await this.run(`
      INSERT OR REPLACE INTO token_decimals (chain_id, denom, decimals, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `, [chainId, denom, decimals]);
  }

  async getAllTokenDecimals() {
    return await this.all('SELECT * FROM token_decimals ORDER BY chain_id, denom');
  }

  // Cleanup methods
  async cleanup() {
    const retentionDays = parseInt(process.env.METRICS_RETENTION_DAYS) || 30;
    
    // Clean up expired sessions
    const expiredSessions = await this.cleanupExpiredSessions();
    
    // Clean up old alerts
    const oldAlerts = await this.run(`
      DELETE FROM alert_history 
      WHERE created_at < datetime('now', '-${retentionDays} days')
    `);

    // Clean up old balance history
    const oldBalanceHistory = await this.run(`
      DELETE FROM balance_history 
      WHERE created_at < datetime('now', '-${retentionDays} days')
    `);
    
    logger.info(`Cleanup completed: ${expiredSessions} expired sessions, ${oldAlerts.changes} old alerts, ${oldBalanceHistory.changes} old balance records`);
  }

  close() {
    if (this.db) {
      this.db.close((err) => {
        if (err) {
          logger.error('Error closing database:', err);
        } else {
          logger.info('Database connection closed');
        }
      });
    }
  }
}

module.exports = Database;