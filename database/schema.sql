-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100),
    password_hash VARCHAR(255) NOT NULL,
    role TEXT DEFAULT 'monitoring' CHECK(role IN ('admin', 'monitoring')),
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- Sessions table for managing user sessions
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(255) PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Configuration table for application settings
CREATE TABLE IF NOT EXISTS app_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT,
    config_type TEXT DEFAULT 'string' CHECK(config_type IN ('string', 'number', 'boolean', 'json')),
    is_encrypted BOOLEAN DEFAULT 0,
    updated_by INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- Metrics sources configuration
CREATE TABLE IF NOT EXISTS metrics_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL,
    url VARCHAR(500) NOT NULL,
    type TEXT DEFAULT 'hermes' CHECK(type IN ('hermes', 'prometheus', 'custom')),
    is_active BOOLEAN DEFAULT 1,
    auth_type TEXT DEFAULT 'none' CHECK(auth_type IN ('none', 'basic', 'bearer')),
    auth_credentials TEXT, -- encrypted JSON
    refresh_interval INTEGER DEFAULT 10, -- seconds
    timeout INTEGER DEFAULT 30, -- seconds
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- API endpoints configuration
CREATE TABLE IF NOT EXISTS api_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metrics_source_id INTEGER NOT NULL,
    endpoint_path VARCHAR(200) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (metrics_source_id) REFERENCES metrics_sources(id) ON DELETE CASCADE
);

-- Notification settings
CREATE TABLE IF NOT EXISTS notification_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gotify_url VARCHAR(500),
    gotify_token VARCHAR(255),
    is_enabled BOOLEAN DEFAULT 0,
    alert_thresholds TEXT, -- JSON with threshold configurations
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Alert history
CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type VARCHAR(100) NOT NULL,
    chain_name VARCHAR(100),
    severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
    message TEXT NOT NULL,
    alert_data TEXT, -- JSON with alert details
    is_acknowledged BOOLEAN DEFAULT 0,
    acknowledged_by INTEGER,
    acknowledged_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (acknowledged_by) REFERENCES users(id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_metrics_sources_active ON metrics_sources(is_active);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_source ON api_endpoints(metrics_source_id);
CREATE INDEX IF NOT EXISTS idx_notification_user ON notification_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_created ON alert_history(created_at);
CREATE INDEX IF NOT EXISTS idx_alert_history_chain ON alert_history(chain_name);

-- Insert default admin user (password: admin123)
-- Note: In production, this should be changed immediately
INSERT OR IGNORE INTO users (id, username, email, password_hash, role, is_active) 
VALUES (1, 'admin', 'admin@localhost', 
        '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewRukhOGz.T8.zhi', 
        'admin', 1);

-- Insert default application configuration
INSERT OR IGNORE INTO app_config (config_key, config_value, config_type) VALUES
    ('auth_method', 'sqlite', 'string'),
    ('ldap_server', '', 'string'),
    ('ldap_port', '389', 'number'),
    ('ldap_bind_dn', '', 'string'),
    ('ldap_bind_password', '', 'string'),
    ('ldap_user_search_base', '', 'string'),
    ('ldap_user_search_filter', '(uid={username})', 'string'),
    ('session_timeout', '24', 'number'),
    ('max_failed_logins', '5', 'number'),
    ('app_name', 'IBC Monitor', 'string'),
    ('app_version', '1.0.0', 'string'),
    ('company_name', 'PT Roomit Trimiko Digital', 'string'),
    ('company_website', 'https://roomit.xyz', 'string'),
    ('company_email', 'info@roomit.xyz', 'string');

-- Insert default metrics source (existing Hermes endpoint)
INSERT OR IGNORE INTO metrics_sources (id, name, url, type, is_active, refresh_interval, created_by) 
VALUES (1, 'Default Hermes', 'http://127.0.0.1:3001', 'hermes', 1, 10, 1);

-- Insert default API endpoints
INSERT OR IGNORE INTO api_endpoints (metrics_source_id, endpoint_path, description) VALUES
    (1, '/version', 'Get Hermes version information'),
    (1, '/chains', 'Get list of monitored chains'),
    (1, '/chain/{chainId}', 'Get specific chain configuration'),
    (1, '/state', 'Get current relayer state'),
    (1, '/metrics', 'Get Prometheus metrics');