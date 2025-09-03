const axios = require('axios');
const logger = require('../utils/logger');

class WalletBalanceService {
  constructor(database, websocketService) {
    this.db = database;
    this.ws = websocketService;
    // Force IPv4 to avoid DNS resolution issues
    this.metricsEndpoint = process.env.METRICS_ENDPOINT || 'http://127.0.0.1:4001/metrics';
    this.cosmosDirectoryCache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
    this.isRunning = false;
    this.refreshInterval = parseInt(process.env.WALLET_BALANCE_REFRESH_INTERVAL) || 30; // seconds
    this.lastSuccessfulFetch = null;
    this.errorCount = 0;
    this.maxRetries = 3;
    this.backoffMultiplier = 2;
    this.maxBackoffInterval = 300; // 5 minutes max backoff
    this.requestTimeout = 10000; // 10 seconds
    this.rateLimitDelay = 1000; // 1 second between API calls
    this.isCollecting = false; // Prevent concurrent collections
    
    // Create dedicated HTTP agent to avoid connection pooling issues
    const http = require('http');
    this.httpAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
      family: 4 // Force IPv4
    });
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Wallet balance service is already running');
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();
    logger.info('Starting wallet balance service...');

    // Initialize database tables first
    const tablesInitialized = await this.initializeDatabaseTables();
    if (!tablesInitialized) {
      logger.warn('Database tables initialization failed, some features may not work properly');
    }

    // Wait for metrics endpoint to be ready (graceful startup)
    const isReady = await this.waitForMetricsEndpoint();
    if (!isReady) {
      logger.warn('Metrics endpoint not ready, starting with periodic checks only');
    } else {
      // Initial collection only if endpoint is ready
      try {
        await this.collectAndProcessBalances();
      } catch (error) {
        logger.warn('Initial collection failed, continuing with periodic checks:', error.message);
      }
    }

    // Set up periodic collection
    this.intervalId = setInterval(async () => {
      try {
        await this.collectAndProcessBalances();
      } catch (error) {
        logger.error('Wallet balance service error:', error);
      }
    }, this.refreshInterval * 1000);

    logger.info('Wallet balance service started');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Wallet balance service stopped');
  }

  async initializeDatabaseTables() {
    try {
      if (!this.db || !this.db.run) {
        logger.warn('Database not available, skipping table initialization');
        return false;
      }

      logger.info('Initializing database tables for wallet balance service...');
      
      // Create token_decimals table
      const createTableResult = await this.db.run(`
        CREATE TABLE IF NOT EXISTS token_decimals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chain_id TEXT NOT NULL,
          denom TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(chain_id, denom)
        )
      `);
      
      logger.info('✅ token_decimals table created/verified successfully');
      
      // Verify table exists by querying its schema
      const tableInfo = await this.db.all(`PRAGMA table_info(token_decimals)`);
      logger.debug(`token_decimals table has ${tableInfo.length} columns:`, 
        tableInfo.map(col => col.name).join(', '));
      
      // Test table access
      const testQuery = await this.db.get(`SELECT COUNT(*) as count FROM token_decimals`);
      logger.info(`token_decimals table is accessible with ${testQuery.count} existing records`);
      
      return true;
      
    } catch (error) {
      logger.error('❌ Failed to initialize database tables:', error.message);
      logger.error('Error details:', error.stack);
      return false;
    }
  }

  async waitForMetricsEndpoint(maxWaitTime = 30000, checkInterval = 2000) {
    logger.info(`Waiting for metrics endpoint to be ready: ${this.metricsEndpoint}`);
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const axios = require('axios');
        await axios.get(this.metricsEndpoint, {
          timeout: 5000,
          validateStatus: (status) => status === 200,
          httpAgent: this.httpAgent
        });
        
        logger.info('✅ Metrics endpoint is ready');
        return true;
        
      } catch (error) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        logger.debug(`Metrics endpoint not ready (${elapsed}s): ${error.message}`);
        
        // Wait before next check
        await this.sleep(checkInterval);
      }
    }
    
    logger.warn(`❌ Metrics endpoint not ready after ${maxWaitTime/1000}s, proceeding anyway`);
    return false;
  }

  async collectAndProcessBalances() {
    // Prevent concurrent collections
    if (this.isCollecting) {
      logger.debug('Collection already in progress, skipping concurrent request');
      return [];
    }
    
    this.isCollecting = true;
    const startTime = Date.now();
    let retryCount = 0;
    
    while (retryCount <= this.maxRetries) {
      try {
        // Fetch wallet balance metrics with retry logic
        const balances = await this.fetchWalletBalanceMetricsWithRetry();
        
        if (!balances || balances.length === 0) {
          logger.debug('No wallet balance metrics found');
          this.resetErrorCount();
          return [];
        }

        logger.info(`Processing ${balances.length} wallet balance metrics`);

        // Process balances in batches for better performance
        const batchSize = 10;
        const processedBalances = [];
        
        for (let i = 0; i < balances.length; i += batchSize) {
          const batch = balances.slice(i, i + batchSize);
          const batchResults = await Promise.allSettled(
            batch.map(balance => this.processWalletBalance(balance))
          );

          batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
              processedBalances.push(result.value);
            } else {
              logger.error(`Failed to process balance for ${batch[index].account}:`, 
                result.reason?.message || 'Unknown error');
            }
          });

          // Rate limiting between batches
          if (i + batchSize < balances.length) {
            await this.sleep(this.rateLimitDelay);
          }
        }

        // Update database in transaction if possible
        await this.updateBalancesInDatabase(processedBalances);

        // Broadcast updates
        this.broadcastBalanceUpdates(processedBalances);

        const duration = Date.now() - startTime;
        logger.info(`Successfully processed ${processedBalances.length}/${balances.length} wallet balances in ${duration}ms`);

        this.resetErrorCount();
        this.lastSuccessfulFetch = new Date();
        this.isCollecting = false;
        return processedBalances;

      } catch (error) {
        retryCount++;
        this.errorCount++;
        this.lastFailureTime = Date.now();
        
        // Enhanced error logging with more context
        const errorContext = {
          message: error.message,
          code: error.code,
          status: error.response?.status,
          statusText: error.response?.statusText,
          url: this.metricsEndpoint,
          timeout: this.requestTimeout,
          attempt: retryCount,
          maxRetries: this.maxRetries + 1
        };
        
        logger.error(`Error collecting wallet balances (attempt ${retryCount}/${this.maxRetries + 1}):`, error.message);
        logger.error('Error context:', errorContext);
        
        if (retryCount <= this.maxRetries) {
          const backoffTime = Math.min(
            1000 * Math.pow(this.backoffMultiplier, retryCount - 1),
            this.maxBackoffInterval * 1000
          );
          logger.info(`Retrying in ${backoffTime}ms...`);
          await this.sleep(backoffTime);
        }
      }
    }

    logger.error('Failed to collect wallet balances after all retries');
    
    // Log final error summary for troubleshooting
    logger.error('Final error summary:', {
      totalAttempts: this.maxRetries + 1,
      errorCount: this.errorCount,
      lastFailureTime: new Date(this.lastFailureTime).toISOString(),
      metricsEndpoint: this.metricsEndpoint,
      requestTimeout: this.requestTimeout,
      circuitBreakerOpen: this.isCircuitBreakerOpen()
    });
    
    this.isCollecting = false;
    return [];
  }

  async fetchWalletBalanceMetricsWithRetry() {
    let lastError;
    
    // Try with different timeout strategies if needed
    const timeoutStrategies = [this.requestTimeout, this.requestTimeout * 2, this.requestTimeout * 3];
    
    for (let i = 0; i < timeoutStrategies.length; i++) {
      try {
        const originalTimeout = this.requestTimeout;
        this.requestTimeout = timeoutStrategies[i];
        
        logger.debug(`Attempting to fetch metrics with timeout: ${this.requestTimeout}ms`);
        const result = await this.fetchWalletBalanceMetrics();
        
        // Restore original timeout on success
        this.requestTimeout = originalTimeout;
        return result;
        
      } catch (error) {
        lastError = error;
        logger.debug(`Fetch attempt ${i + 1} failed with timeout ${timeoutStrategies[i]}ms:`, error.message);
        
        // Restore original timeout before next attempt
        this.requestTimeout = timeoutStrategies[0];
        
        // Don't wait between timeout strategy attempts if this is the last one
        if (i < timeoutStrategies.length - 1) {
          await this.sleep(500); // Short delay between timeout strategies
        }
      }
    }
    
    // If all timeout strategies fail, throw the last error
    throw lastError;
  }

  resetErrorCount() {
    if (this.errorCount > 0) {
      logger.info('Error count reset after successful operation');
      this.errorCount = 0;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async fetchWalletBalanceMetrics() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

      const response = await axios.get(this.metricsEndpoint, {
        timeout: this.requestTimeout,
        signal: controller.signal,
        headers: {
          'User-Agent': 'IBC-Monitor-WalletBalance/1.0',
          'Accept': 'text/plain',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        validateStatus: (status) => status === 200,
        maxRedirects: 3,
        httpAgent: this.httpAgent,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      clearTimeout(timeoutId);

      if (!response.data || typeof response.data !== 'string') {
        throw new Error('Invalid metrics data format');
      }

      const metricsText = response.data;
      const balances = this.parseWalletBalanceMetrics(metricsText);
      
      if (balances.length === 0) {
        logger.warn('No wallet balance metrics found in response');
      }
      
      return balances;

    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.requestTimeout}ms`);
      }
      
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      }
      
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Connection refused - metrics endpoint may be down');
      }
      
      throw new Error(`Network error: ${error.message}`);
    }
  }

  parseWalletBalanceMetrics(metricsText) {
    const balances = [];
    const lines = metricsText.split('\n');
    
    logger.debug(`Parsing ${lines.length} lines from metrics response`);
    
    // Find wallet_balance lines for debugging
    const walletBalanceLines = lines.filter(line => line.includes('wallet_balance{'));
    logger.debug(`Found ${walletBalanceLines.length} wallet_balance lines`);
    
    for (const line of lines) {
      // Parse wallet_balance metrics
      const walletBalanceMatch = line.match(/^wallet_balance\{account="([^"]+)",chain="([^"]+)",denom="([^"]+)",otel_scope_name="([^"]+)"\}\s+(\d+(?:\.\d+)?)/);
      
      if (walletBalanceMatch) {
        const [, account, chain, denom, scope, value] = walletBalanceMatch;
        
        balances.push({
          account,
          chain,
          denom,
          rawValue: value,
          scope,
          timestamp: new Date().toISOString()
        });
        
        logger.debug(`Parsed balance: ${chain} - ${denom}: ${value}`);
      }
    }

    logger.debug(`Successfully parsed ${balances.length} wallet balances`);
    return balances;
  }

  async processWalletBalance(balance) {
    try {
      // Get chain info and decimals
      const chainInfo = await this.getChainInfo(balance.chain);
      const decimals = await this.getTokenDecimals(balance.chain, balance.denom);
      
      // Convert raw value to human readable
      const humanReadableBalance = this.convertToHumanReadable(balance.rawValue, decimals);
      
      return {
        account: balance.account,
        chain: balance.chain,
        chainName: chainInfo?.chainName || balance.chain,
        denom: balance.denom,
        symbol: balance.denom.replace('u', '').toUpperCase(),
        rawBalance: balance.rawValue,
        balance: humanReadableBalance,
        decimals: decimals,
        timestamp: balance.timestamp,
        scope: balance.scope
      };

    } catch (error) {
      logger.error(`Error processing balance for ${balance.account}:`, error);
      return null;
    }
  }

  async getChainInfo(chainId) {
    try {
      const cacheKey = `chain_info_${chainId}`;
      const cached = this.cosmosDirectoryCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
        return cached.data;
      }

      // Fetch from cosmos.directory
      const response = await axios.get(`https://chains.cosmos.directory/${chainId}`, {
        timeout: 5000,
        headers: {
          'User-Agent': 'IBC-Monitor/1.0'
        }
      });

      const chainInfo = {
        chainId: response.data.chain_id,
        chainName: response.data.chain_name,
        prettyName: response.data.pretty_name,
        bech32Prefix: response.data.bech32_prefix,
        decimals: response.data.decimals
      };

      // Cache the result
      this.cosmosDirectoryCache.set(cacheKey, {
        data: chainInfo,
        timestamp: Date.now()
      });

      return chainInfo;

    } catch (error) {
      logger.debug(`Failed to get chain info for ${chainId} from cosmos.directory:`, error.message);
      return {
        chainId,
        chainName: chainId,
        prettyName: chainId
      };
    }
  }

  async getTokenDecimals(chainId, denom) {
    try {
      // First check database for cached decimals
      const cachedDecimals = await this.getDecimalsFromDatabase(chainId, denom);
      if (cachedDecimals !== null) {
        return cachedDecimals;
      }

      // Try to fetch from chain API endpoint first
      let decimals = await this.fetchDecimalsFromChainAPI(chainId, denom);
      
      // If chain API fails, fallback to cosmos.directory
      if (decimals === null) {
        decimals = await this.fetchDecimalsFromDirectory(chainId, denom);
      }
      
      // Save to database for future use
      await this.saveDecimalsToDatabase(chainId, denom, decimals);
      
      return decimals;

    } catch (error) {
      logger.debug(`Failed to get decimals for ${denom} on ${chainId}:`, error.message);
      return this.getFallbackDecimals(denom);
    }
  }

  async getDecimalsFromDatabase(chainId, denom) {
    try {
      if (!this.db || !this.db.get) {
        logger.debug('Database not available for decimals lookup');
        return null;
      }

      const result = await this.db.get(`
        SELECT decimals FROM token_decimals 
        WHERE chain_id = ? AND denom = ?
      `, [chainId, denom]);
      
      return result ? result.decimals : null;
    } catch (error) {
      logger.debug('Error getting decimals from database:', error.message);
      return null;
    }
  }

  async fetchDecimalsFromChainAPI(chainId, denom) {
    try {
      // Get chain API endpoint from environment variables
      const envKey = `${chainId.toUpperCase().replace(/-/g, '_')}_REST_ENDPOINT`;
      const chainEndpoint = process.env[envKey];
      
      if (!chainEndpoint) {
        logger.debug(`No chain API endpoint configured for ${chainId} (${envKey})`);
        return null;
      }

      // Multiple strategies to fetch decimals from different chain API formats
      const strategies = [
        // Strategy 1: Single denom metadata endpoint
        async () => {
          const response = await axios.get(`${chainEndpoint}/cosmos/bank/v1beta1/denom_metadata/${denom}`, {
            timeout: 5000,
            headers: { 'User-Agent': 'IBC-Monitor/1.0' }
          });
          
          if (response.data?.metadata?.denom_units) {
            return this.parseMetadataDecimals(response.data.metadata, denom);
          }
          return null;
        },

        // Strategy 2: All denoms metadata endpoint (find specific denom)
        async () => {
          const response = await axios.get(`${chainEndpoint}/cosmos/bank/v1beta1/denoms_metadata`, {
            timeout: 8000,
            headers: { 'User-Agent': 'IBC-Monitor/1.0' }
          });
          
          if (response.data?.metadatas) {
            const metadata = response.data.metadatas.find(meta => 
              meta.base === denom || 
              meta.denom_units?.some(unit => unit.denom === denom)
            );
            
            if (metadata) {
              return this.parseMetadataDecimals(metadata, denom);
            }
          }
          return null;
        },

        // Strategy 3: Supply endpoint (check if token exists, use chain-specific defaults)
        async () => {
          const response = await axios.get(`${chainEndpoint}/cosmos/bank/v1beta1/supply/${denom}`, {
            timeout: 5000,
            headers: { 'User-Agent': 'IBC-Monitor/1.0' }
          });
          
          // Some chains include decimals info in supply response
          if (response.data?.amount?.denom === denom && response.data?.decimals) {
            logger.debug(`Found decimals in supply endpoint for ${chainId}/${denom}: ${response.data.decimals}`);
            return response.data.decimals;
          }
          
          // If token exists in supply but no decimals, check if it's a native token
          if (response.data?.amount?.denom === denom) {
            const nativeDecimals = this.getNativeTokenDecimals(chainId, denom);
            if (nativeDecimals !== null) {
              logger.debug(`Using native token decimals for ${chainId}/${denom}: ${nativeDecimals}`);
              return nativeDecimals;
            }
          }
          
          return null;
        }
      ];

      // Try each strategy until one succeeds
      for (let i = 0; i < strategies.length; i++) {
        try {
          const result = await strategies[i]();
          if (result !== null) {
            logger.debug(`Fetched decimals from chain API strategy ${i + 1} for ${chainId}/${denom}: ${result}`);
            return result;
          }
        } catch (strategyError) {
          logger.debug(`Chain API strategy ${i + 1} failed for ${chainId}/${denom}:`, strategyError.message);
          continue;
        }
      }

      logger.debug(`No metadata found in chain API for ${chainId}/${denom} after trying all strategies`);
      return null;

    } catch (error) {
      logger.debug(`Failed to fetch decimals from chain API for ${chainId}/${denom}:`, error.message);
      return null;
    }
  }

  parseMetadataDecimals(metadata, denom) {
    if (!metadata?.denom_units) {
      return null;
    }

    // Strategy 1: Look for display unit with exponent
    if (metadata.display) {
      const displayUnit = metadata.denom_units.find(unit => unit.denom === metadata.display);
      if (displayUnit && displayUnit.exponent !== undefined) {
        return displayUnit.exponent;
      }
    }

    // Strategy 2: Find unit with highest exponent for the denom
    const matchingUnits = metadata.denom_units.filter(unit => 
      unit.denom === denom || 
      unit.denom === metadata.base ||
      unit.aliases?.includes(denom)
    );

    if (matchingUnits.length > 0) {
      // Get the unit with highest exponent (usually the display unit)
      const maxExponentUnit = matchingUnits.reduce((max, unit) => 
        (unit.exponent || 0) > (max.exponent || 0) ? unit : max
      );
      
      if (maxExponentUnit.exponent !== undefined) {
        return maxExponentUnit.exponent;
      }
    }

    // Strategy 3: Look for any unit with non-zero exponent
    const nonZeroExponentUnits = metadata.denom_units.filter(unit => 
      unit.exponent && unit.exponent > 0
    );

    if (nonZeroExponentUnits.length === 1) {
      return nonZeroExponentUnits[0].exponent;
    }

    return null;
  }

  getNativeTokenDecimals(chainId, denom) {
    // Known native tokens for specific chains
    const nativeTokens = {
      // Cosmos SDK chains typically use 6 decimals for native tokens
      'cosmoshub-4': { 'uatom': 6 },
      'osmosis-1': { 'uosmo': 6 },
      'juno-1': { 'ujuno': 6 },
      'stargaze-1': { 'ustars': 6 },
      'akashnet-2': { 'uakt': 6 },
      'atomone-1': { 'uatone': 6, 'uphoton': 6 },
      'gitopia': { 'ulore': 6 },
      
      // EVM-based chains typically use 18 decimals for native tokens
      'planq_7070-2': { 'aplanq': 18 },
      'evmos_9001-2': { 'aevmos': 18 },
      'injective-1': { 'inj': 18 },
      'canto_7700-1': { 'acanto': 18 },
      'vota-ash': { 'peaka': 18 }
    };

    const chainTokens = nativeTokens[chainId];
    if (chainTokens && chainTokens[denom] !== undefined) {
      return chainTokens[denom];
    }

    return null;
  }

  async fetchDecimalsFromDirectory(chainId, denom) {
    try {
      const response = await axios.get(`https://chains.cosmos.directory/${chainId}/assetlist`, {
        timeout: 5000,
        headers: {
          'User-Agent': 'IBC-Monitor/1.0'
        }
      });

      let decimals = 6; // default
      
      if (response.data && response.data.assets) {
        const asset = response.data.assets.find(a => 
          a.base === denom || 
          a.denom_units?.some(unit => unit.denom === denom)
        );
        
        if (asset && asset.denom_units) {
          const displayUnit = asset.denom_units.find(unit => unit.denom === asset.display);
          if (displayUnit) {
            decimals = displayUnit.exponent || 6;
          }
        }
      }

      return decimals;
    } catch (error) {
      logger.debug(`Failed to fetch from cosmos.directory for ${denom}:`, error.message);
      return this.getFallbackDecimals(denom);
    }
  }

  async saveDecimalsToDatabase(chainId, denom, decimals) {
    try {
      if (!this.db || !this.db.run) {
        logger.debug('Database not available for saving decimals');
        return;
      }

      // Create table if it doesn't exist
      await this.db.run(`
        CREATE TABLE IF NOT EXISTS token_decimals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chain_id TEXT NOT NULL,
          denom TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(chain_id, denom)
        )
      `);

      // Insert or update
      await this.db.run(`
        INSERT OR REPLACE INTO token_decimals (chain_id, denom, decimals, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `, [chainId, denom, decimals]);

      logger.debug(`Saved decimals to database: ${chainId}/${denom} = ${decimals}`);
    } catch (error) {
      logger.debug('Error saving decimals to database (skipping):', error.message);
    }
  }

  getFallbackDecimals(denom) {
    // Use smart defaults based on token naming conventions
    // No more hardcoded chain-specific values
    
    // EVM-based tokens (typically start with 'a' but not 'au', or contain planq/evmos patterns)
    if ((denom.startsWith('a') && !denom.startsWith('au')) || 
        denom.includes('planq') || 
        denom.includes('evmos') ||
        denom.includes('injective') ||
        denom.includes('canto')) {
      return 18;
    }
    
    // Most Cosmos SDK native tokens use 6 decimals
    // This covers tokens like: uatom, uosmo, ujuno, ustars, etc.
    return 6;
  }

  // Removed token info fetching - focusing on balances only

  convertToHumanReadable(rawValue, decimals) {
    const divisor = Math.pow(10, decimals);
    const numericValue = parseFloat(rawValue);
    return numericValue / divisor;
  }

  async updateBalancesInDatabase(processedBalances) {
    try {
      if (!this.db) {
        logger.debug('Database not available, skipping balance updates');
        return;
      }

      for (const balance of processedBalances) {
        try {
          // Find or create wallet address
          let walletId = await this.findWalletByAddress(balance.account, balance.chain);
          
          if (!walletId) {
            // Try to create new wallet entry if the method exists
            if (this.db.createWalletAddress) {
              walletId = await this.db.createWalletAddress({
                chainId: balance.chain,
                chainName: balance.chainName,
                address: balance.account,
                addressType: 'relayer'
              });
              
              logger.info(`Created new wallet entry for ${balance.account} on ${balance.chainName}`);
            } else {
              logger.debug('createWalletAddress method not available, skipping wallet creation');
              continue;
            }
          }

          // Update balance if the method exists
          if (this.db.updateWalletBalance) {
            await this.db.updateWalletBalance(
              walletId,
              balance.denom,
              balance.balance,
              null // block height not available from metrics
            );
          } else {
            logger.debug('updateWalletBalance method not available, skipping balance update');
          }
        } catch (balanceError) {
          logger.debug(`Error processing balance for ${balance.account}:`, balanceError.message);
          continue;
        }
      }
    } catch (error) {
      logger.debug('Error updating balances in database (continuing without DB updates):', error.message);
    }
  }

  async findWalletByAddress(address, chainId) {
    try {
      if (!this.db || !this.db.get) {
        return null;
      }

      const result = await this.db.get(`
        SELECT id FROM wallet_addresses 
        WHERE address = ? AND chain_id = ?
      `, [address, chainId]);
      
      return result?.id || null;
    } catch (error) {
      logger.debug('Error finding wallet by address (table may not exist):', error.message);
      return null;
    }
  }

  // Removed token info update - focusing on balances only

  broadcastBalanceUpdates(processedBalances) {
    if (!this.ws) return;

    // Group by chain for organized updates
    const balancesByChain = processedBalances.reduce((acc, balance) => {
      if (!acc[balance.chain]) {
        acc[balance.chain] = {
          chainId: balance.chain,
          chainName: balance.chainName,
          balances: []
        };
      }
      
      acc[balance.chain].balances.push({
        account: balance.account,
        denom: balance.denom,
        symbol: balance.symbol,
        balance: balance.balance,
        rawBalance: balance.rawBalance,
        decimals: balance.decimals
      });
      
      return acc;
    }, {});

    // Broadcast summary update
    this.ws.broadcast({
      type: 'wallet_balances_update',
      data: {
        timestamp: new Date().toISOString(),
        chains: Object.values(balancesByChain),
        totalWallets: processedBalances.length,
        summary: this.generateBalanceSummary(processedBalances)
      }
    });
  }

  generateBalanceSummary(balances) {
    const summary = {
      totalChains: new Set(balances.map(b => b.chain)).size,
      totalWallets: new Set(balances.map(b => b.account)).size,
      totalTokens: new Set(balances.map(b => b.denom)).size,
      chainSummary: {}
    };

    balances.forEach(balance => {
      if (!summary.chainSummary[balance.chain]) {
        summary.chainSummary[balance.chain] = {
          chainName: balance.chainName,
          walletCount: new Set(),
          tokenCount: new Set()
        };
      }
      
      summary.chainSummary[balance.chain].walletCount.add(balance.account);
      summary.chainSummary[balance.chain].tokenCount.add(balance.denom);
    });

    // Convert sets to counts
    Object.keys(summary.chainSummary).forEach(chain => {
      summary.chainSummary[chain].walletCount = summary.chainSummary[chain].walletCount.size;
      summary.chainSummary[chain].tokenCount = summary.chainSummary[chain].tokenCount.size;
    });

    return summary;
  }

  // Public methods for API endpoints
  async getFormattedBalances(chainFilter = null) {
    try {
      // Check circuit breaker
      if (this.isCircuitBreakerOpen()) {
        logger.warn('Circuit breaker is open, using cached data if available');
        return this.getCachedBalances(chainFilter);
      }

      const balances = await this.collectAndProcessBalances();
      
      if (!balances || balances.length === 0) {
        logger.warn('No balances returned from collection process');
        return [];
      }
      
      if (chainFilter) {
        const filtered = balances.filter(b => b.chain === chainFilter);
        logger.debug(`Filtered balances: ${filtered.length} of ${balances.length} for chain ${chainFilter}`);
        return filtered;
      }
      
      logger.debug(`Returning ${balances.length} total balances`);
      return balances;
    } catch (error) {
      logger.error('Error getting formatted balances:', error);
      return this.getCachedBalances(chainFilter);
    }
  }

  isCircuitBreakerOpen() {
    const failureThreshold = 5;
    const timeWindow = 300000; // 5 minutes
    
    if (this.errorCount >= failureThreshold) {
      const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
      return timeSinceLastFailure < timeWindow;
    }
    
    return false;
  }

  getCachedBalances(chainFilter = null) {
    // Return cached balances if available (implement based on your caching strategy)
    logger.debug('Returning cached balances due to circuit breaker');
    return [];
  }

  clearCache() {
    this.cosmosDirectoryCache.clear();
    logger.info('Cosmos directory cache cleared');
  }

  getHealthStatus() {
    const now = Date.now();
    const isHealthy = this.errorCount < 3 && 
                     this.lastSuccessfulFetch && 
                     (now - this.lastSuccessfulFetch.getTime()) < (this.refreshInterval * 2000);

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      lastSuccessfulFetch: this.lastSuccessfulFetch,
      errorCount: this.errorCount,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      cacheSize: this.cosmosDirectoryCache.size,
      isRunning: this.isRunning,
      metricsEndpoint: this.metricsEndpoint,
      refreshInterval: this.refreshInterval,
      circuitBreakerOpen: this.isCircuitBreakerOpen(),
      requestTimeout: this.requestTimeout,
      uptime: this.isRunning ? Math.round((now - (this.startTime || now)) / 1000) : 0
    };
  }

  async testConnectivity() {
    try {
      logger.info('Testing wallet balance service connectivity...');
      const startTime = Date.now();
      
      const balances = await this.fetchWalletBalanceMetrics();
      const duration = Date.now() - startTime;
      
      logger.info(`✅ Connectivity test passed: ${balances.length} wallet balances found in ${duration}ms`);
      return {
        success: true,
        balanceCount: balances.length,
        responseTime: duration,
        endpoint: this.metricsEndpoint
      };
    } catch (error) {
      logger.error('❌ Connectivity test failed:', error.message);
      return {
        success: false,
        error: error.message,
        endpoint: this.metricsEndpoint
      };
    }
  }
}

// Factory function to create and start wallet balance service
async function startWalletBalanceService(database, websocketService) {
  const service = new WalletBalanceService(database, websocketService);
  await service.start();
  return service;
}

module.exports = {
  WalletBalanceService,
  startWalletBalanceService
};