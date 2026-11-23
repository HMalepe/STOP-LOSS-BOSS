/** Haptic tick where supported. iOS Safari has no Vibration API: the DOM types say otherwise, so check at runtime. */
export function buzz(pattern: number | number[]): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator && typeof navigator.vibrate === "function") {
    navigator.vibrate(pattern);
  }
}
