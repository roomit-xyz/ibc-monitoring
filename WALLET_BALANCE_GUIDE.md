# Wallet Balance Service Guide

## Overview

The Wallet Balance Service is a comprehensive monitoring system that collects wallet balance data from Hermes relayer metrics and provides both real-time collection and database-backed API endpoints. The service has been enhanced with robust error handling, graceful startup procedures, and reliable data persistence.

## Recent Updates (September 2025)

✅ **Fixed Connection Issues**: Resolved "Connection refused" errors with IPv4-forced connections and dedicated HTTP agents  
✅ **Database Integration**: Added automatic database table creation and proper error handling  
✅ **Graceful Startup**: Service now waits for metrics endpoint to be ready before initialization  
✅ **API Optimization**: Endpoints now serve data from database for better performance and reliability  
✅ **Enhanced Logging**: Detailed debug logging for troubleshooting connection and parsing issues  
✅ **Concurrency Protection**: Prevents multiple simultaneous collection processes

## Features

- ✅ Fetches wallet balance metrics from Hermes
- ✅ Converts raw balance values to human-readable format
- ✅ **Dynamic decimal caching** - stores decimals in database after first fetch
- ✅ Support for specific tokens: uphoton, peaka, ulore, uosmo, aplanq
- ✅ Performance optimized with batching and database caching
- ✅ Error handling with retry logic and circuit breaker
- ✅ Real-time WebSocket updates
- ✅ Health monitoring endpoints
- ✅ **No price fetching** - focuses purely on wallet balances

## API Endpoints

**Note**: All API endpoints have been optimized to serve data from database instead of live metrics collection for better performance and reliability.

### Get Live Chains from Database
```
GET /api/wallets/balances/live-chains
```
Returns chains that have active wallet balances stored in the database. Data is automatically updated by the background wallet balance service.

Response:
```json
{
  "success": true,
  "chains": [
    {
      "chainId": "atomone-1",
      "chainName": "atomone-1", 
      "walletCount": 1
    },
    {
      "chainId": "osmosis-1",
      "chainName": "osmosis-1",
      "walletCount": 1
    }
  ],
  "totalChains": 5,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### Get Formatted Wallet Balances from Database
```
GET /api/wallets/balances/formatted?chainId=osmosis-1
```

Returns formatted wallet balance data from database. Data is kept up-to-date by the background collection service.
```json
{
  "success": true,
  "chains": [
    {
      "chain": "atomone-1",
      "chainName": "atomone-1",
      "wallets": [
        {
          "address": "atone16zv6xqknkcfk4ecgjh5d3nyu2l5t0adz726ex9",
          "denom": "uphoton",
          "symbol": "PHOTON",
          "rawBalance": "12261010",
          "balance": 12.26101,
          "decimals": 6,
          "timestamp": "2025-01-15T10:30:00.000Z"
        }
      ]
    }
  ],
  "totalChains": 5,
  "totalWallets": 5,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### Cleanup Old Data (Admin Only)
```
POST /api/wallets/balances/cleanup
```
Removes wallet addresses and balances for chains not present in the metrics endpoint.

### Health Check
```
GET /api/wallets/balances/health
```

Response:
```json
{
  "success": true,
  "status": "healthy",
  "lastSuccessfulFetch": "2025-01-15T10:29:45.000Z",
  "errorCount": 0,
  "cacheSize": 15,
  "isRunning": true,
  "metricsEndpoint": "http://localhost:4001/metrics",
  "refreshInterval": 30
}
```

## Configuration

Environment variables:
- `METRICS_ENDPOINT`: Hermes metrics endpoint (default: http://127.0.0.1:4001/metrics)
- `WALLET_BALANCE_REFRESH_INTERVAL`: Refresh interval in seconds (default: 30)

**Important**: The endpoint now uses `127.0.0.1` instead of `localhost` to force IPv4 connections and avoid DNS resolution issues.

## Token Decimals Support

The service automatically handles different decimal places:

| Token | Decimals | Example Conversion |
|-------|----------|-------------------|
| uphoton | 6 | 12261010 → 12.26101 |
| peaka | 18 | 30674415480000000000 → 30.67441548 |
| ulore | 6 | 62474550 → 62.47455 |
| uosmo | 6 | 43302538 → 43.302538 |
| aplanq | 18 | 103061216687315320000 → 103.06121668731532 |

## WebSocket Updates

Subscribe to `wallet_balances_update` events for real-time balance updates:

```javascript
{
  "type": "wallet_balances_update",
  "data": {
    "timestamp": "2025-01-15T10:30:00.000Z",
    "chains": [...],
    "totalWallets": 5,
    "summary": {...}
  }
}
```

## Performance Features

- **Batch Processing**: Processes balances in batches of 10
- **Database Caching**: Stores decimals in `token_decimals` table after first fetch
- **Dynamic Decimals**: No repeated cosmos.directory calls for known tokens
- **Circuit Breaker**: Automatic fallback when error threshold is reached
- **Retry Logic**: 3 retries with exponential backoff
- **Connection Pooling**: Keep-alive HTTP connections
- **Memory Efficiency**: Removed price caching and token info fetching

## UI Display Format

The updated UI now shows only live chains from metrics with human-readable balances:

### Summary Cards Display:
```
Chain: atomone-1 🟢
Chain ID: atomone-1
Wallets: 1
Status: Active in Metrics
```

### Detailed Balance Display:
```
atomone-1 (atomone-1) | 1 wallet(s)

Relayer Wallet
atone16zv6x...z726ex9
12.26101 PHOTON | Decimals: 6

PHOTON | [timestamp]
12.26101
Raw: 12261010
```

## Key Changes

✅ **UI Only Shows Live Chains**: No more akash, cosmoshub, juno, stargaze
✅ **Human Readable Balances**: 12261010 → 12.26101 PHOTON  
✅ **Real-time Data**: Direct from metrics endpoint  
✅ **Clean Interface**: No USD prices, focus on balance amounts

## Troubleshooting

### Common Issues and Solutions

#### "Connection refused" Errors
**Symptoms**: `Error collecting wallet balances: Connection refused - metrics endpoint may be down`

**Solutions**:
1. Verify Hermes is running: `curl http://127.0.0.1:4001/metrics`
2. Check if port 4001 is accessible: `nc -z 127.0.0.1 4001`
3. Restart the IBC monitor application
4. Ensure `METRICS_ENDPOINT` uses `127.0.0.1` not `localhost`

#### "No wallet balance metrics found" Warning
**Symptoms**: Service connects but finds no wallet balance data

**Solutions**:
1. Check Hermes configuration includes wallet balance metrics
2. Verify Hermes relayer wallets have transactions/activity
3. Check metrics endpoint manually: `curl http://127.0.0.1:4001/metrics | grep wallet_balance`

#### Database Table Errors
**Symptoms**: `SQLITE_ERROR: no such table: token_decimals`

**Solutions**:
1. Database tables are now auto-created on service startup
2. Restart the application to trigger table creation
3. Check database permissions and disk space

#### Empty Dashboard Display
**Symptoms**: UI shows "Total: 0 wallets across 0 chains"

**Solutions**:
1. Check if wallet balance service is running: Look for "✅ Metrics endpoint is ready" in logs
2. Verify API endpoints return data (check browser developer tools Network tab)
3. Check database has wallet balance data: `sqlite3 database/ibc_monitor.db "SELECT * FROM wallet_balances;"`

### Service Startup Sequence

The service now follows a graceful startup process:

1. **Database Tables Initialization** - Creates required tables
2. **Metrics Endpoint Check** - Waits up to 30 seconds for Hermes to be ready
3. **Initial Collection** - Collects and processes wallet balance data
4. **Periodic Updates** - Sets up interval-based collection

### Debug Logging

Enable debug logging to troubleshoot issues:
```bash
# In .env file
LOG_LEVEL=debug
```

Debug logs will show:
- Metrics endpoint connectivity tests
- Database table creation status
- Number of wallet balances found and processed
- API endpoint data retrieval details

## Monitoring

The service provides comprehensive health monitoring:
- Error count tracking with automatic reset
- Last successful fetch timestamp
- Cache utilization metrics
- Circuit breaker status with automatic recovery
- Service availability status
- Graceful startup process monitoring
- Database connectivity verification