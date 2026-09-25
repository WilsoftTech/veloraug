# Telegram's official Bot API server (tdlib/telegram-bot-api), built from source.
# No third-party image. Pins are recorded in docs/PHASE_C_INGESTION_DESIGN.md
# ("C2B.2A") and change only by a reviewed edit to this file.
#
# No credential, token, channel id or path is baked in: TELEGRAM_API_ID and
# TELEGRAM_API_HASH are read by the server from its environment at runtime.

# debian:trixie-slim (Debian 13), multi-arch index digest resolved 2026-09-26.
ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

FROM ${DEBIAN_IMAGE} AS build

# Bot API 10.3 ("Update version to 10.3.") and the td submodule commit it records.
ARG TBA_REPO=https://github.com/tdlib/telegram-bot-api.git
ARG TBA_COMMIT=2efabc722e9493b9cac450233198d09e5cea0573
ARG TD_REPO=https://github.com/tdlib/td.git
ARG TD_COMMIT=bc9c263e2bfee06aaab41e82db51a103376030bc
ARG BUILD_JOBS=4

# The official Debian dependency list (build.html), plus ca-certificates for git.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git make g++ cmake gperf zlib1g-dev libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Fetch exactly the pinned commits and refuse anything else. The superproject
# commit fixes the td gitlink, which must equal TD_COMMIT.
WORKDIR /src
RUN git init -q telegram-bot-api \
 && git -C telegram-bot-api fetch -q --depth 1 "$TBA_REPO" "$TBA_COMMIT" \
 && git -C telegram-bot-api -c advice.detachedHead=false checkout -q FETCH_HEAD \
 && test "$(git -C telegram-bot-api rev-parse HEAD)" = "$TBA_COMMIT" \
 && test "$(git -C telegram-bot-api ls-tree HEAD td | awk '{print $3}')" = "$TD_COMMIT" \
 && git -C telegram-bot-api/td init -q \
 && git -C telegram-bot-api/td fetch -q --depth 1 "$TD_REPO" "$TD_COMMIT" \
 && git -C telegram-bot-api/td -c advice.detachedHead=false checkout -q FETCH_HEAD \
 && test "$(git -C telegram-bot-api/td rev-parse HEAD)" = "$TD_COMMIT"

RUN cmake -S telegram-bot-api -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/telegram-bot-api \
 && cmake --build build --target install -j "$BUILD_JOBS" \
 && strip /opt/telegram-bot-api/bin/telegram-bot-api

FROM ${DEBIAN_IMAGE} AS runtime

ARG TBA_COMMIT=2efabc722e9493b9cac450233198d09e5cea0573
LABEL org.opencontainers.image.title="velora-telegram-bot-api" \
      org.opencontainers.image.source="https://github.com/tdlib/telegram-bot-api" \
      org.opencontainers.image.revision="${TBA_COMMIT}" \
      org.opencontainers.image.version="10.3" \
      org.opencontainers.image.licenses="BSL-1.0"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3t64 zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 telegram-bot-api \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin telegram-bot-api \
 && mkdir -p /var/lib/telegram-bot-api /media/movies \
 && chown telegram-bot-api:telegram-bot-api /var/lib/telegram-bot-api

COPY --from=build /opt/telegram-bot-api/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

USER telegram-bot-api
EXPOSE 8081

# Any HTTP answer on the port means the server is up; no token is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8081"]

ENTRYPOINT ["/usr/local/bin/telegram-bot-api"]
