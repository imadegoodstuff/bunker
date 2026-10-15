// What is actually deployed at the addresses this indexer serves. Exposed in
// /health so the site can show it and anyone can compare `codeHash` against
// the keccak256 of the Hardhat artifact's `deployedBytecode` for the same
// commit (BscScan source verification is the user-facing form of the same check).
import { keccak256, type PublicClient } from "viem";

export interface ContractInfo {
  address: string;
  deployed: boolean;
  codeBytes?: number;
  codeHash?: string;
  checkedAt: number;
  error?: string;
}

export async function inspectContract(client: PublicClient, address: `0x${string}`): Promise<ContractInfo> {
  const checkedAt = Date.now();
  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return { address, deployed: false, checkedAt };
    return { address, deployed: true, codeBytes: (code.length - 2) / 2, codeHash: keccak256(code), checkedAt };
  } catch (e) {
    return { address, deployed: false, checkedAt, error: (e as Error).message };
  }
}
