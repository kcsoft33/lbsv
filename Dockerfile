# LabSave hub: serves the UI, REST API, WebSocket fan-out. Data lives in /data (mount a volume).
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain only used if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:ext && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    LBSV_DATA_DIR=/data \
    LBSV_HOST=0.0.0.0 \
    LBSV_PORT=8080 \
    LBSV_UI_DIR=/app/packages/ui/dist
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/packages/hub/src ./packages/hub/src
COPY --from=build /app/packages/hub/bin ./packages/hub/bin
COPY --from=build /app/packages/hub/migrations ./packages/hub/migrations
COPY --from=build /app/packages/ui/dist ./packages/ui/dist
COPY --from=build /app/packages/ext/dist/packages ./packages/ext/dist/packages
RUN chmod +x packages/hub/bin/lbsv.js \
 && ln -s /app/packages/hub/bin/lbsv.js /usr/local/bin/lbsv \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/hub/src/cli.ts", "serve"]
