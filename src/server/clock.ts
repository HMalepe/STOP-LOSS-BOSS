import type { Clock } from "@/domain/clock";

/** The real clock. Lives outside the domain on purpose. */
export const systemClock: Clock = { now: () => Date.now() };
