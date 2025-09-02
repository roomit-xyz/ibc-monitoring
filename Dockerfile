# IBC Monitor - Enterprise Monitoring Solution
# Developed by PT Roomit Trimiko Digital

FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    sqlite \
    openldap-dev \
    python3 \
    make \
    g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p database logs public/img

# Set proper permissions
RUN chmod +x scripts/*.sh || true

# Create non-root user
RUN addgroup -g 1001 -S ibcmonitor && \
    adduser -S ibcmonitor -u 1001 -G ibcmonitor

# Change ownership
RUN chown -R ibcmonitor:ibcmonitor /app

# Switch to non-root user
USER ibcmonitor

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start application
CMD ["node", "server.js"]