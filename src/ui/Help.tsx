"use client";
import { CircleHelp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Explains a metric in context (ORBIT 06: tooltips must work on keyboard focus too). A real button, so touch, mouse and
 * keyboard all reach it; Escape or tapping elsewhere closes it.
 */
export function Help({ label, children }: { readonly label: string; readonly children: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="-m-2 grid size-7 place-items-center rounded-full text-faint transition-colors hover:text-subtle"
      >
        <CircleHelp aria-hidden className="size-3.5" strokeWidth={1.75} />
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="absolute top-full left-1/2 z-40 mt-1 w-56 -translate-x-1/2 rounded-md border border-line-strong bg-overlay px-3 py-2 text-xs leading-relaxed font-normal tracking-normal text-subtle normal-case shadow-[0_12px_32px_-12px_rgb(0_0_0_/_0.8)]"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
