import type { Composer } from "grammy";
import { env } from "../../config/env";
import type { PendingAction } from "../../db/schema";
import { PINTEREST_LIMITS } from "../../modules/ai/schemas";
import { changeDraft, getOwnedDraft } from "../../modules/batches/draft.service";
import { validateCount } from "../../modules/batches/batch.service";
import { rescheduleBatch } from "../../modules/scheduling/schedule.service";
import { setPendingAction, setTimezone, updateSettings } from "../../modules/users/user.service";
import { escapeHtml } from "../../utils/text";
import { formatLocal, isValidTimezone, parseUserDateTime } from "../../utils/time";
import type { BotContext } from "../context";
import { askStyle, enqueueRegeneration, showScheduleReview, startGeneration } from "../flows";
import { IMAGE_STYLES, IMAGE_STYLE_KEYS } from "../../modules/images/styles";
import { countKeyboard, newBatchStyleKeyboard } from "../keyboards";
import { sendDraftCard } from "../presenters";
import { showSettings } from "./settings";

/** "7 sad relationship quotes" → {count: 7, topic: "sad relationship quotes"}; "Heartbroken" → {count: null, topic}. */
export function parseNaturalRequest(text: string): { count: number | null; topic: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const lead = t.match(/^(\d{1,2})\s*(?:x\s*)?(?:pins?\s*(?:about|for|on)?\s*)?(.+)$/i);
  if (lead) return { count: Number(lead[1]), topic: tidyTopic(lead[2]!) };
  const inner = t.match(/^(.*?)\b(\d{1,2})\s*(?:pins?|quotes?)\b\s*(.*)$/i);
  if (inner && (inner[1]!.trim() || inner[3]!.trim())) return { count: Number(inner[2]), topic: tidyTopic(`${inner[1]} ${inner[3]}`) || t };
  return { count: null, topic: t };
}

function tidyTopic(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please\s+)?(make|create|generate|give me|write|need)\s+/i, "")
    .replace(/^(about|on|for)\s+/i, "")
    .trim();
}

const isUrl = (s: string) => {
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && s.length <= PINTEREST_LIMITS.link;
  } catch {
    return false;
  }
};

async function handlePending(ctx: BotContext, pending: PendingAction, text: string): Promise<void> {
  const uid = ctx.user.id;
  switch (pending.kind) {
    case "choose_count": {
      const n = Number(text);
      if (!Number.isInteger(n)) {
        await ctx.reply("Please choose how many pins:", { reply_markup: countKeyboard() });
        return;
      }
      validateCount(n);
      await setPendingAction(uid, null);
      return askStyle(ctx, pending.topic, n);
    }
    case "choose_style": {
      const t = text.trim().toLowerCase();
      const idx = Number(t);
      const byName = IMAGE_STYLE_KEYS.find((k) => k === t.replace(/\s+/g, "_") || IMAGE_STYLES[k].label.toLowerCase() === t);
      const style = t === "auto" ? "auto" : byName ?? (Number.isInteger(idx) && idx >= 1 && idx <= IMAGE_STYLE_KEYS.length ? IMAGE_STYLE_KEYS[idx - 1]! : null);
      if (!style) {
        await ctx.reply("Please tap a style button (or /cancel):", { reply_markup: newBatchStyleKeyboard() });
        return;
      }
      await setPendingAction(uid, null);
      return startGeneration(ctx, pending.topic, pending.count, style);
    }
    case "edit_quote": {
      // The user's quote is preserved exactly (punctuation, quotes, emphasis) — only whitespace is normalised.
      const q = text.replace(/\s+/g, " ").trim();
      if (q.length < 3 || q.length > 300) {
        await ctx.reply("A quote must be 3–300 characters. Send it again, or /cancel.");
        return;
      }
      await setPendingAction(uid, null);
      const d = await changeDraft(uid, pending.draftId, pending.version, { quote: q }, { status: "GENERATING", action: "draft.edit_quote" });
      await enqueueRegeneration(d, "render");
      await ctx.reply("⏳ Re-rendering the image with your quote (same background). Tip: use Regenerate → Refresh SEO text if the title/description should change too.");
      return;
    }
    case "edit_title":
    case "edit_description": {
      const max = pending.kind === "edit_title" ? PINTEREST_LIMITS.title : PINTEREST_LIMITS.description;
      if (text.length < 3 || text.length > max) {
        await ctx.reply(`Must be 3–${max} characters (yours: ${text.length}). Send it again, or /cancel.`);
        return;
      }
      await setPendingAction(uid, null);
      const change = pending.kind === "edit_title" ? { title: text } : { description: text };
      const d = await changeDraft(uid, pending.draftId, pending.version, change, { action: `draft.${pending.kind}` });
      await sendDraftCard(ctx.api, ctx.chat!.id, d, "✏️ Updated — approval reset, please re-approve");
      return;
    }
    case "edit_link": {
      const none = /^(none|remove|-)$/i.test(text);
      if (!none && !isUrl(text)) {
        await ctx.reply("That doesn't look like a valid http(s) URL. Send it again, `none`, or /cancel.");
        return;
      }
      await setPendingAction(uid, null);
      const d = await changeDraft(uid, pending.draftId, pending.version, { link: none ? null : text }, { action: "draft.edit_link" });
      await sendDraftCard(ctx.api, ctx.chat!.id, d, "🔗 Link updated — please re-approve");
      return;
    }
    case "schedule_start": {
      const at = parseUserDateTime(text, ctx.user.timezone);
      if (!at) {
        await ctx.reply("I couldn't read that time. Try `2026-10-20 10:00`, `tomorrow 9:30`, `18:00` or `in 2h`.");
        return;
      }
      if (at.getTime() < Date.now() - 60_000) {
        await ctx.reply("That time is in the past. Send a future time.");
        return;
      }
      await setPendingAction(uid, null);
      return showScheduleReview(ctx, pending.batchId, at, pending.intervalMinutes);
    }
    case "reschedule_start": {
      const at = parseUserDateTime(text, ctx.user.timezone);
      if (!at) {
        await ctx.reply("I couldn't read that time. Try `tomorrow 10:00` or `2026-10-20 18:00`.");
        return;
      }
      await setPendingAction(uid, null);
      const rows = await rescheduleBatch(uid, pending.batchId, at);
      await ctx.reply(`🕒 Rescheduled ${rows.length} pin(s). First: ${formatLocal(rows[0]!.scheduledAt, rows[0]!.timezone)}. See /queue.`);
      return;
    }
    case "setting_text": {
      const v = text.trim();
      if (pending.key === "timezone") {
        if (!isValidTimezone(v)) {
          await ctx.reply("Unknown timezone. Use an IANA name like Asia/Dhaka.");
          return;
        }
        await setTimezone(uid, v);
        ctx.user.timezone = v;
      } else if (pending.key === "defaultLink") {
        const none = /^(none|remove|-)$/i.test(v);
        if (!none && !isUrl(v)) {
          await ctx.reply("Invalid URL. Send https://… or none.");
          return;
        }
        await updateSettings(uid, { defaultLink: none ? null : v });
      } else if (pending.key === "defaultLanguage") {
        await updateSettings(uid, { defaultLanguage: v.slice(0, 40) });
      } else if (pending.key === "tone") {
        await updateSettings(uid, { tone: v.slice(0, 80) });
      }
      await setPendingAction(uid, null);
      return showSettings(ctx);
    }
  }
}

export function registerText(bot: Composer<BotContext>) {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      await ctx.reply("Unknown command. See /help.");
      return;
    }
    const pending = ctx.user.pendingAction;
    if (pending) {
      // Make sure the referenced draft still belongs to the user before acting.
      if ("draftId" in pending) await getOwnedDraft(ctx.user.id, pending.draftId);
      return handlePending(ctx, pending, text);
    }
    const { count, topic } = parseNaturalRequest(text);
    if (count !== null) {
      if (count < 1 || count > env.MAX_BATCH_SIZE) {
        await ctx.reply(`I can create 1–${env.MAX_BATCH_SIZE} pins per batch.`);
        return;
      }
      return askStyle(ctx, topic, count);
    }
    if (topic.length > 200) {
      await ctx.reply("That's a bit long for a topic — please send a few keywords (max 200 characters).");
      return;
    }
    await setPendingAction(ctx.user.id, { kind: "choose_count", topic });
    await ctx.reply(`How many Pins should I create for “${escapeHtml(topic)}”?`, { parse_mode: "HTML", reply_markup: countKeyboard() });
  });
}
