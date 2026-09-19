// The credentials of the external MCP server (docs/spec/external-mcp.md,
// ADR 0006): Keys made in Settings or by the Agent, and the tokens OAuth
// clients hold after consent. Both are one row shape with a hashed secret,
// a scope, the Workspaces they reach and an expiry that is never "never".
// Beside them, the OAuth tables: dynamically registered clients, the
// authorizations in flight with their PKCE challenge, and refresh tokens.
// Postgres in production, memory in tests; the module above sees only the
// interface. Runtime-neutral: Web Crypto only.

import type {
  ExternalCredential,
  ExternalKeyCreated,
  ExternalKeyInput,
  ExternalScope,
} from "@monday/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomToken, sha256Hex } from "../auth/index.ts";
import type { Db } from "../db/client.ts";
import { externalCredentials, oauthClients, oauthCodes, oauthRefreshTokens } from "../db/schema.ts";

/** The visible start of a key, so a leaked one is recognisable as monday's. */
export const KEY_PREFIX = "mk_live_";
/** The start of an OAuth access token, so logs can tell the two apart. */
export const TOKEN_PREFIX = "mo_";
/** How much of a key the list shows. */
export const PREFIX_SHOWN = KEY_PREFIX.length + 6;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** An authorization in flight, as the consent page and the token endpoint see it. */
export interface OAuthCode {
  id: string;
  clientId: string;
  pairingCode: string;
  redirectUri: string;
  scope: ExternalScope;
  workspaceIds: string[] | null;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
  approvedAt: string | null;
  usedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface NewOAuthCode {
  clientId: string;
  pairingCode: string;
  redirectUri: string;
  scope: ExternalScope;
  workspaceIds: string[] | null;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
  expiresAt: Date;
}

export interface NewCredential {
  kind: "key" | "oauth";
  name: string;
  scope: ExternalScope;
  workspaceIds: string[] | null;
  secret: string;
  expiresAt: Date;
  clientId?: string | null | undefined;
}

export interface CredentialStore {
  /** Inserts a credential for a secret the caller minted; the secret is hashed here. */
  insert(input: NewCredential): Promise<ExternalCredential>;
  list(): Promise<ExternalCredential[]>;
  get(id: string): Promise<ExternalCredential | null>;
  /** The credential a presented secret belongs to, revoked or expired ones included. */
  findBySecret(secret: string): Promise<ExternalCredential | null>;
  touch(id: string): Promise<void>;
  /** False when already revoked or unknown. */
  revoke(id: string): Promise<boolean>;
  /** A new secret for the same credential (an OAuth refresh): the old one stops working. */
  rotateSecret(id: string, secret: string, expiresAt: Date): Promise<ExternalCredential | null>;

  registerClient(client: Omit<OAuthClient, "createdAt">): Promise<OAuthClient>;
  getClient(id: string): Promise<OAuthClient | null>;

  createCode(input: NewOAuthCode): Promise<OAuthCode>;
  getCode(id: string): Promise<OAuthCode | null>;
  /** The authorization a pairing code names, if still open. */
  findCodeByPairingCode(pairingCode: string): Promise<OAuthCode | null>;
  /** Marks the authorization approved and binds the authorization code (hashed) to it. */
  approveCode(id: string, code: string, workspaceIds: string[] | null): Promise<OAuthCode | null>;
  /** The open authorization the code belongs to, marking it used; null when unknown or spent. */
  consumeCode(code: string): Promise<OAuthCode | null>;
  /** Authorizations waiting for the owner, newest first. */
  listOpenCodes(): Promise<OAuthCode[]>;
  denyCode(id: string): Promise<void>;

  insertRefresh(credentialId: string, token: string): Promise<void>;
  /** The credential a refresh token names, marking the token used; null when unknown or spent. */
  consumeRefresh(token: string): Promise<string | null>;
}

/** A fresh key: the prefix, then 32 random bytes as URL-safe base64. */
export function mintKey(): string {
  return `${KEY_PREFIX}${randomToken(32)}`;
}

export function mintAccessToken(): string {
  return `${TOKEN_PREFIX}${randomToken(32)}`;
}

export function prefixOf(secret: string): string {
  return secret.slice(0, PREFIX_SHOWN);
}

/** Whether a credential may be used now: not revoked, not past its expiry. */
export function credentialLive(credential: ExternalCredential, now: Date): boolean {
  return credential.revokedAt === null && Date.parse(credential.expiresAt) > now.getTime();
}

/** Whether a credential reaches a Workspace: its list, or all of them. */
export function credentialReaches(
  credential: Pick<ExternalCredential, "workspaceIds">,
  workspaceId: string,
): boolean {
  return credential.workspaceIds === null || credential.workspaceIds.includes(workspaceId);
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function projectCredential(r: typeof externalCredentials.$inferSelect): ExternalCredential {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    scope: r.scope,
    workspaceIds: r.workspaceIds ?? null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    lastUsedAt: iso(r.lastUsedAt),
    revokedAt: iso(r.revokedAt),
    clientId: r.clientId ?? null,
    prefix: r.prefix ?? null,
  };
}

function projectCode(r: typeof oauthCodes.$inferSelect): OAuthCode {
  return {
    id: r.id,
    clientId: r.clientId,
    pairingCode: r.pairingCode,
    redirectUri: r.redirectUri,
    scope: r.scope,
    workspaceIds: r.workspaceIds ?? null,
    state: r.state ?? null,
    codeChallenge: r.codeChallenge,
    resource: r.resource ?? null,
    approvedAt: iso(r.approvedAt),
    usedAt: iso(r.usedAt),
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

export function createCredentialStore(db: Db, options: { now?: () => Date } = {}): CredentialStore {
  const now = options.now ?? (() => new Date());
  return {
    async insert(input) {
      const secret = input.secret;
      const [row] = await db
        .insert(externalCredentials)
        .values({
          id: crypto.randomUUID(),
          kind: input.kind,
          name: input.name,
          scope: input.scope,
          workspaceIds: input.workspaceIds,
          secretHash: await sha256Hex(secret),
          prefix: input.kind === "key" ? prefixOf(secret) : null,
          createdAt: now(),
          expiresAt: input.expiresAt,
          clientId: input.clientId ?? null,
        })
        .returning();
      if (!row) throw new Error("credential insert returned nothing");
      return projectCredential(row);
    },
    async list() {
      const rows = await db
        .select()
        .from(externalCredentials)
        .orderBy(desc(externalCredentials.createdAt));
      return rows.map(projectCredential);
    },
    async get(id) {
      const row = await db.query.externalCredentials.findFirst({
        where: eq(externalCredentials.id, id),
      });
      return row ? projectCredential(row) : null;
    },
    async findBySecret(secret) {
      const row = await db.query.externalCredentials.findFirst({
        where: eq(externalCredentials.secretHash, await sha256Hex(secret)),
      });
      return row ? projectCredential(row) : null;
    },
    async touch(id) {
      await db
        .update(externalCredentials)
        .set({ lastUsedAt: now() })
        .where(eq(externalCredentials.id, id));
    },
    async revoke(id) {
      const rows = await db
        .update(externalCredentials)
        .set({ revokedAt: now() })
        .where(and(eq(externalCredentials.id, id), isNull(externalCredentials.revokedAt)))
        .returning({ id: externalCredentials.id });
      return rows.length > 0;
    },
    async rotateSecret(id, secret, expiresAt) {
      const [row] = await db
        .update(externalCredentials)
        .set({ secretHash: await sha256Hex(secret), expiresAt })
        .where(eq(externalCredentials.id, id))
        .returning();
      return row ? projectCredential(row) : null;
    },

    async registerClient(client) {
      const [row] = await db
        .insert(oauthClients)
        .values({ ...client, createdAt: now() })
        .returning();
      if (!row) throw new Error("client insert returned nothing");
      return { ...row, createdAt: row.createdAt.toISOString() };
    },
    async getClient(id) {
      const row = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, id) });
      return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
    },

    async createCode(input) {
      const [row] = await db
        .insert(oauthCodes)
        .values({ id: crypto.randomUUID(), ...input, createdAt: now() })
        .returning();
      if (!row) throw new Error("code insert returned nothing");
      return projectCode(row);
    },
    async getCode(id) {
      const row = await db.query.oauthCodes.findFirst({ where: eq(oauthCodes.id, id) });
      return row ? projectCode(row) : null;
    },
    async findCodeByPairingCode(pairingCode) {
      const row = await db.query.oauthCodes.findFirst({
        where: and(
          eq(oauthCodes.pairingCode, pairingCode),
          isNull(oauthCodes.approvedAt),
          isNull(oauthCodes.usedAt),
        ),
        orderBy: desc(oauthCodes.createdAt),
      });
      return row && row.expiresAt.getTime() > now().getTime() ? projectCode(row) : null;
    },
    async approveCode(id, code, workspaceIds) {
      const [row] = await db
        .update(oauthCodes)
        .set({ approvedAt: now(), codeHash: await sha256Hex(code), workspaceIds })
        .where(and(eq(oauthCodes.id, id), isNull(oauthCodes.approvedAt), isNull(oauthCodes.usedAt)))
        .returning();
      return row ? projectCode(row) : null;
    },
    async consumeCode(code) {
      const [row] = await db
        .update(oauthCodes)
        .set({ usedAt: now() })
        .where(and(eq(oauthCodes.codeHash, await sha256Hex(code)), isNull(oauthCodes.usedAt)))
        .returning();
      return row ? projectCode(row) : null;
    },
    async listOpenCodes() {
      const rows = await db
        .select()
        .from(oauthCodes)
        .where(and(isNull(oauthCodes.approvedAt), isNull(oauthCodes.usedAt)))
        .orderBy(desc(oauthCodes.createdAt));
      return rows.filter((r) => r.expiresAt.getTime() > now().getTime()).map(projectCode);
    },
    async denyCode(id) {
      await db.update(oauthCodes).set({ usedAt: now() }).where(eq(oauthCodes.id, id));
    },

    async insertRefresh(credentialId, token) {
      await db
        .insert(oauthRefreshTokens)
        .values({ tokenHash: await sha256Hex(token), credentialId, createdAt: now() });
    },
    async consumeRefresh(token) {
      const [row] = await db
        .update(oauthRefreshTokens)
        .set({ usedAt: now() })
        .where(
          and(
            eq(oauthRefreshTokens.tokenHash, await sha256Hex(token)),
            isNull(oauthRefreshTokens.usedAt),
          ),
        )
        .returning({ credentialId: oauthRefreshTokens.credentialId });
      return row?.credentialId ?? null;
    },
  };
}

/** The same interface in memory, for tests that need no database. */
export function createMemoryCredentialStore(
  options: { now?: () => Date } = {},
): CredentialStore & { credentials: ExternalCredential[] } {
  const now = options.now ?? (() => new Date());
  const credentials: Array<ExternalCredential & { secretHash: string }> = [];
  const clients: OAuthClient[] = [];
  const codes: Array<OAuthCode & { codeHash: string | null }> = [];
  const refreshes: Array<{ tokenHash: string; credentialId: string; usedAt: string | null }> = [];
  const strip = ({ secretHash: _s, ...rest }: (typeof credentials)[number]): ExternalCredential =>
    rest;
  const stripCode = ({ codeHash: _c, ...rest }: (typeof codes)[number]): OAuthCode => rest;
  return {
    get credentials() {
      return credentials.map(strip);
    },
    async insert(input) {
      const row = {
        id: crypto.randomUUID(),
        kind: input.kind,
        name: input.name,
        scope: input.scope,
        workspaceIds: input.workspaceIds,
        createdAt: now().toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        clientId: input.clientId ?? null,
        prefix: input.kind === "key" ? prefixOf(input.secret) : null,
        secretHash: await sha256Hex(input.secret),
      };
      credentials.unshift(row);
      return strip(row);
    },
    async list() {
      return credentials.map(strip);
    },
    async get(id) {
      const row = credentials.find((c) => c.id === id);
      return row ? strip(row) : null;
    },
    async findBySecret(secret) {
      const hash = await sha256Hex(secret);
      const row = credentials.find((c) => c.secretHash === hash);
      return row ? strip(row) : null;
    },
    async touch(id) {
      const row = credentials.find((c) => c.id === id);
      if (row) row.lastUsedAt = now().toISOString();
    },
    async revoke(id) {
      const row = credentials.find((c) => c.id === id);
      if (!row || row.revokedAt) return false;
      row.revokedAt = now().toISOString();
      return true;
    },
    async rotateSecret(id, secret, expiresAt) {
      const row = credentials.find((c) => c.id === id);
      if (!row) return null;
      row.secretHash = await sha256Hex(secret);
      row.expiresAt = expiresAt.toISOString();
      return strip(row);
    },
    async registerClient(client) {
      const row = { ...client, createdAt: now().toISOString() };
      clients.push(row);
      return row;
    },
    async getClient(id) {
      return clients.find((c) => c.id === id) ?? null;
    },
    async createCode(input) {
      const row = {
        id: crypto.randomUUID(),
        ...input,
        expiresAt: input.expiresAt.toISOString(),
        approvedAt: null,
        usedAt: null,
        createdAt: now().toISOString(),
        codeHash: null,
      };
      codes.unshift(row);
      return stripCode(row);
    },
    async getCode(id) {
      const row = codes.find((c) => c.id === id);
      return row ? stripCode(row) : null;
    },
    async findCodeByPairingCode(pairingCode) {
      const row = codes.find(
        (c) =>
          c.pairingCode === pairingCode &&
          !c.approvedAt &&
          !c.usedAt &&
          Date.parse(c.expiresAt) > now().getTime(),
      );
      return row ? stripCode(row) : null;
    },
    async approveCode(id, code, workspaceIds) {
      const row = codes.find((c) => c.id === id);
      if (!row || row.approvedAt || row.usedAt) return null;
      row.approvedAt = now().toISOString();
      row.codeHash = await sha256Hex(code);
      row.workspaceIds = workspaceIds;
      return stripCode(row);
    },
    async consumeCode(code) {
      const hash = await sha256Hex(code);
      const row = codes.find((c) => c.codeHash === hash && !c.usedAt);
      if (!row) return null;
      row.usedAt = now().toISOString();
      return stripCode(row);
    },
    async listOpenCodes() {
      return codes
        .filter((c) => !c.approvedAt && !c.usedAt && Date.parse(c.expiresAt) > now().getTime())
        .map(stripCode);
    },
    async denyCode(id) {
      const row = codes.find((c) => c.id === id);
      if (row) row.usedAt = now().toISOString();
    },
    async insertRefresh(credentialId, token) {
      refreshes.push({ tokenHash: await sha256Hex(token), credentialId, usedAt: null });
    },
    async consumeRefresh(token) {
      const hash = await sha256Hex(token);
      const row = refreshes.find((r) => r.tokenHash === hash && !r.usedAt);
      if (!row) return null;
      row.usedAt = now().toISOString();
      return row.credentialId;
    },
  };
}

/** The list projection with nothing secret: what the Settings panel shows. */
export function keyInputDefaults(
  input: ExternalKeyInput,
  defaultDays: number,
  now: Date,
): { expiresAt: Date } {
  const days = input.expiresInDays ?? defaultDays;
  return { expiresAt: new Date(now.getTime() + Math.max(1, days) * 86_400_000) };
}

export type { ExternalKeyCreated };
