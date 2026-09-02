-- Baileys WhatsApp auth state — Postgres-backed session store for the
-- multi-file auth replacement. One row per scope (default for now);
-- creds/keys are JSONB blobs serialized with Baileys' BufferJSON codec.

CREATE TABLE "messaging_baileys_sessions" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unpaired',
  "creds" JSONB,
  "keys" JSONB,
  "lastQr" TEXT,
  "lastQrAt" TIMESTAMP(3),
  "connectedJid" TEXT,
  "pairingPhone" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "messaging_baileys_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "messaging_baileys_sessions_scope_key" ON "messaging_baileys_sessions"("scope");
