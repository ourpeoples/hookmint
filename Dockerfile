# Hookmint HTTP server. Built and run on Railway; a real render of the stub-free path has to be checked after each change to render/.
# Run migrations as a deploy step (npm run db:migrate, or HOOKMINT_MIGRATE_ON_START=1); see docs/DATABASE.md.
# Chromium is included because HOOKMINT_RENDERER=remotion renders videos in a browser. An emoji font is included because scripts may use emoji in on-screen text.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOOKMINT_BROWSER=/usr/bin/chromium \
    HOOKMINT_DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY render ./render
# The video template imports the pure layout rules from src/render/layout.ts, and Remotion bundles it from source at runtime.
COPY src/render/layout.ts ./src/render/layout.ts
COPY migrations ./migrations
COPY docker-entrypoint.sh ./docker-entrypoint.sh
# Chromium's crash handler refuses to start without a writable home, so the user gets one and the browser is pointed at it.
RUN useradd --system --uid 10001 --create-home --home-dir /home/hookmint hookmint && mkdir -p /data /home/hookmint/.cache /home/hookmint/.config && chown -R hookmint /data /home/hookmint
ENV HOME=/home/hookmint XDG_CONFIG_HOME=/home/hookmint/.config XDG_CACHE_HOME=/home/hookmint/.cache
# No USER line: the entrypoint starts as root to fix the volume's owner, then runs the server as "hookmint".
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/http.js"]
