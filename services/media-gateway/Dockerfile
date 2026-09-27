# Velora UG media gateway (E1.2). Build from the repository root:
#   docker build -f services/media-gateway/Dockerfile -t velora-media-gateway .
# The context is limited by Dockerfile.dockerignore (allow-list): no session,
# journal, .env file or application source outside the gateway enters the image.
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first (cached). --ignore-scripts: no native build; the reader uses
# in-memory mtcute storage, so better-sqlite3's addon is never built or loaded.
COPY services/media-gateway/package.json services/media-gateway/package-lock.json services/media-gateway/
RUN cd services/media-gateway \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY scripts/ingest/register.mjs scripts/ingest/
COPY lib/telegram/mtproto-range.ts lib/telegram/
COPY lib/media-gateway/ lib/media-gateway/
COPY services/media-gateway/*.mts services/media-gateway/

# The session directory is a mounted, owner-only secret volume in deployment.
RUN mkdir -p /run/velora-media && chown node:node /run/velora-media
USER node
WORKDIR /app/services/media-gateway

ENV MEDIA_GATEWAY_HOST=0.0.0.0 \
    MEDIA_GATEWAY_PORT=8787 \
    MEDIA_GATEWAY_SESSION_FILE=/run/velora-media/reader.session
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "--import", "../../scripts/ingest/register.mjs", "main.mts"]
