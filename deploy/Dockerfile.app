# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* ./
COPY sdk/package.json sdk/
COPY app/package.json app/
COPY circuits/package.json circuits/
COPY contracts/package.json contracts/
COPY relayer/package.json relayer/
COPY indexer/package.json indexer/
COPY agents/package.json agents/
COPY legacy/sdk-v1/package.json legacy/sdk-v1/
COPY legacy/indexer-v1/package.json legacy/indexer-v1/
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM deps AS build
ARG NEXT_PUBLIC_CHAIN_ID=56
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_INDEXER_URL
ARG NEXT_PUBLIC_RELAYER_URL
ARG NEXT_PUBLIC_AGENTS_URL
ARG NEXT_PUBLIC_POOL_ADDRESS
ARG NEXT_PUBLIC_LAUNCHPAD_ADDRESS
ARG NEXT_PUBLIC_SWAP_EXIT_ADDRESS
ARG NEXT_PUBLIC_RELAYER_URLS
ARG NEXT_PUBLIC_SITE_URL
ARG GIT_SHA=unknown
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID \
    NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL \
    NEXT_PUBLIC_RELAYER_URL=$NEXT_PUBLIC_RELAYER_URL \
    NEXT_PUBLIC_AGENTS_URL=$NEXT_PUBLIC_AGENTS_URL \
    NEXT_PUBLIC_POOL_ADDRESS=$NEXT_PUBLIC_POOL_ADDRESS \
    NEXT_PUBLIC_LAUNCHPAD_ADDRESS=$NEXT_PUBLIC_LAUNCHPAD_ADDRESS \
    NEXT_PUBLIC_SWAP_EXIT_ADDRESS=$NEXT_PUBLIC_SWAP_EXIT_ADDRESS \
    NEXT_PUBLIC_RELAYER_URLS=$NEXT_PUBLIC_RELAYER_URLS \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_GIT_SHA=$GIT_SHA
COPY sdk sdk
COPY legacy/sdk-v1 legacy/sdk-v1
COPY app app
# proving artifacts (wasm + zkey) are served statically; copy whatever was built locally
COPY circuits/build/transact2x3/transact2x3_js/transact2x3.wasm app/public/circuits/transact2x3.wasm
COPY circuits/build/transact2x3/transact2x3_dev.zkey app/public/circuits/transact2x3.zkey
COPY circuits/build/transact4x3/transact4x3_js/transact4x3.wasm app/public/circuits/transact4x3.wasm
COPY circuits/build/transact4x3/transact4x3_dev.zkey app/public/circuits/transact4x3.zkey
# protocol v1 artifacts: v1 notes stay spendable / migratable from the same app
COPY circuits/legacy/build/transact2x2/transact2x2_js/transact2x2.wasm app/public/circuits/v1/transact2x2.wasm
COPY circuits/legacy/build/transact2x2/transact2x2_dev.zkey app/public/circuits/v1/transact2x2.zkey
COPY circuits/legacy/build/transact4x2/transact4x2_js/transact4x2.wasm app/public/circuits/v1/transact4x2.wasm
COPY circuits/legacy/build/transact4x2/transact4x2_dev.zkey app/public/circuits/v1/transact4x2.zkey
ARG NEXT_PUBLIC_INDEXER_V1_URL
ARG NEXT_PUBLIC_MIGRATE_EXIT_ADDRESS
ENV NEXT_PUBLIC_INDEXER_V1_URL=$NEXT_PUBLIC_INDEXER_V1_URL NEXT_PUBLIC_MIGRATE_EXIT_ADDRESS=$NEXT_PUBLIC_MIGRATE_EXIT_ADDRESS
RUN npm run -w sdk build && npm run -w legacy/sdk-v1 build && npm run -w app build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -r app && useradd -r -g app app
COPY --from=build --chown=app:app /repo/app/.next/standalone ./
COPY --from=build --chown=app:app /repo/app/.next/static ./app/.next/static
COPY --from=build --chown=app:app /repo/app/public ./app/public
USER app
EXPOSE 3000
CMD ["node", "app/server.js"]
