"use client";
import { Minus, Plus } from "lucide-react";
import { useId } from "react";
import { cx } from "./cx";
import { nudge, parsePrice } from "./logic";

/**
 * A price field built for a thumb (07-UI-SPEC #3): big mono digits, −/+ nudges of 1 and 10 points, and "use bid" /
 * "use ask" chips so the owner starts from the live market instead of typing it.
 */
export function PriceInput({
  label,
  value,
  onChange,
  digits,
  bid,
  ask,
  hint,
  error,
  optional = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly digits: number;
  readonly bid?: number;
  readonly ask?: number;
  readonly hint?: string;
  readonly error?: string;
  readonly optional?: boolean;
}) {
  const id = useId();
  const invalid = error !== undefined || (value !== "" && parsePrice(value) === null);
  const step = (points: number) => {
    // Nudging an empty field starts from the market, which is what the owner almost always wants.
    const base = value === "" ? ((bid ?? ask)?.toFixed(digits) ?? "") : value;
    onChange(nudge(base, points, digits));
  };
  const nudgeBtn = (points: number) => (
    <button
      type="button"
      onClick={() => {
        step(points);
      }}
      aria-label={`${points > 0 ? "Up" : "Down"} ${String(Math.abs(points))} point${Math.abs(points) === 1 ? "" : "s"}`}
      className="num flex min-h-tap min-w-11 items-center justify-center gap-0.5 rounded-md border border-line bg-raised text-xs text-subtle transition-colors hover:border-line-strong hover:text-text active:bg-overlay"
    >
      {points > 0 ? <Plus aria-hidden className="size-3" /> : <Minus aria-hidden className="size-3" />}
      {Math.abs(points)}
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="eyebrow">
          {label}
          {optional ? <span className="ml-1 normal-case tracking-normal text-faint">optional</span> : null}
        </label>
        {hint === undefined ? null : <span className="text-xs text-muted">{hint}</span>}
      </div>
      <div className="flex items-stretch gap-1.5">
        {nudgeBtn(-10)}
        {nudgeBtn(-1)}
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={(bid ?? 0).toFixed(digits)}
          aria-invalid={invalid || undefined}
          aria-describedby={error === undefined ? undefined : `${id}-err`}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={cx(
            "num min-h-tap min-w-0 flex-1 rounded-md border bg-surface px-3 text-center text-lg text-text placeholder:text-faint",
            "transition-colors focus:border-accent focus:outline-none",
            invalid ? "border-down/70" : "border-line-strong",
          )}
        />
        {nudgeBtn(1)}
        {nudgeBtn(10)}
      </div>
      {bid === undefined || ask === undefined ? null : (
        <div className="flex gap-2">
          {(
            [
              ["Use bid", bid],
              ["Use ask", ask],
            ] as const
          ).map(([name, p]) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                onChange(p.toFixed(digits));
              }}
              className="num inline-flex h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-text"
            >
              {name} <span className="text-subtle">{p.toFixed(digits)}</span>
            </button>
          ))}
        </div>
      )}
      {error === undefined ? null : (
        <p id={`${id}-err`} role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
    </div>
  );
}
