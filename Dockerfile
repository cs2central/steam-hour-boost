FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src
COPY views ./views
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production PORT=8869 DATA_DIR=/data
EXPOSE 8869

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8869/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
