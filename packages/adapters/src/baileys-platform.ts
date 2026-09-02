import type { MessagingPlatform } from "./chat-sdk-surface.js";
import type { BaileysEmulator } from "./baileys-emulator.js";
import { createBaileysFakeAdapter } from "./baileys-emulator.js";

/**
 * Build the "baileys" MessagingPlatform from the emulator's fake socket.
 * Mirrors `createEmulatedSendbluePlatform` but exposes `provider: "baileys"`
 * with `groups: true` (WhatsApp groups) and `typing: false` (typings are
 * per-chat presence, not needed for this step's offline contract).
 */
export function createEmulatedBaileysPlatform(emulator: BaileysEmulator): MessagingPlatform {
  const adapter = createBaileysFakeAdapter(emulator);
  return {
    provider: "baileys",
    capabilities: { direct: true, groups: true, typing: false },
    adapter,
    directThreadId: (address) => adapter.encodeThreadId({ jid: normalizeForDirect(address) }),
    participants: (raw) => baileysParticipants(raw, emulator.selfJid),
    channelName: (raw) => baileysGroupName(raw),
  };
}

/**
 * Totally invented baileys platform builder for a real socket: would inject
 * the persisted Baileys auth state that step 1 (Postgres auth-state store)
 * will provide. Left as a reference for step 3 — this step uses only
 * the emulated path above.
 */
export function createBaileysPlatformFromRealAdapter(_auth: unknown): never {
  throw new Error("Real Baileys socket wiring is step 3 — use createEmulatedBaileysPlatform for tests");
}

function normalizeForDirect(address: string): string {
  if (address.includes("@")) return address;
  return `${address}@s.whatsapp.net`;
}

function baileysParticipants(raw: unknown, selfJid: string): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const maybe = raw as Record<string, unknown>;
  // Our fake raw stores emulator meta under _emulatorMeta; real Baileys would
  // need groupMetadata lookup — not needed for emulator.
  if ("_emulatorMeta" in maybe) {
    const meta = (maybe._emulatorMeta as Record<string, unknown> | null) ?? null;
    const list = meta?.participants;
    if (Array.isArray(list)) {
      return list.filter((entry): entry is string => typeof entry === "string" && entry !== selfJid);
    }
  }
  const participants = (maybe as { participants?: unknown }).participants;
  if (Array.isArray(participants)) {
    return participants.filter((entry): entry is string => typeof entry === "string" && entry !== selfJid);
  }
  return [];
}

function baileysGroupName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const maybe = raw as Record<string, unknown>;
  if ("_emulatorMeta" in maybe) {
    const meta = (maybe._emulatorMeta as Record<string, unknown> | null) ?? null;
    const name = meta?.groupSubject;
    return typeof name === "string" && name ? name : null;
  }
  const candidate = (maybe as { groupSubject?: unknown; subject?: unknown; group_display_name?: unknown }).groupSubject;
  if (typeof candidate === "string" && candidate) return candidate;
  return null;
}
