const express = require('express');
const validator = require('validator');
const crypto = require('crypto');
const Database = require('../database/database');
const logger = require('../utils/logger');

const router = express.Router();
let db = null;

// Function to set database instance from server
const setDatabase = (database) => {
  db = database;
};

// Get all configuration
router.get('/', async (req, res) => {
  try {
    const config = await db.getAllConfig();
    
    // Filter out sensitive configuration for security
    const sensitiveKeys = ['ldap_bind_password', 'jwt_secret', 'session_secret'];
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([key]) => !sensitiveKeys.includes(key))
    );

    res.json({ config: filteredConfig });

  } catch (error) {
    logger.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to retrieve configuration' });
  }
});

// Get specific configuration value
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    if (!validator.isAlphanumeric(key, 'en-US', { ignore: '_' })) {
      return res.status(400).json({ error: 'Invalid configuration key' });
    }

    // Check if key is sensitive
    const sensitiveKeys = ['ldap_bind_password', 'jwt_secret', 'session_secret'];
    if (sensitiveKeys.includes(key)) {
      return res.status(403).json({ error: 'Access denied to sensitive configuration' });
    }

    const value = await db.getConfig(key);
    res.json({ key, value });

  } catch (error) {
    logger.error('Get config key error:', error);
    res.status(500).json({ error: 'Failed to retrieve configuration value' });
  }
});

// Update configuration
router.put('/', async (req, res) => {
  try {
    const { config } = req.body;
    
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Configuration object is required' });
    }

    const updatedKeys = [];
    
    for (const [key, value] of Object.entries(config)) {
      // Validate key name
      if (!validator.isAlphanumeric(key, 'en-US', { ignore: '_' })) {
        return res.status(400).json({ error: `Invalid configuration key: ${key}` });
      }

      // Determine value type
      let type = 'string';
      if (typeof value === 'number') {
        type = 'number';
      } else if (typeof value === 'boolean') {
        type = 'boolean';
      } else if (typeof value === 'object') {
        type = 'json';
      }

      // Validate specific configuration values
      const validationError = validateConfigValue(key, value);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      // Update configuration
      await db.setConfig(key, value, type, req.user.id);
      updatedKeys.push(key);
    }

    logger.info(`Configuration updated by ${req.user.username}: ${updatedKeys.join(', ')}`);

    res.json({ 
      success: true,
      message: 'Configuration updated successfully',
      updatedKeys
    });

  } catch (error) {
    logger.error('Update config error:', error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Update single configuration value
router.put('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (!validator.isAlphanumeric(key, 'en-US', { ignore: '_' })) {
      return res.status(400).json({ error: 'Invalid configuration key' });
    }

    // Validate configuration value
    const validationError = validateConfigValue(key, value);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Determine value type
    let type = 'string';
    if (typeof value === 'number') {
      type = 'number';
    } else if (typeof value === 'boolean') {
      type = 'boolean';
    } else if (typeof value === 'object') {
      type = 'json';
    }

    await db.setConfig(key, value, type, req.user.id);

    logger.info(`Configuration updated by ${req.user.username}: ${key} = ${typeof value === 'object' ? JSON.stringify(value) : value}`);

    res.json({ 
      success: true,
      message: 'Configuration value updated successfully',
      key,
      value
    });

  } catch (error) {
    logger.error('Update config key error:', error);
    res.status(500).json({ error: 'Failed to update configuration value' });
  }
});

// Metrics sources management
router.get('/metrics-sources', async (req, res) => {
  try {
    const sources = await db.getAllMetricsSources();
    
    // Remove sensitive auth credentials
    const sanitizedSources = sources.map(source => {
      const { auth_credentials, ...publicSource } = source;
      return {
        ...publicSource,
        hasAuth: !!auth_credentials
      };
    });

    res.json({ sources: sanitizedSources });

  } catch (error) {
    logger.error('Get metrics sources error:', error);
    res.status(500).json({ error: 'Failed to retrieve metrics sources' });
  }
});

// Create metrics source
router.post('/metrics-sources', async (req, res) => {
  try {
    const { name, url, type, authType, authCredentials, refreshInterval, timeout } = req.body;

    // Validate required fields
    if (!name || !url) {
      return res.status(400).json({ error: 'Name and URL are required' });
    }

    // Validate name
    if (!validator.isLength(name, { min: 1, max: 100 })) {
      return res.status(400).json({ error: 'Name must be 1-100 characters' });
    }

    // Validate URL
    if (!validator.isURL(url, { protocols: ['http', 'https'] })) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Validate type
    const validTypes = ['hermes', 'prometheus', 'custom'];
    if (type && !validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid source type' });
    }

    // Validate auth type
    const validAuthTypes = ['none', 'basic', 'bearer'];
    if (authType && !validAuthTypes.includes(authType)) {
      return res.status(400).json({ error: 'Invalid auth type' });
    }

    // Validate refresh interval
    if (refreshInterval && (!validator.isInt(String(refreshInterval)) || refreshInterval < 5 || refreshInterval > 3600)) {
      return res.status(400).json({ error: 'Refresh interval must be 5-3600 seconds' });
    }

    // Validate timeout
    if (timeout && (!validator.isInt(String(timeout)) || timeout < 1 || timeout > 300)) {
      return res.status(400).json({ error: 'Timeout must be 1-300 seconds' });
    }

    // Encrypt auth credentials if provided
    let encryptedCredentials = null;
    if (authCredentials && authType && authType !== 'none') {
      try {
        encryptedCredentials = encryptCredentials(JSON.stringify(authCredentials));
      } catch (credError) {
        return res.status(400).json({ error: 'Invalid auth credentials format' });
      }
    }

    const sourceData = {
      name: validator.escape(name),
      url: url.trim(),
      type: type || 'hermes',
      authType: authType || 'none',
      authCredentials: encryptedCredentials,
      refreshInterval: refreshInterval || 10,
      timeout: timeout || 30,
      createdBy: req.user.id
    };

    const sourceId = await db.createMetricsSource(sourceData);

    logger.info(`Metrics source created by ${req.user.username}: ${name} (${url})`);

    const newSource = await db.getMetricsSource(sourceId);
    const { auth_credentials, ...publicSource } = newSource;

    res.status(201).json({ 
      success: true,
      message: 'Metrics source created successfully',
      source: {
        ...publicSource,
        hasAuth: !!auth_credentials
      }
    });

  } catch (error) {
    logger.error('Create metrics source error:', error);
    res.status(500).json({ error: 'Failed to create metrics source' });
  }
});

// Update metrics source
router.put('/metrics-sources/:sourceId', async (req, res) => {
  try {
    const { sourceId } = req.params;
    const { name, url, type, authType, authCredentials, refreshInterval, timeout, is_active } = req.body;

    if (!validator.isInt(sourceId)) {
      return res.status(400).json({ error: 'Invalid source ID' });
    }

    // Check if source exists
    const existingSource = await db.getMetricsSource(parseInt(sourceId));
    if (!existingSource) {
      return res.status(404).json({ error: 'Metrics source not found' });
    }

    const updates = {};

    // Update name
    if (name !== undefined) {
      if (!validator.isLength(name, { min: 1, max: 100 })) {
        return res.status(400).json({ error: 'Name must be 1-100 characters' });
      }
      updates.name = validator.escape(name);
    }

    // Update URL
    if (url !== undefined) {
      if (!validator.isURL(url, { protocols: ['http', 'https'] })) {
        return res.status(400).json({ error: 'Invalid URL format' });
      }
      updates.url = url.trim();
    }

    // Update type
    if (type !== undefined) {
      const validTypes = ['hermes', 'prometheus', 'custom'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid source type' });
      }
      updates.type = type;
    }

    // Update auth type and credentials
    if (authType !== undefined) {
      const validAuthTypes = ['none', 'basic', 'bearer'];
      if (!validAuthTypes.includes(authType)) {
        return res.status(400).json({ error: 'Invalid auth type' });
      }
      updates.auth_type = authType;

      // Handle auth credentials
      if (authType === 'none') {
        updates.auth_credentials = null;
      } else if (authCredentials) {
        try {
          updates.auth_credentials = encryptCredentials(JSON.stringify(authCredentials));
        } catch (credError) {
          return res.status(400).json({ error: 'Invalid auth credentials format' });
        }
      }
    }

    // Update refresh interval
    if (refreshInterval !== undefined) {
      if (!validator.isInt(String(refreshInterval)) || refreshInterval < 5 || refreshInterval > 3600) {
        return res.status(400).json({ error: 'Refresh interval must be 5-3600 seconds' });
      }
      updates.refresh_interval = refreshInterval;
    }

    // Update timeout
    if (timeout !== undefined) {
      if (!validator.isInt(String(timeout)) || timeout < 1 || timeout > 300) {
        return res.status(400).json({ error: 'Timeout must be 1-300 seconds' });
      }
      updates.timeout = timeout;
    }

    // Update active status
    if (is_active !== undefined) {
      updates.is_active = is_active ? 1 : 0;
    }

    // Apply updates
    if (Object.keys(updates).length > 0) {
      await db.updateMetricsSource(parseInt(sourceId), updates);
      logger.info(`Metrics source updated by ${req.user.username}: ${existingSource.name}`);
    }

    // Get updated source
    const updatedSource = await db.getMetricsSource(parseInt(sourceId));
    const { auth_credentials, ...publicSource } = updatedSource;

    res.json({ 
      success: true,
      message: 'Metrics source updated successfully',
      source: {
        ...publicSource,
        hasAuth: !!auth_credentials
      }
    });

  } catch (error) {
    logger.error('Update metrics source error:', error);
    res.status(500).json({ error: 'Failed to update metrics source' });
  }
});

// Delete metrics source
router.delete('/metrics-sources/:sourceId', async (req, res) => {
  try {
    const { sourceId } = req.params;

    if (!validator.isInt(sourceId)) {
      return res.status(400).json({ error: 'Invalid source ID' });
    }

    // Check if source exists
    const existingSource = await db.getMetricsSource(parseInt(sourceId));
    if (!existingSource) {
      return res.status(404).json({ error: 'Metrics source not found' });
    }

    // Soft delete (set is_active = 0)
    await db.deleteMetricsSource(parseInt(sourceId));

    logger.info(`Metrics source deleted by ${req.user.username}: ${existingSource.name}`);

    res.json({ 
      success: true,
      message: 'Metrics source deleted successfully'
    });

  } catch (error) {
    logger.error('Delete metrics source error:', error);
    res.status(500).json({ error: 'Failed to delete metrics source' });
  }
});

// Test metrics source connection
router.post('/metrics-sources/:sourceId/test', async (req, res) => {
  try {
    const { sourceId } = req.params;

    if (!validator.isInt(sourceId)) {
      return res.status(400).json({ error: 'Invalid source ID' });
    }

    const source = await db.getMetricsSource(parseInt(sourceId));
    if (!source) {
      return res.status(404).json({ error: 'Metrics source not found' });
    }

    // Test connection
    const startTime = Date.now();
    try {
      const axios = require('axios');
      const requestOptions = {
        method: 'GET',
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'IBC-Monitor/1.0.0'
        }
      };

      // Add authentication if configured
      if (source.auth_type && source.auth_credentials) {
        try {
          const credentials = JSON.parse(decryptCredentials(source.auth_credentials));
          
          if (source.auth_type === 'basic' && credentials.username && credentials.password) {
            requestOptions.auth = {
              username: credentials.username,
              password: credentials.password
            };
          } else if (source.auth_type === 'bearer' && credentials.token) {
            requestOptions.headers['Authorization'] = `Bearer ${credentials.token}`;
          }
        } catch (authError) {
          return res.status(400).json({ error: 'Invalid auth credentials' });
        }
      }

      const response = await axios(`${source.url}/version`, requestOptions);
      const responseTime = Date.now() - startTime;

      res.json({
        success: true,
        message: 'Connection successful',
        responseTime: `${responseTime}ms`,
        status: response.status,
        data: response.data
      });

    } catch (connectionError) {
      const responseTime = Date.now() - startTime;
      
      res.status(400).json({
        success: false,
        message: 'Connection failed',
        error: connectionError.message,
        responseTime: `${responseTime}ms`
      });
    }

  } catch (error) {
    logger.error('Test metrics source error:', error);
    res.status(500).json({ error: 'Failed to test metrics source' });
  }
});

// Helper functions for credential encryption/decryption
function encryptCredentials(data) {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(process.env.JWT_SECRET || 'default-secret', 'salt', 32);
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipher(algorithm, key);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

function decryptCredentials(encryptedData) {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(process.env.JWT_SECRET || 'default-secret', 'salt', 32);
  
  const parts = encryptedData.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  
  const decipher = crypto.createDecipher(algorithm, key);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

function validateConfigValue(key, value) {
  switch (key) {
    case 'auth_method':
      if (!['sqlite', 'ldap'].includes(value)) {
        return 'Auth method must be either "sqlite" or "ldap"';
      }
      break;
      
    case 'ldap_port':
      if (!validator.isInt(String(value)) || value < 1 || value > 65535) {
        return 'LDAP port must be 1-65535';
      }
      break;
      
    case 'session_timeout':
      if (!validator.isInt(String(value)) || value < 1 || value > 168) {
        return 'Session timeout must be 1-168 hours';
      }
      break;
      
    case 'max_failed_logins':
      if (!validator.isInt(String(value)) || value < 1 || value > 100) {
        return 'Max failed logins must be 1-100';
      }
      break;
      
    case 'ldap_server':
      if (value && !validator.isURL(value, { protocols: ['ldap', 'ldaps'] })) {
        return 'Invalid LDAP server URL';
      }
      break;
  }
  
  return null;
}

module.exports = { router, setDatabase };