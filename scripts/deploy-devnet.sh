#!/usr/bin/env sh
# Deploy both programs to devnet and initialize the protocol.
# Expects target/deploy/*.so (from `cargo build-sbf` or the CI artifact) and
# keypairs/{deployer,scash_vault-keypair,scash_harvester-keypair}.json.
set -eu
RPC="${RPC_URL:-https://api.devnet.solana.com}"
solana config set --url "$RPC" --keypair keypairs/deployer.json >/dev/null
echo "deployer: $(solana address)  balance: $(solana balance)"
solana program deploy target/deploy/scash_vault.so \
  --program-id keypairs/scash_vault-keypair.json --upgrade-authority keypairs/deployer.json
solana program deploy target/deploy/scash_harvester.so \
  --program-id keypairs/scash_harvester-keypair.json --upgrade-authority keypairs/deployer.json
if [ -f keypairs/scash_migrator-keypair.json ]; then
  solana program deploy target/deploy/scash_migrator.so \
    --program-id keypairs/scash_migrator-keypair.json --upgrade-authority keypairs/deployer.json
fi
node scripts/init.mjs --keypair keypairs/deployer.json --rpc "$RPC"
