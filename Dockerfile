# Hookmint HTTP server. NOT yet built or tested in CI: build it and run /readyz before relying on it.
# Chromium is included because HOOKMINT_RENDERER=remotion renders videos in a browser.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
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
RUN useradd --system --uid 10001 hookmint && mkdir -p /data && chown hookmint /data
USER hookmint
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/http.js"]
