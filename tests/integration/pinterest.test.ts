import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/config/database";
import { oauthStates, pinterestAccounts } from "../../src/db/schema";
import { listBoards, syncBoards } from "../../src/modules/pinterest/boards.service";
import { PinterestApiError, PinterestUnknownOutcomeError } from "../../src/modules/pinterest/client";
import { consumeState, createAuthorizationUrl, exchangeCodeAndStore, getValidAccessToken, OAuthStateError, ReconnectRequiredError } from "../../src/modules/pinterest/oauth.service";
import { createPin, findMatchingRecentPin } from "../../src/modules/pinterest/pins.service";
import { ensureUser } from "../../src/modules/users/user.service";
import { setupDb } from "../helpers/db";
import { startFakePinterest, type FakePinterest } from "../helpers/fake-pinterest";

let fake: FakePinterest;
let userId: string;

beforeAll(async () => {
  fake = await startFakePinterest();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  await setupDb();
  fake.boards = [];
  fake.pins = [];
  fake.pinBehaviors = [];
  userId = (await ensureUser({ id: 111, username: "istiak" }, 111)).id;
});

describe("Pinterest OAuth", () => {
  it("builds an authorize URL with state, and the state is single-use", async () => {
    const url = new URL(await createAuthorizationUrl(userId));
    expect(url.origin + url.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(url.searchParams.get("scope")).toBe("boards:read,pins:read,pins:write,user_accounts:read");
    const state = url.searchParams.get("state")!;
    expect(await consumeState(state)).toBe(userId);
    await expect(consumeState(state)).rejects.toBeInstanceOf(OAuthStateError);
    await expect(consumeState("forged-state")).rejects.toBeInstanceOf(OAuthStateError);
  });

  it("rejects expired states", async () => {
    const url = new URL(await createAuthorizationUrl(userId));
    await db.update(oauthStates).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(consumeState(url.searchParams.get("state")!)).rejects.toBeInstanceOf(OAuthStateError);
  });

  it("exchanges the code and stores tokens encrypted", async () => {
    const acc = await exchangeCodeAndStore(userId, "good-code");
    expect(acc.username).toBe("quotetester");
    const row = await db.query.pinterestAccounts.findFirst({ where: eq(pinterestAccounts.userId, userId) });
    expect(row!.encryptedAccessToken).not.toMatch(/access-/);
    expect((await getValidAccessToken(userId)).token).toMatch(/^access-\d+$/);
  });

  it("refreshes an expiring token and marks the account expired when refresh fails", async () => {
    await exchangeCodeAndStore(userId, "good-code");
    await db.update(pinterestAccounts).set({ tokenExpiresAt: new Date(Date.now() - 1000) });
    const before = fake.tokenCalls.length;
    const { token } = await getValidAccessToken(userId);
    expect(fake.tokenCalls.length).toBe(before + 1);
    expect(fake.tokenCalls.at(-1)!.grant_type).toBe("refresh_token");
    expect(fake.validTokens.has(token)).toBe(true);

    const { encrypt } = await import("../../src/utils/crypto");
    await db.update(pinterestAccounts).set({ tokenExpiresAt: new Date(Date.now() - 1000), encryptedRefreshToken: encrypt("revoked") });
    await expect(getValidAccessToken(userId)).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect((await db.query.pinterestAccounts.findFirst())!.connectionStatus).toBe("EXPIRED");
  });

  it("rejects a bad authorization code", async () => {
    await expect(exchangeCodeAndStore(userId, "bad-code")).rejects.toThrow(/400/);
  });
});

describe("Boards", () => {
  it("follows pagination and deactivates removed boards", async () => {
    await exchangeCodeAndStore(userId, "good-code");
    fake.boards = ["A", "B", "C", "D", "E"].map((n, i) => ({ id: `b${i}`, name: `Board ${n}` }));
    expect(await syncBoards(userId)).toHaveLength(5); // 3 pages of 2
    fake.boards = fake.boards.slice(0, 3);
    expect(await syncBoards(userId)).toHaveLength(3);
    expect(await listBoards(userId)).toHaveLength(3);
  });
});

describe("Pins API client", () => {
  const input = { accessToken: "access-1", boardExternalId: "b0", title: "T", description: "D", altText: "A", imageUrl: "https://img.example.com/x.jpg" };
  beforeEach(() => {
    fake.boards = [{ id: "b0", name: "Board" }];
  });

  it("creates a pin and returns its URL", async () => {
    const p = await createPin(input);
    expect(p.url).toBe(`https://www.pinterest.com/pin/${p.id}/`);
  });

  it("surfaces rate limits as retryable errors with retry-after", async () => {
    fake.pinBehaviors = ["429"];
    const e = await createPin(input).catch((x) => x);
    expect(e).toBeInstanceOf(PinterestApiError);
    expect(e.isRetryable).toBe(true);
    expect(e.retryAfterSec).toBe(1);
  });

  it("treats a timeout or 500 on create as an UNKNOWN outcome (never blindly retried)", async () => {
    fake.pinBehaviors = ["hang"];
    await expect(createPin(input)).rejects.toBeInstanceOf(PinterestUnknownOutcomeError);
    fake.pinBehaviors = ["500"];
    await expect(createPin(input)).rejects.toBeInstanceOf(PinterestUnknownOutcomeError);
  });

  it("validation errors are permanent", async () => {
    fake.pinBehaviors = ["400"];
    const e = await createPin(input).catch((x) => x);
    expect(e).toBeInstanceOf(PinterestApiError);
    expect(e.isRetryable).toBe(false);
  });

  it("finds a pin created despite a lost response", async () => {
    const since = new Date();
    fake.pinBehaviors = ["ok-then-hang"];
    await expect(createPin(input)).rejects.toBeInstanceOf(PinterestUnknownOutcomeError);
    const found = await findMatchingRecentPin("access-1", "b0", { title: "T", description: "D", since });
    expect(found?.id).toBeTruthy();
  });
});
