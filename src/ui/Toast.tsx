"use client";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cx } from "./cx";

type Tone = "info" | "ok" | "error";
interface ToastItem {
  readonly id: number;
  readonly text: string;
  readonly tone: Tone;
}

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => undefined);

/** Brief notices above the bottom dock. Polite live region; never the only place an error is shown. */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const push = useCallback((text: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, text, tone }]);
    setTimeout(() => {
      setItems((xs) => xs.filter((x) => x.id !== id));
    }, 4_000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-44 z-[60] flex flex-col items-center gap-2 px-gutter lg:bottom-28"
      >
        {items.map((t) => {
          const Icon = t.tone === "ok" ? CircleCheck : t.tone === "error" ? CircleAlert : Info;
          return (
            <div
              key={t.id}
              role="status"
              className="pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-md border border-line-strong bg-overlay px-3.5 py-2.5 text-sm text-text shadow-[0_12px_32px_-12px_rgb(0_0_0_/_0.8)]"
            >
              <Icon
                aria-hidden
                className={cx(
                  "size-4 shrink-0",
                  t.tone === "ok" ? "text-up" : t.tone === "error" ? "text-down" : "text-accent",
                )}
              />
              {t.text}
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): (text: string, tone?: Tone) => void {
  return useContext(Ctx);
}
