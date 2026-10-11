FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
WORKDIR /app
ENV NODE_ENV=production VELORA_FFPROBE_PATH=/usr/bin/ffprobe VELORA_FFMPEG_PATH=/usr/bin/ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/media-gateway/package.json services/media-gateway/package-lock.json services/media-gateway/
RUN cd services/media-gateway && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY lib/ lib/
COPY types/ types/
COPY scripts/ingest/register.mjs scripts/ingest/
COPY services/media-gateway/admin-upload-r2.mts services/media-gateway/
RUN mkdir -p /media/uploads /var/lib/velora-upload-journal && chown 10001:10001 /media/uploads /var/lib/velora-upload-journal
USER 10001:10001
STOPSIGNAL SIGTERM
CMD ["node","--experimental-transform-types","--import","./scripts/ingest/register.mjs","services/media-gateway/admin-upload-r2.mts"]
