import { describe, expect, it } from "vitest";
import { cb, longId, parseCallback, shortId } from "../../src/bot/callbacks";
import { parseNaturalRequest } from "../../src/bot/handlers/text";
import { decrypt, encrypt } from "../../src/utils/crypto";
import { clampText, cleanQuote, lexicalSimilarity } from "../../src/utils/text";
import { buildTimeline, formatLocal, parseUserDateTime } from "../../src/utils/time";
import { deriveBatchStatus, canTransitionDraft } from "../../src/modules/state/state-machine";
import { normalizeSeo } from "../../src/modules/ai/seo.service";

describe("text utils", () => {
  it("detects near-duplicate quotes but not different ones", () => {
    expect(lexicalSimilarity("You taught me that not every promise is meant to be kept.", "You taught me not every promise is meant to be kept")).toBeGreaterThan(0.55);
    expect(lexicalSimilarity("You taught me that not every promise is meant to be kept.", "Healing is not forgetting; it is remembering without bleeding.")).toBeLessThan(0.3);
  });
  it("cleans quote marks and fake attributions", () => {
    expect(cleanQuote('"Let it go." — Albert Einstein')).toBe("Let it go.");
    expect(cleanQuote("“Some wounds teach.”")).toBe("Some wounds teach.");
  });
  it("clamps at word boundaries", () => {
    const t = clampText("word ".repeat(50), 30);
    expect(t.length).toBeLessThanOrEqual(30);
    expect(t.endsWith("…")).toBe(true);
  });
  it("normalizes SEO to Pinterest limits and caps hashtags", () => {
    const s = normalizeSeo({ title: "T".repeat(150), description: "desc #a #b #c #d #e " + "x".repeat(900), keywords: ["A", "a", "#B"], alt_text: "y".repeat(600) });
    expect(s.title.length).toBeLessThanOrEqual(100);
    expect(s.description.length).toBeLessThanOrEqual(800);
    expect(s.alt_text.length).toBeLessThanOrEqual(500);
    expect((s.description.match(/#/g) ?? []).length).toBe(3);
    expect(s.keywords).toEqual(["a", "b"]);
  });
});

describe("callback payloads", () => {
  const id = "3f2b8c1e-9a4d-4c2e-8b7f-1a2b3c4d5e6f";
  it("round-trips UUIDs compactly", () => {
    expect(shortId(id)).toHaveLength(22);
    expect(longId(shortId(id))).toBe(id);
  });
  it("stays within Telegram's 64-byte limit", () => {
    expect(Buffer.byteLength(cb("cbs", id, 123, id))).toBeLessThanOrEqual(64);
  });
  it("rejects malformed payloads", () => {
    expect(parseCallback("DROP TABLE")).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
    expect(parseCallback("ap:notanid:1")!.id(0)).toBeNull();
    expect(parseCallback("ap:x:abc")!.int(1)).toBeNull();
  });
});

describe("natural language parsing", () => {
  it.each([
    ["7 sad relationship quotes", 7, "sad relationship quotes"],
    ["Heartbroken", null, "Heartbroken"],
    ["Broken trust, dark emotional", null, "Broken trust, dark emotional"],
    ["make 3 pins about healing", 3, "healing"],
    ["5 pins about self-love", 5, "self-love"],
  ])("%s", (input, count, topic) => {
    const r = parseNaturalRequest(input);
    expect(r.count).toBe(count);
    expect(r.topic).toBe(topic);
  });
});

describe("crypto", () => {
  it("encrypts and decrypts with AES-GCM and detects tampering", () => {
    const c = encrypt("secret-token");
    expect(c).not.toContain("secret-token");
    expect(decrypt(c)).toBe("secret-token");
    const parts = c.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
});

describe("time", () => {
  const now = new Date("2026-10-16T04:00:00Z"); // 10:00 in Dhaka
  it("parses times in the user's timezone and stores UTC", () => {
    expect(parseUserDateTime("2026-10-20 10:00", "Asia/Dhaka", now)!.toISOString()).toBe("2026-10-20T04:00:00.000Z");
    expect(parseUserDateTime("tomorrow 9:30", "Asia/Dhaka", now)!.toISOString()).toBe("2026-10-17T03:30:00.000Z");
    expect(parseUserDateTime("18:00", "Asia/Dhaka", now)!.toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(parseUserDateTime("9:00", "Asia/Dhaka", now)!.toISOString()).toBe("2026-10-17T03:00:00.000Z"); // past today → tomorrow
    expect(parseUserDateTime("in 2h", "Asia/Dhaka", now)!.toISOString()).toBe("2026-10-16T06:00:00.000Z");
    expect(parseUserDateTime("10pm", "America/New_York", now)!.toISOString()).toBe("2026-10-17T02:00:00.000Z");
    expect(parseUserDateTime("whenever", "Asia/Dhaka", now)).toBeNull();
  });
  it("builds hourly timelines", () => {
    const t = buildTimeline(new Date("2026-10-16T04:00:00Z"), 7, 60);
    expect(t.map((d) => formatLocal(d, "Asia/Dhaka", "HH:mm"))).toEqual(["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]);
  });
});

describe("state machine", () => {
  it("validates draft transitions", () => {
    expect(canTransitionDraft("APPROVED", "SCHEDULED")).toBe(true);
    expect(canTransitionDraft("PUBLISHED", "SCHEDULED")).toBe(false);
    expect(canTransitionDraft("READY_FOR_REVIEW", "PUBLISHING")).toBe(false);
  });
  it("derives batch status", () => {
    const d = (status: any, approvalStatus = "PENDING") => ({ status, approvalStatus });
    expect(deriveBatchStatus([d("GENERATING"), d("READY_FOR_REVIEW")], "GENERATING")).toBe("PARTIALLY_READY");
    expect(deriveBatchStatus([d("PUBLISHED"), d("SCHEDULED")], "SCHEDULED")).toBe("PARTIALLY_PUBLISHED");
    expect(deriveBatchStatus([d("PUBLISHED"), d("CANCELLED", "REJECTED")], "SCHEDULED")).toBe("COMPLETED");
    expect(deriveBatchStatus([d("APPROVED"), d("APPROVED")], "READY_FOR_REVIEW")).toBe("APPROVED");
  });
});
