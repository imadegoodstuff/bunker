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
