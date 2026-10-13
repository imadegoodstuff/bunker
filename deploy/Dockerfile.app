# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* ./
COPY sdk/package.json sdk/
COPY app/package.json app/
COPY circuits/package.json circuits/
COPY relayer/package.json relayer/
COPY indexer/package.json indexer/
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM deps AS build
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_CLUSTER=devnet
ARG NEXT_PUBLIC_INDEXER_URL
ARG NEXT_PUBLIC_RELAYER_URL
ARG NEXT_PUBLIC_PROGRAM_ID
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_CLUSTER=$NEXT_PUBLIC_CLUSTER \
    NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL \
    NEXT_PUBLIC_RELAYER_URL=$NEXT_PUBLIC_RELAYER_URL \
    NEXT_PUBLIC_PROGRAM_ID=$NEXT_PUBLIC_PROGRAM_ID \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
COPY sdk sdk
COPY app app
# proving artifacts (wasm + zkey) are served statically; copy whatever was built locally
COPY circuits/build/transact2x2/transact2x2_js/transact2x2.wasm app/public/circuits/transact2x2.wasm
COPY circuits/build/transact2x2/transact2x2_dev.zkey app/public/circuits/transact2x2.zkey
COPY circuits/build/transact4x2/transact4x2_js/transact4x2.wasm app/public/circuits/transact4x2.wasm
COPY circuits/build/transact4x2/transact4x2_dev.zkey app/public/circuits/transact4x2.zkey
RUN npm run -w sdk build && npm run -w app build

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
