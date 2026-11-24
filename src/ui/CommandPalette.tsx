"use client";
import { CornerDownLeft, Search } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "./cx";
import { NAV } from "./NavLinks";

const ITEMS: readonly { readonly href: Route; readonly label: string; readonly hint: string }[] = [
  ...NAV.map((n) => ({
    href: n.href,
    label: n.label,
    hint:
      n.href === "/"
        ? "positions and actions"
        : n.href === "/history"
          ? "past batches"
          : "kill switch, limits, sign-in",
  })),
  { href: "/system", label: "Design system", hint: "components and states" },
];

/** Ctrl/Cmd+K anywhere (ORBIT 06): type to filter, arrows to move, Enter to go, Escape to close. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => {
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("od:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("od:palette", onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t === "" ? ITEMS : ITEMS.filter((x) => `${x.label} ${x.hint}`.toLowerCase().includes(t));
  }, [q]);
  const active = Math.min(i, Math.max(0, hits.length - 1));

  if (!open) return null;
  const close = () => {
    setOpen(false);
    setQ("");
    setI(0);
  };
  const go = (href: Route) => {
    close();
    router.push(href);
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-gutter pt-[12vh]">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 bg-ink/70 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        className="relative w-full max-w-md overflow-hidden rounded-card border border-line-strong bg-surface shadow-[0_24px_60px_-20px_rgb(0_0_0_/_0.8)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search aria-hidden className="size-4 text-muted" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={hits[active] === undefined ? undefined : `${listId}-${String(active)}`}
            placeholder="Jump to…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setI((x) => Math.min(x + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setI((x) => Math.max(x - 1, 0));
              } else if (e.key === "Enter") {
                const h = hits[active];
                if (h !== undefined) go(h.href);
              }
            }}
            className="h-12 flex-1 bg-transparent text-[0.9375rem] text-text placeholder:text-faint focus:outline-none"
          />
          <kbd className="num rounded-sm border border-line px-1.5 text-2xs text-muted">esc</kbd>
        </div>
        <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1.5">
          {hits.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches.</li>
          ) : null}
          {hits.map((h, n) => (
            <li
              key={h.href}
              id={`${listId}-${String(n)}`}
              role="option"
              aria-selected={n === active}
              onPointerEnter={() => {
                setI(n);
              }}
              onClick={() => {
                go(h.href);
              }}
              className={cx(
                "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5",
                n === active ? "bg-raised" : "",
              )}
            >
              <span className="flex-1">
                <span className="block text-sm text-text">{h.label}</span>
                <span className="block text-xs text-muted">{h.hint}</span>
              </span>
              {n === active ? <CornerDownLeft aria-hidden className="size-3.5 text-muted" /> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The visible way in (desktop rail): keyboard shortcuts must never be the only route. */
export function PaletteButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new Event("od:palette"));
      }}
      className="flex h-9 items-center gap-2 rounded-md border border-line px-2.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-subtle"
    >
      <Search aria-hidden className="size-4" />
      <span className="flex-1 text-left">Jump to…</span>
      <kbd className="num text-2xs text-faint">⌘K</kbd>
    </button>
  );
}
