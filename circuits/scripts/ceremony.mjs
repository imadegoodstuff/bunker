// Phase-2 ceremony helper: contribute / beacon / verify / export.
//   node ceremony.mjs contribute --in a.zkey --out b.zkey --name "handle"
//   node ceremony.mjs beacon     --in a.zkey --out final.zkey --hash <hex> --iters 10
//   node ceremony.mjs verify     --circuit transact2x2 --zkey final.zkey
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PTAU = join(root, "ptau", "ppot_0080_16.ptau");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    in: { type: "string" }, out: { type: "string" }, name: { type: "string" },
    hash: { type: "string" }, iters: { type: "string", default: "10" },
    circuit: { type: "string" }, zkey: { type: "string" },
  },
});
const cmd = positionals[0];

if (cmd === "contribute") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question("Type some random text (mixed with OS entropy): ");
  rl.close();
  const entropy = randomBytes(64).toString("hex") + typed;
  const hash = await snarkjs.zKey.contribute(values.in, values.out, values.name ?? "anonymous", entropy, console);
  console.log("\ncontribution hash:\n" + formatHash(hash));
} else if (cmd === "beacon") {
  const hash = await snarkjs.zKey.beacon(values.in, values.out, "beacon", values.hash, Number(values.iters), console);
  console.log("\nfinal hash:\n" + formatHash(hash));
} else if (cmd === "verify") {
  const r1cs = join(root, "build", values.circuit, `${values.circuit}.r1cs`);
  const ok = await snarkjs.zKey.verifyFromR1cs(r1cs, PTAU, values.zkey, console);
  console.log(ok ? "ZKEY OK" : "ZKEY INVALID");
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: ceremony.mjs contribute|beacon|verify ...");
  process.exit(2);
}
process.exit(0);

function formatHash(h) {
  return Buffer.from(h).toString("hex").match(/.{1,64}/g).join("\n");
}
