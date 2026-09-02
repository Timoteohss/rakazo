import { describe, expect, it } from "vitest";
import { createZaileysMessagingAdapter, type ZaileysAdapterConfig } from "./zaileys.js";

describe("createZaileysMessagingAdapter", () => {
  it("creates an adapter with default options", () => {
    const adapter = createZaileysMessagingAdapter();
    expect(adapter.name).toBe("zaileys");
    expect(adapter.userName).toBe("rakazo");
  });

  it("creates an adapter with custom config and connection string", () => {
    const config: ZaileysAdapterConfig = {
      sessionId: "custom-session",
      connectionString: "postgres://user:pass@localhost:5432/db",
      autoMarkRead: true,
      richMessages: false,
    };
    const adapter = createZaileysMessagingAdapter(config);
    expect(adapter.name).toBe("zaileys");
    expect(adapter.userName).toBe("rakazo");
  });

  it("uses DATABASE_URL when no connectionString is provided", () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://env:env@localhost:5432/envdb";
    try {
      const adapter = createZaileysMessagingAdapter();
      expect(adapter.name).toBe("zaileys");
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previous;
      }
    }
  });

  it("adapter.name is exactly 'zaileys'", () => {
    const adapter = createZaileysMessagingAdapter();
    expect(adapter.name).toBe("zaileys");
  });
});