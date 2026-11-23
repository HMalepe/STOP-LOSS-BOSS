"use client";
import { useEffect, useState } from "react";

/** The current time, re-rendering every `everyMs`. Used by countdowns. */
export function useNow(everyMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, everyMs);
    return () => {
      clearInterval(t);
    };
  }, [everyMs]);
  return now;
}
