const express = require('express');
const axios = require('axios');
const validator = require('validator');
const Database = require('../database/database');
const logger = require('../utils/logger');

const router = express.Router();
let db = null;

// Function to set database instance from server
const setDatabase = (database) => {
  db = database;
};

// Get all metrics sources
router.get('/sources', async (req, res) => {
  try {
    const sources = await db.getAllMetricsSources();
    
    // Hide sensitive auth credentials for non-admin users
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

// Get active metrics sources only
router.get('/sources/active', async (req, res) => {
  try {
    const sources = await db.getActiveMetricsSources();
    
    const sanitizedSources = sources.map(source => {
      const { auth_credentials, ...publicSource } = source;
      return {
        ...publicSource,
        hasAuth: !!auth_credentials
      };
    });

    res.json({ sources: sanitizedSources });

  } catch (error) {
    logger.error('Get active metrics sources error:', error);
    res.status(500).json({ error: 'Failed to retrieve active metrics sources' });
  }
});

// Get data from Hermes API endpoints
router.get('/hermes/:sourceId/version', async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    const source = await db.getMetricsSource(parseInt(sourceId));
    if (!source || !source.is_active) {
      return res.status(404).json({ error: 'Metrics source not found or inactive' });
    }

    const response = await makeRequest(source, '/version');
    res.json(response);

  } catch (error) {
    logger.error('Get Hermes version error:', error);
    res.status(500).json({ error: 'Failed to retrieve version information' });
  }
});

router.get('/hermes/:sourceId/chains', async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    const source = await db.getMetricsSource(parseInt(sourceId));
    if (!source || !source.is_active) {
      return res.status(404).json({ error: 'Metrics source not found or inactive' });
    }

    const response = await makeRequest(source, '/chains');
    
    // Transform response to include human-readable information
    const result = {
      ...response,
      result: Array.isArray(response.result) ? response.result.map(chainId => ({
        id: chainId,
        name: getChainDisplayName(chainId),
        type: 'cosmos-sdk'
      })) : response.result
    };

    res.json(result);

  } catch (error) {
    logger.error('Get Hermes chains error:', error);
    res.status(500).json({ error: 'Failed to retrieve chains information' });
  }
});

router.get('/hermes/:sourceId/chain/:chainId', async (req, res) => {
  try {
    const { sourceId, chainId } = req.params;
    
    const source = await db.getMetricsSource(parseInt(sourceId));
    if (!source || !source.is_active) {
      return res.status(404).json({ error: 'Metrics source not found or inactive' });
    }

    const response = await makeRequest(source, `/chain/${chainId}`);
    
    // Add human-readable information to chain data
    if (response.status === 'success' && response.result) {
      response.result.displayName = getChainDisplayName(chainId);
      response.result.networkType = getNetworkType(chainId);
      
      // Format gas price for readability
      if (response.result.gas_price) {
        response.result.gas_price.formatted = formatGasPrice(response.result.gas_price);
      }
      
      // Format RPC addresses for better display
      if (response.result.rpc_addr) {
        response.result.rpc_info = parseRpcAddress(response.result.rpc_addr);
      }
      
      if (response.result.grpc_addr) {
        response.result.grpc_info = parseRpcAddress(response.result.grpc_addr);
      }
    }

    res.json(response);

  } catch (error) {
    logger.error('Get Hermes chain error:', error);
    res.status(500).json({ error: 'Failed to retrieve chain information' });
  }
});

router.get('/hermes/:sourceId/state', async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    const source = await db.getMetricsSource(parseInt(sourceId));
    if (!source || !source.is_active) {
      return res.status(404).json({ error: 'Metrics source not found or inactive' });
    }

    const response = await makeRequest(source, '/state');
    
    // Add human-readable information to state data
    if (response.status === 'success' && response.result) {
      // Process chains array
      if (response.result.chains) {
        response.result.chains = response.result.chains.map(chainId => ({
          id: chainId,
          name: getChainDisplayName(chainId),
          status: 'active'
        }));
      }
      
      // Process workers
      if (response.result.workers) {
        const processedWorkers = {};
        
        Object.keys(response.result.workers).forEach(workerType => {
          processedWorkers[workerType] = response.result.workers[workerType].map(worker => ({
            ...worker,
            displayName: getWorkerDisplayName(worker),
            healthStatus: getWorkerHealthStatus(worker)
          }));
        });
        
        response.result.workers = processedWorkers;
        
        // Add summary statistics
        response.result.summary = {
          totalWorkers: Object.values(response.result.workers).reduce((total, workers) => total + workers.length, 0),
          workerTypes: Object.keys(response.result.workers).length,
          healthyWorkers: Object.values(response.result.workers).reduce((count, workers) => 
            count + workers.filter(w => w.healthStatus === 'healthy').length, 0
          )
        };
      }
    }

    res.json(response);

  } catch (error) {
    logger.error('Get Hermes state error:', error);
    res.status(500).json({ error: 'Failed to retrieve state information' });
  }
});

// Get aggregated metrics from all sources
router.get('/dashboard', async (req, res) => {
  try {
    const sources = await db.getActiveMetricsSources();
    const dashboardData = {
      timestamp: new Date().toISOString(),
      sources: sources.length,
      chains: new Set(),
      totalWorkers: 0,
      pendingPackets: 0,
      failedPackets: 0,
      alerts: [],
      chainDetails: {},
      workerSummary: {}
    };

    // Collect data from all sources
    for (const source of sources) {
      try {
        // Get chains data
        const chainsResponse = await makeRequest(source, '/chains');
        if (chainsResponse.status === 'success' && chainsResponse.result) {
          chainsResponse.result.forEach(chainId => {
            dashboardData.chains.add(chainId);
          });
        }

        // Get state data
        const stateResponse = await makeRequest(source, '/state');
        if (stateResponse.status === 'success' && stateResponse.result) {
          // Count workers
          if (stateResponse.result.workers) {
            Object.values(stateResponse.result.workers).forEach(workers => {
              dashboardData.totalWorkers += workers.length;
            });
            
            // Update worker summary
            Object.keys(stateResponse.result.workers).forEach(workerType => {
              if (!dashboardData.workerSummary[workerType]) {
                dashboardData.workerSummary[workerType] = 0;
              }
              dashboardData.workerSummary[workerType] += stateResponse.result.workers[workerType].length;
            });
          }
        }

        // Get individual chain details
        for (const chainId of dashboardData.chains) {
          if (!dashboardData.chainDetails[chainId]) {
            try {
              const chainResponse = await makeRequest(source, `/chain/${chainId}`);
              if (chainResponse.status === 'success' && chainResponse.result) {
                dashboardData.chainDetails[chainId] = {
                  id: chainId,
                  name: getChainDisplayName(chainId),
                  type: chainResponse.result.type,
                  rpc_addr: chainResponse.result.rpc_addr,
                  account_prefix: chainResponse.result.account_prefix,
                  trusting_period: chainResponse.result.trusting_period,
                  status: 'active'
                };
              }
            } catch (chainError) {
              logger.warn(`Failed to get chain details for ${chainId}:`, chainError.message);
            }
          }
        }

      } catch (sourceError) {
        logger.warn(`Failed to collect data from source ${source.name}:`, sourceError.message);
        dashboardData.alerts.push({
          type: 'source_error',
          source: source.name,
          message: `Failed to collect data: ${sourceError.message}`,
          severity: 'warning',
          timestamp: new Date().toISOString()
        });
      }
    }

    // Convert chains Set to Array with additional info
    dashboardData.chains = Array.from(dashboardData.chains).map(chainId => ({
      id: chainId,
      name: getChainDisplayName(chainId),
      status: dashboardData.chainDetails[chainId] ? 'active' : 'unknown'
    }));

    // Add performance metrics
    dashboardData.performance = {
      chainsCount: dashboardData.chains.length,
      sourcesCount: sources.length,
      workersCount: dashboardData.totalWorkers,
      alertsCount: dashboardData.alerts.length
    };

    res.json(dashboardData);

  } catch (error) {
    logger.error('Get dashboard metrics error:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard metrics' });
  }
});

// Get real-time metrics suitable for WebSocket updates
router.get('/realtime', async (req, res) => {
  try {
    const sources = await db.getActiveMetricsSources();
    const realtimeData = {
      timestamp: new Date().toISOString(),
      metrics: {}
    };

    for (const source of sources) {
      try {
        const stateResponse = await makeRequest(source, '/state');
        if (stateResponse.status === 'success' && stateResponse.result) {
          realtimeData.metrics[source.name] = {
            chains: stateResponse.result.chains?.length || 0,
            workers: Object.values(stateResponse.result.workers || {}).reduce((total, workers) => total + workers.length, 0),
            status: 'active',
            lastUpdate: new Date().toISOString()
          };
        }
      } catch (sourceError) {
        realtimeData.metrics[source.name] = {
          status: 'error',
          error: sourceError.message,
          lastUpdate: new Date().toISOString()
        };
      }
    }

    res.json(realtimeData);

  } catch (error) {
    logger.error('Get realtime metrics error:', error);
    res.status(500).json({ error: 'Failed to retrieve realtime metrics' });
  }
});

// Health check for metrics sources
router.get('/health', async (req, res) => {
  try {
    const sources = await db.getActiveMetricsSources();
    const healthStatus = {
      overall: 'healthy',
      timestamp: new Date().toISOString(),
      sources: {}
    };

    let healthySources = 0;

    for (const source of sources) {
      const startTime = Date.now();
      try {
        const response = await makeRequest(source, '/version', { timeout: 5000 });
        const responseTime = Date.now() - startTime;
        
        healthStatus.sources[source.name] = {
          status: 'healthy',
          responseTime: `${responseTime}ms`,
          lastCheck: new Date().toISOString(),
          version: response.result ? response.result.map(r => `${r.name} v${r.version}`).join(', ') : 'unknown'
        };
        
        healthySources++;
      } catch (error) {
        healthStatus.sources[source.name] = {
          status: 'unhealthy',
          error: error.message,
          lastCheck: new Date().toISOString()
        };
      }
    }

    // Determine overall health
    if (healthySources === 0) {
      healthStatus.overall = 'critical';
    } else if (healthySources < sources.length) {
      healthStatus.overall = 'degraded';
    }

    healthStatus.summary = {
      total: sources.length,
      healthy: healthySources,
      unhealthy: sources.length - healthySources
    };

    res.json(healthStatus);

  } catch (error) {
    logger.error('Get health status error:', error);
    res.status(500).json({ error: 'Failed to retrieve health status' });
  }
});

// Helper functions
async function makeRequest(source, endpoint, options = {}) {
  const url = `${source.url}${endpoint}`;
  const requestOptions = {
    method: 'GET',
    timeout: options.timeout || (source.timeout * 1000) || 30000,
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'IBC-Monitor/1.0.0'
    }
  };

  // Add authentication if configured
  if (source.auth_type && source.auth_credentials) {
    try {
      const credentials = JSON.parse(source.auth_credentials);
      
      if (source.auth_type === 'basic' && credentials.username && credentials.password) {
        requestOptions.auth = {
          username: credentials.username,
          password: credentials.password
        };
      } else if (source.auth_type === 'bearer' && credentials.token) {
        requestOptions.headers['Authorization'] = `Bearer ${credentials.token}`;
      }
    } catch (authError) {
      logger.warn(`Invalid auth credentials for source ${source.name}:`, authError.message);
    }
  }

  const response = await axios(url, requestOptions);
  return response.data;
}

function getChainDisplayName(chainId) {
  const chainNames = {
    'osmosis-1': 'Osmosis',
    'planq_7070-2': 'Planq',
    'gitopia': 'Gitopia',
    'atomone-1': 'AtomOne',
    'vota-ash': 'Dora Vota',
    'cosmoshub-4': 'Cosmos Hub',
    'juno-1': 'Juno',
    'akashnet-2': 'Akash',
    'regen-1': 'Regen',
    'sifchain-1': 'Sifchain'
  };
  
  return chainNames[chainId] || chainId;
}

function getNetworkType(chainId) {
  if (chainId.includes('planq')) return 'EVM Compatible';
  if (chainId.includes('osmosis')) return 'DEX';
  if (chainId.includes('gitopia')) return 'Git Platform';
  return 'Cosmos SDK';
}

function formatGasPrice(gasPrice) {
  if (!gasPrice || !gasPrice.price) return 'Unknown';
  
  const price = parseFloat(gasPrice.price);
  const denom = gasPrice.denom || '';
  
  if (price >= 1e18) {
    return `${(price / 1e18).toFixed(4)} E${denom.replace(/^[au]/, '')}`;
  } else if (price >= 1e15) {
    return `${(price / 1e15).toFixed(4)} P${denom.replace(/^[au]/, '')}`;
  } else if (price >= 1e12) {
    return `${(price / 1e12).toFixed(4)} T${denom.replace(/^[au]/, '')}`;
  } else if (price >= 1e9) {
    return `${(price / 1e9).toFixed(4)} G${denom.replace(/^[au]/, '')}`;
  } else if (price >= 1e6) {
    return `${(price / 1e6).toFixed(4)} M${denom.replace(/^[au]/, '')}`;
  } else if (price >= 1e3) {
    return `${(price / 1e3).toFixed(4)} K${denom.replace(/^[au]/, '')}`;
  }
  
  return `${price} ${denom}`;
}

function parseRpcAddress(address) {
  try {
    const url = new URL(address);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      path: url.pathname
    };
  } catch (error) {
    return { original: address, parsed: false };
  }
}

function getWorkerDisplayName(worker) {
  if (!worker.object) return 'Unknown Worker';
  
  const { type, src_chain_id, dst_chain_id, src_channel_id, dst_client_id } = worker.object;
  
  switch (type) {
    case 'Client':
      return `Client: ${getChainDisplayName(src_chain_id)} → ${getChainDisplayName(dst_chain_id)}`;
    case 'Packet':
      return `Packet: ${getChainDisplayName(src_chain_id)} → ${getChainDisplayName(dst_chain_id)} (${src_channel_id})`;
    case 'Wallet':
      return `Wallet: ${getChainDisplayName(worker.object.chain_id)}`;
    default:
      return `${type}: ${src_chain_id || worker.object.chain_id || 'Unknown'}`;
  }
}

function getWorkerHealthStatus(worker) {
  if (!worker.data) return 'unknown';
  
  if (worker.object?.type === 'Client' && worker.data.misbehaviour) {
    return 'warning';
  }
  
  return 'healthy';
}

module.exports = { router, setDatabase };