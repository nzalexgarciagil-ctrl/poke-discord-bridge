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
}

export interface DiscordMessageSnapshotRecord {
  discordMessageId: string;
  content: string;
  updatedAt: string;
}

export interface DiscordUserMetadataRecord {
  userId: string;
  guildId: string;
  username: string;
  globalName?: string | null;
  displayName: string;
  serverDisplayName?: string | null;
  serverNickname?: string | null;
  avatarUrl: string;
  bannerUrl?: string | null;
  accentColor?: string | null;
  accountCreatedAt: string;
  joinedServerAt?: string | null;
  roles: string[];
  bot: boolean;
  system: boolean;
  updatedAt?: string;
}

export class BridgeStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of MIGRATIONS) {
        if (this.migrationApplied(migration.version)) continue;
        migration.up(this.db);
        this.db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrationApplied(version: number): boolean {
    const row = this.db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version) as { version: number } | undefined;
    return Boolean(row);
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
    this.db.prepare("UPDATE rich_interaction SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  saveDiscordMessageSnapshot(record: { discordMessageId: string; content: string }): void {
    this.db.prepare(`
      INSERT INTO discord_message_snapshot (discord_message_id, content, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(discord_message_id) DO UPDATE SET
        content = excluded.content,
        updated_at = CURRENT_TIMESTAMP
    `).run(record.discordMessageId, record.content);
  }

  discordMessageSnapshot(discordMessageId: string): DiscordMessageSnapshotRecord | undefined {
    const row = this.db.prepare(`
      SELECT discord_message_id, content, updated_at
      FROM discord_message_snapshot WHERE discord_message_id = ?
    `).get(discordMessageId) as DiscordMessageSnapshotRow | undefined;
    return row ? mapDiscordMessageSnapshotRow(row) : undefined;
  }

  discordUserContext(userId: string, guildId: string): DiscordUserContextRecord | undefined {
    const row = this.db.prepare(`
      SELECT user_id, guild_id, first_seen_at, last_seen_at
      FROM discord_user_context WHERE user_id = ? AND guild_id = ?
    `).get(userId, guildId) as DiscordUserContextRow | undefined;
    return row ? mapDiscordUserContextRow(row) : undefined;
  }

  saveDiscordUserContext(record: { userId: string; guildId: string }): void {
    this.db.prepare(`
      INSERT INTO discord_user_context
        (user_id, guild_id, first_seen_at, last_seen_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        last_seen_at = CURRENT_TIMESTAMP
    `).run(record.userId, record.guildId);
  }

  saveDiscordUserMetadata(record: DiscordUserMetadataRecord): void {
    this.db.prepare(`
      INSERT INTO user_metadata
        (user_id, guild_id, username, global_name, display_name, server_display_name, server_nickname,
         avatar_url, banner_url, accent_color, account_created_at, joined_server_at, roles_json,
         bot, system, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        username = excluded.username,
        global_name = excluded.global_name,
        display_name = excluded.display_name,
        server_display_name = excluded.server_display_name,
        server_nickname = excluded.server_nickname,
        avatar_url = excluded.avatar_url,
        banner_url = excluded.banner_url,
        accent_color = excluded.accent_color,
        account_created_at = excluded.account_created_at,
        joined_server_at = excluded.joined_server_at,
        roles_json = excluded.roles_json,
        bot = excluded.bot,
        system = excluded.system,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      record.userId,
      record.guildId,
      record.username,
      record.globalName ?? null,
      record.displayName,
      record.serverDisplayName ?? null,
      record.serverNickname ?? null,
      record.avatarUrl,
      record.bannerUrl ?? null,
      record.accentColor ?? null,
      record.accountCreatedAt,
      record.joinedServerAt ?? null,
      JSON.stringify(record.roles),
      record.bot ? 1 : 0,
      record.system ? 1 : 0,
    );
  }

  discordUserMetadata(userId: string, guildId: string): DiscordUserMetadataRecord | undefined {
    const row = this.db.prepare(`
      SELECT user_id, guild_id, username, global_name, display_name, server_display_name, server_nickname,
        avatar_url, banner_url, accent_color, account_created_at, joined_server_at, roles_json,
        bot, system, updated_at
      FROM user_metadata WHERE user_id = ? AND guild_id = ?
    `).get(userId, guildId) as DiscordUserMetadataRow | undefined;
    return row ? mapDiscordUserMetadataRow(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
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
      `);
    },
  },
  {
    version: 2,
    up(db) {
      if (!messageMapHasDiscordChannelId(db)) {
        db.exec("ALTER TABLE message_map ADD COLUMN discord_channel_id TEXT");
      }
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discord_user_context (
          user_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, guild_id)
        );
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_metadata (
          user_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          username TEXT NOT NULL,
          global_name TEXT,
          display_name TEXT NOT NULL,
          server_display_name TEXT,
          server_nickname TEXT,
          avatar_url TEXT NOT NULL,
          banner_url TEXT,
          accent_color TEXT,
          account_created_at TEXT NOT NULL,
          joined_server_at TEXT,
          roles_json TEXT NOT NULL DEFAULT '[]',
          bot INTEGER NOT NULL DEFAULT 0,
          system INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, guild_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_metadata_guild_id
          ON user_metadata(guild_id);
      `);
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discord_message_snapshot (
          discord_message_id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
];

function messageMapHasDiscordChannelId(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA table_info(message_map)").all() as Array<{ name: string }>;
  return rows.some((row) => row.name === "discord_channel_id");
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
}

interface DiscordMessageSnapshotRow {
  discord_message_id: string;
  content: string;
  updated_at: string;
}

interface DiscordUserMetadataRow {
  user_id: string;
  guild_id: string;
  username: string;
  global_name?: string | null;
  display_name: string;
  server_display_name?: string | null;
  server_nickname?: string | null;
  avatar_url: string;
  banner_url?: string | null;
  accent_color?: string | null;
  account_created_at: string;
  joined_server_at?: string | null;
  roles_json: string;
  bot: number;
  system: number;
  updated_at: string;
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
  };
}

function mapDiscordMessageSnapshotRow(row: DiscordMessageSnapshotRow): DiscordMessageSnapshotRecord {
  return {
    discordMessageId: row.discord_message_id,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

function mapDiscordUserMetadataRow(row: DiscordUserMetadataRow): DiscordUserMetadataRecord {
  return {
    userId: row.user_id,
    guildId: row.guild_id,
    username: row.username,
    globalName: row.global_name,
    displayName: row.display_name,
    serverDisplayName: row.server_display_name,
    serverNickname: row.server_nickname,
    avatarUrl: row.avatar_url,
    bannerUrl: row.banner_url,
    accentColor: row.accent_color,
    accountCreatedAt: row.account_created_at,
    joinedServerAt: row.joined_server_at,
    roles: parseRoles(row.roles_json),
    bot: Boolean(row.bot),
    system: Boolean(row.system),
    updatedAt: row.updated_at,
  };
}

function parseRoles(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((role): role is string => typeof role === "string") : [];
  } catch {
    return [];
  }
}
