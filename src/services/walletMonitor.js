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

  async collectAllBalances() {
    try {
      // First, try to get wallet data from metrics endpoint
      await this.collectFromMetricsEndpoint();
      
      // Fallback to direct API calls if needed
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
      const amount = parseFloat(balance.amount) / Math.pow(10, this.getTokenDecimals(balance.denom));
      
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

  getTokenDecimals(denom) {
    // Common token decimals
    const decimals = {
      'uatom': 6,
      'uosmo': 6,
      'ujuno': 6,
      'ustars': 6,
      'uakt': 6,
      'uluna': 6,
      'uusd': 6,
      'ukrw': 6
    };

    // Default to 6 decimals for most cosmos tokens
    return decimals[denom] || 6;
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

  async updateTokenPrices() {
    try {
      // Get unique denoms from wallet_balances
      const denoms = await this.db.all(`
        SELECT DISTINCT denom FROM wallet_balances 
        WHERE balance > 0
      `);

      // Update prices from CoinGecko or similar service
      for (const { denom } of denoms) {
        try {
          const priceData = await this.fetchTokenPrice(denom);
          if (priceData) {
            await this.db.updateTokenPrice(denom, priceData);
            logger.debug(`Updated price for ${denom}: $${priceData.priceUsd}`);
          }
        } catch (error) {
          logger.debug(`Failed to update price for ${denom}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error('Error updating token prices:', error);
    }
  }

  async fetchTokenPrice(denom) {
    // Map common denoms to CoinGecko IDs
    const coinGeckoIds = {
      'uatom': 'cosmos',
      'uosmo': 'osmosis',
      'ujuno': 'juno-network',
      'ustars': 'stargaze',
      'uakt': 'akash-network'
    };

    const coinId = coinGeckoIds[denom];
    if (!coinId) {
      return null; // Skip unknown tokens
    }

    try {
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price`,
        {
          params: {
            ids: coinId,
            vs_currencies: 'usd',
            include_market_cap: 'true',
            include_24hr_vol: 'true',
            include_24hr_change: 'true'
          },
          timeout: 10000
        }
      );

      const data = response.data[coinId];
      if (data) {
        return {
          symbol: denom.replace('u', '').toUpperCase(),
          name: coinId.charAt(0).toUpperCase() + coinId.slice(1),
          priceUsd: data.usd,
          marketCapUsd: data.usd_market_cap,
          volume24hUsd: data.usd_24h_vol,
          change24h: data.usd_24h_change
        };
      }
    } catch (error) {
      logger.debug(`CoinGecko API error for ${coinId}: ${error.message}`);
    }

    return null;
  }
}

async function startWalletMonitoring(database, websocketService) {
  const monitor = new WalletMonitor(database, websocketService);
  
  // Update token prices first
  await monitor.updateTokenPrices();
  
  // Start monitoring
  await monitor.start();
  
  // Update prices periodically (every hour)
  setInterval(async () => {
    try {
      await monitor.updateTokenPrices();
    } catch (error) {
      logger.error('Price update error:', error);
    }
  }, 60 * 60 * 1000); // 1 hour

  return monitor;
}

module.exports = {
  WalletMonitor,
  startWalletMonitoring
};