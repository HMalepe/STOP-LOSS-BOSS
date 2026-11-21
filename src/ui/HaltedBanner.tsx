/** Kill switch on: say so loudly, and say what still works. */
export function HaltedBanner() {
  return (
    <div role="alert" className="rounded-card border border-loss/60 bg-loss/10 px-4 py-3 text-sm text-loss">
      <strong className="font-bold">Trading halted.</strong> Everything is blocked except Close All Now.
    </div>
  );
}
