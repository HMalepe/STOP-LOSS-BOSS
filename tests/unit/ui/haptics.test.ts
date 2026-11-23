import { afterEach, describe, expect, it, vi } from "vitest";
import { buzz } from "@/ui/haptics";

describe("buzz", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("vibrates where supported", () => {
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    buzz([30, 40]);
    expect(vibrate).toHaveBeenCalledWith([30, 40]);
  });
  it("is a silent no-op on iOS Safari (no Vibration API) and on the server", () => {
    vi.stubGlobal("navigator", {});
    expect(() => {
      buzz(10);
    }).not.toThrow();
    vi.stubGlobal("navigator", undefined);
    expect(() => {
      buzz(10);
    }).not.toThrow();
  });
});

describe("cx", () => {
  it("joins truthy class names only", async () => {
    const { cx } = await import("@/ui/cx");
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });
});
