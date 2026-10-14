// What the connected wallet holds. Every SPL / Token-2022 mint with a balance
// becomes a shieldable asset: pools are permissionless, so the first shield of
// a new mint opens its pool. Names come from Jupiter's token registry, then the
// mint's Metaplex metadata, then the mint address itself.
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@scash/sdk";
import type { AssetMeta } from "./config";

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const REGISTRY = process.env.NEXT_PUBLIC_TOKEN_REGISTRY ?? "https://lite-api.jup.ag/tokens/v2/search";

export interface WalletToken {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  /** public balance in base units */
  amount: bigint;
}

export async function walletTokens(conn: Connection, owner: PublicKey): Promise<WalletToken[]> {
  const out: WalletToken[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId }).catch(() => ({ value: [] }));
    for (const { account } of res.value) {
      const info = (account.data as { parsed?: { info?: { mint: string; tokenAmount: { amount: string; decimals: number } } } }).parsed?.info;
      if (!info) continue;
      const amount = BigInt(info.tokenAmount.amount);
      if (amount === 0n) continue;
      out.push({ mint: new PublicKey(info.mint), tokenProgram: programId, decimals: info.tokenAmount.decimals, amount });
    }
  }
  return out;
}

interface RegistryRow { id: string; name?: string; symbol?: string; icon?: string; decimals?: number }

async function registry(mints: string[]): Promise<Map<string, RegistryRow>> {
  const m = new Map<string, RegistryRow>();
  for (let i = 0; i < mints.length; i += 50) {
    try {
      const r = await fetch(`${REGISTRY}?query=${mints.slice(i, i + 50).join(",")}`);
      if (!r.ok) continue;
      for (const row of (await r.json()) as RegistryRow[]) m.set(row.id, row);
    } catch { /* offline registry: fall through to on-chain names */ }
  }
  return m;
}

function metadataPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBytes(), mint.toBytes()], METAPLEX)[0];
}

/** Metaplex metadata: key(1) update_authority(32) mint(32) name(u32 + bytes) symbol(u32 + bytes); strings are null-padded. */
function parseMetaplex(data: Buffer): { name: string; symbol: string } | undefined {
  try {
    let o = 65;
    const nameLen = data.readUInt32LE(o); o += 4;
    const name = data.subarray(o, o + nameLen).toString("utf8").replace(/\0+$/, ""); o += nameLen;
    const symLen = data.readUInt32LE(o); o += 4;
    const symbol = data.subarray(o, o + symLen).toString("utf8").replace(/\0+$/, "");
    return symbol || name ? { name: name || symbol, symbol: symbol || name } : undefined;
  } catch {
    return undefined;
  }
}

function roundDenominations(decimals: number, amount: bigint): number[] {
  const whole = Number(amount) / 10 ** decimals;
  if (whole >= 10_000) return [100, 1000, 10_000];
  if (whole >= 100) return [1, 10, 100];
  if (whole >= 1) return [0.1, 1, 10];
  return [0.01, 0.1, 1];
}

/** Resolve names for wallet tokens and shape them as assets. Symbols are made unique so UI keys stay stable. */
export async function describe(conn: Connection, tokens: WalletToken[], taken: Set<string>): Promise<AssetMeta[]> {
  if (tokens.length === 0) return [];
  const reg = await registry(tokens.map((t) => t.mint.toBase58()));
  const missing = tokens.filter((t) => !reg.has(t.mint.toBase58()));
  const onchain = new Map<string, { name: string; symbol: string }>();
  if (missing.length) {
    const infos = await conn.getMultipleAccountsInfo(missing.map((t) => metadataPda(t.mint))).catch(() => []);
    infos.forEach((info, i) => {
      const parsed = info ? parseMetaplex(info.data) : undefined;
      if (parsed) onchain.set(missing[i].mint.toBase58(), parsed);
    });
  }
  const used = new Set(taken);
  return tokens.map((t) => {
    const k = t.mint.toBase58();
    const r = reg.get(k);
    const oc = onchain.get(k);
    let symbol = (r?.symbol || oc?.symbol || k.slice(0, 4)).trim().slice(0, 12);
    const name = (r?.name || oc?.name || `${k.slice(0, 4)}…${k.slice(-4)}`).trim();
    if (used.has(symbol)) symbol = `${symbol}·${k.slice(0, 4)}`;
    used.add(symbol);
    return {
      symbol, name, mint: t.mint, decimals: t.decimals,
      tokenProgram: t.tokenProgram.equals(TOKEN_PROGRAM_ID) ? undefined : t.tokenProgram,
      denominations: roundDenominations(t.decimals, t.amount),
      image: r?.icon, fromWallet: true,
    };
  });
}
