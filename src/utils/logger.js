const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for different log levels
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

// Tell winston that you want to link the colors
winston.addColors(colors);

// Chose the aspect of your log customizing the log format.
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.prettyPrint()
);

// Define which transports the logger must use to print out messages.
const transports = [
  // Console transport
  new winston.transports.Console({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(
        (info) => `${info.timestamp} [${info.level}]: ${info.message}`
      )
    )
  }),
  
  // File transport for all logs
  new winston.transports.File({
    filename: process.env.LOG_FILE_PATH || path.join(logsDir, 'ibc-monitor.log'),
    level: 'info',
    format: format,
    maxsize: 5242880, // 5MB
    maxFiles: 5,
  }),
  
  // File transport for error logs
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    format: format,
    maxsize: 5242880, // 5MB
    maxFiles: 5,
  }),
];

// Create the logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels,
  format,
  transports,
  // Do not exit on handled exceptions
  exitOnError: false,
});

// Create a stream object with a 'write' function that will be used by `morgan`
logger.stream = {
  write: function(message) {
    logger.http(message.trim());
  },
};

// Add request logging helper
logger.logRequest = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent'),
      userId: req.session?.userId || 'anonymous'
    };
    
    if (res.statusCode >= 400) {
      logger.warn('HTTP Request', logData);
    } else {
      logger.http('HTTP Request', logData);
    }
  });
  
  next();
};

// Add authentication logging
logger.logAuth = (action, user, req, success = true, error = null) => {
  const logData = {
    action,
    user: typeof user === 'object' ? user.username : user,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent'),
    success,
    timestamp: new Date().toISOString()
  };
  
  if (error) {
    logData.error = error.message;
    logger.error('Auth Event', logData);
  } else if (success) {
    logger.info('Auth Event', logData);
  } else {
    logger.warn('Auth Event', logData);
  }
};

// Add security logging
logger.logSecurity = (event, details, req) => {
  const logData = {
    event,
    details,
    ip: req?.ip || req?.connection?.remoteAddress,
    userAgent: req?.get('User-Agent'),
    userId: req?.session?.userId,
    timestamp: new Date().toISOString()
  };
  
  logger.warn('Security Event', logData);
};

// Add alert logging
logger.logAlert = (alert, sent = true, error = null) => {
  const logData = {
    type: alert.type,
    chain: alert.chain,
    severity: alert.severity,
    sent,
    timestamp: new Date().toISOString()
  };
  
  if (error) {
    logData.error = error.message;
    logger.error('Alert Event', logData);
  } else {
    logger.info('Alert Event', logData);
  }
};

// Add metrics logging
logger.logMetrics = (source, success = true, error = null, responseTime = null) => {
  const logData = {
    source: typeof source === 'object' ? source.name : source,
    success,
    responseTime: responseTime ? `${responseTime}ms` : null,
    timestamp: new Date().toISOString()
  };
  
  if (error) {
    logData.error = error.message;
    logger.error('Metrics Collection', logData);
  } else {
    logger.debug('Metrics Collection', logData);
  }
};

module.exports = logger;