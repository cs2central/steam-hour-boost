FROM node:20-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create directories for persistent data
RUN mkdir -p /app/data /app/mafiles

# Set permissions
RUN chown -R node:node /app

USER node

# Expose the web UI port
EXPOSE 8869

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8869/health || exit 1

CMD ["node", "src/index.js"]
