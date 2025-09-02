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
      }
      
      // Fall back to hardcoded values
      return this.getFallbackDecimals(denom);
    } catch (error) {
      logger.debug(`Error getting decimals for ${denom}:`, error.message);
      return this.getFallbackDecimals(denom);
    }
  }

  getFallbackDecimals(denom) {
    const fallbackDecimals = {
      // Your specific tokens
      'uphoton': 6,   // atomone-1
      'peaka': 18,    // vota-ash
      'ulore': 6,     // gitopia
      'uosmo': 6,     // osmosis-1
      'aplanq': 18,   // planq_7070-2
      
      // Common Cosmos tokens
      'uatom': 6,
      'ujuno': 6,
      'ustars': 6,
      'uakt': 6,
      'uluna': 6,
      'uusd': 6,
      'ukrw': 6,
      'uion': 6,
      'ustrd': 6,
      'uhuahua': 6,
      'ucmdx': 6
    };

    // Default to 6 decimals for most Cosmos tokens, 18 for EVM-based chains
    if (denom.startsWith('a') && !denom.startsWith('au')) {
      return fallbackDecimals[denom] || 18;
    }
    
    return fallbackDecimals[denom] || 6;
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