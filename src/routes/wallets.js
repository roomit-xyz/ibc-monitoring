const express = require('express');
const validator = require('validator');
const { requireRole } = require('../middleware/auth');
const Database = require('../database/database');
const logger = require('../utils/logger');

const router = express.Router();
let db = null;

// Function to set database instance from server
const setDatabase = (database) => {
  db = database;
};

// Get all wallet addresses
router.get('/addresses', async (req, res) => {
  try {
    const { chainId } = req.query;
    const addresses = await db.getWalletAddresses(chainId);
    
    res.json({
      success: true,
      addresses
    });
  } catch (error) {
    logger.error('Get wallet addresses error:', error);
    res.status(500).json({ error: 'Failed to retrieve wallet addresses' });
  }
});

// Add new wallet address (admin only)
router.post('/addresses', requireRole('admin'), async (req, res) => {
  try {
    const { chainId, chainName, address, addressType } = req.body;

    // Validate input
    if (!chainId || !chainName || !address) {
      return res.status(400).json({ error: 'Chain ID, chain name, and address are required' });
    }

    // Validate address format (basic validation)
    if (!validator.isLength(address, { min: 20, max: 100 })) {
      return res.status(400).json({ error: 'Invalid address format' });
    }

    // Validate address type
    const validTypes = ['relayer', 'fee', 'gas'];
    if (addressType && !validTypes.includes(addressType)) {
      return res.status(400).json({ error: 'Invalid address type' });
    }

    const walletId = await db.createWalletAddress({
      chainId: validator.escape(chainId),
      chainName: validator.escape(chainName),
      address: validator.escape(address),
      addressType: addressType || 'relayer'
    });

    logger.info(`Wallet address added: ${chainName} - ${address} by user ${req.user.username}`);

    res.json({
      success: true,
      walletId,
      message: 'Wallet address added successfully'
    });
  } catch (error) {
    logger.error('Add wallet address error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'Wallet address already exists for this chain' });
    } else {
      res.status(500).json({ error: 'Failed to add wallet address' });
    }
  }
});

// Get wallet balances
router.get('/balances', async (req, res) => {
  try {
    const { walletId, chainId } = req.query;
    
    let balances;
    if (walletId) {
      balances = await db.getWalletBalances(parseInt(walletId));
    } else {
      balances = await db.getWalletBalances();
    }

    // Filter by chain if specified
    if (chainId) {
      balances = balances.filter(b => b.chain_id === chainId);
    }

    // Group balances by chain
    const balancesByChain = balances.reduce((acc, balance) => {
      const chainKey = balance.chain_id;
      if (!acc[chainKey]) {
        acc[chainKey] = {
          chain_id: balance.chain_id,
          chain_name: balance.chain_name,
          wallets: []
        };
      }

      // Find or create wallet in chain
      let wallet = acc[chainKey].wallets.find(w => w.wallet_id === balance.wallet_id);
      if (!wallet) {
        wallet = {
          wallet_id: balance.wallet_id,
          address: balance.address,
          address_type: balance.address_type,
          tokens: [],
          total_usd: 0
        };
        acc[chainKey].wallets.push(wallet);
      }

      // Add token balance
      if (balance.denom) {
        const tokenBalance = {
          denom: balance.denom,
          symbol: balance.symbol,
          token_name: balance.token_name,
          balance: parseFloat(balance.balance) || 0,
          balance_usd: parseFloat(balance.calculated_usd_value) || 0,
          price_usd: parseFloat(balance.price_usd) || 0,
          last_updated: balance.last_updated,
          block_height: balance.block_height
        };
        wallet.tokens.push(tokenBalance);
        wallet.total_usd += tokenBalance.balance_usd;
      }

      return acc;
    }, {});

    res.json({
      success: true,
      balances: Object.values(balancesByChain)
    });
  } catch (error) {
    logger.error('Get wallet balances error:', error);
    res.status(500).json({ error: 'Failed to retrieve wallet balances' });
  }
});

// Get total balances by chain
router.get('/summary', async (req, res) => {
  try {
    const summary = await db.getTotalBalancesByChain();
    
    const totalSummary = {
      total_chains: summary.length,
      total_wallets: summary.reduce((sum, chain) => sum + parseInt(chain.wallet_count), 0),
      total_usd_value: summary.reduce((sum, chain) => sum + parseFloat(chain.total_usd_value || 0), 0),
      chains: summary.map(chain => ({
        chain_id: chain.chain_id,
        chain_name: chain.chain_name,
        wallet_count: parseInt(chain.wallet_count),
        token_count: parseInt(chain.token_count),
        total_usd_value: parseFloat(chain.total_usd_value || 0),
        tokens: chain.tokens ? chain.tokens.split(',') : []
      }))
    };

    res.json({
      success: true,
      summary: totalSummary
    });
  } catch (error) {
    logger.error('Get wallet summary error:', error);
    res.status(500).json({ error: 'Failed to retrieve wallet summary' });
  }
});

// Get balance history
router.get('/history/:walletId', async (req, res) => {
  try {
    const { walletId } = req.params;
    const { denom, limit } = req.query;

    if (!validator.isInt(walletId)) {
      return res.status(400).json({ error: 'Invalid wallet ID' });
    }

    const history = await db.getBalanceHistory(
      parseInt(walletId),
      denom,
      limit ? parseInt(limit) : 100
    );

    res.json({
      success: true,
      history
    });
  } catch (error) {
    logger.error('Get balance history error:', error);
    res.status(500).json({ error: 'Failed to retrieve balance history' });
  }
});

// Update wallet balance (admin only)
router.post('/balances/:walletId', requireRole('admin'), async (req, res) => {
  try {
    const { walletId } = req.params;
    const { denom, balance, blockHeight } = req.body;

    if (!validator.isInt(walletId)) {
      return res.status(400).json({ error: 'Invalid wallet ID' });
    }

    if (!denom || balance === undefined) {
      return res.status(400).json({ error: 'Denom and balance are required' });
    }

    if (!validator.isFloat(balance.toString())) {
      return res.status(400).json({ error: 'Invalid balance format' });
    }

    const result = await db.updateWalletBalance(
      parseInt(walletId),
      validator.escape(denom),
      parseFloat(balance),
      blockHeight ? parseInt(blockHeight) : null
    );

    logger.info(`Balance updated for wallet ${walletId}: ${denom} = ${balance} by user ${req.user.username}`);

    res.json({
      success: true,
      result,
      message: 'Balance updated successfully'
    });
  } catch (error) {
    logger.error('Update wallet balance error:', error);
    res.status(500).json({ error: 'Failed to update wallet balance' });
  }
});

// Get low balance alerts
router.get('/alerts/low-balance', async (req, res) => {
  try {
    const { threshold } = req.query;
    const alerts = await db.getLowBalanceAlerts(threshold ? parseFloat(threshold) : null);

    res.json({
      success: true,
      alerts: alerts.map(alert => ({
        chain_id: alert.chain_id,
        chain_name: alert.chain_name,
        address: alert.address,
        address_type: alert.address_type,
        denom: alert.denom,
        symbol: alert.symbol,
        balance: parseFloat(alert.balance),
        usd_value: parseFloat(alert.usd_value),
        price_usd: parseFloat(alert.price_usd),
        severity: alert.usd_value < 5 ? 'critical' : (alert.usd_value < 10 ? 'warning' : 'info')
      }))
    });
  } catch (error) {
    logger.error('Get low balance alerts error:', error);
    res.status(500).json({ error: 'Failed to retrieve low balance alerts' });
  }
});

// Update token prices (admin only)
router.post('/prices/:denom', requireRole('admin'), async (req, res) => {
  try {
    const { denom } = req.params;
    const { symbol, name, priceUsd, marketCapUsd, volume24hUsd, change24h } = req.body;

    if (!priceUsd || !validator.isFloat(priceUsd.toString())) {
      return res.status(400).json({ error: 'Valid price in USD is required' });
    }

    await db.updateTokenPrice(validator.escape(denom), {
      symbol: symbol ? validator.escape(symbol) : null,
      name: name ? validator.escape(name) : null,
      priceUsd: parseFloat(priceUsd),
      marketCapUsd: marketCapUsd ? parseFloat(marketCapUsd) : null,
      volume24hUsd: volume24hUsd ? parseFloat(volume24hUsd) : null,
      change24h: change24h ? parseFloat(change24h) : null
    });

    logger.info(`Token price updated: ${denom} = $${priceUsd} by user ${req.user.username}`);

    res.json({
      success: true,
      message: 'Token price updated successfully'
    });
  } catch (error) {
    logger.error('Update token price error:', error);
    res.status(500).json({ error: 'Failed to update token price' });
  }
});

module.exports = { router, setDatabase };