#!/usr/bin/env sh
# Deploy one or all BUNKER services to Fly.io from the repo root.
#   deploy/fly-deploy.sh [app|relayer|indexer|indexer-v1|agents|all]
# Contract addresses are read from contracts/deployments/56.json (protocol v2)
# and contracts/deployments/56.v1.json (the frozen v1 pool/launchpad and the
# v1 -> v2 migration bridge); secrets (keys, keyed RPC URLs) are set separately
# with `flyctl secrets set` and never pass through this script.
set -eu
cd "$(dirname "$0")/.."
what="${1:-all}"
dep=contracts/deployments/56.json
dep1=contracts/deployments/56.v1.json
[ -f "$dep" ] || { echo "missing $dep: deploy the contracts first (npm run -w contracts deploy:bsc)"; exit 1; }
pool=$(node -p "require('./$dep').pool")
launchpad=$(node -p "require('./$dep').launchpad")
swapexit=$(node -p "require('./$dep').swapExit || ''")
start=$(node -p "require('./$dep').startBlock")
pool1=$(node -p "try{require('./$dep1').pool}catch{''}")
launchpad1=$(node -p "try{require('./$dep1').launchpad}catch{''}")
start1=$(node -p "try{require('./$dep1').startBlock}catch{''}")
migrate=$(node -p "try{require('./$dep1').migrateExit||''}catch{''}")
sha=$(git rev-parse --short HEAD)
indexer_v1_url="${INDEXER_V1_URL:-https://bunker-indexer-v1.fly.dev}"

service() {
  name=$1
  flyctl deploy --config "deploy/fly.$name.toml" --dockerfile deploy/Dockerfile.service --remote-only \
    --build-arg SERVICE="$name" --build-arg GIT_SHA="$sha" \
    --env POOL_ADDRESS="$pool" --env LAUNCHPAD_ADDRESS="$launchpad" --env SWAP_EXIT_ADDRESS="$swapexit" --env START_BLOCK="$start" \
    --env POOL_V1_ADDRESS="$pool1" --env LAUNCHPAD_V1_ADDRESS="$launchpad1" --env MIGRATE_EXIT_ADDRESS="$migrate"
}

case "$what" in
  relayer|indexer|agents) service "$what" ;;
  indexer-v1)
    [ -n "$pool1" ] || { echo "missing $dep1"; exit 1; }
    flyctl deploy --config deploy/fly.indexer-v1.toml --dockerfile deploy/Dockerfile.service --remote-only \
      --build-arg SERVICE="legacy/indexer-v1" --build-arg GIT_SHA="$sha" \
      --env POOL_ADDRESS="$pool1" --env LAUNCHPAD_ADDRESS="$launchpad1" --env START_BLOCK="$start1"
    ;;
  app)
    flyctl deploy --config deploy/fly.app.toml --dockerfile deploy/Dockerfile.app --remote-only \
      --build-arg GIT_SHA="$sha" \
      --build-arg NEXT_PUBLIC_POOL_ADDRESS="$pool" --build-arg NEXT_PUBLIC_LAUNCHPAD_ADDRESS="$launchpad" \
      --build-arg NEXT_PUBLIC_SWAP_EXIT_ADDRESS="$swapexit" \
      --build-arg NEXT_PUBLIC_INDEXER_V1_URL="$indexer_v1_url" --build-arg NEXT_PUBLIC_MIGRATE_EXIT_ADDRESS="$migrate" \
      ${NEXT_PUBLIC_RELAYER_URLS:+--build-arg NEXT_PUBLIC_RELAYER_URLS="$NEXT_PUBLIC_RELAYER_URLS"} \
      ${NEXT_PUBLIC_RPC_URL:+--build-arg NEXT_PUBLIC_RPC_URL="$NEXT_PUBLIC_RPC_URL"}
    ;;
  all) service indexer; "$0" indexer-v1; service relayer; service agents; "$0" app ;;
  *) echo "usage: $0 [app|relayer|indexer|indexer-v1|agents|all]"; exit 2 ;;
esac
