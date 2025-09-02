# Wallet Balance Service Guide

## Overview

The Wallet Balance Service fetches wallet balance data from Hermes metrics endpoint at `http://localhost:4001/metrics` and converts raw values to human-readable format using proper decimal conversion based on each blockchain's specifications.

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

### Get Formatted Wallet Balances
```
GET /api/wallets/balances/formatted?chainId=osmosis-1
```

Response:
```json
{
  "success": true,
  "balances": [
    {
      "account": "osmo16zv6xqknkcfk4ecgjh5d3nyu2l5t0adzc34wx0",
      "chain": "osmosis-1",
      "chainName": "osmosis-1",
      "denom": "uosmo",
      "symbol": "uosmo",
      "tokenName": "uosmo",
      "rawBalance": "43302538",
      "balance": 43.302538,
      "decimals": 6
    }
  ],
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

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
- `METRICS_ENDPOINT`: Hermes metrics endpoint (default: http://localhost:4001/metrics)
- `WALLET_BALANCE_REFRESH_INTERVAL`: Refresh interval in seconds (default: 30)

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

## Monitoring

The service provides comprehensive health monitoring:
- Error count tracking
- Last successful fetch timestamp
- Cache utilization metrics
- Circuit breaker status
- Service availability status