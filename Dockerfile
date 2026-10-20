# syntax=docker/dockerfile:1

# ---- build: install production dependencies. better-sqlite3 is a native module, so this stage has a compiler
#      in case there is no prebuilt binary for the platform. None of it reaches the final image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- run: only what the server needs.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/lightlms.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

# Everything that must survive a restart (the database, its backups) lives in /data. Mount a volume there.
VOLUME /data
EXPOSE 3000

# The entrypoint starts as root only to fix the ownership of a freshly mounted volume, then runs the server as "node".
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
