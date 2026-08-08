# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

FROM ${NODE_IMAGE} AS dependencies

ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:${PATH}

WORKDIR /workspace

RUN if command -v apt-get >/dev/null 2>&1; then \
      apt-get update && \
      apt-get install --yes --no-install-recommends g++ make python3 && \
      rm -rf /var/lib/apt/lists/*; \
    else \
      apk add --no-cache g++ make python3; \
    fi

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile --ignore-scripts

FROM dependencies AS builder

COPY . .

RUN --network=none pnpm install --offline --frozen-lockfile
RUN --network=none pnpm rebuild better-sqlite3
RUN --network=none pnpm --filter @autoforge/web build

FROM ${NODE_IMAGE} AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="AutoForge Backend" \
      org.opencontainers.image.description="Offline-first AutoForge Lite control plane" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/iskycc/auto-forge"

ENV AUTOFORGE_MODE=lite \
    AUTOFORGE_DATA_DIR=/var/lib/autoforge \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=builder --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml

RUN mkdir -p /var/lib/autoforge && chown node:node /var/lib/autoforge

USER node

EXPOSE 3000
VOLUME ["/var/lib/autoforge"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/web/server.js"]
