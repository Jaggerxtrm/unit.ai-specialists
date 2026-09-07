FROM docker.io/oven/bun:1.4.2 AS builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json vitest.config.ts ./
COPY src ./src
COPY config ./config
COPY scripts/generate-asset-contract.mjs ./scripts/generate-asset-contract.mjs
COPY scripts/postprocess-build.mjs ./scripts/postprocess-build.mjs
COPY .gitignore ./.gitignore

RUN bun install --frozen-lockfile
RUN bun run build

FROM docker.io/oven/bun:1.4.2-slim AS runtime
ARG PI_VERSION=latest
WORKDIR /app

ENV NODE_ENV=production
ENV HOME=/home/specialists

# Runtime working directory is /work — the consumer's project root mount.
# /app holds the dist/ bundle; /work holds .specialists/ (specs + observability.db).
# Overridable via compose `working_dir:` if a consumer wants a different layout.

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates sqlite3 npm \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home --home-dir /home/specialists --shell /usr/sbin/nologin specialists \
  && npm install -g "@mariozechner/pi-coding-agent@${PI_VERSION}"

COPY --from=builder /app/dist ./dist

RUN printf '#!/bin/sh\nexec bun /app/dist/index.js "$@"\n' > /usr/local/bin/sp \
  && chmod +x /usr/local/bin/sp \
  && ln -s /usr/local/bin/sp /usr/local/bin/specialists

LABEL org.specialists.uid="10001"

USER specialists:specialists
WORKDIR /work

# Default healthcheck targets the default --port 8000. If a deploy overrides the
# port via CMD or compose `command:`, override this with a compose-level
# `healthcheck:` block. node is on PATH from the bun:slim base; no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["sp", "serve"]
CMD ["--port", "8000"]
