-- Wallet addresses table
CREATE TABLE IF NOT EXISTS wallet_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id VARCHAR(100) NOT NULL,
    chain_name VARCHAR(100) NOT NULL,
    address VARCHAR(255) NOT NULL,
    address_type TEXT DEFAULT 'relayer' CHECK(address_type IN ('relayer', 'fee', 'gas')),
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chain_id, address, address_type)
);

-- Wallet balances table
CREATE TABLE IF NOT EXISTS wallet_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL,
    denom VARCHAR(100) NOT NULL,
    balance DECIMAL(30,6) NOT NULL DEFAULT 0,
    balance_usd DECIMAL(15,2) DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    block_height INTEGER,
    FOREIGN KEY (wallet_id) REFERENCES wallet_addresses(id) ON DELETE CASCADE,
    UNIQUE(wallet_id, denom)
);

-- Balance history for tracking changes
CREATE TABLE IF NOT EXISTS balance_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL,
    denom VARCHAR(100) NOT NULL,
    old_balance DECIMAL(30,6) NOT NULL,
    new_balance DECIMAL(30,6) NOT NULL,
    change_amount DECIMAL(30,6) NOT NULL,
    change_type TEXT CHECK(change_type IN ('increase', 'decrease')) NOT NULL,
    transaction_hash VARCHAR(100),
    block_height INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES wallet_addresses(id) ON DELETE CASCADE
);

-- Token prices for USD conversion
CREATE TABLE IF NOT EXISTS token_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    denom VARCHAR(100) UNIQUE NOT NULL,
    symbol VARCHAR(20),
    name VARCHAR(100),
    price_usd DECIMAL(15,8) NOT NULL DEFAULT 0,
    market_cap_usd DECIMAL(20,2),
    volume_24h_usd DECIMAL(20,2),
    change_24h DECIMAL(8,4),
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_wallet_balances_wallet_id ON wallet_balances(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_balances_denom ON wallet_balances(denom);
CREATE INDEX IF NOT EXISTS idx_balance_history_wallet_id ON balance_history(wallet_id);
CREATE INDEX IF NOT EXISTS idx_balance_history_created ON balance_history(created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_addresses_chain ON wallet_addresses(chain_id);
CREATE INDEX IF NOT EXISTS idx_wallet_addresses_active ON wallet_addresses(is_active);

-- Insert some default wallet addresses (examples - should be configured per deployment)
INSERT OR IGNORE INTO wallet_addresses (chain_id, chain_name, address, address_type) VALUES
    ('cosmoshub-4', 'Cosmos Hub', 'cosmos1example...', 'relayer'),
    ('osmosis-1', 'Osmosis', 'osmo1example...', 'relayer'),
    ('juno-1', 'Juno', 'juno1example...', 'relayer'),
    ('stargaze-1', 'Stargaze', 'stars1example...', 'relayer'),
    ('akashnet-2', 'Akash', 'akash1example...', 'relayer');

-- Insert some default token prices
INSERT OR IGNORE INTO token_prices (denom, symbol, name, price_usd) VALUES
    ('uatom', 'ATOM', 'Cosmos', 10.50),
    ('uosmo', 'OSMO', 'Osmosis', 0.65),
    ('ujuno', 'JUNO', 'Juno', 0.45),
    ('ustars', 'STARS', 'Stargaze', 0.025),
    ('uakt', 'AKT', 'Akash', 2.80),
    ('ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', 'ATOM', 'Cosmos (IBC)', 10.50);