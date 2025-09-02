const path = require('path');
const Database = require('../src/database/database');
const logger = require('../src/utils/logger');

// Load environment variables
require('dotenv').config();

async function initializeDatabase() {
    const db = new Database();
    
    try {
        logger.info('Initializing IBC Monitor database...');
        
        // Initialize database with schema
        await db.initialize();
        
        logger.info('Database initialized successfully');
        
        // Check if default admin user exists
        const adminUser = await db.getUserByUsername('admin');
        if (adminUser) {
            logger.info('Default admin user already exists');
            logger.warn('SECURITY WARNING: Please change the default admin password immediately!');
            logger.warn('Default credentials: admin / admin123');
        } else {
            logger.info('Default admin user not found - will be created from schema.sql');
        }
        
        // Display configuration summary
        await displayConfigurationSummary(db);
        
    } catch (error) {
        logger.error('Database initialization failed:', error);
        process.exit(1);
    } finally {
        db.close();
    }
}

async function displayConfigurationSummary(db) {
    try {
        logger.info('\n=== Database Configuration Summary ===');
        
        // Get database file info
        logger.info(`Database file: ${db.dbPath}`);
        
        // Count users
        const userCount = await db.get('SELECT COUNT(*) as count FROM users');
        logger.info(`Total users: ${userCount.count}`);
        
        // Count active users by role
        const adminCount = await db.get('SELECT COUNT(*) as count FROM users WHERE role = "admin" AND is_active = 1');
        const monitoringCount = await db.get('SELECT COUNT(*) as count FROM users WHERE role = "monitoring" AND is_active = 1');
        
        logger.info(`- Admin users: ${adminCount.count}`);
        logger.info(`- Monitoring users: ${monitoringCount.count}`);
        
        // Count metrics sources
        const sourcesCount = await db.get('SELECT COUNT(*) as count FROM metrics_sources');
        const activeSourcesCount = await db.get('SELECT COUNT(*) as count FROM metrics_sources WHERE is_active = 1');
        
        logger.info(`Metrics sources: ${sourcesCount.count} (${activeSourcesCount.count} active)`);
        
        // Get authentication method
        const authMethod = await db.getConfig('auth_method');
        logger.info(`Authentication method: ${authMethod || 'sqlite'}`);
        
        logger.info('=== End Configuration Summary ===\n');
        
        // Security reminders
        logger.warn('\n=== SECURITY REMINDERS ===');
        logger.warn('1. Change default admin password: admin123');
        logger.warn('2. Configure strong session secrets in .env');
        logger.warn('3. Set up HTTPS in production');
        logger.warn('4. Review user permissions regularly');
        logger.warn('5. Enable proper firewall rules');
        logger.warn('========================\n');
        
    } catch (error) {
        logger.error('Failed to display configuration summary:', error);
    }
}

// Add helper functions
async function createDefaultConfiguration(db) {
    try {
        logger.info('Creating default configuration...');
        
        // Set default configuration values
        const defaultConfig = {
            'app_name': 'IBC Monitor',
            'app_version': '1.0.0',
            'auth_method': 'sqlite',
            'session_timeout': 24,
            'max_failed_logins': 5,
            'default_refresh_interval': 10
        };
        
        for (const [key, value] of Object.entries(defaultConfig)) {
            const existing = await db.getConfig(key);
            if (existing === null) {
                await db.setConfig(key, value, typeof value === 'number' ? 'number' : 'string');
                logger.info(`Set default config: ${key} = ${value}`);
            }
        }
        
        logger.info('Default configuration created');
    } catch (error) {
        logger.error('Failed to create default configuration:', error);
    }
}

async function createTestUser(db) {
    try {
        // Check if test user already exists
        const testUser = await db.getUserByUsername('monitor');
        if (testUser) {
            logger.info('Test monitoring user already exists');
            return;
        }
        
        // Create test monitoring user
        await db.createUser({
            username: 'monitor',
            email: 'monitor@localhost',
            password: 'monitor123',
            role: 'monitoring'
        });
        
        logger.info('Test monitoring user created: monitor / monitor123');
        logger.warn('Remember to change the default password!');
    } catch (error) {
        logger.warn('Failed to create test user:', error);
    }
}

// Command line interface
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
IBC Monitor Database Initialization

Usage:
  node scripts/init-database.js [options]

Options:
  --test-user     Create a test monitoring user (monitor/monitor123)
  --force         Force reinitialize database (DANGER: will reset data)
  --help, -h      Show this help message

Environment Variables:
  DATABASE_PATH   Path to SQLite database file (default: ./database/ibc_monitor.db)
  
Examples:
  node scripts/init-database.js
  node scripts/init-database.js --test-user
        `);
        process.exit(0);
    }
    
    (async () => {
        try {
            await initializeDatabase();
            
            // Create test user if requested
            if (args.includes('--test-user')) {
                const db = new Database();
                await db.initialize();
                await createTestUser(db);
                db.close();
            }
            
            logger.info('Database initialization completed successfully');
            process.exit(0);
        } catch (error) {
            logger.error('Database initialization failed:', error);
            process.exit(1);
        }
    })();
}

module.exports = {
    initializeDatabase,
    createDefaultConfiguration,
    createTestUser
};