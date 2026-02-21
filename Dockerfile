FROM node:18-alpine
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

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
