"use client";
import { useEffect } from "react";

/** Registers the shell-only service worker in production builds (never in dev: it would cache HMR chunks). */
export function ServiceWorker({ enabled }: { readonly enabled: boolean }) {
  useEffect(() => {
    if (!enabled || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, [enabled]);
  return null;
}
