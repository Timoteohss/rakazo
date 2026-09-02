import { createZaileysAdapter } from "chat-adapter-zaileys";
import { PostgresAuthStore, PostgresMessageStore } from "zaileys";

export interface ZaileysAdapterConfig {
  sessionId?: string;
  connectionString?: string;
  autoMarkRead?: boolean;
  richMessages?: boolean;
}

/**
 * Build a Chat SDK WhatsApp adapter backed by zaileys with PostgreSQL
 * persistence for auth credentials and message history.
 *
 * `autoConnect` is intentionally `false`: callers wire the adapter into a
 * `Chat` instance and register handlers before the underlying socket connects
 * so no inbound events are dropped on cold start.
 */
export function createZaileysMessagingAdapter(config?: ZaileysAdapterConfig) {
  const sessionId = config?.sessionId ?? "main";
  const connectionString = config?.connectionString ?? process.env.DATABASE_URL;

  const session: {
    sessionId: string;
    authType: "qr";
    autoConnect: boolean;
    auth?: PostgresAuthStore;
    store?: PostgresMessageStore;
    autoMarkRead?: boolean;
    richMessages?: boolean;
  } = {
    sessionId,
    authType: "qr",
    autoConnect: false,
  };

  if (connectionString) {
    session.auth = new PostgresAuthStore({ connectionString });
    session.store = new PostgresMessageStore({ connectionString });
  }

  if (config?.autoMarkRead !== undefined) {
    session.autoMarkRead = config.autoMarkRead;
  }
  if (config?.richMessages !== undefined) {
    session.richMessages = config.richMessages;
  }

  return createZaileysAdapter({
    session,
    adapterName: "zaileys",
    userName: "rakazo",
  });
}