/** The BUNKER wordmark: a blast-door glyph followed by the name in the display face. */
export function Wordmark({ className = "h-5", withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg viewBox="0 0 32 32" className="h-full w-auto" aria-hidden>
        <rect x="1" y="1" width="30" height="30" fill="none" stroke="#b6ff2e" strokeWidth="2" />
        <rect x="7" y="7" width="18" height="18" fill="#b6ff2e" />
        <rect x="13" y="13" width="6" height="6" fill="#0e0f0e" />
      </svg>
      {withText ? <span className="display text-[17px] tracking-[0.08em] leading-none font-bold">BUNKER</span> : null}
    </span>
  );
}
