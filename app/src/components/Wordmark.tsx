/** The BUNKER wordmark: the vault-door mark followed by the name in the display face. */
export function Wordmark({ className = "h-6", withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/mark-128.png" alt="" aria-hidden className="h-full w-auto" draggable={false} />
      {withText ? <span className="display text-[17px] tracking-[0.08em] leading-none font-bold">BUNKER</span> : null}
    </span>
  );
}
