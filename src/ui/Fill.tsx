"use client";
import { useLayoutEffect, useRef } from "react";

/**
 * A bar segment whose width is a fraction. Set through the DOM (CSSOM), never a `style` attribute: the strict CSP
 * (no 'unsafe-inline' styles) blocks server-rendered style attributes, which would leave every bar empty.
 */
export function Fill({ fraction, className }: { readonly fraction: number; readonly className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current !== null) {
      ref.current.style.width = `${String(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    }
  }, [fraction]);
  return <span ref={ref} aria-hidden className={className} />;
}
