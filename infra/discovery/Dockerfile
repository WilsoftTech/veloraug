FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
WORKDIR /app
ENV NODE_ENV=production
# ffprobe/ffmpeg for bounded media verification (VELORA_DISCOVERY_INSPECTION=bounded only;
# metadata mode never runs them). The worker refuses to start in bounded mode unless both report a version.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV VELORA_FFPROBE_PATH=/usr/bin/ffprobe VELORA_FFMPEG_PATH=/usr/bin/ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY services/media-gateway/package.json services/media-gateway/package-lock.json services/media-gateway/
RUN cd services/media-gateway && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY lib/ lib/
COPY types/ types/
COPY scripts/ingest/register.mjs scripts/ingest/
COPY services/media-gateway/*.mts services/media-gateway/
COPY infra/discovery/entrypoint.sh /app/entrypoint.sh
USER node
STOPSIGNAL SIGTERM
CMD ["sh", "/app/entrypoint.sh"]
