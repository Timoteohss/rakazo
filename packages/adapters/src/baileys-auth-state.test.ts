import { BufferJSON, initAuthCreds } from "baileys";
import { describe, expect, it } from "vitest";
import { createPostgresAuthState } from "./baileys-auth-state.js";

type Row = { id: string; scope: string; creds: unknown; keys: unknown; status: string };

function createInMemoryPrisma() {
  const store = new Map<string, Row>();
  let nextId = 1;

  const api = {
    messagingBaileysSession: {
      findUnique: async ({ where }: { where: { scope?: string; id?: string } }) => {
        if (where.scope) {
          for (const r of store.values()) if (r.scope === where.scope) return { ...r };
          return null;
        }
        if (where.id) {
          const r = store.get(where.id);
          return r ? { ...r } : null;
        }
        return null;
      },
      findFirst: async ({ where }: { where: { OR?: Array<{ scope?: string; id?: string }> } }) => {
        const ors = where.OR ?? [];
        for (const r of store.values()) {
          for (const cond of ors) {
            if (cond.scope && r.scope === cond.scope) return { ...r };
            if (cond.id && r.id === cond.id) return { ...r };
          }
        }
        return null;
      },
      create: async ({ data }: { data: { scope: string; status?: string } }) => {
        const id = `mbs_${nextId++}`;
        const row: Row = {
          id,
          scope: data.scope,
          status: data.status ?? "unpaired",
          creds: null,
          keys: null,
        };
        store.set(id, row);
        return { ...row };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { scope: string };
        create: { scope: string; status?: string };
        update: Record<string, unknown>;
      }) => {
        for (const r of store.values()) {
          if (r.scope === where.scope) {
            // apply update if any
            Object.assign(r, update);
            return { ...r };
          }
        }
        const id = `mbs_${nextId++}`;
        const row: Row = {
          id,
          scope: create.scope,
          status: create.status ?? "unpaired",
          creds: null,
          keys: null,
        };
        store.set(id, row);
        return { ...row };
      },
      update: async ({
        where,
        data,
      }: {
        where: { scope?: string; id?: string };
        data: { creds?: unknown; keys?: unknown };
      }) => {
        let target: Row | undefined;
        if (where.scope) {
          for (const r of store.values()) if (r.scope === where.scope) target = r;
        } else if (where.id) {
          target = store.get(where.id);
        }
        if (!target) throw new Error(`row not found for ${JSON.stringify(where)}`);
        if ("creds" in data) target.creds = data.creds;
        if ("keys" in data) target.keys = data.keys;
        // also bump any other fields if provided
        Object.assign(target, data);
        return { ...target };
      },
    },
    // expose for inspection
    __store: store,
  };
  return api;
}

function realisticFixture() {
  const creds = initAuthCreds();
  // Make deterministic, add binary fields
  (creds as unknown as Record<string, unknown>).me = {
    id: "1234567890@s.whatsapp.net",
    name: "Test User",
  };
  creds.account = undefined;
  creds.signalIdentities = [
    {
      identifier: { name: "1234567890@s.whatsapp.net", deviceId: 0 },
      identifierKey: Buffer.from("identifierKey-data"),
    },
  ];
  creds.myAppStateKeyId = "test-key-id";
  creds.registered = true;

  const keys = {
    "pre-key": {
      "1": { public: Buffer.from("prekey-public-1"), private: Buffer.from("prekey-private-1") },
      "2": { public: new Uint8Array([1, 2, 3, 4]), private: new Uint8Array([5, 6, 7, 8]) },
    },
    session: {
      "123@s.whatsapp.net.0": Buffer.from("session-data-blob"),
    },
    "sender-key": {
      "group123@s.whatsapp.net": Buffer.from("sender-key-data"),
    },
    "app-state-sync-key": {
      testKeyId: {
        keyData: Buffer.from("app-state-key"),
        fingerprint: { currentIndex: 1 },
      } as unknown as never,
    },
  } as unknown as Record<string, Record<string, unknown>>;

  return { creds, keys };
}

describe("baileys-auth-state Postgres store", () => {
  it("round-trips BufferJSON serialize/deserialize for a realistic fixture", async () => {
    const { creds, keys } = realisticFixture();
    // Direct BufferJSON round-trip check (proves codec handles our fixture)
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    const deserialized = JSON.parse(JSON.stringify(serialized), BufferJSON.reviver);
    // Buffers survive
    expect(deserialized.noiseKey.public).toBeInstanceOf(Buffer);
    expect(deserialized.noiseKey.private).toBeInstanceOf(Buffer);
    expect(deserialized.signedIdentityKey.public).toBeInstanceOf(Buffer);
    // Keys fixture buffers survive too
    const keysSer = JSON.parse(JSON.stringify(keys, BufferJSON.replacer));
    const keysDes = JSON.parse(JSON.stringify(keysSer), BufferJSON.reviver) as typeof keys;
    expect((keysDes["pre-key"] as Record<string, { public: Buffer }>)["1"]!.public).toBeInstanceOf(
      Buffer,
    );
    expect((keysDes.session as Record<string, Buffer>)["123@s.whatsapp.net.0"]).toBeInstanceOf(
      Buffer,
    );
  });

  it("persists creds and restores them on fresh instance (process restart simulation)", async () => {
    const prisma = createInMemoryPrisma() as unknown as Parameters<
      typeof createPostgresAuthState
    >[0];
    const scope = "test-restart-scope";

    const a = await createPostgresAuthState(prisma, scope);
    // Mutate creds like Baileys does
    (a.state.creds as unknown as Record<string, unknown>).me = {
      id: " restart-me@s.whatsapp.net",
      name: "Restart",
    };
    (a.state.creds as unknown as Record<string, unknown>).registered = true;
    // Add a deterministic noiseKey mutation via Buffer
    a.state.creds.noiseKey = {
      public: Buffer.from("restart-public"),
      private: Buffer.from("restart-private"),
    } as unknown as typeof a.state.creds.noiseKey;
    await a.saveCreds();
    // Flush keys also (ensure destroy flushes)
    await a.destroy();

    // Fresh instance should see identical creds
    const b = await createPostgresAuthState(prisma, scope);
    expect(b.state.creds.me).toEqual({ id: " restart-me@s.whatsapp.net", name: "Restart" });
    expect(b.state.creds.registered).toBe(true);
    expect(Buffer.isBuffer(b.state.creds.noiseKey.public)).toBe(true);
    expect(Buffer.from(b.state.creds.noiseKey.public).toString()).toBe("restart-public");
    expect(Buffer.from(b.state.creds.noiseKey.private).toString()).toBe("restart-private");
    // Cleanup
    await b.destroy();
  });

  it("keys.set writes through and subsequent read reflects it", async () => {
    const prisma = createInMemoryPrisma() as unknown as Parameters<
      typeof createPostgresAuthState
    >[0];
    const scope = "test-keys-write-through";

    const a = await createPostgresAuthState(prisma, scope);
    const payload = {
      "pre-key": {
        "42": { public: Buffer.from("pk42-public"), private: Buffer.from("pk42-private") },
      },
      session: { "peer@s.whatsapp.net.0": Buffer.from("session-xyz") },
    } as unknown as import("baileys").SignalDataSet;

    await a.state.keys.set(payload);
    // Wait for debounced flush (40ms) plus margin
    await new Promise((r) => setTimeout(r, 80));
    // Also flush via destroy to ensure persistence if debounce missed
    await a.destroy();

    const b = await createPostgresAuthState(prisma, scope);
    const got = (await b.state.keys.get("pre-key", ["42"])) as Record<string, unknown>;
    expect(got["42"]).toBeTruthy();
    expect(Buffer.isBuffer((got["42"] as { public: Buffer }).public)).toBe(true);

    const sess = (await b.state.keys.get("session", ["peer@s.whatsapp.net.0"])) as Record<
      string,
      Buffer
    >;
    expect(sess["peer@s.whatsapp.net.0"]).toBeTruthy();
    expect(Buffer.from(sess["peer@s.whatsapp.net.0"]!).toString()).toBe("session-xyz");
    await b.destroy();
  });

  it("concurrent flushes do not corrupt or lose data", async () => {
    const prisma = createInMemoryPrisma() as unknown as Parameters<
      typeof createPostgresAuthState
    >[0];
    const scope = "test-concurrent-flush";

    const a = await createPostgresAuthState(prisma, scope);

    // Two saves in quick succession, overlapping
    const p1 = a.state.keys.set({
      "pre-key": { "100": { public: Buffer.from("c100"), private: Buffer.from("c100p") } },
    } as unknown as import("baileys").SignalDataSet);
    const p2 = a.state.keys.set({
      session: { "concurrent@s.whatsapp.net.0": Buffer.from("concurrent-session") },
    } as unknown as import("baileys").SignalDataSet);
    await Promise.all([p1, p2]);

    // Wait for debounce to coalesce and flush
    await new Promise((r) => setTimeout(r, 100));
    await a.destroy();

    const b = await createPostgresAuthState(prisma, scope);
    const pre = (await b.state.keys.get("pre-key", ["100"])) as Record<string, unknown>;
    const sess = (await b.state.keys.get("session", ["concurrent@s.whatsapp.net.0"])) as Record<
      string,
      Buffer
    >;
    // Neither write was lost
    expect(pre["100"]).toBeTruthy();
    expect(sess["concurrent@s.whatsapp.net.0"]).toBeTruthy();
    expect(Buffer.from(sess["concurrent@s.whatsapp.net.0"]!).toString()).toBe("concurrent-session");
    await b.destroy();
  });

  it("destroy flushes pending writes even if called immediately after set", async () => {
    const prisma = createInMemoryPrisma() as unknown as Parameters<
      typeof createPostgresAuthState
    >[0];
    const scope = "test-destroy-flush";
    const a = await createPostgresAuthState(prisma, scope);
    await a.state.keys.set({
      "pre-key": { "999": { public: Buffer.from("pending"), private: Buffer.from("pending-p") } },
    } as unknown as import("baileys").SignalDataSet);
    // No wait — destroy should force flush
    await a.destroy();

    const b = await createPostgresAuthState(prisma, scope);
    const got = (await b.state.keys.get("pre-key", ["999"])) as Record<string, unknown>;
    expect(got["999"]).toBeTruthy();
    await b.destroy();
  });
});
