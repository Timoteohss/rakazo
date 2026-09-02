import type { Adapter, AdapterPostableMessage, ChatInstance, FetchOptions, FetchResult, Message } from "chat";
import { Message as ChatMessage } from "chat";

/**
 * Inbound payload for the fake Baileys socket. Mirrors the shape callers care
 * about: a sender address (phone or full JID), text, and optional group
 * context. JIDs follow WhatsApp conventions:
 *  - DM: "<number>@s.whatsapp.net" (also accepted as bare number)
 *  - Group: "<id>@g.us"
 */
export interface BaileysEmulatorInboundInput {
  from: string;
  content: string;
  handle?: string;
  pushName?: string;
  /** Full group JID, e.g. "120363025@g.us". Forces group semantics. */
  groupJid?: string;
  groupSubject?: string;
  participants?: string[];
  mediaUrl?: string;
}

interface SentRecord {
  kind: "dm" | "group";
  jid: string;
  body: string;
  handle: string;
}

type ConnectionState = "open" | "close" | "connecting";

export interface BaileysConnectionUpdate {
  connection: ConnectionState;
  qr?: string;
  lastDisconnect?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toJid(address: string, fallbackDomain: string): string {
  if (address.includes("@")) return address;
  // Bare phone / id → WhatsApp user JID.
  return `${address}@${fallbackDomain}`;
}

function normalizeJid(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed;
  // Default DM domain.
  return `${trimmed}@s.whatsapp.net`;
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

function encodeJid(jid: string): string {
  return Buffer.from(jid).toString("base64url");
}

function decodeJid(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString();
}

/**
 * Deterministic in-process fake for the Baileys WebSocket.
 * Mirrors `packages/adapters/src/sendblue-emulator.ts` in spirit but models
 * the Baileys socket interface: `connection.update` (qr/open/close),
 * `messages.upsert` (inbound), and `sendMessage` recording (outbound), with
 * QR-rotation simulation. No network, no native Baileys deps.
 */
export class BaileysEmulator {
  /** Bot's own JID for roster filtering (like Sendblue's phoneNumber). */
  readonly selfJid = "15550009999@s.whatsapp.net";

  readonly sent: SentRecord[] = [];
  readonly typingIndicators: string[] = [];

  currentQr: string | null = null;
  connectionState: ConnectionState = "close";
  qrCounter = 0;

  private readonly connectionListeners = new Set<(update: BaileysConnectionUpdate) => void>();
  private readonly qrListeners = new Set<(qr: string) => void>();

  private chat: ChatInstance | null = null;
  private adapterRef: BaileysFakeAdapter | null = null;
  private pendingInbounds: BaileysEmulatorInboundInput[] = [];
  private handleCounter = 0;
  private failRemaining = 0;

  readonly adapterName = "baileys";

  /** Subscribe to raw connection updates (open/close/qr). */
  onConnectionUpdate(listener: (update: BaileysConnectionUpdate) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onQr(listener: (qr: string) => void): () => void {
    this.qrListeners.add(listener);
    return () => this.qrListeners.delete(listener);
  }

  /** Internal: adapter calls this on initialize(chat). */
  _attach(chat: ChatInstance, adapter: BaileysFakeAdapter): void {
    this.chat = chat;
    this.adapterRef = adapter;
    // Flush any inbounds queued before chat was ready.
    const pending = [...this.pendingInbounds];
    this.pendingInbounds = [];
    for (const input of pending) {
      void this._inject(input);
    }
  }

  _detach(): void {
    this.chat = null;
    this.adapterRef = null;
  }

  // -- QR / connection -------------------------------------------------------

  simulateConnectionUpdate(update: BaileysConnectionUpdate): void {
    this.connectionState = update.connection;
    if (update.qr !== undefined) {
      this.currentQr = update.qr;
      if (update.qr) {
        for (const l of this.qrListeners) l(update.qr);
      }
    }
    if (update.connection === "open") {
      this.currentQr = null;
    }
    if (update.connection === "close") {
      // QR cleared on close mirrors real Baileys close flow.
    }
    for (const l of this.connectionListeners) l(update);
  }

  simulateQr(qr?: string): string {
    this.qrCounter += 1;
    const next = qr ?? `baileys-qr-${this.qrCounter}`;
    this.currentQr = next;
    this.connectionState = "connecting";
    const update: BaileysConnectionUpdate = { connection: "connecting", qr: next };
    for (const l of this.qrListeners) l(next);
    for (const l of this.connectionListeners) l(update);
    return next;
  }

  /** Emit a fresh QR, closing the previous one. Deterministic rotation. */
  rotateQr(): string {
    return this.simulateQr();
  }

  simulateConnectionOpen(): void {
    this.simulateConnectionUpdate({ connection: "open" });
  }

  simulateConnectionClose(): void {
    this.simulateConnectionUpdate({ connection: "close" });
  }

  // -- Outbound recording ----------------------------------------------------

  failNextSends(count: number): void {
    this.failRemaining = count;
  }

  private nextHandle(): string {
    this.handleCounter += 1;
    return `baileys-handle-${this.handleCounter}`;
  }

  // Called by adapter.postMessage via _send.
  _recordSend(jid: string, body: string): string {
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      throw new Error("baileys emulator: emulated send failure");
    }
    const handle = this.nextHandle();
    this.sent.push({
      kind: isGroupJid(jid) ? "group" : "dm",
      jid,
      body,
      handle,
    });
    return handle;
  }

  _recordTyping(jid: string): void {
    this.typingIndicators.push(jid);
  }

  // -- Inbound injection -----------------------------------------------------

  /**
   * Drive an inbound message through the real Chat SDK, mirroring
   * `socket.ev.emit("messages.upsert", {messages, type:"notify"})`.
   * Queues if chat hasn't initialized yet (lazy ChatSdkMessagingSurface).
   */
  async simulateInbound(input: BaileysEmulatorInboundInput): Promise<void> {
    if (!this.chat || !this.adapterRef) {
      this.pendingInbounds.push(input);
      return;
    }
    await this._inject(input);
  }

  private async _inject(input: BaileysEmulatorInboundInput): Promise<void> {
    const adapter = this.adapterRef!;
    const chat = this.chat!;
    // Ensure state is connected before processing (off-webhook socket path).
    const maybeInit = (chat as unknown as { ensureInitialized?: () => Promise<void> }).ensureInitialized;
    if (maybeInit) await maybeInit.call(chat);
    const handle = input.handle ?? this.nextHandle();

    // Resolve JIDs.
    const senderJid = normalizeJid(input.from);
    const isGroup = Boolean(input.groupJid) || (input.participants && input.participants.length > 0 && input.groupJid !== undefined) || isGroupJid(senderJid) === false && input.groupJid !== undefined;
    // Canonical thread JID is groupJid for groups, sender JID for DMs.
    const threadJid = input.groupJid ? normalizeJid(input.groupJid) : senderJid;
    // For groups, ensure JID ends with @g.us.
    const canonicalThreadJid = (() => {
      if (input.groupJid) return normalizeJid(input.groupJid);
      if (isGroup && !isGroupJid(threadJid)) {
        // Caller gave group context but thread jid not group-shaped; synthesize.
        return threadJid;
      }
      return threadJid;
    })();

    const participants = (input.participants ?? []).map((p) => normalizeJid(p));
    const groupSubject = input.groupSubject ?? null;

    // Fake Baileys raw payload — enough for our parseMessage + platform hooks.
    const raw = {
      key: {
        remoteJid: canonicalThreadJid,
        id: handle,
        participant: isGroupJid(canonicalThreadJid) ? senderJid : undefined,
        fromMe: false,
      },
      pushName: input.pushName ?? senderJid.split("@")[0] ?? null,
      message: {
        conversation: input.content,
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      // Emulator metadata used by adapter.parseMessage and platform participants/channelName.
      _emulatorMeta: {
        senderJid,
        threadJid: canonicalThreadJid,
        participants,
        groupSubject,
        mediaUrl: input.mediaUrl ?? null,
        handle,
        content: input.content,
      },
    };

    const threadId = adapter.encodeThreadId({ jid: canonicalThreadJid });

    // Use the Chat SDK's processMessage path that BaileysAdapter uses for messages.upsert.
    const maybePromise = (chat as unknown as { processMessage: (adapter: Adapter, threadId: string, factory: () => Message, opts?: unknown) => unknown }).processMessage(
      adapter as unknown as Adapter,
      threadId,
      () => adapter.parseMessage(raw),
    );
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
      await (maybePromise as Promise<unknown>);
    }
    // Allow concurrent handlers (dispatchToHandlers) to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  // Helpers mirroring Baileys thread id helpers (exposed for tests).
  encodeThreadId(jid: string): string {
    return `${this.adapterName}:${encodeJid(jid)}`;
  }

  decodeThreadId(threadId: string): { jid: string } {
    const prefix = `${this.adapterName}:`;
    if (!threadId.startsWith(prefix)) throw new Error(`Invalid Baileys thread ID: ${threadId}`);
    return { jid: decodeJid(threadId.slice(prefix.length)) };
  }
}

/**
 * Minimal Baileys-compatible Chat Adapter that speaks to BaileysEmulator's
 * fake socket. NOT the npm `chat-adapter-baileys` — a lightweight, zero-deps
 * deterministic stand-in for offline tests and future real-socket composition.
 */
export class BaileysFakeAdapter {
  readonly name: string;
  readonly userName: string;
  private chat: ChatInstance | null = null;

  constructor(
    private readonly emulator: BaileysEmulator,
    opts: { adapterName?: string; userName?: string } = {},
  ) {
    this.name = opts.adapterName ?? emulator.adapterName;
    this.userName = opts.userName ?? "baileys-bot";
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.emulator._attach(chat, this as unknown as BaileysFakeAdapter);
  }

  async disconnect(): Promise<void> {
    this.emulator._detach();
  }

  encodeThreadId(data: { jid: string }): string {
    return `${this.name}:${encodeJid(data.jid)}`;
  }

  decodeThreadId(threadId: string): { jid: string } {
    const prefix = `${this.name}:`;
    if (!threadId.startsWith(prefix)) {
      throw new Error(`Invalid Baileys thread ID: ${threadId}`);
    }
    return { jid: decodeJid(threadId.slice(prefix.length)) };
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    const { jid } = this.decodeThreadId(threadId);
    return !isGroupJid(jid);
  }

  async handleWebhook(_request: Request, _options?: unknown): Promise<Response> {
    return new Response(
      JSON.stringify({
        error: "Baileys adapter does not use HTTP webhooks. Inbound arrives via socket messages.upsert.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

  parseMessage(raw: unknown): Message<unknown> {
    const r = raw as {
      key: { remoteJid: string; id: string; participant?: string; fromMe?: boolean };
      pushName?: string | null;
      message?: { conversation?: string; extendedTextMessage?: { text?: string } };
      messageTimestamp?: number;
      _emulatorMeta?: {
        senderJid: string;
        threadJid: string;
        participants: string[];
        groupSubject: string | null;
        mediaUrl: string | null;
        handle: string;
        content: string;
      };
    };
    const meta = r._emulatorMeta;
    const jid = r.key.remoteJid;
    const threadId = this.encodeThreadId({ jid });
    const senderJid = meta?.senderJid ?? r.key.participant ?? jid;
    const content = meta?.content ?? r.message?.conversation ?? r.message?.extendedTextMessage?.text ?? "";
    const pushName = r.pushName ?? senderJid.split("@")[0] ?? senderJid;
    // Author is the sender for both DM and group.
    const authorUserId = senderJid;
    return new ChatMessage({
      id: r.key.id ?? meta?.handle ?? `msg-${Date.now()}`,
      threadId,
      text: content,
      formatted: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: content }]}]} as unknown as never,
      raw: r,
      author: {
        userId: authorUserId,
        userName: pushName,
        fullName: pushName,
        isBot: false,
        isMe: false,
      },
      metadata: {
        dateSent: new Date(),
        edited: false,
      } as unknown as never,
      attachments: meta?.mediaUrl
        ? [{ url: meta.mediaUrl, mimeType: "image/jpeg", filename: "media" } as unknown as never]
        : [],
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<{ id: string; threadId: string; raw: unknown }> {
    const { jid } = this.decodeThreadId(threadId);
    let text = "";
    if (typeof message === "string") text = message;
    else if (message && typeof message === "object" && "text" in message && typeof (message as { text?: unknown }).text === "string") {
      text = (message as { text: string }).text;
    } else if (message && typeof message === "object" && "raw" in message && typeof (message as { raw?: unknown }).raw === "string") {
      text = (message as { raw: string }).raw;
    }
    const handle = this.emulator._recordSend(jid, text);
    // Simulate Baileys sendMessage returning a WAMessage-like key.
    return {
      id: handle,
      threadId,
      raw: { key: { remoteJid: jid, id: handle, fromMe: true } },
    };
  }

  async postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<{ id: string; threadId: string; raw: unknown }> {
    return this.postMessage(channelId, message);
  }

  async editMessage(): Promise<never> {
    throw new Error("editMessage not implemented in baileys emulator");
  }

  async deleteMessage(): Promise<void> {
    // no-op
  }

  async addReaction(): Promise<void> {}

  async removeReaction(): Promise<void> {}

  async fetchMessages(_threadId: string, _options?: FetchOptions): Promise<FetchResult<unknown>> {
    return { messages: [] as unknown as Message<unknown>[] };
  }

  async fetchThread(threadId: string): Promise<{ id: string; channelId: string; isDM: boolean; metadata: Record<string, unknown> }> {
    const { jid } = this.decodeThreadId(threadId);
    return { id: threadId, channelId: threadId, isDM: !isGroupJid(jid), metadata: { jid } };
  }

  async fetchChannelInfo(channelId: string): Promise<{ id: string; name?: string; isDM: boolean; memberCount?: number; metadata: Record<string, unknown> }> {
    const { jid } = this.decodeThreadId(channelId);
    return { id: channelId, isDM: !isGroupJid(jid), metadata: { jid } };
  }

  async fetchChannelMessages(_channelId: string, _options?: FetchOptions): Promise<FetchResult<unknown>> {
    return { messages: [] as unknown as Message<unknown>[] };
  }

  async listThreads(): Promise<{ threads: unknown[]; nextCursor?: string }> {
    return { threads: [] };
  }

  async openDM(userId: string): Promise<string> {
    const jid = userId.includes("@") ? userId : `${userId}@s.whatsapp.net`;
    return this.encodeThreadId({ jid });
  }

  async startTyping(threadId: string): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    this.emulator._recordTyping(jid);
  }

  renderFormatted(content: unknown): string {
    // Plain passthrough for emulator: if content is string return it, else JSON.
    if (typeof content === "string") return content;
    return "";
  }
}

export function createBaileysFakeAdapter(emulator: BaileysEmulator): Adapter {
  return new BaileysFakeAdapter(emulator) as unknown as Adapter;
}
