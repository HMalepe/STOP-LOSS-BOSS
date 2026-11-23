"use client";
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { cx } from "./cx";

/**
 * Six code boxes (07-UI-SPEC #1): numeric keypad, auto-advance, backspace goes back, paste fills all, and the first box
 * takes the OS one-time-code autofill. Calls onComplete once six digits are in.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly onComplete: (code: string) => void;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  // The code screen opens ready to type: no extra tap before the keypad comes up.
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");

  const set = (next: string) => {
    const clean = next.replace(/\D/g, "").slice(0, 6);
    onChange(clean);
    if (clean.length === 6) onComplete(clean);
    refs.current[Math.min(clean.length, 5)]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === "Backspace" && digits[i] === "" && i > 0) {
      e.preventDefault();
      onChange(value.slice(0, i - 1));
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    set(e.clipboardData.getData("text"));
  };
  return (
    <div role="group" aria-label="6-digit code" className="grid grid-cols-6 gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${String(i + 1)}`}
          aria-invalid={invalid || undefined}
          maxLength={i === 0 ? 6 : 1}
          onPaste={onPaste}
          onKeyDown={(e) => {
            onKey(e, i);
          }}
          onFocus={(e) => {
            e.target.select();
          }}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, "");
            if (typed.length > 1) {
              set(typed); // autofill drops the whole code into one box
              return;
            }
            set(value.slice(0, i) + typed + value.slice(i + 1));
          }}
          className={cx(
            "num h-14 w-full min-w-0 rounded-md border bg-surface text-center text-2xl text-text caret-accent",
            "transition-colors focus:border-accent focus:outline-none disabled:opacity-50",
            invalid ? "border-down/70" : d === "" ? "border-line-strong" : "border-faint",
          )}
        />
      ))}
    </div>
  );
}
