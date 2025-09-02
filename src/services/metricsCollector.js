const axios = require('axios');
const cron = require('node-cron');
const logger = require('../utils/logger');

class MetricsCollector {
  constructor(database, websocketServer) {
    this.db = database;
    this.wss = websocketServer;
    this.collectors = new Map(); // Store active collectors
    this.lastMetrics = new Map(); // Cache last metrics for comparison
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Metrics collector is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting metrics collection service...');

    // Initial collection
    await this.collectFromAllSources();

    // Start periodic collection
    this.startPeriodicCollection();

    logger.info('Metrics collection service started');
  }

  async stop() {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Stop all collectors
    for (const [sourceId, collector] of this.collectors) {
      if (collector.task) {
        collector.task.stop();
      }
    }
    
    this.collectors.clear();
    logger.info('Metrics collection service stopped');
  }

  async collectFromAllSources() {
    try {
      const sources = await this.db.getActiveMetricsSources();
      
      for (const source of sources) {
        await this.collectFromSource(source);
      }
    } catch (error) {
      logger.error('Error collecting from all sources:', error);
    }
  }

  async collectFromSource(source) {
    const startTime = Date.now();
    
    try {
      logger.debug(`Collecting metrics from ${source.name} (${source.url})`);

      // Collect different types of data based on source type
      const metricsData = {};

      if (source.type === 'hermes') {
        metricsData.version = await this.makeRequest(source, '/version');
        metricsData.chains = await this.makeRequest(source, '/chains');
        metricsData.state = await this.makeRequest(source, '/state');
        
        // Get individual chain data
        if (metricsData.chains?.status === 'success' && Array.isArray(metricsData.chains.result)) {
          metricsData.chainDetails = {};
          
          for (const chainId of metricsData.chains.result.slice(0, 10)) { // Limit to first 10 chains
            try {
              metricsData.chainDetails[chainId] = await this.makeRequest(source, `/chain/${chainId}`);
            } catch (chainError) {
              logger.warn(`Failed to get chain data for ${chainId} from ${source.name}:`, chainError.message);
            }
          }
        }
      } else if (source.type === 'prometheus') {
        metricsData.metrics = await this.makeRequest(source, '/metrics');
      }

      // Process and analyze the metrics
      const analysis = this.analyzeMetrics(source, metricsData);

      // Store the metrics data (you might want to implement this)
      // await this.storeMetrics(source.id, metricsData, analysis);

      // Broadcast updates via WebSocket
      this.broadcastMetricsUpdate(source, metricsData, analysis);

      // Update last metrics cache
      this.lastMetrics.set(source.id, {
        timestamp: new Date().toISOString(),
        data: metricsData,
        analysis
      });

      const responseTime = Date.now() - startTime;
      logger.logMetrics(source, true, null, responseTime);

    } catch (error) {
      const responseTime = Date.now() - startTime;
      logger.logMetrics(source, false, error, responseTime);
      
      // Broadcast error status
      this.broadcastSourceError(source, error);
    }
  }

  async makeRequest(source, endpoint) {
    const url = `${source.url}${endpoint}`;
    const options = {
      method: 'GET',
      timeout: (source.timeout || 30) * 1000,
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
          options.auth = {
            username: credentials.username,
            password: credentials.password
          };
        } else if (source.auth_type === 'bearer' && credentials.token) {
          options.headers['Authorization'] = `Bearer ${credentials.token}`;
        }
      } catch (authError) {
        logger.warn(`Invalid auth credentials for source ${source.name}:`, authError.message);
      }
    }

    const response = await axios(url, options);
    return response.data;
  }

  analyzeMetrics(source, metricsData) {
    const analysis = {
      timestamp: new Date().toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      status: 'healthy',
      chains: [],
      workers: [],
      alerts: [],
      summary: {}
    };

    try {
      if (source.type === 'hermes') {
        // Analyze Hermes data
        if (metricsData.chains?.status === 'success') {
          analysis.chains = Array.isArray(metricsData.chains.result) 
            ? metricsData.chains.result.map(chainId => ({
                id: chainId,
                name: this.getChainDisplayName(chainId),
                status: 'active'
              }))
            : [];
        }

        if (metricsData.state?.status === 'success' && metricsData.state.result?.workers) {
          const workers = metricsData.state.result.workers;
          let totalWorkers = 0;
          
          Object.keys(workers).forEach(workerType => {
            const workerList = workers[workerType] || [];
            totalWorkers += workerList.length;
            
            workerList.forEach(worker => {
              analysis.workers.push({
                id: worker.id,
                type: workerType,
                object: worker.object,
                data: worker.data,
                displayName: this.getWorkerDisplayName(worker),
                status: this.getWorkerStatus(worker)
              });
            });
          });
          
          analysis.summary.totalWorkers = totalWorkers;
          analysis.summary.workersByType = Object.fromEntries(
            Object.entries(workers).map(([type, list]) => [type, list.length])
          );
        }

        // Check for issues and generate alerts
        this.checkForAlerts(source, metricsData, analysis);
      }

      // Set overall status based on alerts
      const criticalAlerts = analysis.alerts.filter(alert => alert.severity === 'critical');
      const warningAlerts = analysis.alerts.filter(alert => alert.severity === 'warning');
      
      if (criticalAlerts.length > 0) {
        analysis.status = 'critical';
      } else if (warningAlerts.length > 0) {
        analysis.status = 'warning';
      }

    } catch (error) {
      logger.error(`Error analyzing metrics from ${source.name}:`, error);
      analysis.status = 'error';
      analysis.error = error.message;
    }

    return analysis;
  }

  checkForAlerts(source, metricsData, analysis) {
    try {
      // Check for worker issues
      if (metricsData.state?.result?.workers) {
        Object.entries(metricsData.state.result.workers).forEach(([workerType, workers]) => {
          workers.forEach(worker => {
            // Check for client misbehaviour
            if (workerType === 'Client' && worker.data?.misbehaviour) {
              analysis.alerts.push({
                type: 'client_misbehaviour',
                severity: 'warning',
                source: source.name,
                chain: this.extractChainFromWorker(worker),
                message: `Client misbehaviour detected: ${worker.object?.dst_chain_id} -> ${worker.object?.src_chain_id}`,
                data: worker
              });
            }

            // Check for packet issues
            if (workerType === 'Packet' && worker.data) {
              // Add packet-specific checks here
            }
          });
        });
      }

      // Check chain connectivity
      if (metricsData.chainDetails) {
        Object.entries(metricsData.chainDetails).forEach(([chainId, chainData]) => {
          if (chainData.status !== 'success') {
            analysis.alerts.push({
              type: 'chain_connection_error',
              severity: 'critical',
              source: source.name,
              chain: chainId,
              message: `Failed to connect to chain ${chainId}`,
              data: chainData
            });
          }
        });
      }

    } catch (error) {
      logger.error(`Error checking for alerts from ${source.name}:`, error);
    }
  }

  broadcastMetricsUpdate(source, metricsData, analysis) {
    if (!this.wss) return;

    const updateMessage = {
      type: 'metrics_update',
      data: {
        source: {
          id: source.id,
          name: source.name,
          type: source.type
        },
        timestamp: new Date().toISOString(),
        analysis: {
          status: analysis.status,
          chains: analysis.chains,
          summary: analysis.summary,
          alertsCount: analysis.alerts.length
        },
        // Include limited raw data for dashboard
        raw: {
          chainsCount: analysis.chains.length,
          workersCount: analysis.summary.totalWorkers || 0
        }
      }
    };

    // Broadcast to subscribers
    this.wss.broadcast(updateMessage, (client) => {
      return client.subscriptions.has('metrics') || client.subscriptions.has('chain_updates');
    });

    // Send alerts to alert subscribers
    if (analysis.alerts.length > 0) {
      this.wss.broadcast({
        type: 'alerts_update',
        data: {
          source: source.name,
          alerts: analysis.alerts,
          timestamp: new Date().toISOString()
        }
      }, (client) => {
        return client.subscriptions.has('alerts');
      });
    }
  }

  broadcastSourceError(source, error) {
    if (!this.wss) return;

    this.wss.broadcast({
      type: 'source_error',
      data: {
        source: {
          id: source.id,
          name: source.name
        },
        error: error.message,
        timestamp: new Date().toISOString()
      }
    }, (client) => {
      return client.subscriptions.has('metrics') || client.subscriptions.has('system_status');
    });
  }

  startPeriodicCollection() {
    // Schedule collection based on individual source refresh intervals
    cron.schedule('*/10 * * * * *', async () => { // Every 10 seconds
      if (!this.isRunning) return;

      try {
        const sources = await this.db.getActiveMetricsSources();
        
        for (const source of sources) {
          const lastCollection = this.lastMetrics.get(source.id);
          const refreshInterval = (source.refresh_interval || 10) * 1000; // Convert to milliseconds
          
          // Check if it's time to collect from this source
          if (!lastCollection || 
              (Date.now() - new Date(lastCollection.timestamp).getTime()) >= refreshInterval) {
            await this.collectFromSource(source);
          }
        }
      } catch (error) {
        logger.error('Error in periodic collection:', error);
      }
    });
  }

  // Utility methods
  getChainDisplayName(chainId) {
    const chainNames = {
      'osmosis-1': 'Osmosis',
      'planq_7070-2': 'Planq',
      'gitopia': 'Gitopia',
      'atomone-1': 'AtomOne',
      'vota-ash': 'Dora Vota'
    };
    return chainNames[chainId] || chainId;
  }

  getWorkerDisplayName(worker) {
    if (!worker.object) return 'Unknown Worker';
    
    const { type, src_chain_id, dst_chain_id } = worker.object;
    
    switch (type) {
      case 'Client':
        return `${this.getChainDisplayName(src_chain_id)} → ${this.getChainDisplayName(dst_chain_id)}`;
      case 'Packet':
        return `${this.getChainDisplayName(src_chain_id)} → ${this.getChainDisplayName(dst_chain_id)}`;
      case 'Wallet':
        return this.getChainDisplayName(worker.object.chain_id);
      default:
        return `${type}`;
    }
  }

  getWorkerStatus(worker) {
    if (!worker.data) return 'unknown';
    
    if (worker.object?.type === 'Client' && worker.data.misbehaviour) {
      return 'warning';
    }
    
    return 'healthy';
  }

  extractChainFromWorker(worker) {
    if (!worker.object) return 'unknown';
    return worker.object.src_chain_id || worker.object.chain_id || 'unknown';
  }

  // Public methods
  getLastMetrics(sourceId) {
    return this.lastMetrics.get(sourceId);
  }

  getAllLastMetrics() {
    return Object.fromEntries(this.lastMetrics);
  }
}

// Factory function to create and start metrics collector
async function startMetricsCollection(database, websocketServer) {
  const collector = new MetricsCollector(database, websocketServer);
  await collector.start();
  return collector;
}

module.exports = {
  MetricsCollector,
  startMetricsCollection
};