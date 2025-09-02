# 🌉 IBC Monitor - Enterprise Blockchain Monitoring Solution

**Developed by PT Roomit Trimiko Digital**

A secure, full-stack monitoring application for IBC (Inter-Blockchain Communication) Hermes relayers with enterprise-grade authentication, real-time metrics, and comprehensive alerting.

## ✨ Features

### 🔐 **Security & Authentication**
- **Dual Authentication**: SQLite database or LDAP directory integration
- **Role-Based Access Control**: Admin and monitoring user roles
- **Session Management**: Secure session handling with configurable timeouts
- **JWT Token Support**: API access with JSON Web Tokens
- **Rate Limiting**: Protection against brute force attacks
- **Secure Frontend**: Code obfuscation and developer tools protection

### 👥 **User Management**
- **SQLite Users**: Full user CRUD operations for admin users
- **LDAP Integration**: Seamless directory service authentication
- **User Roles**: Admin (full access) and Monitoring (read-only) roles
- **Session Tracking**: View and manage active user sessions
- **Password Management**: Secure password changes and policies

### 📊 **Monitoring & Metrics**
- **Multiple Data Sources**: Support for multiple Hermes endpoints
- **Real-Time Updates**: WebSocket-based live data streaming
- **Chain Monitoring**: Track all connected blockchain networks
- **Worker Status**: Monitor relayer workers (Client, Packet, Wallet)
- **Human-Readable Data**: Formatted metrics with chain name mapping
- **Performance Tracking**: Response times and connection health

### 🔔 **Alert System**
- **Gotify Integration**: Push notifications to mobile devices
- **Configurable Thresholds**: Custom alert levels per user
- **Alert History**: Complete audit trail of all alerts
- **Real-Time Alerts**: WebSocket delivery to connected clients
- **Alert Categories**: Critical, warning, and info severity levels

### ⚙️ **Configuration Management**
- **Dynamic Configuration**: Runtime configuration changes
- **Environment Variables**: Comprehensive .env configuration
- **Metrics Sources**: Add/remove/configure data sources
- **API Endpoints**: Dynamic API endpoint management
- **Authentication Settings**: Switch between SQLite and LDAP

### 🌐 **Web Interface**
- **Modern UI**: Clean, responsive Tailwind CSS design
- **Real-Time Dashboard**: Live metrics and status updates
- **Admin Panel**: Complete system administration interface
- **Mobile Friendly**: Optimized for all device sizes
- **Dark/Light Theme**: Professional green-themed interface

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ and npm 7+
- IBC Hermes relayer with metrics enabled
- (Optional) LDAP server for directory authentication
- (Optional) Gotify server for push notifications

### Installation

1. **Clone and Setup**
   ```bash
   git clone <repository-url>
   cd ibc-monitor
   npm install
   ```

2. **Add Company Logo**
   ```bash
   # Place the official Roomit logo in the img directory
   cp /path/to/logo-roomit.png public/img/logo-roomit.png
   ```

3. **Environment Configuration**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   nano .env
   ```

4. **Initialize Database**
   ```bash
   npm run init-db
   # Optional: Create test users
   npm run init-db -- --test-user
   ```

5. **Start the Application**
   ```bash
   # Production
   npm start
   
   # Development
   npm run dev
   ```

6. **Access the Application**
   - Dashboard: http://localhost:3000
   - Default credentials: `admin` / `admin123`
   - **⚠️ Change default password immediately!**

## 📋 Configuration

### Environment Variables

```bash
# Database
DATABASE_PATH=./database/ibc_monitor.db

# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# Security
SESSION_SECRET=your-very-secure-session-secret
JWT_SECRET=your-jwt-secret
BCRYPT_ROUNDS=12

# Authentication
AUTH_METHOD=sqlite  # or 'ldap'

# LDAP (if AUTH_METHOD=ldap)
LDAP_SERVER=ldap://your-ldap-server.com
LDAP_PORT=389
LDAP_BIND_DN=cn=admin,dc=example,dc=com
LDAP_BIND_PASSWORD=your-ldap-password
LDAP_USER_SEARCH_BASE=ou=users,dc=example,dc=com

# Metrics
DEFAULT_HERMES_URL=http://127.0.0.1:3001
DEFAULT_REFRESH_INTERVAL=10

# Alerts
GOTIFY_DEFAULT_URL=https://gotify.example.com
GOTIFY_ENABLED=false
```

### API Endpoints

The application monitors these Hermes API endpoints:

```
GET  /version                 # Hermes version information
GET  /chains                  # List of monitored chains  
GET  /chain/{chainId}         # Specific chain configuration
GET  /state                   # Current relayer state
GET  /metrics                 # Prometheus metrics (if available)
```

## 🏗️ Architecture

### Backend Components
- **Express.js Server**: Main application server with security middleware
- **SQLite Database**: User data, configuration, and alert history
- **Authentication System**: Dual SQLite/LDAP authentication with JWT
- **WebSocket Server**: Real-time updates and notifications
- **Metrics Collector**: Background service for data collection
- **Alert Manager**: Intelligent alert processing and notification

### Frontend Components
- **Login System**: Secure authentication with session management
- **Dashboard**: Real-time monitoring interface
- **Admin Panel**: System administration (admin users only)
- **WebSocket Client**: Live data updates and notifications

### Security Features
- **Helmet.js**: Security headers and CSP
- **Rate Limiting**: Protection against abuse
- **Session Security**: Secure cookies and session management
- **Input Validation**: Comprehensive data sanitization
- **SQL Injection Prevention**: Parameterized queries
- **XSS Protection**: Content Security Policy and input escaping

## 👨‍💼 User Management

### User Roles

**Admin Users:**
- Full system access
- User management (create, edit, delete users)
- System configuration
- Metrics source management
- Alert configuration
- View all system logs

**Monitoring Users:**
- Read-only dashboard access
- View metrics and alerts
- Configure personal notifications
- Limited to monitoring functions

### Authentication Methods

**SQLite (Default):**
- Local user database
- Password-based authentication
- Full user lifecycle management
- Suitable for small teams

**LDAP Integration:**
- Corporate directory authentication
- Centralized user management
- Single sign-on compatibility
- Automatic user provisioning

## 🔔 Alert System

### Alert Types
- **Client Misbehaviour**: IBC client issues
- **High Pending Packets**: Packet backlog alerts
- **Failed Packets**: Transaction failures
- **Source Connectivity**: Metrics source errors
- **Worker Health**: Relayer worker status

### Notification Channels
- **Gotify**: Push notifications to mobile devices
- **WebSocket**: Real-time browser notifications
- **Email**: (Future enhancement)
- **Slack**: (Future enhancement)

### Alert Configuration
```json
{
  "pendingWarning": 10,
  "pendingCritical": 50, 
  "failedPackets": 1,
  "balanceThreshold": 20,
  "minSeverity": "warning",
  "disabledTypes": [],
  "disabledChains": []
}
```

## 🛠️ Development

### Project Structure
```
ibc-monitor/
├── src/
│   ├── database/         # Database layer
│   ├── routes/          # API routes
│   ├── middleware/      # Express middleware
│   ├── services/        # Background services
│   └── utils/           # Utility functions
├── public/              # Frontend assets
├── database/            # SQLite database files
├── scripts/             # Database and utility scripts
└── logs/                # Application logs
```

### Available Scripts
```bash
npm start              # Start production server
npm run dev           # Start development server
npm run init-db       # Initialize database
npm test              # Run tests
npm run lint          # Code linting
npm run format        # Code formatting
```

### API Documentation

**Authentication:**
```bash
POST /api/auth/login      # User login
POST /api/auth/logout     # User logout  
GET  /api/auth/status     # Check auth status
POST /api/auth/refresh    # Refresh JWT token
```

**Users (Admin only):**
```bash
GET    /api/users         # List all users
POST   /api/users         # Create new user
GET    /api/users/:id     # Get user details
PUT    /api/users/:id     # Update user
DELETE /api/users/:id     # Delete user
```

**Metrics:**
```bash
GET /api/metrics/dashboard           # Dashboard data
GET /api/metrics/sources            # Metrics sources
GET /api/metrics/hermes/:id/chains  # Chain data
GET /api/metrics/hermes/:id/state   # Relayer state
GET /api/metrics/health             # Health check
```

**Configuration (Admin only):**
```bash
GET /api/config                    # Get configuration
PUT /api/config                    # Update configuration
GET /api/config/metrics-sources    # Get metrics sources
POST /api/config/metrics-sources   # Create metrics source
```

**Alerts:**
```bash
GET  /api/alerts/notifications      # Get user notification settings
PUT  /api/alerts/notifications      # Update notification settings
POST /api/alerts/notifications/test # Test notification
GET  /api/alerts/history            # Get alert history
POST /api/alerts/trigger            # Trigger manual alert (admin)
```

## 🔧 Troubleshooting

### Common Issues

**Database Connection:**
```bash
# Check database file permissions
ls -la database/
# Reinitialize if needed
npm run init-db
```

**Authentication Issues:**
```bash
# Check LDAP connectivity (if using LDAP)
ldapsearch -H ldap://your-server -D "bind-dn" -W

# Reset to SQLite authentication
echo "AUTH_METHOD=sqlite" >> .env
```

**Metrics Collection:**
```bash
# Test Hermes API manually
curl http://127.0.0.1:3001/version
curl http://127.0.0.1:3001/chains
curl http://127.0.0.1:3001/state
```

**WebSocket Issues:**
- Check firewall rules for WebSocket connections
- Verify JWT token is being passed correctly
- Check browser console for WebSocket errors

### Logging
```bash
# View application logs
tail -f logs/ibc-monitor.log

# View error logs
tail -f logs/error.log

# Debug mode
LOG_LEVEL=debug npm start
```

## 📊 Monitoring

### Health Checks
- **Application**: http://localhost:3000/health
- **Database**: Automatic connectivity checks
- **Metrics Sources**: Real-time health monitoring
- **WebSocket**: Connection status in UI

### Performance Metrics
- Response times for all API endpoints
- Database query performance
- WebSocket connection statistics
- Memory and CPU usage monitoring

## 🔒 Security

### Best Practices
1. **Change Default Passwords**: Update admin credentials immediately
2. **Use HTTPS**: Enable SSL/TLS in production
3. **Firewall Rules**: Restrict access to necessary ports only
4. **Regular Updates**: Keep dependencies updated
5. **Session Security**: Configure secure session settings
6. **Database Security**: Protect SQLite file permissions
7. **LDAP Security**: Use secure LDAP connections (LDAPS)

### Security Headers
- Content Security Policy (CSP)
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin
- Permissions-Policy restrictions

## 🚀 Production Deployment

### Method 1: Traditional Server Deployment

#### 1. **Server Preparation**
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 process manager
sudo npm install -g pm2

# Create application user
sudo adduser --disabled-password --gecos "" ibcmonitor
sudo mkdir -p /opt/ibc-monitor
sudo chown ibcmonitor:ibcmonitor /opt/ibc-monitor
```

#### 2. **Application Setup**
```bash
# Switch to application user
sudo su - ibcmonitor
cd /opt/ibc-monitor

# Clone repository
git clone https://github.com/roomit-xyz/ibc-monitor.git .

# Install dependencies
npm ci --production

# Add company logo
cp /path/to/logo-roomit.png public/img/logo-roomit.png

# Configure environment
cp .env.example .env
nano .env
```

#### 3. **Production Environment Configuration**
```bash
# Edit .env file for production
nano .env
```
```env
# Production Configuration
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Security - CHANGE THESE!
SESSION_SECRET=your-super-secure-session-secret-min-32-chars
JWT_SECRET=your-super-secure-jwt-secret-min-32-chars

# Database
DATABASE_PATH=/opt/ibc-monitor/database/ibc_monitor.db

# Hermes endpoint
DEFAULT_HERMES_URL=http://127.0.0.1:3001

# Logging
LOG_LEVEL=info
LOG_FILE_PATH=/opt/ibc-monitor/logs/ibc-monitor.log

# Rate limiting (adjust based on usage)
RATE_LIMIT_MAX=1000

# Enable security features
ENABLE_HTTPS=false  # Set to true if using SSL
CORS_ORIGINS=your-domain.com,localhost
```

#### 4. **Initialize Application**
```bash
# Create necessary directories
mkdir -p logs database

# Initialize database
npm run init-db

# Set up log rotation
sudo nano /etc/logrotate.d/ibc-monitor
```
```
/opt/ibc-monitor/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 ibcmonitor ibcmonitor
    postrotate
        pm2 reload ibc-monitor
    endscript
}
```

#### 5. **PM2 Configuration**
```bash
# Create PM2 ecosystem file
nano ecosystem.config.js
```
```javascript
module.exports = {
  apps: [{
    name: 'ibc-monitor',
    script: 'server.js',
    cwd: '/opt/ibc-monitor',
    user: 'ibcmonitor',
    instances: 1,  // or 'max' for cluster mode
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/opt/ibc-monitor/logs/pm2-error.log',
    out_file: '/opt/ibc-monitor/logs/pm2-out.log',
    log_file: '/opt/ibc-monitor/logs/pm2-combined.log',
    time: true,
    max_memory_restart: '500M',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
```

```bash
# Start application with PM2
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Enable PM2 startup script
pm2 startup
# Follow the instructions shown by PM2
```

#### 6. **Nginx Reverse Proxy Setup**
```bash
# Install nginx
sudo apt install nginx -y

# Create nginx configuration
sudo nano /etc/nginx/sites-available/ibc-monitor
```
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
    }
    
    # WebSocket support
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Rate limit login endpoint
    location /api/auth/login {
        limit_req zone=login burst=3 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Static files caching
    location /img/ {
        proxy_pass http://127.0.0.1:3000;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/ibc-monitor /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### 7. **SSL/HTTPS Setup with Let's Encrypt**
```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Verify auto-renewal
sudo certbot renew --dry-run
```

#### 8. **Firewall Configuration**
```bash
# Configure UFW firewall
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw --force enable
```

### Method 2: Docker Deployment

#### 1. **Create Dockerfile**
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create directories
RUN mkdir -p logs database public/img

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set permissions
RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); })"

CMD ["node", "server.js"]
```

#### 2. **Create docker-compose.yml**
```yaml
version: '3.8'

services:
  ibc-monitor:
    build: .
    container_name: ibc-monitor
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./database:/app/database
      - ./logs:/app/logs
      - ./public/img:/app/public/img
    environment:
      - NODE_ENV=production
      - PORT=3000
      - HOST=0.0.0.0
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  nginx:
    image: nginx:alpine
    container_name: ibc-monitor-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - ibc-monitor
```

#### 3. **Deploy with Docker**
```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f ibc-monitor

# Update application
git pull
docker-compose build
docker-compose up -d

# Backup database
docker-compose exec ibc-monitor cp /app/database/ibc_monitor.db /app/backup/
```

### Method 3: Systemd Service (Alternative to PM2)

#### 1. **Create systemd service**
```bash
sudo nano /etc/systemd/system/ibc-monitor.service
```
```ini
[Unit]
Description=IBC Monitor Application
After=network.target

[Service]
Type=simple
User=ibcmonitor
WorkingDirectory=/opt/ibc-monitor
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ibc-monitor

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl enable ibc-monitor
sudo systemctl start ibc-monitor
sudo systemctl status ibc-monitor

# View logs
sudo journalctl -u ibc-monitor -f
```

### 🔧 Production Monitoring & Maintenance

#### Health Monitoring
```bash
# Check application health
curl http://localhost:3000/health

# Monitor PM2 processes
pm2 status
pm2 logs ibc-monitor
pm2 monit

# Check system resources
htop
df -h
free -h
```

#### Backup Strategy
```bash
#!/bin/bash
# backup.sh - Daily backup script

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/backups/ibc-monitor"
APP_DIR="/opt/ibc-monitor"

mkdir -p $BACKUP_DIR

# Backup database
cp $APP_DIR/database/ibc_monitor.db $BACKUP_DIR/ibc_monitor_$DATE.db

# Backup configuration
cp $APP_DIR/.env $BACKUP_DIR/env_$DATE.backup

# Keep only last 30 days
find $BACKUP_DIR -name "*.db" -mtime +30 -delete
find $BACKUP_DIR -name "*.backup" -mtime +30 -delete
```

#### Updates & Maintenance
```bash
# Update application
cd /opt/ibc-monitor
git pull
npm ci --production
pm2 reload ibc-monitor

# Update dependencies (monthly)
npm update
npm audit fix

# Monitor disk usage
du -sh /opt/ibc-monitor/logs/*
du -sh /opt/ibc-monitor/database/*
```

### 🔐 Security Checklist

- ✅ Change default admin password
- ✅ Use strong SESSION_SECRET and JWT_SECRET
- ✅ Enable HTTPS with valid SSL certificate
- ✅ Configure firewall (UFW/iptables)
- ✅ Set up fail2ban for brute force protection
- ✅ Regular security updates
- ✅ Database file permissions (600)
- ✅ Log file rotation
- ✅ Monitor application logs for suspicious activity

### 📊 Performance Optimization

- Use PM2 cluster mode for high traffic
- Enable nginx gzip compression
- Configure proper caching headers
- Monitor memory usage and restart if needed
- Use CDN for static assets if required
- Database vacuum and optimization

### 🚨 Troubleshooting

**Application won't start:**
```bash
# Check logs
pm2 logs ibc-monitor
sudo journalctl -u ibc-monitor

# Check port availability
sudo netstat -tulpn | grep :3000

# Check file permissions
ls -la /opt/ibc-monitor/database/
```

**High memory usage:**
```bash
# Monitor memory
pm2 monit
# Restart if needed
pm2 restart ibc-monitor
```

**Database issues:**
```bash
# Check database integrity
sqlite3 database/ibc_monitor.db "PRAGMA integrity_check;"
# Backup and recreate if corrupted
```

## 🤝 Support

### Getting Help
- Check logs: `logs/ibc-monitor.log`
- Enable debug mode: `LOG_LEVEL=debug`
- Review configuration: `.env` settings
- Test API endpoints manually
- Check WebSocket connectivity

### Common Configuration

**Default Users:**
- Admin: `admin` / `admin123`
- Monitor: `monitor` / `monitor123` (if created with --test-user)

```
sqlite3 database/ibc_monitor.db "UPDATE users SET password_hash = '\$2b\$12\$M4O6KuyB2Gh7dneTcY3cvef9Zb/gcLjJW2faEduxHui9ztpYge/eK' WHERE username = 'admin';"
```

**Default Ports:**
- Application: 3000
- Hermes API: 3001 (configurable)
- WebSocket: Same as application port

---

## 🏢 About PT Roomit Trimiko Digital

PT Roomit Trimiko Digital is a leading provider of blockchain infrastructure solutions in Indonesia. We specialize in:

- **Blockchain Infrastructure**: Validator nodes, RPC endpoints, and monitoring solutions
- **Enterprise Solutions**: Custom blockchain applications and integration services  
- **Technical Consulting**: Blockchain architecture and implementation guidance
- **Monitoring & Analytics**: Real-time blockchain network monitoring and alerting

### Our Services
- 🔗 **IBC Relayer Services**: Professional Hermes relayer operations
- 📊 **Network Monitoring**: Real-time blockchain health monitoring
- 🛡️ **Security Auditing**: Smart contract and infrastructure security
- ⚙️ **Custom Development**: Tailored blockchain solutions

### Contact Information
- 🌐 **Website**: [roomit.xyz](https://roomit.xyz)
- 📧 **Email**: [info@roomit.xyz](mailto:info@roomit.xyz)
- 💼 **LinkedIn**: [PT Roomit Trimiko Digital](https://linkedin.com/company/roomit-xyz)
- 🐦 **Twitter**: [@roomit_xyz](https://twitter.com/roomit_xyz)

---

**🌟 Ready to monitor your IBC infrastructure with enterprise-grade security and real-time insights!**

Start monitoring your blockchain relayers with confidence using IBC Monitor's comprehensive feature set developed by PT Roomit Trimiko Digital. 🚀