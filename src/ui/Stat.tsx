export function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-h-tap flex-col justify-center rounded-card border border-line bg-card px-3 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd className="num text-base text-text">{value}</dd>
    </div>
  );
}
