// ExtData encoding per SPEC.md section 7. Must match programs/scash_vault/src/state.rs.
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { mod, bytesToBigIntBE, bigIntToBytesLE, concatBytes } from "./field.js";

export interface ExtData {
  recipient: PublicKey;
  relayer: PublicKey;
  relayerFee: bigint; // u64, asset base units
  exitTarget: PublicKey; // default = SystemProgram id meaning "none"
  exitData: Uint8Array;
  ciphertexts: Uint8Array[];
  outCiphertext: Uint8Array;
}

export const NO_EXIT = new PublicKey("11111111111111111111111111111111");

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function vec(b: Uint8Array): Uint8Array {
  return concatBytes(u32le(b.length), b);
}

/** Borsh-compatible serialization (fixed order, u32 length prefixes). */
export function serializeExtData(e: ExtData): Uint8Array {
  return concatBytes(
    e.recipient.toBytes(),
    e.relayer.toBytes(),
    bigIntToBytesLE(e.relayerFee, 8),
    e.exitTarget.toBytes(),
    vec(e.exitData),
    u32le(e.ciphertexts.length),
    ...e.ciphertexts.map(vec),
    vec(e.outCiphertext)
  );
}

export function extDataHash(e: ExtData): bigint {
  return mod(bytesToBigIntBE(sha256(serializeExtData(e))));
}

export function deserializeExtData(b: Uint8Array): ExtData {
  let o = 0;
  const take = (n: number) => {
    const s = b.slice(o, o + n);
    o += n;
    return s;
  };
  const u32 = () => new DataView(take(4).buffer).getUint32(0, true);
  const recipient = new PublicKey(take(32));
  const relayer = new PublicKey(take(32));
  const feeBytes = take(8);
  let relayerFee = 0n;
  for (let i = 7; i >= 0; i--) relayerFee = (relayerFee << 8n) | BigInt(feeBytes[i]);
  const exitTarget = new PublicKey(take(32));
  const exitData = take(u32());
  const n = u32();
  const ciphertexts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) ciphertexts.push(take(u32()));
  const outCiphertext = take(u32());
  return { recipient, relayer, relayerFee, exitTarget, exitData, ciphertexts, outCiphertext };
}
