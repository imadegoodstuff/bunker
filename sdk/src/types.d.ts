declare module "circomlibjs" {
  export function buildPoseidon(): Promise<any>;
  export function buildBabyjub(): Promise<any>;
}
declare module "snarkjs" {
  export const groth16: {
    fullProve(input: any, wasm: string | Uint8Array, zkey: string | Uint8Array): Promise<{ proof: any; publicSignals: string[] }>;
    verify(vk: any, publicSignals: string[], proof: any): Promise<boolean>;
    exportSolidityCallData(proof: any, publicSignals: string[]): Promise<string>;
  };
  export const zKey: {
    exportVerificationKey(zkey: string | Uint8Array): Promise<any>;
  };
}
declare module "ffjavascript" {
  export const utils: {
    unstringifyBigInts(o: any): any;
    stringifyBigInts(o: any): any;
    leBuff2int(b: Uint8Array): bigint;
    leInt2Buff(n: bigint, len: number): Uint8Array;
  };
  export function getCurveFromName(name: string): Promise<any>;
}
