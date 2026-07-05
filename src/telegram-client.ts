import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Api, TelegramClient } from "telegram";
import { NewMessage, Raw } from "telegram/events/index.js";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import { StringSession } from "telegram/sessions/index.js";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { promptText } from "./prompt.js";

export class TelegramBridgeClient {
  readonly client: TelegramClient;
  private targetEntity?: Api.TypeEntityLike;

  constructor(private config: AppConfig) {
    this.client = new TelegramClient(
      new StringSession(config.TELEGRAM_STRING_SESSION),
      config.TELEGRAM_API_ID,
      config.TELEGRAM_API_HASH,
      { connectionRetries: 5 },
    );
  }

  async start(): Promise<void> {
    await this.client.start({
      phoneNumber: async () => await promptText("Telegram phone number: "),
      password: async () => await promptText("Telegram 2FA password, if any: "),
      phoneCode: async () => await promptText("Telegram login code: "),
      onError: (error) => logger.error({ err: error }, "telegram login error"),
    });

    const savedSession = this.client.session.save();
    if (!this.config.TELEGRAM_STRING_SESSION && savedSession) {
      mkdirSync(dirname(this.config.TELEGRAM_STRING_SESSION_FILE), { recursive: true });
      writeFileSync(this.config.TELEGRAM_STRING_SESSION_FILE, savedSession, { mode: 0o600 });
      logger.warn({ path: this.config.TELEGRAM_STRING_SESSION_FILE }, "TELEGRAM_STRING_SESSION was empty; wrote session file");
    }

    this.targetEntity = await this.resolveTargetEntity();
    logger.info("telegram client started");
  }

  async sendText(text: string, replyTo?: number): Promise<Api.Message> {
    const entity = await this.getTargetEntity();
    return await this.client.sendMessage(entity, { message: text, replyTo });
  }

  async sendFile(file: string | Buffer, caption: string, replyTo?: number): Promise<Api.Message> {
    const entity = await this.getTargetEntity();
    return await this.client.sendFile(entity, {
      file,
      caption,
      replyTo,
      forceDocument: false,
    });
  }

  async sendReaction(messageId: number, emoji: string): Promise<void> {
    const entity = await this.getTargetEntity();
    await this.client.invoke(new Api.messages.SendReaction({
      peer: entity,
      msgId: messageId,
      reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
    }));
  }

  async sendTyping(): Promise<void> {
    const entity = await this.getTargetEntity();
    await this.client.invoke(new Api.messages.SetTyping({
      peer: entity,
      action: new Api.SendMessageTypingAction(),
    }));
  }

  async getTargetUserId(): Promise<string | undefined> {
    const entity = await this.getTargetEntity();
    if (entity instanceof Api.User) return entity.id?.toString();
    return undefined;
  }

  onMessage(handler: (message: Api.Message) => Promise<void>): void {
    this.client.addEventHandler(async (event: NewMessageEvent) => {
      const message = event.message;
      if (!(message instanceof Api.Message)) return;
      if (message.out) return;
      await handler(message);
    }, new NewMessage({ chats: [this.config.TELEGRAM_TARGET_BOT_USERNAME ?? this.config.TELEGRAM_TARGET_BOT_ID] }));
  }

  onReaction(handler: (messageId: number, emoji: string) => Promise<void>): void {
    this.client.addEventHandler(async (update: unknown) => {
      if (!(update instanceof Api.UpdateMessageReactions)) return;
      const messageId = update.msgId;
      const results = update.reactions.results;
      const top = results[0]?.reaction;
      if (!(top instanceof Api.ReactionEmoji)) return;
      await handler(messageId, top.emoticon);
    }, new Raw({}));
  }

  onTyping(handler: (userId: string) => Promise<void>): void {
    this.client.addEventHandler(async (update: unknown) => {
      if (!(update instanceof Api.UpdateUserTyping)) return;
      if (update.action instanceof Api.SendMessageCancelAction) return;
      await handler(update.userId.toString());
    }, new Raw({}));
  }

  async downloadMedia(message: Api.Message): Promise<Buffer | undefined> {
    if (!message.media) return undefined;
    const downloaded = await this.client.downloadMedia(message.media, {});
    if (!downloaded) return undefined;
    if (Buffer.isBuffer(downloaded)) return downloaded;
    if (typeof downloaded === "string") return undefined;
    return Buffer.from(downloaded);
  }

  private async getTargetEntity(): Promise<Api.TypeEntityLike> {
    if (!this.targetEntity) this.targetEntity = await this.resolveTargetEntity();
    return this.targetEntity;
  }

  private async resolveTargetEntity(): Promise<Api.TypeEntityLike> {
    if (this.config.TELEGRAM_TARGET_BOT_USERNAME) {
      return await this.client.getEntity(this.config.TELEGRAM_TARGET_BOT_USERNAME);
    }
    return await this.client.getEntity(this.config.TELEGRAM_TARGET_BOT_ID);
  }
}

export async function loginTelegramStringSession(): Promise<void> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required for login");

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => await promptText("Telegram phone number: "),
    password: async () => await promptText("Telegram 2FA password, if any: "),
    phoneCode: async () => await promptText("Telegram login code: "),
    onError: (error) => console.error(error),
  });
  console.log("\nTELEGRAM_STRING_SESSION=");
  console.log(client.session.save());
  await client.disconnect();
}
