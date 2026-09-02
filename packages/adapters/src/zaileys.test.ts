import { describe, expect, it } from "vitest";
import { jidToPhoneE164, phoneE164ToJid } from "./zaileys.js";

describe("jidToPhoneE164", () => {
  it("converts a standard user JID to E.164", () => {
    expect(jidToPhoneE164("5511999998888@s.whatsapp.net")).toBe("+5511999998888");
  });

  it("strips a device suffix before converting", () => {
    expect(jidToPhoneE164("5511999998888:0@s.whatsapp.net")).toBe("+5511999998888");
    expect(jidToPhoneE164("5511999998888:42@s.whatsapp.net")).toBe("+5511999998888");
  });

  it("returns null for group, broadcast, and newsletter JIDs", () => {
    expect(jidToPhoneE164("12345@g.us")).toBeNull();
    expect(jidToPhoneE164("status@broadcast")).toBeNull();
    expect(jidToPhoneE164("123456@newsletter")).toBeNull();
  });

  it("returns null for malformed JIDs", () => {
    expect(jidToPhoneE164("")).toBeNull();
    expect(jidToPhoneE164("@s.whatsapp.net")).toBeNull();
    expect(jidToPhoneE164("5511999@s.whatsapp.net.extra")).toBeNull();
    expect(jidToPhoneE164("not-a-number@s.whatsapp.net")).toBeNull();
    expect(jidToPhoneE164("5511999@lid")).toBeNull();
  });
});

describe("phoneE164ToJid", () => {
  it("strips formatting and produces a user JID", () => {
    expect(phoneE164ToJid("+1 (555) 019-2834")).toBe("15550192834@s.whatsapp.net");
  });

  it("passes through already-clean digits", () => {
    expect(phoneE164ToJid("15550192834")).toBe("15550192834@s.whatsapp.net");
  });

  it("preserves leading zeros when present in the input", () => {
    expect(phoneE164ToJid("+0 (11) 99999-8888")).toBe("011999998888@s.whatsapp.net");
  });

  it("returns the suffix alone when the input has no digits", () => {
    expect(phoneE164ToJid("")).toBe("@s.whatsapp.net");
  });
});