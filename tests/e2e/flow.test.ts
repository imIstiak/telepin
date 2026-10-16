/**
 * End-to-end: Telegram update → generation workers → previews → board assignment → approval →
 * schedule → publishing worker → confirmation, against real PostgreSQL + Redis/BullMQ, with mocked
 * AI providers, a fake Telegram API and a fake Pinterest API.
 */
import { asc, eq } from "drizzle-orm";
import type { Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/config/database";
import { createRedisConnection } from "../../src/config/redis";
import { imageAssets, pinBatches, pinDrafts, pinSchedules, publishJobs, users } from "../../src/db/schema";
import { exchangeCodeAndStore } from "../../src/modules/pinterest/oauth.service";
import { publishSchedule, reconcileUnknown, RECONCILE_MAX_ATTEMPTS } from "../../src/modules/publishing/publishing.service";
import { reconcileSchedules } from "../../src/modules/scheduling/reconciliation.service";
import { getQueues, publishJobId } from "../../src/queues";
import { startWorkers } from "../../src/workers";
import { setupDb } from "../helpers/db";
import { startFakePinterest, type FakePinterest } from "../helpers/fake-pinterest";
import { createTestBot } from "../helpers/telegram";

let fake: FakePinterest;
let workers: Worker[];
let tg: ReturnType<typeof createTestBot>;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 25_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const draftsOf = (batchId: string) => db.select().from(pinDrafts).where(eq(pinDrafts.batchId, batchId)).orderBy(asc(pinDrafts.position));
const schedulesOf = (batchId: string) => db.select().from(pinSchedules).where(eq(pinSchedules.batchId, batchId)).orderBy(asc(pinSchedules.scheduledAt));

beforeAll(async () => {
  const r = createRedisConnection();
  await r.flushdb();
  await r.quit();
  await setupDb();
  fake = await startFakePinterest();
  fake.boards = [
    { id: "900", name: "Heartbreak Quotes", description: "sad heartbreak quotes" },
    { id: "901", name: "Healing & Moving On", description: "healing after heartbreak" },
    { id: "902", name: "Betrayal and Broken Trust", description: "betrayal quotes" },
    { id: "903", name: "Dinner Recipes" },
  ];
  tg = createTestBot();
  workers = startWorkers();
});

afterAll(async () => {
  await Promise.allSettled(workers.map((w) => w.close()));
  await fake.close();
});

describe("full Telegram → Pinterest flow", () => {
  let batchId: string;

  it("rejects unauthorized Telegram users", async () => {
    await tg.send("heartbreak", 222);
    expect(tg.lastText()).toContain("not authorized");
    expect(tg.lastText()).toContain("222");
  });

  it("connects Pinterest for the authorized user", async () => {
    await tg.send("/start");
    const u = await db.query.users.findFirst({ where: eq(users.telegramUserId, "111") });
    expect(u?.isAuthorized).toBe(true);
    await exchangeCodeAndStore(u!.id, "good-code");
    await tg.send("/boards");
    expect(tg.lastText()).toContain("4 boards");
  });

  it("generates a 3-pin batch from natural language, previews it and auto-assigns boards", async () => {
    await tg.send("3 heartbreak, betrayal and healing");
    // Style is chosen before anything is generated.
    expect(tg.lastText()).toContain("Choose a style");
    expect(await db.select().from(pinBatches)).toHaveLength(0);
    await tg.click(tg.button("Auto"));
    expect(tg.lastText()).toContain("Generating 3 Pinterest quote Pins");
    const batch = await waitFor(async () => {
      const [b] = await db.select().from(pinBatches).orderBy(asc(pinBatches.createdAt));
      return b?.readyNotifiedAt ? b : null;
    });
    batchId = batch.id;
    // Wait for the notifier (album + summary) to finish after the flag was set.
    await waitFor(async () => tg.texts().some((t) => t.includes("Pinterest Pins are ready")));
    const drafts = await draftsOf(batchId);
    expect(drafts.every((d) => d.status === "READY_FOR_REVIEW" && d.selectedImageId && d.quote)).toBe(true);
    expect(new Set(drafts.map((d) => d.quote)).size).toBe(3);
    expect(tg.calls.some((c) => c.method === "sendMediaGroup")).toBe(true);
    // Default mode AUTO assigned real (synced) boards, never invented ones.
    expect(drafts.every((d) => d.selectedBoardId)).toBe(true);
  });

  it("rejects stale buttons (version mismatch)", async () => {
    const [d] = await draftsOf(batchId);
    await tg.click(`ap:${Buffer.from(d!.id.replace(/-/g, ""), "hex").toString("base64url")}:${d!.version - 1}`);
    expect(tg.lastText()).toContain("out of date");
    expect((await draftsOf(batchId))[0]!.status).toBe("READY_FOR_REVIEW");
  });

  it("edits a title, which bumps the version", async () => {
    const [d] = await draftsOf(batchId);
    await tg.click("pv:" + Buffer.from(d!.id.replace(/-/g, ""), "hex").toString("base64url"));
    await tg.click(tg.button("Edit Title"));
    await tg.send("My Edited Pinterest Title");
    const after = (await draftsOf(batchId))[0]!;
    expect(after.title).toBe("My Edited Pinterest Title");
    expect(after.version).toBe(d!.version + 1);
  });

  it("regenerates only the background of one pin", async () => {
    const [, d] = await draftsOf(batchId);
    await tg.click("pv:" + Buffer.from(d!.id.replace(/-/g, ""), "hex").toString("base64url"));
    await tg.click(tg.button("Regenerate"));
    await tg.click(tg.button("Background only"));
    const after = await waitFor(async () => {
      const x = (await draftsOf(batchId))[1]!;
      return x.status === "READY_FOR_REVIEW" && x.version === d!.version + 1 ? x : null;
    });
    expect(after.quote).toBe(d!.quote); // unchanged content not regenerated
    expect(after.backgroundImageId).not.toBe(d!.backgroundImageId);
    expect(after.selectedImageId).not.toBe(d!.selectedImageId);
  });

  it("approves all, shows a final review and only schedules after confirmation", async () => {
    await tg.click(tg.button("Approve All"));
    expect((await draftsOf(batchId)).every((d) => d.status === "APPROVED")).toBe(true);
    await tg.click(tg.button("Approve & Schedule"));
    await tg.click(tg.button("Schedule Hourly"));
    await tg.click(tg.button("Start now"));
    expect(tg.lastText()).toContain("Final review");
    expect(tg.lastText()).toContain("every 1 hour");
    expect(await schedulesOf(batchId)).toHaveLength(0); // nothing scheduled yet
    const confirm = tg.button("Confirm Schedule");
    await tg.click(confirm);
    expect(tg.lastText()).toContain("scheduled successfully");
    const s = await schedulesOf(batchId);
    expect(s).toHaveLength(3);
    expect(s[1]!.scheduledAt.getTime() - s[0]!.scheduledAt.getTime()).toBe(60 * 60_000);
    // Double-tapping Confirm must not create duplicate schedules.
    await tg.click(confirm);
    expect(tg.lastText()).toContain("already confirmed");
    expect(await schedulesOf(batchId)).toHaveLength(3);
  });

  it("publishes the first pin and sends a confirmation with the Pin URL", async () => {
    const job = await waitFor(async () => {
      const [s] = await schedulesOf(batchId);
      const j = await db.query.publishJobs.findFirst({ where: eq(publishJobs.scheduleId, s!.id) });
      return j?.status === "SUCCEEDED" ? j : null;
    });
    expect(job.pinterestPinUrl).toMatch(/^https:\/\/www\.pinterest\.com\/pin\/\d+\/$/);
    expect(fake.pins).toHaveLength(1);
    expect(fake.pins[0]!.media_source.url).toMatch(/^https:\/\//);
    await waitFor(async () => tg.texts().some((t) => t.includes("Published Successfully")));
  });

  it("never publishes the same schedule twice", async () => {
    const [s] = await schedulesOf(batchId);
    const calls = fake.pinCalls;
    const results = await Promise.all([publishSchedule(s!.id, s!.revision), publishSchedule(s!.id, s!.revision)]);
    expect(results).toEqual(["skipped", "skipped"]);
    expect(fake.pinCalls).toBe(calls);
  });

  it("blocks editing a scheduled pin", async () => {
    const d = (await draftsOf(batchId))[1]!;
    expect(d.status).toBe("SCHEDULED");
    await tg.click("eq:" + Buffer.from(d.id.replace(/-/g, ""), "hex").toString("base64url") + ":" + d.version);
    await tg.send("A sneaky new quote after approval");
    expect(tg.lastText()).toContain("scheduled");
    expect((await draftsOf(batchId))[1]!.quote).toBe(d.quote);
  });

  it("pauses and resumes publishing", async () => {
    await tg.send("/cancel");
    await tg.send("/pause");
    expect(tg.lastText()).toContain("Paused 2");
    const paused = await schedulesOf(batchId);
    expect(paused.filter((s) => s.status === "PAUSED")).toHaveLength(2);
    expect(await getQueues().publish.getJob(publishJobId(paused[1]!.id, paused[1]!.revision))).toBeFalsy();
    await tg.send("/resume");
    expect(tg.lastText()).toContain("Resumed 2");
    const resumed = await schedulesOf(batchId);
    for (const s of resumed.filter((x) => x.status === "SCHEDULED")) {
      const j = await getQueues().publish.getJob(publishJobId(s.id, s.revision));
      expect(await j?.getState()).toBe("delayed");
    }
  });

  it("recovers lost BullMQ jobs from PostgreSQL after a restart", async () => {
    await getQueues().publish.drain(true);
    const stats = await reconcileSchedules();
    expect(stats.enqueued).toBe(2);
  });

  it("shifts missed schedules instead of publishing a backlog burst", async () => {
    const pending = (await schedulesOf(batchId)).filter((s) => s.status === "SCHEDULED");
    for (const s of pending) await db.update(pinSchedules).set({ scheduledAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(pinSchedules.id, s.id));
    const calls = fake.pinCalls;
    await reconcileSchedules();
    const after = (await schedulesOf(batchId)).filter((s) => s.status === "SCHEDULED");
    expect(after).toHaveLength(2);
    expect(after[0]!.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(after[1]!.scheduledAt.getTime() - after[0]!.scheduledAt.getTime()).toBe(60 * 60_000);
    expect(fake.pinCalls).toBe(calls);
    expect(tg.texts().some((t) => t.includes("missed"))).toBe(true);
  });

  it("reconciles an unknown outcome and does not create a duplicate when the pin exists", async () => {
    await workers.find((w) => w.name === "pinterest-publishing")!.close(); // drive publishing manually from here
    const s = (await schedulesOf(batchId)).find((x) => x.status === "SCHEDULED")!;
    await db.update(pinSchedules).set({ scheduledAt: new Date() }).where(eq(pinSchedules.id, s.id));
    fake.pinBehaviors = ["ok-then-hang"];
    expect(await publishSchedule(s.id, s.revision)).toBe("unknown");
    const j = await db.query.publishJobs.findFirst({ where: eq(publishJobs.scheduleId, s.id) });
    expect(j!.status).toBe("UNKNOWN");
    const pinsBefore = fake.pins.length;
    expect(await reconcileUnknown(j!.id)).toBe("found");
    expect((await db.query.publishJobs.findFirst({ where: eq(publishJobs.id, j!.id) }))!.status).toBe("SUCCEEDED");
    expect(fake.pins.length).toBe(pinsBefore);
  });

  it("retries only after reconciliation proves the pin wasn't created", async () => {
    const s = (await schedulesOf(batchId)).find((x) => x.status === "SCHEDULED")!;
    await db.update(pinSchedules).set({ scheduledAt: new Date() }).where(eq(pinSchedules.id, s.id));
    fake.pinBehaviors = ["hang"];
    expect(await publishSchedule(s.id, s.revision)).toBe("unknown");
    const j = (await db.query.publishJobs.findFirst({ where: eq(publishJobs.scheduleId, s.id) }))!;
    const results: string[] = [];
    for (let i = 0; i < RECONCILE_MAX_ATTEMPTS; i++) results.push(await reconcileUnknown(j.id));
    expect(results.at(-1)).toBe("retry_scheduled");
    const s2 = (await db.query.pinSchedules.findFirst({ where: eq(pinSchedules.id, s.id) }))!;
    expect(s2.status).toBe("SCHEDULED");
    await db.update(pinSchedules).set({ scheduledAt: new Date() }).where(eq(pinSchedules.id, s.id));
    fake.pinBehaviors = ["ok"];
    expect(await publishSchedule(s.id, s2.revision)).toBe("published");
    const b = await db.query.pinBatches.findFirst({ where: eq(pinBatches.id, batchId) });
    expect(b!.status).toBe("COMPLETED");
    await waitFor(async () => tg.texts().some((t) => t.includes("is complete")));
  });

  it("shows history with Pin URLs", async () => {
    await tg.send("/history");
    expect(tg.lastText()).toContain("Published pins");
    expect(tg.lastText()).toContain("pinterest.com/pin/");
  });

  it("uses the manually selected style for every pin and renders without branding", async () => {
    await tg.send("/create self respect and boundaries");
    await tg.click(tg.button("Minimal Typography"));
    const batch = await waitFor(async () => {
      const rows = await db.select().from(pinBatches).orderBy(asc(pinBatches.createdAt));
      const b = rows.at(-1);
      return b && b.id !== batchId && b.readyNotifiedAt ? b : null;
    });
    expect(batch.imageStyle).toBe("minimal_typography");
    const [d] = await draftsOf(batch.id);
    expect(d!.imageStyle).toBe("minimal_typography");
    const img = await db.query.imageAssets.findFirst({ where: eq(imageAssets.id, d!.selectedImageId!) });
    expect(img!.styleVersion).toBe(2);
    expect((img!.qa as { noBranding: boolean }).noBranding).toBe(true);
  });
});
