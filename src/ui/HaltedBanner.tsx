import { OctagonPause } from "lucide-react";

/** Kill switch on: say so loudly, and say what still works. */
export function HaltedBanner() {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-card border border-danger/50 bg-danger/10 px-4 py-3"
    >
      <OctagonPause aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" strokeWidth={1.75} />
      <p className="text-sm text-text">
        <strong className="font-semibold text-danger">Trading halted.</strong> Everything is blocked except
        Close All Now.
      </p>
    </div>
  );
}
