const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const ldap = require('ldapjs');
const Database = require('../database/database');
const logger = require('../utils/logger');

// Initialize database instance (will be set by the server)
let db = null;

// Function to set database instance from server
const setDatabase = (database) => {
  db = database;
};

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  try {
    // Check for session-based authentication first
    if (req.session && req.session.userId) {
      const user = await db.getUserById(req.session.userId);
      if (user) {
        req.user = user;
        return next();
      }
    }

    // Check for JWT token in headers
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      logger.logSecurity('Unauthorized access attempt', 'No token provided', req);
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-secret');
      const user = await db.getUserById(decoded.userId);
      
      if (!user) {
        logger.logSecurity('Invalid token', 'User not found', req);
        return res.status(401).json({ error: 'Invalid token.' });
      }

      req.user = user;
      next();
    } catch (jwtError) {
      logger.logSecurity('Invalid token', jwtError.message, req);
      return res.status(403).json({ error: 'Invalid token.' });
    }

  } catch (error) {
    logger.error('Authentication middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Role-based authorization middleware
const requireRole = (requiredRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role !== requiredRole && req.user.role !== 'admin') {
      logger.logSecurity('Insufficient permissions', `Required: ${requiredRole}, Has: ${req.user.role}`, req);
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};

// SQLite authentication
const authenticateWithSQLite = async (username, password) => {
  try {
    const user = await db.getUserByUsername(username);
    if (!user) {
      return { success: false, error: 'Invalid credentials' };
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return { success: false, error: 'Invalid credentials' };
    }

    // Update last login
    await db.updateUserLastLogin(user.id);

    return { 
      success: true, 
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    };
  } catch (error) {
    logger.error('SQLite authentication error:', error);
    return { success: false, error: 'Authentication failed' };
  }
};

// LDAP authentication with group-based role assignment
const authenticateWithLDAP = async (username, password) => {
  return new Promise((resolve) => {
    try {
      logger.info(`Starting LDAP authentication for user: ${username}`);
      logger.debug('LDAP config:', {
        server: process.env.LDAP_SERVER,
        port: process.env.LDAP_PORT,
        searchBase: process.env.LDAP_USER_SEARCH_BASE,
        searchFilter: process.env.LDAP_USER_SEARCH_FILTER
      });
      
      const client = ldap.createClient({
        url: `${process.env.LDAP_SERVER}:${process.env.LDAP_PORT || 389}`,
        timeout: 10000,
        connectTimeout: 10000,
      });

      // First bind with service account
      const bindDN = process.env.LDAP_BIND_DN;
      const bindPassword = process.env.LDAP_BIND_PASSWORD;

      client.bind(bindDN, bindPassword, (bindErr) => {
        if (bindErr) {
          logger.error('LDAP bind error:', {
            server: process.env.LDAP_SERVER,
            port: process.env.LDAP_PORT,
            bindDN: bindDN,
            error: bindErr.message
          });
          try {
            client.unbind();
          } catch (unbindErr) {
            // Ignore unbind errors
          }
          return resolve({ success: false, error: 'LDAP server unavailable' });
        }
        
        logger.debug('LDAP bind successful, searching for user:', username);

        // Search for user
        const searchBase = process.env.LDAP_USER_SEARCH_BASE;
        const searchFilter = process.env.LDAP_USER_SEARCH_FILTER.replace('{username}', username);
        const searchOptions = {
          scope: 'sub',
          filter: searchFilter,
          attributes: process.env.LDAP_USER_ATTRIBUTES?.split(',') || ['uid', 'cn', 'mail', 'memberOf']
        };

        client.search(searchBase, searchOptions, (searchErr, searchRes) => {
          if (searchErr) {
            logger.error('LDAP search error:', searchErr);
            client.unbind();
            return resolve({ success: false, error: 'LDAP search failed' });
          }

          let userDN = null;
          let userAttributes = {};

          searchRes.on('searchEntry', (entry) => {
            userDN = entry.dn.toString();
            userAttributes = entry.object;
            logger.debug('LDAP user found:', { 
              dn: userDN, 
              attributes: Object.keys(userAttributes),
              uid: userAttributes.uid,
              mail: userAttributes.mail
            });
          });

          searchRes.on('error', (err) => {
            logger.error('LDAP search result error:', err);
            client.unbind();
            resolve({ success: false, error: 'User search failed' });
          });

          searchRes.on('end', (result) => {
            if (!userDN) {
              client.unbind();
              return resolve({ success: false, error: 'User not found' });
            }

            // Try to bind with user credentials
            const userClient = ldap.createClient({
              url: `${process.env.LDAP_SERVER}:${process.env.LDAP_PORT || 389}`,
              timeout: 10000,
              connectTimeout: 10000,
            });

            userClient.bind(userDN, password, async (userBindErr) => {
              if (userBindErr) {
                userClient.unbind();
                client.unbind();
                logger.error('LDAP user bind error:', userBindErr);
                return resolve({ success: false, error: 'Invalid credentials' });
              }

              try {
                // Determine user role based on LDAP group membership
                const userRole = await determineUserRoleFromGroups(client, userDN, userAttributes);
                
                if (!userRole) {
                  userClient.unbind();
                  client.unbind();
                  logger.warn(`User ${username} is not a member of any authorized groups`);
                  return resolve({ success: false, error: 'User not authorized' });
                }

                // Get the actual username from LDAP attributes for storage
                const actualUsername = userAttributes.uid || userAttributes.cn || username;
                const userEmail = userAttributes.mail || userAttributes.cn || '';
                
                logger.info(`LDAP auth successful for user: ${actualUsername} (${userEmail}) with role: ${userRole}`);

                // Check if user exists in local database, create if not
                let user = await db.getUserByUsername(actualUsername);
                if (!user) {
                  // Create user in local database with role from LDAP groups
                  const userId = await db.createUser({
                    username: actualUsername,
                    email: userEmail,
                    password: 'ldap-user', // Placeholder password
                    role: userRole
                  });
                  user = await db.getUserById(userId);
                  logger.info(`Created new LDAP user: ${actualUsername} with role: ${userRole}`);
                } else {
                  // Update user role and last login
                  await db.updateUser(user.id, { role: userRole });
                  await db.updateUserLastLogin(user.id);
                  user.role = userRole; // Update in memory
                  logger.info(`Updated existing LDAP user: ${actualUsername} with role: ${userRole}`);
                }

                userClient.unbind();
                client.unbind();

                resolve({ 
                  success: true, 
                  user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role
                  }
                });
              } catch (dbError) {
                userClient.unbind();
                client.unbind();
                logger.error('Database error during LDAP auth:', dbError);
                resolve({ success: false, error: 'Authentication failed' });
              }
            });
          });
        });
      });

    } catch (error) {
      logger.error('LDAP authentication error:', error.message);
      resolve({ success: false, error: 'LDAP authentication failed' });
    }
  });
};

// Function to determine user role based on LDAP group membership
const determineUserRoleFromGroups = (client, userDN, userAttributes) => {
  return new Promise((resolve) => {
    try {
      const adminGroups = process.env.LDAP_ADMIN_GROUPS?.split(',') || ['cn=lldap_admin,ou=groups,dc=roomit,dc=xyz'];
      const monitoringGroups = process.env.LDAP_MONITORING_GROUPS?.split(',') || ['cn=lldap_web_admin,ou=groups,dc=roomit,dc=xyz'];
      
      const username = userAttributes.uid || userAttributes.cn || 'unknown';
      logger.debug(`Checking group membership for user: ${username}`, {
        adminGroups,
        monitoringGroups,
        memberOf: userAttributes.memberOf
      });
      
      // Check memberOf attribute first (if available)
      const memberOf = userAttributes.memberOf;
      if (memberOf) {
        const groups = Array.isArray(memberOf) ? memberOf : [memberOf];
        logger.debug(`User ${username} memberOf groups:`, groups);
        
        // Check for admin groups first (trim whitespace)
        for (const adminGroup of adminGroups.map(g => g.trim())) {
          if (groups.some(group => {
            const groupLower = group.toLowerCase();
            const adminGroupLower = adminGroup.toLowerCase();
            return groupLower.includes(adminGroupLower) || adminGroupLower.includes(groupLower);
          })) {
            logger.info(`User ${username} assigned admin role via group: ${adminGroup}`);
            return resolve('admin');
          }
        }
        
        // Check for monitoring groups (trim whitespace)
        for (const monitoringGroup of monitoringGroups.map(g => g.trim())) {
          if (groups.some(group => {
            const groupLower = group.toLowerCase();
            const monitoringGroupLower = monitoringGroup.toLowerCase();
            return groupLower.includes(monitoringGroupLower) || monitoringGroupLower.includes(groupLower);
          })) {
            logger.info(`User ${username} assigned monitoring role via group: ${monitoringGroup}`);
            return resolve('monitoring');
          }
        }
      } else {
        logger.debug(`No memberOf attribute found for user: ${username}, will search groups manually`);
      }

      // If memberOf is not available, search for group membership
      const allGroups = [...adminGroups, ...monitoringGroups];
      let groupsChecked = 0;
      let roleFound = null;

      if (allGroups.length === 0) {
        logger.warn('No LDAP groups configured, defaulting to monitoring role');
        return resolve('monitoring');
      }

      // Search for group membership manually (fallback for lldap)
      allGroups.forEach((groupDN) => {
        const trimmedGroupDN = groupDN.trim();
        // Try different search filters for lldap compatibility
        const searchFilters = [
          `(&(objectClass=groupOfNames)(member=${userDN}))`,
          `(&(objectClass=groupOfUniqueNames)(uniqueMember=${userDN}))`,
          `(&(objectClass=group)(member=${userDN}))`,
          `(&(cn=${trimmedGroupDN.split(',')[0].replace('cn=', '')})(member=${userDN}))`
        ];

        let filterIndex = 0;
        
        const tryNextFilter = () => {
          if (filterIndex >= searchFilters.length) {
            groupsChecked++;
            if (groupsChecked === allGroups.length && !roleFound) {
              logger.warn(`No authorized groups found for user: ${username}`);
              resolve(null);
            }
            return;
          }

          const groupSearchFilter = searchFilters[filterIndex];
          const groupSearchOptions = {
            scope: 'sub',
            filter: groupSearchFilter,
            attributes: ['cn', 'member', 'uniqueMember']
          };

          logger.debug(`Searching for group membership with filter: ${groupSearchFilter}`);

          client.search(trimmedGroupDN, groupSearchOptions, (searchErr, searchRes) => {
            if (searchErr) {
              logger.debug(`LDAP group search attempt ${filterIndex + 1} failed for ${trimmedGroupDN}:`, searchErr.message);
              filterIndex++;
              tryNextFilter();
              return;
            }

            let entryFound = false;

            searchRes.on('searchEntry', (entry) => {
              if (!roleFound && !entryFound) {
                entryFound = true;
                if (adminGroups.map(g => g.trim()).includes(trimmedGroupDN)) {
                  roleFound = 'admin';
                  logger.info(`User ${username} assigned admin role via group: ${trimmedGroupDN}`);
                } else if (monitoringGroups.map(g => g.trim()).includes(trimmedGroupDN)) {
                  roleFound = 'monitoring';
                  logger.info(`User ${username} assigned monitoring role via group: ${trimmedGroupDN}`);
                }
              }
            });

            searchRes.on('error', (err) => {
              logger.debug(`LDAP group search result error for ${trimmedGroupDN}:`, err.message);
              filterIndex++;
              tryNextFilter();
            });

            searchRes.on('end', () => {
              if (entryFound || filterIndex >= searchFilters.length - 1) {
                groupsChecked++;
                if (groupsChecked === allGroups.length) {
                  if (!roleFound) {
                    logger.warn(`User ${username} is not a member of any authorized groups`);
                  }
                  resolve(roleFound);
                }
              } else {
                filterIndex++;
                tryNextFilter();
              }
            });
          });
        };

        tryNextFilter();
      });
    } catch (error) {
      logger.error('Error determining user role from groups:', error);
      resolve(null);
    }
  });
};

// Main authentication function
const authenticate = async (username, password, req) => {
  try {
    if (!db) {
      throw new Error('Database not initialized');
    }
    const authMethod = await db.getConfig('auth_method') || 'sqlite';
    
    logger.info(`Authentication attempt for user: ${username} using method: ${authMethod}`);
    
    let result;
    if (authMethod === 'ldap') {
      result = await authenticateWithLDAP(username, password);
    } else {
      result = await authenticateWithSQLite(username, password);
    }

    // Log authentication attempt
    logger.logAuth('login', username, req, result.success, result.error ? new Error(result.error) : null);

    return result;
  } catch (error) {
    logger.error('Authentication error:', error);
    logger.logAuth('login', username, req, false, error);
    return { success: false, error: 'Authentication failed' };
  }
};

// Generate JWT token
const generateToken = (user) => {
  const payload = {
    userId: user.id,
    username: user.username,
    role: user.role
  };
  
  return jwt.sign(payload, process.env.JWT_SECRET || 'default-secret', { 
    expiresIn: '24h' 
  });
};

// Rate limiting for authentication attempts
const authAttempts = new Map();

const rateLimitAuth = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const maxAttempts = parseInt(process.env.MAX_FAILED_LOGINS) || 5;
  const windowMs = 15 * 60 * 1000; // 15 minutes
  
  const now = Date.now();
  const attempts = authAttempts.get(ip) || [];
  
  // Remove old attempts outside the window
  const recentAttempts = attempts.filter(timestamp => now - timestamp < windowMs);
  
  if (recentAttempts.length >= maxAttempts) {
    logger.logSecurity('Rate limit exceeded', `IP: ${ip}, Attempts: ${recentAttempts.length}`, req);
    return res.status(429).json({ 
      error: 'Too many authentication attempts. Please try again later.' 
    });
  }
  
  // Add current attempt timestamp on failure (handled in auth route)
  req.addAuthAttempt = () => {
    recentAttempts.push(now);
    authAttempts.set(ip, recentAttempts);
  };
  
  // Clear attempts on successful auth
  req.clearAuthAttempts = () => {
    authAttempts.delete(ip);
  };
  
  next();
};

module.exports = {
  authenticateToken,
  requireRole,
  authenticate,
  generateToken,
  rateLimitAuth,
  setDatabase
};