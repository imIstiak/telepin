import { z } from "zod";

const csvIds = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^\d+$/, "Telegram user IDs must be numeric")));

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  TELEGRAM_USE_POLLING: bool(false),
  AUTHORIZED_TELEGRAM_USER_IDS: csvIds,
  /** Per-user Telegram actions per minute (burst of 10). */
  BOT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),

  DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/pinterest_agent"),
  DATABASE_SSL: bool(false),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  PINTEREST_CLIENT_ID: z.string().default(""),
  PINTEREST_CLIENT_SECRET: z.string().default(""),
  PINTEREST_REDIRECT_URI: z.string().default(""),
  /** https://api.pinterest.com/v5 (production) or https://api-sandbox.pinterest.com/v5 (Trial access). */
  PINTEREST_API_BASE: z.string().url().default("https://api.pinterest.com/v5"),
  /** OAuth authorize page and token endpoint (production hosts, also used for Trial apps). */
  PINTEREST_OAUTH_AUTHORIZE_URL: z.string().url().default("https://www.pinterest.com/oauth/"),
  PINTEREST_OAUTH_TOKEN_URL: z.string().url().default("https://api.pinterest.com/v5/oauth/token"),
  PINTEREST_WRITE_TIMEOUT_MS: z.coerce.number().int().min(500).default(45_000),
  PINTEREST_SCOPES: z.string().default("boards:read,pins:read,pins:write,user_accounts:read"),

  AI_TEXT_PROVIDER: z.enum(["gemini", "mock"]).default("gemini"),
  AI_TEXT_API_KEY: z.string().default(""),
  AI_TEXT_MODEL: z.string().default("gemini-2.5-flash"),
  AI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  AI_IMAGE_PROVIDER: z.enum(["gemini", "gradient", "mock"]).default("gemini"),
  AI_IMAGE_API_KEY: z.string().default(""),
  /** imagen-* models use the Imagen endpoint; gemini-*-image models use generateContent. */
  AI_IMAGE_MODEL: z.string().default("imagen-4.0-generate-001"),

  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET_NAME: z.string().default(""),
  R2_PUBLIC_BASE_URL: z.string().default(""),
  /** "r2" in production. "local" stores files under LOCAL_STORAGE_DIR (development/tests only). */
  STORAGE_DRIVER: z.enum(["r2", "local"]).default("r2"),
  LOCAL_STORAGE_DIR: z.string().default(".data/storage"),

  TOKEN_ENCRYPTION_KEY: z.string().default(""),

  DEFAULT_TIMEZONE: z.string().default("Asia/Dhaka"),
  DEFAULT_BATCH_SIZE: z.coerce.number().int().min(1).max(7).default(5),
  DEFAULT_SCHEDULE_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(60),
  MAX_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(7),

  /** What to do with schedules that were missed while the worker was down: shift | pause */
  MISSED_SCHEDULE_POLICY: z.enum(["shift", "pause"]).default("shift"),
  /** A schedule is "missed" if it is more than this many minutes overdue at recovery time. */
  MISSED_SCHEDULE_GRACE_MINUTES: z.coerce.number().int().min(0).default(10),

  GENERATION_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  IMAGE_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  PUBLISH_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(4),
  DRAFT_IMAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
});

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    const missing: string[] = [];
    for (const key of ["TELEGRAM_BOT_TOKEN", "TOKEN_ENCRYPTION_KEY", "TELEGRAM_WEBHOOK_SECRET"] as const) {
      if (!env[key]) missing.push(key);
    }
    if (env.AUTHORIZED_TELEGRAM_USER_IDS.length === 0) missing.push("AUTHORIZED_TELEGRAM_USER_IDS");
    if (env.STORAGE_DRIVER === "local") missing.push("STORAGE_DRIVER must be r2 in production");
    if (!env.APP_BASE_URL.startsWith("https://")) missing.push("APP_BASE_URL must be https in production");
    if (missing.length) throw new Error(`Missing/invalid production configuration: ${missing.join(", ")}`);
  }
  return env;
}

export const env: Env = load();

/** Which external integrations have credentials configured. Used for honest status reporting. */
export function integrationStatus() {
  return {
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
    pinterest: Boolean(env.PINTEREST_CLIENT_ID && env.PINTEREST_CLIENT_SECRET && env.PINTEREST_REDIRECT_URI),
    aiText: env.AI_TEXT_PROVIDER === "mock" || Boolean(env.AI_TEXT_API_KEY),
    aiImage: env.AI_IMAGE_PROVIDER !== "gemini" || Boolean(env.AI_IMAGE_API_KEY || env.AI_TEXT_API_KEY),
    storage:
      env.STORAGE_DRIVER === "local" ||
      Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME && env.R2_PUBLIC_BASE_URL),
    encryption: Boolean(env.TOKEN_ENCRYPTION_KEY),
  };
}
