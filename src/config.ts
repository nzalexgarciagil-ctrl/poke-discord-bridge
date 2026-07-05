import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const envFiles = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../.env")];
for (const path of envFiles) {
  if (existsSync(path)) dotenv.config({ path, override: false, quiet: true });
}

const booleanFromEnv = z.preprocess((value) => value === "true" || value === true, z.boolean());

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  DISCORD_CHANNEL_ID: z.string().min(1),
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(1),
  TELEGRAM_STRING_SESSION: z.string().default(""),
  TELEGRAM_STRING_SESSION_FILE: z.string().default("./data/telegram-string-session.txt"),
  TELEGRAM_TARGET_BOT_ID: z.coerce.number().int().positive().default(8509073799),
  TELEGRAM_TARGET_BOT_USERNAME: z.string().min(1).default("interaction_poke_bot"),
  BRIDGE_DB_PATH: z.string().default("./data/bridge.sqlite"),
  BRIDGE_TMP_DIR: z.string().default("./data/tmp"),
  BRIDGE_USER_CONTEXT_INCLUDE_PRESENCE: booleanFromEnv.default(false),
  BRIDGE_USER_CONTEXT_STATUS_UPDATES: booleanFromEnv.default(false),
  BRIDGE_USER_CONTEXT_CACHE_MEMBER_JOINS: booleanFromEnv.default(false),
  LOG_LEVEL: z.string().default("info"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  if (!process.env.TELEGRAM_STRING_SESSION) {
    const sessionFile = process.env.TELEGRAM_STRING_SESSION_FILE ?? "./data/telegram-string-session.txt";
    if (existsSync(sessionFile)) {
      process.env.TELEGRAM_STRING_SESSION = readFileSync(sessionFile, "utf8").trim();
    }
  }

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment:\n${errors}`);
  }
  return parsed.data;
}
