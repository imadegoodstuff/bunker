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
export function Builds() {
  const [relayer, setRelayer] = useState<string>();
  const [indexer, setIndexer] = useState<string>();
  useEffect(() => {
    const get = (url: string, set: (s: string) => void) =>
      fetch(url).then((r) => r.json()).then((j: { commit?: string }) => set(j.commit ?? "unknown")).catch(() => set("offline"));
    get(`${RELAYER_URL}/info`, setRelayer);
    get(`${INDEXER_URL}/health`, setIndexer);
  }, []);
  const same = relayer && indexer && relayer.startsWith(APP_SHA.slice(0, 12)) && indexer.startsWith(APP_SHA.slice(0, 12));
  return (
    <div className="mt-3 space-y-1 font-mono text-[11px] text-dim">
      <Row name="app" sha={APP_SHA} />
      <Row name="relayer" sha={relayer} />
      <Row name="indexer" sha={indexer} />
      <p className="pt-1">
        program {process.env.NEXT_PUBLIC_PROGRAM_ID?.slice(0, 8) ?? "default"}…
        {relayer && indexer && (same ? " · all three on one commit" : " · services differ from this build")}
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
