"use client";
import { useEffect, useState } from "react";
import { INDEXER_URL, RELAYER_URL } from "@/lib/config";

const GH = "https://github.com/imadegoodstuff/scash";
const APP_SHA = process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown";

/**
 * The three deployed pieces report the commit they were built from: this page
 * at build time, the relayer in `/info`, the indexer in `/health`. Showing all
 * three side by side is the only way a visitor can tell whether the services
 * behind the site run the same source as the site itself.
 */
interface OnChain { id: string; deployed: boolean; deploySlot?: number; upgradeAuthority?: string | null; elfSha256?: string }

export function Builds() {
  const [relayer, setRelayer] = useState<string>();
  const [indexer, setIndexer] = useState<string>();
  const [onChain, setOnChain] = useState<OnChain | null>();
  useEffect(() => {
    fetch(`${RELAYER_URL}/info`).then((r) => r.json()).then((j: { commit?: string }) => setRelayer(j.commit ?? "unknown")).catch(() => setRelayer("offline"));
    fetch(`${INDEXER_URL}/health`)
      .then((r) => r.json())
      .then((j: { commit?: string; onChain?: OnChain }) => { setIndexer(j.commit ?? "unknown"); setOnChain(j.onChain ?? null); })
      .catch(() => { setIndexer("offline"); setOnChain(null); });
  }, []);
  const same = relayer && indexer && relayer.startsWith(APP_SHA.slice(0, 12)) && indexer.startsWith(APP_SHA.slice(0, 12));
  const programId = process.env.NEXT_PUBLIC_PROGRAM_ID ?? onChain?.id ?? "";
  return (
    <div className="mt-3 space-y-1 font-mono text-[11px] text-dim">
      <Row name="app" sha={APP_SHA} />
      <Row name="relayer" sha={relayer} />
      <Row name="indexer" sha={indexer} />
      <p>
        <span className="inline-block w-14">program</span>
        <span>{programId.slice(0, 8)}…</span>
        {onChain === undefined ? null : onChain === null ? (
          <span> · unknown (indexer offline)</span>
        ) : onChain.deployed ? (
          <span>
            {" · "}deployed slot {onChain.deploySlot?.toLocaleString()} · elf sha256 <span title={onChain.elfSha256}>{onChain.elfSha256?.slice(0, 12)}</span>
            {onChain.upgradeAuthority === null ? " · no upgrade authority" : " · upgradeable"}
          </span>
        ) : (
          <span className="text-bad"> · not deployed on this cluster</span>
        )}
      </p>
      <p className="pt-1 text-[10px] leading-relaxed">
        {relayer && indexer && (same ? "Services and site are on one commit. " : "Services differ from this build. ")}
        Same commit is not the same binary: compare the elf hash with SHA256SUMS from the sbf CI job, or run scripts/verify-program.mjs. Fly images are not reproducibly attested.
      </p>
    </div>
  );
}

function Row({ name, sha }: { name: string; sha?: string }) {
  const short = sha ? sha.slice(0, 12) : "…";
  const link = sha && sha !== "unknown" && sha !== "offline";
  return (
    <p>
      <span className="inline-block w-14">{name}</span>
      {link ? <a className="underline-offset-2 hover:underline" href={`${GH}/commit/${sha}`}>{short}</a> : <span>{short}</span>}
    </p>
  );
}
