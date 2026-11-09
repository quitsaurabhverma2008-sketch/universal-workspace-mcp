import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Environment configuration, validated at boot. Fail fast with a clear message
 * instead of discovering a bad config at request time.
 */

const boolFromString = z
  .string()
  .default("true")
  .transform((v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()));

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  DATA_DIR: z.string().default("./data"),

  TOKEN_PEPPER: z
    .string()
    .min(16, "TOKEN_PEPPER must be at least 16 characters (openssl rand -base64 48)"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  EXEC_MODE: z.enum(["disabled", "restricted", "allowlist"]).default("restricted"),
  EXEC_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  EXEC_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(600_000),
  EXEC_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  EXEC_MAX_CONCURRENT_PER_WORKSPACE: z.coerce.number().int().min(1).max(20).default(5),
  ALLOWED_COMMANDS: z
    .string()
    .default("git,npm,npx,node,ls,cat,pwd,echo,mkdir,cp,mv,find,grep,sed,awk,head,tail,wc,tar,tsc,vitest"),

  MAX_FILE_BYTES: z.coerce.number().int().min(1024).default(5_242_880),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(4_194_304),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

  GIT_ENABLED_DEFAULT: boolFromString,
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // eslint-disable-next-line no-console
    console.error(`\n❌ Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fix the values.\n`);
    process.exit(1);
  }
  const e = parsed.data;

  // src/config/env.ts -> project root is two levels up (dist/config/env.js too)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dataDir = path.isAbsolute(e.DATA_DIR) ? path.resolve(e.DATA_DIR) : path.resolve(projectRoot, e.DATA_DIR);

  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(e.HOST);
  if (!isLoopback) {
    // eslint-disable-next-line no-console
    console.error(`\n⚠️  HOST=${e.HOST} is not loopback. The server refuses to bind publicly — use a tunnel instead (see README).\n`);
    process.exit(1);
  }

  return {
    host: e.HOST,
    port: e.PORT,
    projectRoot,
    dataDir,
    workspacesDir: path.join(dataDir, "workspaces"),
    backupsDir: path.join(dataDir, "backups"),
    tmpDir: path.join(dataDir, "tmp"),
    databasePath: path.join(dataDir, "database.sqlite"),
    tokenPepper: e.TOKEN_PEPPER,
    logLevel: e.LOG_LEVEL,
    execMode: e.EXEC_MODE,
    execDefaultTimeoutMs: e.EXEC_DEFAULT_TIMEOUT_MS,
    execMaxTimeoutMs: e.EXEC_MAX_TIMEOUT_MS,
    execMaxOutputBytes: e.EXEC_MAX_OUTPUT_BYTES,
    execMaxConcurrentPerWorkspace: e.EXEC_MAX_CONCURRENT_PER_WORKSPACE,
    allowedCommands: e.ALLOWED_COMMANDS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    maxFileBytes: e.MAX_FILE_BYTES,
    maxBodyBytes: e.MAX_BODY_BYTES,
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    eventRetentionDays: e.EVENT_RETENTION_DAYS,
    gitEnabledDefault: e.GIT_ENABLED_DEFAULT,
  } as const;
}
