import { describe, expect, it } from "vitest";

import { generateQrDataUrl } from "./zaileys-qr.js";

describe("generateQrDataUrl", () => {
  it("generates data URL from sample string", async () => {
    const dataUrl = await generateQrDataUrl("hello-qr-test");
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });

  it("respects custom width and margin options", async () => {
    const defaultUrl = await generateQrDataUrl("custom-options-test");
    const customUrl = await generateQrDataUrl("custom-options-test", {
      width: 400,
      margin: 4,
    });
    expect(customUrl.startsWith("data:image/png;base64,")).toBe(true);
    // Custom options should produce different output than defaults
    expect(customUrl).not.toBe(defaultUrl);

    const widthOnly = await generateQrDataUrl("custom-options-test", {
      width: 500,
    });
    expect(widthOnly.startsWith("data:image/png;base64,")).toBe(true);
    expect(widthOnly).not.toBe(defaultUrl);
  });
});
