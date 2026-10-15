#!/usr/bin/env sh
# Deploy one or all BUNKER services to Fly.io from the repo root.
#   deploy/fly-deploy.sh [app|relayer|indexer|agents|all]
# Contract addresses are read from contracts/deployments/56.json; secrets
# (keys, keyed RPC URLs) are set separately with `flyctl secrets set` and never
# pass through this script.
set -eu
cd "$(dirname "$0")/.."
what="${1:-all}"
dep=contracts/deployments/56.json
[ -f "$dep" ] || { echo "missing $dep: deploy the contracts first (npm run -w contracts deploy:bsc)"; exit 1; }
pool=$(node -p "require('./$dep').pool")
launchpad=$(node -p "require('./$dep').launchpad")
swapexit=$(node -p "require('./$dep').swapExit || ''")
start=$(node -p "require('./$dep').startBlock")
sha=$(git rev-parse --short HEAD)

service() {
  name=$1
  flyctl deploy --config "deploy/fly.$name.toml" --dockerfile deploy/Dockerfile.service --remote-only \
    --build-arg SERVICE="$name" --build-arg GIT_SHA="$sha" \
    --env POOL_ADDRESS="$pool" --env LAUNCHPAD_ADDRESS="$launchpad" --env SWAP_EXIT_ADDRESS="$swapexit" --env START_BLOCK="$start"
}

case "$what" in
  relayer|indexer|agents) service "$what" ;;
  app)
    flyctl deploy --config deploy/fly.app.toml --dockerfile deploy/Dockerfile.app --remote-only \
      --build-arg GIT_SHA="$sha" \
      --build-arg NEXT_PUBLIC_POOL_ADDRESS="$pool" --build-arg NEXT_PUBLIC_LAUNCHPAD_ADDRESS="$launchpad" \
      --build-arg NEXT_PUBLIC_SWAP_EXIT_ADDRESS="$swapexit" \
      ${NEXT_PUBLIC_RELAYER_URLS:+--build-arg NEXT_PUBLIC_RELAYER_URLS="$NEXT_PUBLIC_RELAYER_URLS"} \
      ${NEXT_PUBLIC_RPC_URL:+--build-arg NEXT_PUBLIC_RPC_URL="$NEXT_PUBLIC_RPC_URL"}
    ;;
  all) service indexer; service relayer; service agents; "$0" app ;;
  *) echo "usage: $0 [app|relayer|indexer|agents|all]"; exit 2 ;;
esac
