import { InlineKeyboard } from "grammy";
import { env } from "../../config/env";
import type { UserSettings } from "../../db/schema";
import { getOwnedBoard, listBoards } from "../../modules/pinterest/boards.service";
import { IMAGE_STYLES, IMAGE_STYLE_KEYS, TYPOGRAPHY_KEYS, TYPOGRAPHY_PRESETS, isImageStyle, isTypographyPreset } from "../../modules/images/styles";
import { getSettings, setPendingAction, updateSettings } from "../../modules/users/user.service";
import { escapeHtml } from "../../utils/text";
import { cb, type ParsedCallback } from "../callbacks";
import type { BotContext } from "../context";
import { INTERVAL_CHOICES } from "../keyboards";

const cycle = <T>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length]!;

const STYLE_CYCLE = ["auto", ...IMAGE_STYLE_KEYS] as const;
const LENGTHS = ["short", "medium", "long"] as const;
const QUALITIES = [90, 91, 92] as const;
const TYPO_CYCLE = ["style", ...TYPOGRAPHY_KEYS] as const;
const SIZES = [1, 3, 5, 7] as const;
const MODES = ["AUTO", "MANUAL", "UNIQUE"] as const;

function settingsText(s: UserSettings, tz: string, preferredBoard?: string | null) {
  const style = s.defaultImageStyle === "auto" ? "Auto (AI picks)" : isImageStyle(s.defaultImageStyle) ? IMAGE_STYLES[s.defaultImageStyle].label : s.defaultImageStyle;
  // (the default is pre-marked in the style picker shown before every new batch)
  const typo = isTypographyPreset(s.typographyPreset) ? TYPOGRAPHY_PRESETS[s.typographyPreset].label : "Matches each style";
  return [
    "⚙️ <b>Settings</b> (tap to change)",
    "",
    "<b>Image</b>",
    `Default style: ${escapeHtml(style)} · Typography: ${escapeHtml(typo)}`,
    `Quote length: ${s.quoteLength} · JPEG quality: ${s.imageQuality}`,
    "Clean pins: no logo, watermark or footer — only your quote.",
    "",
    "<b>AI</b>",
    `Language: ${escapeHtml(s.defaultLanguage)} · Tone: ${escapeHtml(s.tone)}`,
    `Text provider: ${env.AI_TEXT_PROVIDER} (${escapeHtml(env.AI_TEXT_MODEL)}) · Image provider: ${env.AI_IMAGE_PROVIDER} (${escapeHtml(env.AI_IMAGE_MODEL)})`,
    "<i>Providers and API keys are configured on the server, not via Telegram.</i>",
    "",
    "<b>Publishing</b>",
    `Default batch size: ${s.defaultBatchSize} · Interval: ${s.defaultIntervalMinutes} min · Timezone: ${escapeHtml(tz)}`,
    `Notifications: ${s.notificationsEnabled ? "on" : "off"} · Default link: ${escapeHtml(s.defaultLink ?? "none")}`,
    "",
    "<b>Boards</b>",
    `Assignment mode: ${s.defaultBoardAssignmentMode} · Preferred board: ${escapeHtml(preferredBoard ?? "none")}`,
  ].join("\n");
}

function settingsKeyboard() {
  return new InlineKeyboard()
    .text("🎨 Style", cb("set", "style"))
    .text("🔤 Typography", cb("set", "typo"))
    .text("📏 Length", cb("set", "len"))
    .row()
    .text("🖼 Quality", cb("set", "q"))
    .row()
    .text("🌐 Language", cb("set", "lang"))
    .text("🎭 Tone", cb("set", "tone"))
    .row()
    .text("🔢 Batch size", cb("set", "size"))
    .text("⏱ Interval", cb("set", "int"))
    .text("🕐 Timezone", cb("set", "tz"))
    .row()
    .text("📌 Board mode", cb("set", "mode"))
    .text("⭐ Preferred board", cb("set", "pb"))
    .row()
    .text("🔔 Notifications", cb("set", "notif"))
    .text("🔗 Default link", cb("set", "link"));
}

export async function showSettings(ctx: BotContext, edit = false) {
  const s = await getSettings(ctx.user.id);
  const pb = s.preferredBoardId ? (await getOwnedBoard(ctx.user.id, s.preferredBoardId))?.name : null;
  const text = settingsText(s, ctx.user.timezone, pb);
  if (edit) {
    try {
      return void (await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: settingsKeyboard() }));
    } catch {
      /* not modified or not editable */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: settingsKeyboard() });
}

export async function handleSettingsCallback(ctx: BotContext, p: ParsedCallback) {
  const s = await getSettings(ctx.user.id);
  const uid = ctx.user.id;
  if (p.action === "spb") {
    const boardId = p.args[0] === "none" ? null : p.id(0);
    if (boardId && !(await getOwnedBoard(uid, boardId))) return ctx.reply("That board isn't available.");
    await updateSettings(uid, { preferredBoardId: boardId });
    return showSettings(ctx, true);
  }
  const key = p.args[0];
  const ask = async (k: "timezone" | "defaultLink" | "defaultLanguage" | "tone", prompt: string) => {
    await setPendingAction(uid, { kind: "setting_text", key: k });
    await ctx.reply(prompt, { parse_mode: "HTML" });
  };
  switch (key) {
    case "style":
      await updateSettings(uid, { defaultImageStyle: cycle(STYLE_CYCLE as readonly string[], s.defaultImageStyle) });
      break;
    case "typo":
      await updateSettings(uid, { typographyPreset: cycle(TYPO_CYCLE as readonly string[], s.typographyPreset) });
      break;
    case "len":
      await updateSettings(uid, { quoteLength: cycle(LENGTHS as readonly string[], s.quoteLength) });
      break;
    case "q":
      await updateSettings(uid, { imageQuality: cycle(QUALITIES as readonly number[], s.imageQuality as 91) });
      break;
    case "notif":
      await updateSettings(uid, { notificationsEnabled: !s.notificationsEnabled });
      break;
    case "size":
      await updateSettings(uid, { defaultBatchSize: cycle(SIZES as readonly number[], s.defaultBatchSize as 1) });
      break;
    case "int":
      await updateSettings(uid, { defaultIntervalMinutes: cycle(INTERVAL_CHOICES, s.defaultIntervalMinutes) });
      break;
    case "mode":
      await updateSettings(uid, { defaultBoardAssignmentMode: cycle(MODES, s.defaultBoardAssignmentMode) });
      break;
    case "lang":
      return ask("defaultLanguage", "🌐 Send the language for quotes and SEO text, e.g. <code>English</code> or <code>Bangla</code>.");
    case "tone":
      return ask("tone", "🎭 Send the preferred emotional tone, e.g. <code>sad and reflective</code>, <code>hopeful</code>, <code>dark emotional</code>.");
    case "tz":
      return ask("timezone", "🕐 Send an IANA timezone, e.g. <code>Asia/Dhaka</code>, <code>America/New_York</code>.");
    case "link":
      return ask("defaultLink", "🔗 Send a default destination URL for new pins (https://…), or <code>none</code>.");
    case "pb": {
      const boards = await listBoards(uid);
      if (!boards.length) return ctx.reply("No boards yet — /connect and /boards first.");
      const kb = new InlineKeyboard().text("None", cb("spb", "none")).row();
      boards.slice(0, 30).forEach((b) => kb.text(b.name.slice(0, 40), cb("spb", b.id)).row());
      return ctx.reply("⭐ Preferred board (used only when no relevant board matches in Auto mode):", { reply_markup: kb });
    }
    default:
      return;
  }
  await showSettings(ctx, true);
}
