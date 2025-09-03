const axios = require('axios');
const logger = require('../utils/logger');

class WalletMonitor {
  constructor(database, websocketService) {
    this.db = database;
    this.ws = websocketService;
    this.refreshInterval = parseInt(process.env.WALLET_REFRESH_INTERVAL) || 60; // seconds
    this.isRunning = false;
    this.intervalId = null;
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Wallet monitor is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting wallet balance monitoring service...');

    // Initialize database tables first
    await this.initializeDatabaseTables();

    // Initial collection
    await this.collectAllBalances();

    // Set up periodic collection
    this.intervalId = setInterval(async () => {
      try {
        await this.collectAllBalances();
      } catch (error) {
        logger.error('Wallet monitor error:', error);
      }
    }, this.refreshInterval * 1000);

    logger.info('Wallet balance monitoring service started');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Wallet balance monitoring service stopped');
  }

  async initializeDatabaseTables() {
    try {
      if (!this.db || !this.db.run) {
        logger.warn('Database not available, skipping table initialization in wallet monitor');
        return false;
      }

      logger.info('Initializing database tables for wallet monitor...');
      
      // Create token_decimals table (same as walletBalanceService)
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
      
      logger.info('✅ token_decimals table created/verified in wallet monitor');
      
      // Test table access
      const testQuery = await this.db.get(`SELECT COUNT(*) as count FROM token_decimals`);
      logger.debug(`token_decimals table accessible with ${testQuery.count} records`);
      
      return true;
      
    } catch (error) {
      logger.error('❌ Failed to initialize database tables in wallet monitor:', error.message);
      return false;
    }
  }

  async collectFromMetricsEndpoint() {
    try {
      const metricsUrl = process.env.METRICS_ENDPOINT || 'http://localhost:4001/metrics';
      logger.debug(`Fetching wallet balances from metrics endpoint: ${metricsUrl}`);

      const response = await axios.get(metricsUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'IBC-Monitor-WalletBalance/1.0'
        }
      });

      const balances = this.parseWalletBalanceMetrics(response.data);
      
      if (balances.length === 0) {
        logger.debug('No wallet balance metrics found');
        return false;
      }

      logger.info(`Found ${balances.length} wallet balance metrics`);

      // Process each balance
      for (const balance of balances) {
        try {
          await this.processMetricsBalance(balance);
        } catch (error) {
          logger.error(`Failed to process metrics balance for ${balance.account}:`, error.message);
        }
      }

      return true;

    } catch (error) {
      logger.warn('Failed to collect from metrics endpoint:', error.message);
      return false;
    }
  }

  parseWalletBalanceMetrics(metricsText) {
    const balances = [];
    const lines = metricsText.split('\n');
    
    for (const line of lines) {
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
      }
    }

    return balances;
  }

  async processMetricsBalance(balance) {
    try {
      // Find or create wallet
      let walletId = await this.findOrCreateWallet(balance.account, balance.chain);
      
      // Get proper decimals and convert
      const decimals = await this.getTokenDecimals(balance.denom, balance.chain);
      const humanReadableBalance = parseFloat(balance.rawValue) / Math.pow(10, decimals);
      
      // Update balance in database
      const result = await this.db.updateWalletBalance(walletId, balance.denom, humanReadableBalance);
      
      if (Math.abs(result.changeAmount) > 0.000001) {
        logger.debug(`Balance updated from metrics for ${balance.chain} ${balance.denom}: ${result.oldBalance} → ${result.newBalance}`);
        
        // Broadcast balance update via WebSocket
        this.broadcastBalanceUpdate({
          id: walletId,
          chain_id: balance.chain,
          chain_name: this.getChainDisplayName(balance.chain),
          address: balance.account
        }, balance.denom, result);
      }

    } catch (error) {
      logger.error(`Error processing metrics balance for ${balance.account}:`, error);
    }
  }

  async findOrCreateWallet(address, chainId) {
    try {
      // First try to find existing wallet
      const existing = await this.db.get(`
        SELECT id FROM wallet_addresses 
        WHERE address = ? AND chain_id = ?
      `, [address, chainId]);
      
      if (existing) {
        return existing.id;
      }

      // Create new wallet entry
      const walletId = await this.db.createWalletAddress({
        chainId: chainId,
        chainName: this.getChainDisplayName(chainId),
        address: address,
        addressType: 'relayer'
      });

      logger.info(`Created new wallet entry from metrics: ${address} on ${chainId}`);
      return walletId;

    } catch (error) {
      logger.error(`Error finding/creating wallet for ${address}:`, error);
      throw error;
    }
  }

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

  async collectAllBalances() {
    try {
      // First, try to get wallet data from metrics endpoint
      const metricsSuccess = await this.collectFromMetricsEndpoint();
      
      // Fallback to direct API calls if metrics failed
      const wallets = await this.db.getWalletAddresses();
      logger.debug(`Monitoring ${wallets.length} registered wallet addresses`);

      for (const wallet of wallets) {
        try {
          await this.collectWalletBalance(wallet);
          // Small delay to avoid overwhelming the APIs
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error(`Failed to collect balance for ${wallet.chain_name} wallet:`, error.message);
        }
      }

      // Check for low balance alerts
      await this.checkLowBalanceAlerts();
    } catch (error) {
      logger.error('Error collecting wallet balances:', error);
    }
  }

  async collectWalletBalance(wallet) {
    const { id, chain_id, chain_name, address } = wallet;

    // Different APIs based on chain
    let apiUrl;
    let balances = [];

    try {
      switch (chain_id) {
        case 'cosmoshub-4':
          apiUrl = `https://rest.cosmos.directory/cosmoshub/cosmos/bank/v1beta1/balances/${address}`;
          break;
        case 'osmosis-1':
          apiUrl = `https://rest.cosmos.directory/osmosis/cosmos/bank/v1beta1/balances/${address}`;
          break;
        case 'juno-1':
          apiUrl = `https://rest.cosmos.directory/juno/cosmos/bank/v1beta1/balances/${address}`;
          break;
        case 'stargaze-1':
          apiUrl = `https://rest.cosmos.directory/stargaze/cosmos/bank/v1beta1/balances/${address}`;
          break;
        case 'akashnet-2':
          apiUrl = `https://rest.cosmos.directory/akash/cosmos/bank/v1beta1/balances/${address}`;
          break;
        default:
          // Try generic cosmos directory API
          apiUrl = `https://rest.cosmos.directory/${chain_id}/cosmos/bank/v1beta1/balances/${address}`;
      }

      const response = await axios.get(apiUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'IBC-Monitor/1.0'
        }
      });

      if (response.data && response.data.balances) {
        balances = response.data.balances;
      }

      // Also try to get balance from local chain endpoint if available
      const localEndpoint = process.env[`${chain_id.toUpperCase()}_REST_ENDPOINT`];
      if (localEndpoint) {
        try {
          const localResponse = await axios.get(
            `${localEndpoint}/cosmos/bank/v1beta1/balances/${address}`,
            { timeout: 5000 }
          );
          if (localResponse.data && localResponse.data.balances) {
            // Merge with existing balances, preferring local data
            const localBalances = localResponse.data.balances;
            balances = this.mergeBalances(balances, localBalances);
          }
        } catch (localError) {
          // Local endpoint might not be available, continue with public API
          logger.debug(`Local endpoint not available for ${chain_name}: ${localError.message}`);
        }
      }

    } catch (apiError) {
      // If primary API fails, try alternative endpoints
      logger.debug(`Primary API failed for ${chain_name}, trying alternatives: ${apiError.message}`);
      
      const alternativeApis = this.getAlternativeApis(chain_id, address);
      for (const altApi of alternativeApis) {
        try {
          const altResponse = await axios.get(altApi, {
            timeout: 8000,
            headers: { 'User-Agent': 'IBC-Monitor/1.0' }
          });
          if (altResponse.data && altResponse.data.balances) {
            balances = altResponse.data.balances;
            break;
          }
        } catch (altError) {
          continue; // Try next alternative
        }
      }
    }

    // Update balances in database
    let updatedCount = 0;
    for (const balance of balances) {
      const decimals = await this.getTokenDecimals(balance.denom, wallet.chain_id);
      const amount = parseFloat(balance.amount) / Math.pow(10, decimals);
      
      const result = await this.db.updateWalletBalance(id, balance.denom, amount);
      
      if (Math.abs(result.changeAmount) > 0.000001) {
        updatedCount++;
        logger.debug(`Balance changed for ${chain_name} ${balance.denom}: ${result.oldBalance} → ${result.newBalance}`);
        
        // Broadcast balance update via WebSocket
        this.broadcastBalanceUpdate(wallet, balance.denom, result);
      }
    }

    if (updatedCount > 0) {
      logger.info(`Updated ${updatedCount} balances for ${chain_name} wallet`);
    }

    return balances;
  }

  mergeBalances(primary, secondary) {
    const merged = [...primary];
    const primaryDenoms = new Set(primary.map(b => b.denom));
    
    for (const balance of secondary) {
      if (!primaryDenoms.has(balance.denom)) {
        merged.push(balance);
      }
    }
    
    return merged;
  }

  getAlternativeApis(chainId, address) {
    const alternatives = [];
    
    // Add different API providers
    const providers = [
      'cosmos.directory',
      'lcd.cosmos.network',
      'api.cosmos.network'
    ];

    for (const provider of providers) {
      try {
        alternatives.push(`https://rest.${provider}/${chainId}/cosmos/bank/v1beta1/balances/${address}`);
      } catch (e) {
        continue;
      }
    }

    return alternatives;
  }

  async getTokenDecimals(denom, chainId = null) {
    try {
      // First check database for cached decimals
      if (chainId) {
        const result = await this.db.get(`
          SELECT decimals FROM token_decimals 
          WHERE chain_id = ? AND denom = ?
        `, [chainId, denom]);
        
        if (result) {
          return result.decimals;
        }

        // Try to fetch from chain API endpoint first
        let decimals = await this.fetchDecimalsFromChainAPI(chainId, denom);
        
        // If chain API fails, fallback to cosmos.directory
        if (decimals === null) {
          decimals = await this.fetchDecimalsFromDirectory(chainId, denom);
        }
        
        // Save to database for future use
        if (decimals !== null) {
          await this.saveDecimalsToDatabase(chainId, denom, decimals);
          return decimals;
        }
      }
      
      // Fall back to smart defaults
      return this.getFallbackDecimals(denom);
    } catch (error) {
      logger.debug(`Error getting decimals for ${denom}:`, error.message);
      return this.getFallbackDecimals(denom);
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
          
          // If token exists in supply, check if it's a known native token
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

  async checkLowBalanceAlerts() {
    try {
      const lowBalanceAlerts = await this.db.getLowBalanceAlerts();
      
      for (const alert of lowBalanceAlerts) {
        const alertData = {
          type: 'low_balance',
          severity: alert.usd_value < 5 ? 'critical' : 'warning',
          chain_id: alert.chain_id,
          chain_name: alert.chain_name,
          address: alert.address,
          address_type: alert.address_type,
          token: {
            denom: alert.denom,
            symbol: alert.symbol,
            balance: parseFloat(alert.balance),
            usd_value: parseFloat(alert.usd_value)
          },
          message: `Low balance alert: ${alert.chain_name} ${alert.symbol || alert.denom} wallet has only $${parseFloat(alert.usd_value).toFixed(2)} remaining`
        };

        // Save alert to history
        await this.db.saveAlert({
          alertType: 'low_balance',
          chainName: alert.chain_name,
          severity: alertData.severity,
          message: alertData.message,
          alertData: alertData
        });

        // Broadcast via WebSocket
        this.broadcastAlert(alertData);
      }

      if (lowBalanceAlerts.length > 0) {
        logger.warn(`Found ${lowBalanceAlerts.length} low balance alerts`);
      }
    } catch (error) {
      logger.error('Error checking low balance alerts:', error);
    }
  }

  broadcastBalanceUpdate(wallet, denom, balanceChange) {
    if (this.ws) {
      this.ws.broadcast({
        type: 'balance_update',
        data: {
          wallet_id: wallet.id,
          chain_id: wallet.chain_id,
          chain_name: wallet.chain_name,
          address: wallet.address,
          denom: denom,
          old_balance: balanceChange.oldBalance,
          new_balance: balanceChange.newBalance,
          change_amount: balanceChange.changeAmount,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  broadcastAlert(alertData) {
    if (this.ws) {
      this.ws.broadcast({
        type: 'wallet_alert',
        data: alertData
      });
    }
  }

  // Removed CoinGecko price functionality - focusing on wallet balances only
}

async function startWalletMonitoring(database, websocketService) {
  const monitor = new WalletMonitor(database, websocketService);
  
  // Start monitoring
  await monitor.start();

  return monitor;
}

module.exports = {
  WalletMonitor,
  startWalletMonitoring
};