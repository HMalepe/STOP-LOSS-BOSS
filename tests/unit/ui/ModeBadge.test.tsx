import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HaltedBanner } from "@/ui/HaltedBanner";
import { ModeBadge, type Mode } from "@/ui/ModeBadge";

describe("ModeBadge", () => {
  it.each<[Mode, string, string]>([
    ["mock", "MOCK", "simulated broker"],
    ["demo", "DEMO", "demo account money"],
    ["live", "LIVE", "real money"],
  ])("%s shows %s and explains itself to screen readers", (mode, label, description) => {
    const html = renderToStaticMarkup(<ModeBadge mode={mode} />);
    expect(html).toContain(label);
    expect(html).toContain('role="status"');
    expect(html).toContain(description);
  });

  it("only LIVE gets the pulsing dot", () => {
    expect(renderToStaticMarkup(<ModeBadge mode="live" />)).toContain("animate-live-pulse");
    expect(renderToStaticMarkup(<ModeBadge mode="demo" />)).not.toContain("animate-live-pulse");
    expect(renderToStaticMarkup(<ModeBadge mode="mock" />)).not.toContain("animate-live-pulse");
  });
});

describe("HaltedBanner", () => {
  it("is an alert that says close-all-now still works", () => {
    const html = renderToStaticMarkup(<HaltedBanner />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Close All Now");
  });
});
