import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Direction = "discord_to_telegram" | "telegram_to_discord";

export interface MessageMapRecord {
  discordMessageId: string;
  discordChannelId?: string | null;
  telegramMessageId: number;
  direction: Direction;
  createdAt: string;
}

export interface RichInteractionRecord {
  id: string;
  telegramMessageId: number;
  discordMessageId: string;
  kind: string;
  payloadJson: string;
  createdAt: string;
  consumedAt?: string | null;
}

export interface DiscordUserContextRecord {
  userId: string;
  guildId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastStatusSignature?: string | null;
}

export class BridgeStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_map (
        discord_message_id TEXT PRIMARY KEY,
        discord_channel_id TEXT,
        telegram_message_id INTEGER NOT NULL UNIQUE,
        direction TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_message_map_telegram_message_id
        ON message_map(telegram_message_id);

      CREATE TABLE IF NOT EXISTS rich_interaction (
        id TEXT PRIMARY KEY,
        telegram_message_id INTEGER NOT NULL,
        discord_message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rich_interaction_discord_message_id
        ON rich_interaction(discord_message_id);

      CREATE TABLE IF NOT EXISTS discord_user_context (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_status_signature TEXT,
        PRIMARY KEY (user_id, guild_id)
      );
    `);
    if (!this.hasColumn("message_map", "discord_channel_id")) {
      this.db.exec("ALTER TABLE message_map ADD COLUMN discord_channel_id TEXT");
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  save(record: Omit<MessageMapRecord, "createdAt">): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO message_map
        (discord_message_id, discord_channel_id, telegram_message_id, direction, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(record.discordMessageId, record.discordChannelId ?? null, record.telegramMessageId, record.direction);
  }

  byDiscordMessageId(discordMessageId: string): MessageMapRecord | undefined {
    const row = this.db.prepare(`
      SELECT discord_message_id, discord_channel_id, telegram_message_id, direction, created_at
      FROM message_map WHERE discord_message_id = ?
    `).get(discordMessageId) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  byTelegramMessageId(telegramMessageId: number): MessageMapRecord | undefined {
    const row = this.db.prepare(`
      SELECT discord_message_id, discord_channel_id, telegram_message_id, direction, created_at
      FROM message_map WHERE telegram_message_id = ?
    `).get(telegramMessageId) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  saveRichInteraction(record: Omit<RichInteractionRecord, "createdAt" | "consumedAt">): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO rich_interaction
        (id, telegram_message_id, discord_message_id, kind, payload_json, created_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
    `).run(record.id, record.telegramMessageId, record.discordMessageId, record.kind, record.payloadJson);
  }

  richInteractionById(id: string): RichInteractionRecord | undefined {
    const row = this.db.prepare(`
      SELECT id, telegram_message_id, discord_message_id, kind, payload_json, created_at, consumed_at
      FROM rich_interaction WHERE id = ?
    `).get(id) as RichRow | undefined;
    return row ? mapRichRow(row) : undefined;
  }

  consumeRichInteraction(id: string): void {
    this.db.prepare(`
      UPDATE rich_interaction SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(id);
  }

  discordUserContext(userId: string, guildId: string): DiscordUserContextRecord | undefined {
    const row = this.db.prepare(`
      SELECT user_id, guild_id, first_seen_at, last_seen_at, last_status_signature
      FROM discord_user_context WHERE user_id = ? AND guild_id = ?
    `).get(userId, guildId) as DiscordUserContextRow | undefined;
    return row ? mapDiscordUserContextRow(row) : undefined;
  }

  saveDiscordUserContext(record: { userId: string; guildId: string; statusSignature?: string | null }): void {
    this.db.prepare(`
      INSERT INTO discord_user_context
        (user_id, guild_id, first_seen_at, last_seen_at, last_status_signature)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        last_seen_at = CURRENT_TIMESTAMP,
        last_status_signature = excluded.last_status_signature
    `).run(record.userId, record.guildId, record.statusSignature ?? null);
  }

  close(): void {
    this.db.close();
  }
}

interface Row {
  discord_message_id: string;
  discord_channel_id?: string | null;
  telegram_message_id: number;
  direction: Direction;
  created_at: string;
}

interface RichRow {
  id: string;
  telegram_message_id: number;
  discord_message_id: string;
  kind: string;
  payload_json: string;
  created_at: string;
  consumed_at?: string | null;
}

interface DiscordUserContextRow {
  user_id: string;
  guild_id: string;
  first_seen_at: string;
  last_seen_at: string;
  last_status_signature?: string | null;
}

function mapRow(row: Row): MessageMapRecord {
  return {
    discordMessageId: row.discord_message_id,
    discordChannelId: row.discord_channel_id,
    telegramMessageId: row.telegram_message_id,
    direction: row.direction,
    createdAt: row.created_at,
  };
}

function mapRichRow(row: RichRow): RichInteractionRecord {
  return {
    id: row.id,
    telegramMessageId: row.telegram_message_id,
    discordMessageId: row.discord_message_id,
    kind: row.kind,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

function mapDiscordUserContextRow(row: DiscordUserContextRow): DiscordUserContextRecord {
  return {
    userId: row.user_id,
    guildId: row.guild_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastStatusSignature: row.last_status_signature,
  };
}
