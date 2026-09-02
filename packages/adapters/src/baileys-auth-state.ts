import { Mutex } from "async-mutex";
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalKeyStore,
} from "baileys";
import { BufferJSON, initAuthCreds, makeCacheableSignalKeyStore } from "baileys";
import { EncryptedSecretStore } from "./secrets.js";

// Re-export for callers that need the type.
export type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalKeyStore };

export interface BaileysAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  destroy: () => Promise<void>;
}

export interface BaileysAuthStateOptions {
  encryptionKey?: string;
  secrets?: EncryptedSecretStore;
}

type PrismaLike = {
  messagingBaileysSession: {
    findUnique?: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
    create?: (args: unknown) => Promise<unknown>;
    update?: (args: unknown) => Promise<unknown>;
    upsert?: (args: unknown) => Promise<unknown>;
  };
};

type Row = {
  id: string;
  scope: string;
  creds: unknown;
  keys: unknown;
};

const FLUSH_DEBOUNCE_MS = 40;

function resolveSecrets(optsOrKey?: string | BaileysAuthStateOptions): EncryptedSecretStore {
  if (optsOrKey && typeof optsOrKey === "object" && "secrets" in optsOrKey && optsOrKey.secrets) {
    return optsOrKey.secrets;
  }
  const keyFromOpts =
    typeof optsOrKey === "string"
      ? optsOrKey
      : (optsOrKey as BaileysAuthStateOptions | undefined)?.encryptionKey;
  const key = keyFromOpts ?? process.env.ENCRYPTION_KEY ?? "dev-encryption-key";
  return new EncryptedSecretStore(key);
}

async function loadRow(prisma: PrismaLike, scope: string): Promise<Row | null> {
  const delegate = prisma.messagingBaileysSession as unknown as Record<
    string,
    (a: unknown) => Promise<unknown>
  >;
  if (delegate.findUnique) {
    try {
      const byScope = (await delegate.findUnique({ where: { scope } })) as Row | null;
      if (byScope) return byScope;
    } catch {
      // ignore
    }
    try {
      const byId = (await delegate.findUnique({ where: { id: scope } })) as Row | null;
      if (byId) return byId;
    } catch {
      // ignore
    }
  }
  if (delegate.findFirst) {
    try {
      const row = (await delegate.findFirst({
        where: { OR: [{ scope }, { id: scope }] },
      })) as Row | null;
      if (row) return row;
    } catch {
      // ignore
    }
  }
  return null;
}

async function ensureRow(prisma: PrismaLike, scope: string): Promise<Row> {
  const existing = await loadRow(prisma, scope);
  if (existing) return existing;
  const delegate = prisma.messagingBaileysSession as unknown as Record<
    string,
    (a: unknown) => Promise<unknown>
  >;
  if (delegate.upsert) {
    return (await delegate.upsert({
      where: { scope },
      create: { scope, status: "unpaired" },
      update: {},
    })) as Row;
  }
  if (delegate.create) {
    try {
      return (await delegate.create({
        data: { scope, status: "unpaired" },
      })) as Row;
    } catch {
      const raced = await loadRow(prisma, scope);
      if (raced) return raced;
      throw new Error("failed to create messaging_baileys_sessions row");
    }
  }
  throw new Error("prisma.messagingBaileysSession must support upsert or create");
}

/**
 * Postgres-backed Baileys auth state.
 *
 * Each `scope` maps to one `messaging_baileys_sessions` row (`scope` unique,
 * default for now). Creds and keys are serialized with Baileys' BufferJSON
 * codec, then encrypted with EncryptedSecretStore (AES-256-GCM, scrypt,
 * versioned `v2:` format) before being written to the jsonb columns. The
 * signal key store is wrapped with `makeCacheableSignalKeyStore` for in-memory
 * cache + write-through semantics; writes are debounced and coalesced, with an
 * explicit `destroy()` flush hook for disconnect / shutdown callers.
 *
 * The returned `state.creds` object is the live mutable reference Baileys
 * mutates; call `saveCreds()` after Baileys signals creds have changed.
 */
export async function createPostgresAuthState(
  prisma: PrismaLike,
  sessionId = "default",
  optsOrKey?: string | BaileysAuthStateOptions,
): Promise<BaileysAuthState> {
  const scope = sessionId || "default";
  const secrets = resolveSecrets(optsOrKey);
  const credsRecordId = `baileys:${scope}:creds`;
  const keysRecordId = `baileys:${scope}:keys`;

  function encryptValue(obj: unknown, recordId: string): string {
    const plaintext = JSON.stringify(
      obj,
      BufferJSON.replacer as unknown as (k: string, v: unknown) => unknown,
    );
    return secrets.encrypt(plaintext, recordId);
  }

  function decryptValue(stored: unknown, recordId: string): unknown {
    if (stored == null) return null;
    if (typeof stored === "string") {
      // Ciphertext from EncryptedSecretStore always starts with v2:, but also
      // handle legacy base64 without prefix.
      const maybeCipher = stored.trim();
      if (maybeCipher.startsWith("v2:") || /^[A-Za-z0-9+/=]+$/.test(maybeCipher)) {
        try {
          const plain = secrets.load(maybeCipher, recordId);
          return JSON.parse(
            plain,
            BufferJSON.reviver as unknown as (k: string, v: unknown) => unknown,
          );
        } catch {
          // Not actually ciphertext — fall through to plain JSON parse below
        }
      }
      try {
        return JSON.parse(
          stored,
          BufferJSON.reviver as unknown as (k: string, v: unknown) => unknown,
        );
      } catch {
        return null;
      }
    }
    // Legacy plaintext JSONB object (pre-encryption rows)
    return JSON.parse(
      JSON.stringify(stored),
      BufferJSON.reviver as unknown as (k: string, v: unknown) => unknown,
    );
  }

  const row = await ensureRow(prisma, scope);

  let creds: AuthenticationCreds;
  const rawCreds = row.creds;
  const decryptedCreds = decryptValue(rawCreds, credsRecordId);
  if (decryptedCreds != null) {
    creds = decryptedCreds as AuthenticationCreds;
  } else {
    creds = initAuthCreds();
  }

  let keysData: SignalDataSet = {};
  const rawKeys = row.keys;
  const decryptedKeys = decryptValue(rawKeys, keysRecordId);
  if (decryptedKeys != null && typeof decryptedKeys === "object") {
    keysData = decryptedKeys as SignalDataSet;
  }

  const mutex = new Mutex();
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const delegate = prisma.messagingBaileysSession as unknown as Record<
    string,
    (a: unknown) => Promise<unknown>
  >;

  async function flushKeys(): Promise<void> {
    if (destroyed) return;
    const timer = pendingTimer;
    if (timer) {
      clearTimeout(timer);
      pendingTimer = null;
    }
    await mutex.runExclusive(async () => {
      const payload = encryptValue(keysData, keysRecordId);
      const upd = delegate.update;
      if (!upd) throw new Error("prisma delegate missing update");
      try {
        await upd({ where: { scope }, data: { keys: payload } });
      } catch {
        await upd({ where: { id: (row as Row).id }, data: { keys: payload } });
      }
    });
  }

  function scheduleFlush(): void {
    if (destroyed) return;
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void flushKeys().catch(() => {});
    }, FLUSH_DEBOUNCE_MS);
  }

  const rawStore = {
    get: async (type: string, ids: string[]) => {
      const out: Record<string, unknown> = {};
      const bucket = (keysData as Record<string, Record<string, unknown>>)[type];
      if (!bucket) return out;
      for (const id of ids) {
        const v = bucket[id];
        if (v !== undefined && v !== null) out[id] = v;
      }
      return out;
    },
    set: async (data: SignalDataSet) => {
      for (const type in data) {
        const bucket = (data as Record<string, Record<string, unknown | null>>)[type];
        if (!bucket) continue;
        const typeKey = type;
        let existing = (keysData as Record<string, Record<string, unknown>>)[typeKey];
        if (!existing) {
          existing = {};
          (keysData as Record<string, Record<string, unknown>>)[typeKey] = existing;
        }
        for (const id in bucket) {
          const value = bucket[id];
          if (value === null || value === undefined) {
            delete existing[id];
          } else {
            existing[id] = value as unknown;
          }
        }
        if (Object.keys(existing).length === 0) {
          delete (keysData as Record<string, unknown>)[type];
        }
      }
      scheduleFlush();
    },
    clear: async () => {
      for (const k in keysData) delete (keysData as Record<string, unknown>)[k];
      scheduleFlush();
    },
  } as unknown as SignalKeyStore;

  const cachedKeys = makeCacheableSignalKeyStore(rawStore, undefined);

  const state: AuthenticationState = {
    creds,
    keys: cachedKeys,
  };

  async function saveCreds(): Promise<void> {
    await mutex.runExclusive(async () => {
      const payload = encryptValue(state.creds, credsRecordId);
      const upd = delegate.update;
      if (!upd) throw new Error("prisma delegate missing update");
      try {
        await upd({ where: { scope }, data: { creds: payload } });
      } catch {
        await upd({ where: { id: (row as Row).id }, data: { creds: payload } });
      }
    });
  }

  async function destroy(): Promise<void> {
    destroyed = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    await mutex.runExclusive(async () => {
      const payload = encryptValue(keysData, keysRecordId);
      const upd = delegate.update;
      if (!upd) return;
      try {
        await upd({ where: { scope }, data: { keys: payload } });
      } catch {
        try {
          await upd({ where: { id: (row as Row).id }, data: { keys: payload } });
        } catch {
          // ignore
        }
      }
    });
  }

  return { state, saveCreds, destroy };
}
