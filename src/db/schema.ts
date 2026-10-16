import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------- Enums ----------
export const draftStatus = pgEnum("draft_status", [
  "CREATED",
  "GENERATING",
  "READY_FOR_REVIEW",
  "NEEDS_EDIT",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
  "PUBLISH_UNKNOWN",
]);
export const batchStatus = pgEnum("batch_status", [
  "CREATED",
  "GENERATING",
  "PARTIALLY_READY",
  "READY_FOR_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "PARTIALLY_PUBLISHED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);
export const approvalStatus = pgEnum("approval_status", ["PENDING", "APPROVED", "REJECTED"]);
export const boardAssignmentMode = pgEnum("board_assignment_mode", ["AUTO", "MANUAL", "UNIQUE"]);
export const connectionStatus = pgEnum("connection_status", ["CONNECTED", "EXPIRED", "REVOKED", "ERROR"]);
export const assetType = pgEnum("asset_type", ["BACKGROUND", "FINAL"]);
export const scheduleStatus = pgEnum("schedule_status", [
  "SCHEDULED",
  "PAUSED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
  "PUBLISH_UNKNOWN",
]);
export const publishJobStatus = pgEnum("publish_job_status", ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN", "CANCELLED"]);

// ---------- Tables ----------
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  telegramUserId: text("telegram_user_id").notNull().unique(),
  telegramChatId: text("telegram_chat_id"),
  telegramUsername: text("telegram_username"),
  isAuthorized: boolean("is_authorized").notNull().default(false),
  timezone: text("timezone").notNull().default("Asia/Dhaka"),
  preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
  /** Short-lived conversational state (e.g. "waiting for new quote text"). */
  pendingAction: jsonb("pending_action").$type<PendingAction | null>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PendingAction =
  | { kind: "choose_count"; topic: string }
  | { kind: "choose_style"; topic: string; count: number }
  | { kind: "edit_quote" | "edit_title" | "edit_description" | "edit_link"; draftId: string; version: number }
  | { kind: "schedule_start"; batchId: string; intervalMinutes: number }
  | { kind: "reschedule_start"; batchId: string }
  | { kind: "setting_text"; key: "timezone" | "watermarkText" | "defaultLink" | "defaultLanguage" | "tone" };

export const userSettings = pgTable("user_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultLanguage: text("default_language").notNull().default("English"),
  tone: text("tone").notNull().default("emotional"),
  quoteLength: text("quote_length").notNull().default("medium"),
  defaultImageStyle: text("default_image_style").notNull().default("auto"),
  /** "style" = use each style's own typography (V2 default); otherwise a fixed preset for every pin. */
  typographyPreset: text("typography_preset").notNull().default("style"),
  imageQuality: integer("image_quality").notNull().default(91),
  defaultBatchSize: integer("default_batch_size").notNull().default(5),
  defaultIntervalMinutes: integer("default_interval_minutes").notNull().default(60),
  defaultBoardAssignmentMode: boardAssignmentMode("default_board_assignment_mode").notNull().default("AUTO"),
  preferredBoardId: uuid("preferred_board_id"),
  watermarkEnabled: boolean("watermark_enabled").notNull().default(false),
  watermarkText: text("watermark_text"),
  defaultLink: text("default_link"),
  notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pinterestAccounts = pgTable("pinterest_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  pinterestUserId: text("pinterest_user_id"),
  username: text("username"),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  tokenExpiresAt: ts("token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scopes: text("scopes"),
  connectionStatus: connectionStatus("connection_status").notNull().default("CONNECTED"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pinterestBoards = pgTable(
  "pinterest_boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pinterestAccountId: uuid("pinterest_account_id")
      .notNull()
      .references(() => pinterestAccounts.id, { onDelete: "cascade" }),
    externalBoardId: text("external_board_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    privacy: text("privacy"),
    isActive: boolean("is_active").notNull().default(true),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("boards_account_external_uq").on(t.pinterestAccountId, t.externalBoardId)],
);

export const oauthStates = pgTable("oauth_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  nonceHash: text("nonce_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const pinBatches = pgTable(
  "pin_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: serial("number").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    originalTopic: text("original_topic").notNull(),
    requestedCount: integer("requested_count").notNull(),
    generatedCount: integer("generated_count").notNull().default(0),
    boardAssignmentMode: boardAssignmentMode("board_assignment_mode").notNull().default("AUTO"),
    /** Style chosen before generation: a style id, or "auto" (AI picks per pin). */
    imageStyle: text("image_style").notNull().default("auto"),
    status: batchStatus("status").notNull().default("CREATED"),
    /** Proposed (not yet confirmed) schedule shown to the user for final approval. */
    schedulePlan: jsonb("schedule_plan").$type<SchedulePlan | null>(),
    readyNotifiedAt: ts("ready_notified_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("batches_user_idx").on(t.userId, t.createdAt)],
);

export type SchedulePlan = {
  startAt: string; // ISO UTC
  intervalMinutes: number;
  timezone: string;
  /** draftId -> version at the time the plan was proposed */
  draftVersions: Record<string, number>;
  proposedAt: string;
};

export const pinDrafts = pgTable(
  "pin_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => pinBatches.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    topic: text("topic").notNull(),
    emotion: text("emotion"),
    quote: text("quote"),
    title: text("title"),
    description: text("description"),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    altText: text("alt_text"),
    link: text("link"),
    imageStyle: text("image_style"),
    typography: text("typography"),
    backgroundPrompt: text("background_prompt"),
    selectedBoardId: uuid("selected_board_id").references(() => pinterestBoards.id, { onDelete: "set null" }),
    boardReason: text("board_reason"),
    selectedImageId: uuid("selected_image_id"),
    backgroundImageId: uuid("background_image_id"),
    version: integer("version").notNull().default(1),
    status: draftStatus("status").notNull().default("CREATED"),
    approvalStatus: approvalStatus("approval_status").notNull().default("PENDING"),
    approvedVersion: integer("approved_version"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("drafts_batch_position_uq").on(t.batchId, t.position), index("drafts_user_idx").on(t.userId)],
);

export const imageAssets = pgTable(
  "image_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => pinDrafts.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull().unique(),
    publicUrl: text("public_url").notNull(),
    assetType: assetType("asset_type").notNull(),
    imageStyle: text("image_style"),
    generationPrompt: text("generation_prompt"),
    styleVersion: integer("style_version"),
    /** True when the AI image failed and a procedural style-palette gradient was used (never auto-approved). */
    isFallback: boolean("is_fallback").notNull().default(false),
    /** 64-bit dHash used to catch near-identical backgrounds within a batch. */
    phash: text("phash"),
    qa: jsonb("qa").$type<Record<string, unknown> | null>(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    mimeType: text("mime_type").notNull(),
    version: integer("version").notNull(),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("assets_draft_idx").on(t.draftId)],
);

export const pinSchedules = pgTable(
  "pin_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => pinDrafts.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => pinBatches.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => pinterestBoards.id),
    scheduledAt: ts("scheduled_at").notNull(),
    timezone: text("timezone").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    approvedVersion: integer("approved_version").notNull(),
    status: scheduleStatus("status").notNull().default("SCHEDULED"),
    /** Incremented whenever the trigger time changes so BullMQ job IDs stay unique. */
    revision: integer("revision").notNull().default(1),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("schedules_status_time_idx").on(t.status, t.scheduledAt),
    // At most one live schedule per draft.
    uniqueIndex("schedules_one_active_per_draft_uq")
      .on(t.draftId)
      .where(sql`status in ('SCHEDULED','PAUSED','PUBLISHING','PUBLISH_UNKNOWN')`),
  ],
);

export const publishJobs = pgTable(
  "publish_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => pinDrafts.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id")
      .notNull()
      .unique()
      .references(() => pinSchedules.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: publishJobStatus("status").notNull().default("QUEUED"),
    attemptCount: integer("attempt_count").notNull().default(0),
    attemptStartedAt: ts("attempt_started_at"),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    pinterestPinId: text("pinterest_pin_id"),
    pinterestPinUrl: text("pinterest_pin_url"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A draft can only ever have one successful publication.
    uniqueIndex("publish_jobs_one_success_per_draft_uq").on(t.draftId).where(sql`status = 'SUCCEEDED'`),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    draftId: uuid("draft_id"),
    batchId: uuid("batch_id"),
    action: text("action").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_user_idx").on(t.userId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type PinterestAccount = typeof pinterestAccounts.$inferSelect;
export type PinterestBoard = typeof pinterestBoards.$inferSelect;
export type PinBatch = typeof pinBatches.$inferSelect;
export type PinDraft = typeof pinDrafts.$inferSelect;
export type ImageAsset = typeof imageAssets.$inferSelect;
export type PinSchedule = typeof pinSchedules.$inferSelect;
export type PublishJob = typeof publishJobs.$inferSelect;
export type DraftStatus = (typeof draftStatus.enumValues)[number];
export type BatchStatus = (typeof batchStatus.enumValues)[number];
export type BoardAssignmentMode = (typeof boardAssignmentMode.enumValues)[number];
