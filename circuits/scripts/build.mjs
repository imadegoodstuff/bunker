// Compiles every main circuit in src/ to build/<name>/ using the wasm build of
// the circom compiler (no native toolchain needed). Emits r1cs, wasm witness
// generator and symbol file, then prints the constraint count.
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = join(root, "src");
const build = join(root, "build");
const require = createRequire(import.meta.url);

const circomBin = resolve(dirname(require.resolve("circom2/package.json")), "cli.js");
const circomlibDir = resolve(dirname(require.resolve("circomlib/package.json")), "..");

const mains = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(src).filter((f) => /^transact\d+x\d+\.circom$/.test(f)).map((f) => f.replace(/\.circom$/, "")));

mkdirSync(build, { recursive: true });

for (const name of mains) {
  const out = join(build, name);
  mkdirSync(out, { recursive: true });
  const input = join(src, `${name}.circom`);
  if (!existsSync(input)) throw new Error(`missing ${input}`);
  console.log(`[circuits] compiling ${name}`);
  // The wasm compiler hangs if the witness-generator directory already exists.
  rmSync(join(out, `${name}_js`), { recursive: true, force: true });
  // The wasm compiler resolves paths relative to cwd and needs the output dir to exist.
  // The wasm compiler derives output names from the input path verbatim, so run
  // it from src/ with a bare file name and forward-slash relative paths.
  // (Windows only; on POSIX the compiler handles absolute paths fine.)
  const rel = (p) => (process.platform === "win32" ? relative(src, p).split("\\").join("/") : p);
  execFileSync(
    process.execPath,
    [circomBin, `${name}.circom`, "--r1cs", "--wasm", "--sym", "--O2", "-o", rel(out), "-l", rel(circomlibDir), "-l", "."],
    { stdio: "inherit", cwd: src }
  );
}

const snarkjs = await import("snarkjs");
for (const name of mains) {
  const info = await snarkjs.r1cs.info(join(build, name, `${name}.r1cs`));
  console.log(`[circuits] ${name}: ${info.nConstraints} constraints, ${info.nPubInputs} public inputs, ${info.nPrvInputs} private inputs`);
}
process.exit(0);
