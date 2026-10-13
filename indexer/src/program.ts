// What is actually deployed under the program id this indexer serves. Exposed
// in /health so the site can show it and anyone can match `elfSha256` against
// the `SHA256SUMS` the `sbf` CI job prints for the same commit
// (scripts/verify-program.mjs does the same comparison from the command line).
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const PROGRAMDATA_HEADER = 45;

export interface ProgramInfo {
  id: string;
  deployed: boolean;
  owner?: string;
  deploySlot?: number;
  upgradeAuthority?: string | null;
  elfBytes?: number;
  elfSha256?: string;
  checkedAt: number;
  error?: string;
}

export async function inspectProgram(conn: Connection, id: PublicKey): Promise<ProgramInfo> {
  const checkedAt = Date.now();
  try {
    const program = await conn.getAccountInfo(id);
    if (!program) return { id: id.toBase58(), deployed: false, checkedAt };
    let elf: Buffer = program.data;
    let deploySlot: number | undefined;
    let upgradeAuthority: string | null | undefined;
    if (program.owner.toBase58() === UPGRADEABLE_LOADER) {
      const pd = await conn.getAccountInfo(new PublicKey(program.data.subarray(4, 36)));
      if (!pd) return { id: id.toBase58(), deployed: false, checkedAt, error: "programdata account missing" };
      deploySlot = Number(pd.data.readBigUInt64LE(4));
      upgradeAuthority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
      elf = pd.data.subarray(PROGRAMDATA_HEADER);
    }
    let end = elf.length;
    while (end > 0 && elf[end - 1] === 0) end--;
    return {
      id: id.toBase58(),
      deployed: true,
      owner: program.owner.toBase58(),
      deploySlot,
      upgradeAuthority,
      elfBytes: end,
      elfSha256: createHash("sha256").update(elf.subarray(0, end)).digest("hex"),
      checkedAt,
    };
  } catch (e) {
    return { id: id.toBase58(), deployed: false, checkedAt, error: (e as Error).message };
  }
}
