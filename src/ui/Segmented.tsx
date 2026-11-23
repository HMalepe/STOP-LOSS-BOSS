"use client";
import { useId, useRef, type KeyboardEvent } from "react";
import { cx } from "./cx";

/** A segmented control (ARIA tablist): arrow keys move, Home/End jump. 44 px tall, full width on phones. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (v: T) => void;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const last = options.length - 1;
    const to =
      e.key === "ArrowRight"
        ? i === last
          ? 0
          : i + 1
        : e.key === "ArrowLeft"
          ? i === 0
            ? last
            : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    const next = options[to];
    if (next === undefined) return;
    onChange(next.value);
    refs.current[to]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-md border border-line bg-surface p-1"
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${id}-${o.value}`}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => {
              move(e, i);
            }}
            onClick={() => {
              onChange(o.value);
            }}
            className={cx(
              "h-10 rounded-sm text-sm font-medium transition-colors duration-150",
              selected
                ? "bg-raised text-text shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
                : "text-muted hover:text-subtle",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
