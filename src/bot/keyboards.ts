import { InlineKeyboard } from "grammy";
import type { PinBatch, PinDraft, PinterestBoard } from "../db/schema";
import { IMAGE_STYLES, IMAGE_STYLE_KEYS, TYPOGRAPHY_KEYS, TYPOGRAPHY_PRESETS } from "../modules/images/styles";
import { cb } from "./callbacks";

export const BOARDS_PER_PAGE = 8;
export const INTERVAL_CHOICES = [60, 120, 180, 360, 720, 1440];

export function batchSummaryKeyboard(b: PinBatch) {
  const kb = new InlineKeyboard()
    .text("👀 Preview Pins", cb("bp", b.id))
    .text("✏️ Edit Pins", cb("be", b.id))
    .row()
    .text("🤖 Auto Assign Boards", cb("bba", b.id))
    .text("🧩 Unique Boards", cb("bbu", b.id))
    .row()
    .text("📌 Manual Board Selection", cb("bbm", b.id))
    .row()
    .text("✅ Approve All", cb("baa", b.id))
    .text("🗓 Approve & Schedule", cb("bs", b.id))
    .row()
    .text("🗑 Cancel Batch", cb("bc", b.id));
  return kb;
}

export function draftKeyboard(d: PinDraft, publicImageUrl?: string | null) {
  const v = d.version;
  const kb = new InlineKeyboard();
  if (["READY_FOR_REVIEW", "NEEDS_EDIT", "APPROVED", "FAILED"].includes(d.status)) {
    kb.text("✏️ Edit Quote", cb("eq", d.id, v)).text("✏️ Edit Title", cb("et", d.id, v)).row();
    kb.text("✏️ Edit Description", cb("ed", d.id, v)).text("🔗 Edit Link", cb("el", d.id, v)).row();
    kb.text("🔁 Regenerate", cb("rg", d.id, v)).text("📌 Change Board", cb("cb", d.id, v, 0)).row();
    if (d.status !== "APPROVED") kb.text("✅ Approve Pin", cb("ap", d.id, v));
    kb.text("❌ Reject Pin", cb("rj", d.id, v)).row();
  }
  if (publicImageUrl?.startsWith("https://")) kb.url("🖼 Open Full Image", publicImageUrl).row();
  kb.text("⬅️ Batch", cb("bsum", d.batchId));
  return kb;
}

export function regenerateKeyboard(d: PinDraft) {
  const v = d.version;
  return new InlineKeyboard()
    .text("🖼 Background only", cb("rgb", d.id, v))
    .text("🎨 Change style", cb("rgs", d.id, v))
    .row()
    .text("🔤 Typography", cb("rgt", d.id, v))
    .text("📝 Rewrite quote", cb("rgq", d.id, v))
    .row()
    .text("🔍 Refresh SEO text", cb("rgo", d.id, v))
    .text("♻️ Everything", cb("rga", d.id, v))
    .row()
    .text("⬅️ Back", cb("pv", d.id));
}

export function styleKeyboard(d: PinDraft) {
  const kb = new InlineKeyboard();
  IMAGE_STYLE_KEYS.forEach((k, i) => {
    kb.text(`${d.imageStyle === k ? "• " : ""}${IMAGE_STYLES[k].label}`, cb("rss", d.id, d.version, i));
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text("⬅️ Back", cb("rg", d.id, d.version));
}

export function typographyKeyboard(d: PinDraft) {
  const kb = new InlineKeyboard();
  TYPOGRAPHY_KEYS.forEach((k, i) => {
    kb.text(`${d.typography === k ? "• " : ""}${TYPOGRAPHY_PRESETS[k].label}`, cb("rst", d.id, d.version, i));
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text("⬅️ Back", cb("rg", d.id, d.version));
}

/** Paginated board picker. `select`/`page` are the callback actions to use (per-pin vs. sequential manual flow). */
export function boardPickerKeyboard(d: PinDraft, boards: PinterestBoard[], page: number, actions: { select: string; page: string }) {
  const pages = Math.max(1, Math.ceil(boards.length / BOARDS_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const kb = new InlineKeyboard();
  boards.slice(p * BOARDS_PER_PAGE, (p + 1) * BOARDS_PER_PAGE).forEach((b) => {
    const mark = d.selectedBoardId === b.id ? "✓ " : "";
    kb.text(`${mark}${b.name}`.slice(0, 60), cb(actions.select, d.id, d.version, b.id)).row();
  });
  if (pages > 1) {
    if (p > 0) kb.text("◀️ Prev", cb(actions.page, d.id, d.version, p - 1));
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("Next ▶️", cb(actions.page, d.id, d.version, p + 1));
    kb.row();
  }
  kb.text("⬅️ Back", cb("pv", d.id));
  return kb;
}

export function batchEditListKeyboard(b: PinBatch, drafts: PinDraft[]) {
  const kb = new InlineKeyboard();
  drafts.forEach((d, i) => {
    kb.text(`Pin ${d.position}${d.status === "CANCELLED" ? " ✖" : d.status === "APPROVED" ? " ✅" : ""}`, cb("pv", d.id));
    if (i % 3 === 2) kb.row();
  });
  return kb.row().text("⬅️ Batch", cb("bsum", b.id));
}

export function publishOptionsKeyboard(b: PinBatch) {
  return new InlineKeyboard()
    .text("🚀 Publish Now", cb("sn", b.id))
    .row()
    .text("⏰ Schedule Hourly", cb("si", b.id, 60))
    .text("🛠 Custom Schedule", cb("sc", b.id))
    .row()
    .text("⬅️ Batch", cb("bsum", b.id));
}

export function intervalKeyboard(b: PinBatch) {
  const kb = new InlineKeyboard();
  INTERVAL_CHOICES.forEach((m, i) => {
    kb.text(m % 60 === 0 ? `Every ${m / 60}h` : `${m} min`, cb("si", b.id, m));
    if (i % 3 === 2) kb.row();
  });
  return kb.row().text("⬅️ Back", cb("bs", b.id));
}

export function startTimeKeyboard(b: PinBatch, intervalMinutes: number) {
  return new InlineKeyboard()
    .text("Start now", cb("st", b.id, intervalMinutes, "now"))
    .text("In 1 hour", cb("st", b.id, intervalMinutes, "1h"))
    .row()
    .text("Tomorrow 10:00", cb("st", b.id, intervalMinutes, "t10"))
    .text("Tomorrow 20:00", cb("st", b.id, intervalMinutes, "t20"))
    .row()
    .text("⌨️ Type a date/time", cb("st", b.id, intervalMinutes, "type"))
    .row()
    .text("⬅️ Back", cb("bs", b.id));
}

export function scheduleConfirmKeyboard(b: PinBatch) {
  return new InlineKeyboard()
    .text("✅ Confirm Schedule", cb("sok", b.id))
    .row()
    .text("🕒 Change Time", cb("si", b.id, b.schedulePlan?.intervalMinutes ?? 60))
    .text("⏱ Change Interval", cb("sc", b.id))
    .row()
    .text("📌 Change Boards", cb("be", b.id))
    .text("✖️ Cancel", cb("sx", b.id));
}

export function queueBatchKeyboard(batchId: string, paused: boolean) {
  const kb = new InlineKeyboard();
  if (paused) kb.text("▶️ Resume", cb("qr", batchId));
  else kb.text("⏸ Pause", cb("qp", batchId));
  return kb.text("🕒 Reschedule", cb("rsc", batchId)).text("🗑 Cancel", cb("qx", batchId));
}

export function countKeyboard() {
  return new InlineKeyboard().text("1", cb("cnt", 1)).text("3", cb("cnt", 3)).text("5", cb("cnt", 5)).text("7", cb("cnt", 7));
}

export function confirmKeyboard(yesAction: string, id: string, noAction = "noop") {
  return new InlineKeyboard().text("Yes, confirm", cb(yesAction, id)).text("No", noAction === "noop" ? "noop" : cb(noAction, id));
}
