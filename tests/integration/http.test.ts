import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createAuthorizationUrl } from "../../src/modules/pinterest/oauth.service";
import { ensureUser } from "../../src/modules/users/user.service";
import { setupDb } from "../helpers/db";
import { startFakePinterest, type FakePinterest } from "../helpers/fake-pinterest";
import { createTestBot } from "../helpers/telegram";

let server: Server;
let base: string;
let fake: FakePinterest;
let tg: ReturnType<typeof createTestBot>;

beforeAll(async () => {
  await setupDb();
  fake = await startFakePinterest();
  tg = createTestBot();
  server = createApp(tg.bot).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await fake.close();
});

const update = (text: string) => ({
  update_id: Date.now(),
  message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 111, type: "private", first_name: "I" }, from: { id: 111, is_bot: false, first_name: "I" }, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined },
});

describe("HTTP endpoints", () => {
  it("health reports database and redis", async () => {
    const r = await fetch(`${base}/health`);
    const body = (await r.json()) as { checks: unknown };
    expect(r.status).toBe(200);
    expect(body.checks).toEqual({ db: true, redis: true });
  });

  it("rejects Telegram webhooks without the secret token", async () => {
    const r = await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update("/help")) });
    expect(r.status).toBe(401);
    const r2 = await fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
      body: JSON.stringify(update("/help")),
    });
    expect(r2.status).toBe(401);
  });

  it("accepts Telegram webhooks with the secret token", async () => {
    const before = tg.calls.length;
    const r = await fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify(update("/help")),
    });
    expect(r.status).toBe(200);
    expect(tg.calls.length).toBeGreaterThan(before);
    expect(tg.lastText()).toContain("Pinterest AI Quote Agent");
  });

  it("OAuth callback rejects forged state and completes a valid one", async () => {
    const bad = await fetch(`${base}/oauth/pinterest/callback?code=good-code&state=forged`);
    expect(bad.status).toBe(400);
    const u = await ensureUser({ id: 111 }, 111);
    const state = new URL(await createAuthorizationUrl(u.id)).searchParams.get("state")!;
    const ok = await fetch(`${base}/oauth/pinterest/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Pinterest connected");
    expect(tg.lastText()).toContain("Pinterest connected");
    // Replay of the same state is refused.
    const replay = await fetch(`${base}/oauth/pinterest/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(400);
  });
});
