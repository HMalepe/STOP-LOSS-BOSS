/**
 * The mark: many orders converging on one level, a dot on the line: "many orders, one decision". A ring, not a stack of
 * lines, so it can never be mistaken for a menu button. Hairlines keep it crisp at 16 px and in the PWA icon.
 */
export function Logo({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.5" />
      <path d="M4 12h16" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M8 8.25 12 12 8 15.75"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16.5" cy="12" r="2.25" fill="var(--color-accent)" />
    </svg>
  );
}

export function Wordmark({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span className="flex items-center gap-2 text-text" aria-label="Order Desk">
      <Logo className="size-6 shrink-0" />
      <span className={compact ? "sr-only" : "text-[0.9375rem] font-semibold tracking-tight"}>
        Order<span className="text-muted">Desk</span>
      </span>
    </span>
  );
}
