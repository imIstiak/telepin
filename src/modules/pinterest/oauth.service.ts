import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../config/database";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { oauthStates, pinterestAccounts, type PinterestAccount } from "../../db/schema";
import { decrypt, encrypt, randomToken, sha256 } from "../../utils/crypto";
import { audit } from "../audit/audit.service";
import { pinterestRequest } from "./client";

export class ReconnectRequiredError extends Error {
  constructor(message = "Pinterest connection expired or was revoked. Use /connect to reconnect.") {
    super(message);
  }
}
export class OAuthStateError extends Error {}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
}

const STATE_TTL_MS = 15 * 60_000;

export function pinterestConfigured() {
  return Boolean(env.PINTEREST_CLIENT_ID && env.PINTEREST_CLIENT_SECRET && env.PINTEREST_REDIRECT_URI);
}

export async function createAuthorizationUrl(userId: string): Promise<string> {
  if (!pinterestConfigured()) throw new Error("Pinterest app credentials are not configured on the server.");
  const nonce = randomToken(32);
  await db.insert(oauthStates).values({ userId, nonceHash: sha256(nonce), expiresAt: new Date(Date.now() + STATE_TTL_MS) });
  const url = new URL(env.PINTEREST_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.PINTEREST_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.PINTEREST_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", env.PINTEREST_SCOPES);
  url.searchParams.set("state", nonce);
  return url.toString();
}

/** Atomically consumes a state value; returns the owning userId. */
export async function consumeState(state: string): Promise<string> {
  if (!state || state.length > 200) throw new OAuthStateError("Missing or malformed state");
  const [row] = await db
    .update(oauthStates)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthStates.nonceHash, sha256(state)), isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, new Date())))
    .returning({ userId: oauthStates.userId });
  if (!row) throw new OAuthStateError("Invalid, expired or already used OAuth state");
  return row.userId;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${env.PINTEREST_CLIENT_ID}:${env.PINTEREST_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(env.PINTEREST_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { message?: string; code?: number };
  if (!res.ok || !json.access_token) {
    const err = new Error(`Pinterest token endpoint returned ${res.status}: ${json.message ?? "no access token"}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return json;
}

function expiry(sec?: number) {
  return sec ? new Date(Date.now() + sec * 1000) : null;
}

export async function exchangeCodeAndStore(userId: string, code: string): Promise<PinterestAccount> {
  const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: env.PINTEREST_REDIRECT_URI });
  const account = await pinterestRequest<{ username?: string; id?: string }>("/user_account", { accessToken: tok.access_token });
  const values = {
    userId,
    pinterestUserId: account.id ?? null,
    username: account.username ?? null,
    encryptedAccessToken: encrypt(tok.access_token),
    encryptedRefreshToken: tok.refresh_token ? encrypt(tok.refresh_token) : null,
    tokenExpiresAt: expiry(tok.expires_in),
    refreshTokenExpiresAt: expiry(tok.refresh_token_expires_in),
    scopes: tok.scope ?? env.PINTEREST_SCOPES,
    connectionStatus: "CONNECTED" as const,
  };
  const [row] = await db
    .insert(pinterestAccounts)
    .values(values)
    .onConflictDoUpdate({ target: pinterestAccounts.userId, set: { ...values, updatedAt: new Date() } })
    .returning();
  await audit({ userId, action: "pinterest.connected", details: { username: account.username, scopes: tok.scope } });
  return row!;
}

export async function getAccount(userId: string) {
  return db.query.pinterestAccounts.findFirst({ where: eq(pinterestAccounts.userId, userId) });
}

/** Returns a usable access token, refreshing it (under a row lock) when it is about to expire. */
export async function getValidAccessToken(userId: string, opts: { forceRefresh?: boolean } = {}): Promise<{ token: string; account: PinterestAccount }> {
  const acc = await getAccount(userId);
  if (!acc || acc.connectionStatus === "REVOKED") throw new ReconnectRequiredError("Pinterest is not connected. Use /connect.");
  if (acc.connectionStatus === "EXPIRED") throw new ReconnectRequiredError();
  const soon = Date.now() + 5 * 60_000;
  if (!opts.forceRefresh && (!acc.tokenExpiresAt || acc.tokenExpiresAt.getTime() > soon)) {
    return { token: decrypt(acc.encryptedAccessToken), account: acc };
  }
  const result = await db.transaction(async (tx): Promise<{ token: string; account: PinterestAccount } | "expired"> => {
    const [locked] = await tx.select().from(pinterestAccounts).where(eq(pinterestAccounts.id, acc.id)).for("update");
    if (!locked) throw new ReconnectRequiredError();
    // Another process may have refreshed while we waited for the lock.
    if (!opts.forceRefresh && locked.tokenExpiresAt && locked.tokenExpiresAt.getTime() > soon) {
      return { token: decrypt(locked.encryptedAccessToken), account: locked };
    }
    if (!locked.encryptedRefreshToken) return "expired";
    try {
      const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(locked.encryptedRefreshToken) });
      const [updated] = await tx
        .update(pinterestAccounts)
        .set({
          encryptedAccessToken: encrypt(tok.access_token),
          encryptedRefreshToken: tok.refresh_token ? encrypt(tok.refresh_token) : locked.encryptedRefreshToken,
          tokenExpiresAt: expiry(tok.expires_in),
          refreshTokenExpiresAt: tok.refresh_token_expires_in ? expiry(tok.refresh_token_expires_in) : locked.refreshTokenExpiresAt,
          connectionStatus: "CONNECTED",
        })
        .where(eq(pinterestAccounts.id, acc.id))
        .returning();
      logger.info({ userId }, "Pinterest access token refreshed");
      return { token: tok.access_token, account: updated! };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 400 || status === 401) return "expired";
      throw e;
    }
  });
  if (result === "expired") {
    // Persist outside the transaction so the status change isn't rolled back by the thrown error.
    await db.update(pinterestAccounts).set({ connectionStatus: "EXPIRED" }).where(eq(pinterestAccounts.id, acc.id));
    await audit({ userId, action: "pinterest.token_expired" });
    throw new ReconnectRequiredError();
  }
  return result;
}
