import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { BaileysEmulator } from "./baileys-emulator.js";
import { createEmulatedBaileysPlatform } from "./baileys-platform.js";
import { ChatSdkMessagingSurface, providerOfThreadId } from "./chat-sdk-surface.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

async function ensureChatReady(surface: ChatSdkMessagingSurface): Promise<void> {
  // openDirectThread on baileys bypasses ensureInitialized via directThreadId,
  // so force Chat initialization explicitly for socket-path inbound tests.
  await (surface as unknown as { chat: { ensureInitialized: () => Promise<void> } }).chat.ensureInitialized();
}

function createHarness() {
  const emulator = new BaileysEmulator();
  const surface = new ChatSdkMessagingSurface([createEmulatedBaileysPlatform(emulator)]);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { emulator, surface, events };
}

describe("emulated baileys platform inbound", () => {
  it("normalizes a DM via socket messages.upsert into a direct inbound message", async () => {
    const { emulator, surface, events } = createHarness();
    await ensureChatReady(surface);

    await emulator.simulateInbound({
      from: "15551234567@s.whatsapp.net",
      content: "hi there",
      handle: "handle-dm-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "message",
      provider: "baileys",
      handle: "handle-dm-1",
      threadId: expect.stringMatching(/^baileys:/),
      isDirect: true,
      from: "15551234567@s.whatsapp.net",
      fromLabel: "15551234567",
      channelName: null,
      participants: [],
      content: "hi there",
      mediaUrl: null,
    });

    // DM thread id matches what outbound resolution would open.
    const dmThreadId = await surface.openDirectThread("baileys", "15551234567@s.whatsapp.net", context);
    expect((events[0] as { threadId: string }).threadId).toBe(dmThreadId);
  });

  it("normalizes a group messages.upsert with roster and display name", async () => {
    const { emulator, surface, events } = createHarness();
    await ensureChatReady(surface);

    await emulator.simulateInbound({
      from: "15551111111@s.whatsapp.net",
      content: "hello group",
      groupJid: "120363025@g.us",
      groupSubject: "Family",
      participants: ["15551111111@s.whatsapp.net", "15552222222@s.whatsapp.net", emulator.selfJid],
      handle: "handle-group-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "message",
        provider: "baileys",
        threadId: expect.stringMatching(/^baileys:/),
        isDirect: false,
        from: "15551111111@s.whatsapp.net",
        channelName: "Family",
        // The bot's own JID never appears in the roster.
        participants: ["15551111111@s.whatsapp.net", "15552222222@s.whatsapp.net"],
        content: "hello group",
      }),
    );
  });

  it("handles bare phone numbers as DM JIDs", async () => {
    const { emulator, surface, events } = createHarness();
    await ensureChatReady(surface);
    await emulator.simulateInbound({
      from: "15551234567",
      content: "from bare number",
      handle: "h-bare",
    });
    expect(events).toHaveLength(1);
    expect((events[0] as { from: string }).from).toBe("15551234567@s.whatsapp.net");
    expect((events[0] as { isDirect: boolean }).isDirect).toBe(true);
  });
});

describe("emulated baileys platform outbound", () => {
  it("sends a DM through openDirectThread + sendToThread", async () => {
    const { emulator, surface } = createHarness();
    const threadId = await surface.openDirectThread("baileys", "15557654321@s.whatsapp.net", context);
    const sent = await surface.sendToThread({ threadId, body: "hello you" }, context);

    expect(sent.handle).toMatch(/^baileys-handle-/);
    expect(emulator.sent).toEqual([{ kind: "dm", jid: "15557654321@s.whatsapp.net", body: "hello you", handle: sent.handle }]);
  });

  it("posts to a group via the thread id captured from an inbound group event", async () => {
    const { emulator, surface, events } = createHarness();
    await ensureChatReady(surface);
    await emulator.simulateInbound({
      from: "15551111111@s.whatsapp.net",
      content: "hello group",
      groupJid: "120363025@g.us",
      participants: ["15551111111@s.whatsapp.net", emulator.selfJid],
      handle: "h-g-1",
    });
    expect(events).toHaveLength(1);
    const threadId = (events[0] as { threadId: string }).threadId;

    const sent = await surface.sendToThread({ threadId, body: "hi all" }, context);

    expect(emulator.sent).toEqual([{ kind: "group", jid: "120363025@g.us", body: "hi all", handle: sent.handle }]);
  });

  it("rejects the send when the fake socket fails", async () => {
    const { emulator, surface } = createHarness();
    const threadId = await surface.openDirectThread("baileys", "15557654321@s.whatsapp.net", context);
    emulator.failNextSends(1);

    await expect(surface.sendToThread({ threadId, body: "will fail" }, context)).rejects.toThrow();
    expect(emulator.sent).toHaveLength(0);
  });

  it("encodes bare phone numbers for direct thread ids", async () => {
    const { emulator, surface } = createHarness();
    const viaJid = await surface.openDirectThread("baileys", "15557654321@s.whatsapp.net", context);
    const viaBare = await surface.openDirectThread("baileys", "15557654321", context);
    expect(viaJid).toBe(viaBare);
  });
});

describe("emulated baileys platform thread routing", () => {
  it("prefixes thread ids with provider via providerOfThreadId", async () => {
    const { emulator, surface, events } = createHarness();
    await ensureChatReady(surface);
    await emulator.simulateInbound({
      from: "15551234567@s.whatsapp.net",
      content: "routing check",
      handle: "h-route-1",
    });
    expect(events).toHaveLength(1);
    const threadId = (events[0] as { threadId: string }).threadId;
    expect(providerOfThreadId(threadId)).toBe("baileys");
    expect(threadId.startsWith("baileys:")).toBe(true);
  });
});

describe("emulated baileys platform connection", () => {
  it("emits QR and rotates deterministically", async () => {
    const { emulator } = createHarness();
    const seen: string[] = [];
    emulator.onQr((qr) => seen.push(qr));

    const first = emulator.simulateQr();
    const second = emulator.rotateQr();
    const third = emulator.rotateQr();

    expect(first).toBe("baileys-qr-1");
    expect(second).toBe("baileys-qr-2");
    expect(third).toBe("baileys-qr-3");
    expect(seen).toEqual(["baileys-qr-1", "baileys-qr-2", "baileys-qr-3"]);
    expect(emulator.currentQr).toBe("baileys-qr-3");
  });

  it("tracks connection.update open/close/qr", async () => {
    const { emulator } = createHarness();
    const updates: string[] = [];
    emulator.onConnectionUpdate((u) => updates.push(u.connection));

    emulator.simulateQr("qr-custom");
    expect(emulator.connectionState).toBe("connecting");
    emulator.simulateConnectionOpen();
    expect(emulator.connectionState).toBe("open");
    expect(emulator.currentQr).toBeNull();
    emulator.simulateConnectionClose();
    expect(emulator.connectionState).toBe("close");
    expect(emulator.currentQr).toBeNull();

    expect(updates).toEqual(["connecting", "open", "close"]);
  });

  it("clears currentQr on close even when a QR is active", async () => {
    const { emulator } = createHarness();
    const first = emulator.simulateQr("qr-active");
    expect(emulator.currentQr).toBe(first);
    expect(emulator.connectionState).toBe("connecting");
    emulator.simulateConnectionClose();
    expect(emulator.connectionState).toBe("close");
    expect(emulator.currentQr).toBeNull();

    // Also via generic connection update with close.
    const second = emulator.simulateQr("qr-second");
    expect(emulator.currentQr).toBe(second);
    emulator.simulateConnectionUpdate({ connection: "close" });
    expect(emulator.currentQr).toBeNull();
  });

  it("handleWebhook returns 501 (Baileys is socket-driven)", async () => {
    const { emulator, surface } = createHarness();
    const platform = createEmulatedBaileysPlatform(emulator);
    // Not routed via surface; call adapter directly.
    const res = await platform.adapter.handleWebhook(new Request("https://example.test/"), {});
    expect(res.status).toBe(501);
  });
});

describe("emulated baileys platform queued inbound", () => {
  it("queues simulateInbound before attach and resolves only after delivery", async () => {
    const emulator = new BaileysEmulator();
    const pending = emulator.simulateInbound({
      from: "15551234567@s.whatsapp.net",
      content: "queued hello",
      handle: "h-queued-1",
    });

    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    // Flush microtasks — pending must remain unresolved before attach.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    const surface = new ChatSdkMessagingSurface([createEmulatedBaileysPlatform(emulator)]);
    const events: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      events.push(event);
    });

    await (surface as unknown as { chat: { ensureInitialized: () => Promise<void> } }).chat.ensureInitialized();

    // _attach has been called; delivery is in flight but not yet settled before pending resolves.
    // Pending must still encapsulate the real delivery completion.
    await pending;
    expect(resolved).toBe(true);
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { threadId: string }).threadId.startsWith("baileys:")).toBe(true);
  });

  it("preserves order for multiple queued inbounds", async () => {
    const emulator = new BaileysEmulator();
    const p1 = emulator.simulateInbound({
      from: "15551234567@s.whatsapp.net",
      content: "first",
      handle: "h-q-1",
    });
    const p2 = emulator.simulateInbound({
      from: "15551234567@s.whatsapp.net",
      content: "second",
      handle: "h-q-2",
    });

    const surface = new ChatSdkMessagingSurface([createEmulatedBaileysPlatform(emulator)]);
    const events: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      events.push(event);
    });

    await (surface as unknown as { chat: { ensureInitialized: () => Promise<void> } }).chat.ensureInitialized();

    await Promise.all([p1, p2]);
    expect(events).toHaveLength(2);
    expect((events[0] as unknown as { content: string }).content).toBe("first");
    expect((events[1] as unknown as { content: string }).content).toBe("second");
  });

  it("rejects queued simulateInbound when delivery fails instead of unhandled rejection", async () => {
    const emulator = new BaileysEmulator();
    const pending = emulator.simulateInbound({
      from: "15551234567@s.whatsapp.net",
      content: "will fail",
      handle: "h-queued-fail",
    });

    const surface = new ChatSdkMessagingSurface([createEmulatedBaileysPlatform(emulator)]);
    surface.onInbound(async () => {});

    const chat = (surface as unknown as { chat: { processMessage: unknown; ensureInitialized: () => Promise<void> } }).chat as unknown as {
      processMessage: (...args: unknown[]) => unknown;
      ensureInitialized: () => Promise<void>;
    };
    const original = chat.processMessage;
    chat.processMessage = () => {
      throw new Error("inject boom");
    };

    await chat.ensureInitialized();

    await expect(pending).rejects.toThrow("inject boom");

    chat.processMessage = original;
  });
});

describe("emulated baileys platform capabilities", () => {
  it("exposes provider baileys with direct+groups but no typing", async () => {
    const { emulator, surface } = createHarness();
    // Trigger init so surface has platform info
    await surface.openDirectThread("baileys", "15551234567@s.whatsapp.net", context);
    const descriptors = surface.platforms();
    expect(descriptors).toEqual([{ provider: "baileys", capabilities: { direct: true, groups: true, typing: false } }]);
  });
});
