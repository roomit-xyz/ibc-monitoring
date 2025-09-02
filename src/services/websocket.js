const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

function setupWebSocket(server, db) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/ws',
    verifyClient: async (info) => {
      try {
        // Extract token from query parameters or headers
        const url = new URL(info.req.url, 'http://localhost');
        const token = url.searchParams.get('token') || info.req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
          return false;
        }

        // Verify JWT token
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-secret');
        const user = await db.getUserById(decoded.userId);
        
        if (!user) {
          return false;
        }

        // Store user info for later use
        info.req.user = user;
        return true;
      } catch (error) {
        logger.warn('WebSocket authentication failed:', error.message);
        return false;
      }
    }
  });

  const clients = new Map(); // Store connected clients with metadata

  wss.on('connection', (ws, req) => {
    const user = req.user;
    const clientId = generateClientId();
    
    // Check if user is properly authenticated
    if (!user) {
      logger.warn('WebSocket connection attempted without proper authentication');
      ws.close(1008, 'Authentication required');
      return;
    }
    
    // Store client information
    clients.set(clientId, {
      ws,
      user,
      connected: new Date(),
      lastPing: new Date(),
      subscriptions: new Set()
    });

    logger.info(`WebSocket connected: ${user.username} (${clientId})`);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'welcome',
      data: {
        clientId,
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        },
        timestamp: new Date().toISOString()
      }
    }));

    // Handle incoming messages
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        handleClientMessage(clientId, data, clients);
      } catch (error) {
        logger.warn(`Invalid WebSocket message from ${user?.username || 'unknown'}:`, error.message);
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Invalid message format' }
        }));
      }
    });

    // Handle client disconnect
    ws.on('close', () => {
      logger.info(`WebSocket disconnected: ${user?.username || 'unknown'} (${clientId})`);
      clients.delete(clientId);
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error(`WebSocket error for ${user?.username || 'unknown'}:`, error);
      clients.delete(clientId);
    });

    // Update last ping time
    ws.on('pong', () => {
      const client = clients.get(clientId);
      if (client) {
        client.lastPing = new Date();
      }
    });
  });

  // Heartbeat to keep connections alive
  const heartbeat = setInterval(() => {
    const now = new Date();
    
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    });

    // Clean up stale connections
    for (const [clientId, client] of clients.entries()) {
      if (now - client.lastPing > 60000) { // 60 seconds timeout
        logger.info(`Removing stale WebSocket connection: ${client.user?.username || 'unknown'}`);
        client.ws.terminate();
        clients.delete(clientId);
      }
    }
  }, parseInt(process.env.WS_HEARTBEAT_INTERVAL || 30) * 1000);

  // Broadcast functions
  const broadcast = (message, filterFn = null) => {
    const messageStr = JSON.stringify(message);
    
    for (const [clientId, client] of clients.entries()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        if (!filterFn || filterFn(client)) {
          try {
            client.ws.send(messageStr);
          } catch (error) {
            logger.warn(`Failed to send message to ${client.user?.username || 'unknown'}:`, error.message);
          }
        }
      }
    }
  };

  const broadcastToRole = (message, role) => {
    broadcast(message, (client) => client.user.role === role || client.user.role === 'admin');
  };

  const broadcastToUser = (message, userId) => {
    broadcast(message, (client) => client.user.id === userId);
  };

  const getConnectedClients = () => {
    return Array.from(clients.values()).map(client => ({
      user: {
        id: client.user.id,
        username: client.user.username,
        role: client.user.role
      },
      connected: client.connected,
      subscriptions: Array.from(client.subscriptions)
    }));
  };

  // Cleanup on server shutdown
  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return {
    wss,
    broadcast,
    broadcastToRole,
    broadcastToUser,
    getConnectedClients,
    clients: clients
  };
}

function handleClientMessage(clientId, message, clients) {
  const client = clients.get(clientId);
  if (!client) return;

  const { type, data } = message;

  switch (type) {
    case 'subscribe':
      handleSubscription(clientId, data, clients);
      break;
      
    case 'unsubscribe':
      handleUnsubscription(clientId, data, clients);
      break;
      
    case 'ping':
      client.ws.send(JSON.stringify({
        type: 'pong',
        data: { timestamp: new Date().toISOString() }
      }));
      break;
      
    case 'request_data':
      handleDataRequest(clientId, data, clients);
      break;
      
    default:
      logger.warn(`Unknown WebSocket message type: ${type}`);
      client.ws.send(JSON.stringify({
        type: 'error',
        data: { message: 'Unknown message type' }
      }));
  }
}

function handleSubscription(clientId, data, clients) {
  const client = clients.get(clientId);
  if (!client) return;

  const { channel } = data;
  
  // Validate subscription channels
  const allowedChannels = [
    'metrics',
    'alerts', 
    'system_status',
    'chain_updates',
    'worker_updates'
  ];

  if (!allowedChannels.includes(channel)) {
    client.ws.send(JSON.stringify({
      type: 'error',
      data: { message: 'Invalid subscription channel' }
    }));
    return;
  }

  // Role-based channel access
  if (channel === 'system_status' && client.user.role !== 'admin') {
    client.ws.send(JSON.stringify({
      type: 'error',
      data: { message: 'Insufficient permissions for this channel' }
    }));
    return;
  }

  client.subscriptions.add(channel);
  
  client.ws.send(JSON.stringify({
    type: 'subscription_confirmed',
    data: { channel, subscribed: true }
  }));

  logger.debug(`User ${client.user.username} subscribed to ${channel}`);
}

function handleUnsubscription(clientId, data, clients) {
  const client = clients.get(clientId);
  if (!client) return;

  const { channel } = data;
  
  client.subscriptions.delete(channel);
  
  client.ws.send(JSON.stringify({
    type: 'subscription_confirmed',
    data: { channel, subscribed: false }
  }));

  logger.debug(`User ${client.user.username} unsubscribed from ${channel}`);
}

function handleDataRequest(clientId, data, clients) {
  const client = clients.get(clientId);
  if (!client) return;

  const { requestType, params } = data;
  
  // Handle different types of data requests
  switch (requestType) {
    case 'current_status':
      // This would typically fetch current metrics and send them
      client.ws.send(JSON.stringify({
        type: 'data_response',
        data: {
          requestType,
          timestamp: new Date().toISOString(),
          // Add current status data here
        }
      }));
      break;
      
    default:
      client.ws.send(JSON.stringify({
        type: 'error',
        data: { message: 'Unknown data request type' }
      }));
  }
}

function generateClientId() {
  return Math.random().toString(36).substr(2, 9);
}

module.exports = { setupWebSocket };