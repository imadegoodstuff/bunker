export function fmtAmount(base: bigint, decimals: number, max = 6): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  let frac = (v % d).toString().padStart(decimals, "0").slice(0, max).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString()}${frac ? "." + frac : ""}`;
}

export function parseAmount(s: string, decimals: number): bigint {
  const t = s.trim();
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") throw new Error("invalid amount");
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error(`max ${decimals} decimals`);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";
/**
 * A price that may be tiny, without scientific notation: 6.58e-9 becomes
 * "0.0₈658" (eight zeros, then the significant digits), 0.0123 stays "0.0123".
 */
export function fmtPrice(x: number, sig = 3): string {
  if (!isFinite(x) || x <= 0) return "0";
  if (x >= 1) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (x >= 0.001) return x.toPrecision(sig).replace(/\.?0+$/, "");
  const zeros = -Math.floor(Math.log10(x)) - 1; // leading zeros after "0."
  const digits = Math.round(x * 10 ** (zeros + sig)).toString().slice(0, sig).replace(/0+$/, "");
  const sub = String(zeros).split("").map((c) => SUB[Number(c)]).join("");
  return zeros > 2 ? `0.0${sub}${digits}` : `0.${"0".repeat(zeros)}${digits}`;
}

/**
 * Width for a graduation bar: anything raised at all shows at least a sliver
 * (0.003 of 20 SOL is 0.015 %, invisible otherwise), the rest is linear.
 */
export function barWidth(progress: number, floor = 0.02): string {
  if (!(progress > 0)) return "0%";
  return `${(Math.max(floor, Math.min(1, progress)) * 100).toFixed(2)}%`;
}

/** A percentage of the way to graduation with enough digits to be non-zero: 0.015 % rather than 0.0 %. */
export function fmtProgress(progress: number): string {
  if (!(progress > 0)) return "0%";
  const p = Math.min(1, progress) * 100;
  const digits = p >= 10 ? 0 : p >= 1 ? 1 : p >= 0.1 ? 2 : 3;
  return `${p.toFixed(digits)}%`;
}

export function short(s: string, n = 6) {
  return s.length <= 2 * n + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
}

export function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
