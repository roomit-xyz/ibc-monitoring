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

### Get Live Chains from Metrics
```
GET /api/wallets/balances/live-chains
```
Returns only chains that have active wallet balances in the metrics endpoint.

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

### Get Formatted Wallet Balances (Live Data Only)
```
GET /api/wallets/balances/formatted?chainId=osmosis-1
```

Response shows only chains present in metrics endpoint:
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

## Monitoring

The service provides comprehensive health monitoring:
- Error count tracking
- Last successful fetch timestamp
- Cache utilization metrics
- Circuit breaker status
- Service availability status