import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, Message, Partials, type Interaction, type MessageCreateOptions, type SendableChannels } from "discord.js";
import { mkdirSync } from "node:fs";
import { Api } from "telegram";
import type { AppConfig } from "./config.js";
import { discordEmojiToUnicode, formatDiscordMessageForTelegram, formatTelegramMessageForDiscord, truncateTelegram } from "./format.js";
import { logger } from "./logger.js";
import { getButtonValueByIndex, getOptionValue, getOptionValueByIndex, isInteractiveUi, newInteractionId, parseRichUi, renderRichUi, renderSelectedRichUi, type InteractiveUi, type PollUi, type ThreadMessageUi, type ThreadUi } from "./rich-ui.js";
import { BridgeStore } from "./store.js";
import { TelegramBridgeClient } from "./telegram-client.js";

type BridgeDiscordChannel = SendableChannels & {
  messages: { fetch(messageId: string): Promise<Message> };
  sendTyping(): Promise<void>;
};

export class PokeBridge {
  private discord: Client;
  private telegram: TelegramBridgeClient;
  private store: BridgeStore;
  private discordChannel?: BridgeDiscordChannel;
  private targetTelegramUserId?: string;
  private lastDiscordTypingToTelegramAt = 0;
  private lastTelegramTypingToDiscordAt = 0;

  constructor(private config: AppConfig) {
    this.store = new BridgeStore(config.BRIDGE_DB_PATH);
    this.telegram = new TelegramBridgeClient(config);
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.GuildMessagePolls,
        GatewayIntentBits.DirectMessagePolls,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
  }

  async start(): Promise<void> {
    mkdirSync(this.config.BRIDGE_TMP_DIR, { recursive: true });
    this.registerDiscordHandlers();
    this.registerTelegramHandlers();

    await Promise.all([
      this.telegram.start(),
      this.discord.login(this.config.DISCORD_TOKEN),
    ]);

    const channel = await this.fetchDiscordChannel();
    this.discordChannel = channel;
    this.targetTelegramUserId = await this.telegram.getTargetUserId();
    logger.info({ channelId: channel.id }, "bridge started");
  }

  async stop(): Promise<void> {
    this.store.close();
    await this.telegram.client.disconnect();
    this.discord.destroy();
  }

  private registerDiscordHandlers(): void {
    this.discord.once(Events.ClientReady, (client) => {
      logger.info({ user: client.user.tag }, "discord client ready");
    });

    this.discord.on(Events.MessageCreate, async (message) => {
      try {
        await this.handleDiscordMessage(message);
      } catch (error) {
        logger.error({ err: error, messageId: message.id }, "failed to bridge discord message");
      }
    });

    this.discord.on(Events.MessageReactionAdd, async (reaction, user) => {
      try {
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch();
        const message = reaction.message;
        if (!message.id) return;
        if (message.channelId !== this.config.DISCORD_CHANNEL_ID) {
          const channel = message.channel;
          if (!channel?.isThread?.() || channel.parentId !== this.config.DISCORD_CHANNEL_ID) return;
        }
        const mapped = this.store.byDiscordMessageId(message.id);
        if (!mapped) return;
        const emoji = discordEmojiToUnicode(reaction.emoji.name);
        if (!emoji) {
          logger.info({ emoji: reaction.emoji.identifier }, "skipping custom discord emoji reaction");
          return;
        }
        await this.telegram.sendReaction(mapped.telegramMessageId, emoji);
      } catch (error) {
        logger.error({ err: error }, "failed to bridge discord reaction");
      }
    });

    this.discord.on(Events.TypingStart, async (typing) => {
      try {
        if (typing.user?.bot) return;
        if (typing.channel.id !== this.config.DISCORD_CHANNEL_ID) {
          if (!typing.channel.isThread() || typing.channel.parentId !== this.config.DISCORD_CHANNEL_ID) return;
        }
        if (this.config.DISCORD_GUILD_ID && typing.guild?.id !== this.config.DISCORD_GUILD_ID) return;
        if (!this.shouldForwardDiscordTyping()) return;
        await this.telegram.sendTyping();
      } catch (error) {
        logger.error({ err: error }, "failed to bridge discord typing");
      }
    });

    this.discord.on(Events.InteractionCreate, async (interaction) => {
      try {
        await this.handleDiscordInteraction(interaction);
      } catch (error) {
        logger.error({ err: error }, "failed to handle discord interaction");
      }
    });

    this.discord.on(Events.MessagePollVoteAdd, async (pollAnswer, userId) => {
      try {
        await this.forwardPollVote(pollAnswer, userId, "voted");
      } catch (error) {
        logger.error({ err: error }, "failed to bridge discord poll vote add");
      }
    });

    this.discord.on(Events.MessagePollVoteRemove, async (pollAnswer, userId) => {
      try {
        await this.forwardPollVote(pollAnswer, userId, "removed vote");
      } catch (error) {
        logger.error({ err: error }, "failed to bridge discord poll vote remove");
      }
    });
  }

  private registerTelegramHandlers(): void {
    this.telegram.onMessage(async (message) => {
      try {
        await this.handleTelegramMessage(message);
      } catch (error) {
        logger.error({ err: error, telegramMessageId: message.id }, "failed to bridge telegram message");
      }
    });

    this.telegram.onReaction(async (telegramMessageId, emoji) => {
      try {
        const mapped = this.store.byTelegramMessageId(telegramMessageId);
        if (!mapped) return;
        const channel = mapped.discordChannelId
          ? await this.fetchDiscordChannelById(mapped.discordChannelId)
          : await this.getDiscordChannel();
        const discordMessage = await channel.messages.fetch(mapped.discordMessageId);
        await discordMessage.react(emoji);
      } catch (error) {
        logger.error({ err: error, telegramMessageId, emoji }, "failed to bridge telegram reaction");
      }
    });

    this.telegram.onTyping(async (userId) => {
      try {
        if (this.targetTelegramUserId && userId !== this.targetTelegramUserId) return;
        if (!this.shouldForwardTelegramTyping()) return;
        const channel = await this.getDiscordChannel();
        await channel.sendTyping();
      } catch (error) {
        logger.error({ err: error }, "failed to bridge telegram typing");
      }
    });
  }

  private async handleDiscordMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!this.isBridgeDiscordMessage(message)) return;

    const replyTo = await this.telegramReplyTargetForDiscord(message);
    const text = appendDiscordUiHint(formatDiscordMessageForTelegram(message));

    if (message.attachments.size === 0) {
      const sent = await this.telegram.sendText(text, replyTo);
      this.store.save({ discordMessageId: message.id, discordChannelId: message.channelId, telegramMessageId: sent.id, direction: "discord_to_telegram" });
      return;
    }

    let firstTelegramId: number | undefined;
    for (const attachment of message.attachments.values()) {
      const caption = truncateTelegram(`${text}\n\n[attachment: ${attachment.name ?? attachment.url}]`);
      const sent = await this.telegram.sendFile(attachment.url, caption, replyTo);
      firstTelegramId ??= sent.id;
    }

    if (firstTelegramId) {
      this.store.save({ discordMessageId: message.id, discordChannelId: message.channelId, telegramMessageId: firstTelegramId, direction: "discord_to_telegram" });
    }
  }

  private async handleTelegramMessage(message: Api.Message): Promise<void> {
    if (message.media) {
      await this.handleTelegramMediaMessage(message);
      return;
    }

    if (!message.message?.trim()) return;
    await this.handleTelegramTextMessage(message);
  }

  private async handleTelegramTextMessage(message: Api.Message): Promise<void> {
    const channel = await this.discordChannelForTelegram(message);
    const replyMessage = await this.discordReplyTargetForTelegram(message);
    const parsed = parseRichUi(formatTelegramMessageForDiscord(message));

    let sent: Message;
    if (parsed.ui) {
      if (parsed.ui.type === "poll") {
        sent = await this.sendPoll(channel, parsed.ui, parsed.displayText, replyMessage);
      } else if (parsed.ui.type === "thread") {
        sent = await this.createDiscordThread(channel, parsed.ui, parsed.displayText, replyMessage);
      } else if (parsed.ui.type === "thread_message") {
        sent = await this.sendDiscordThreadMessage(channel, parsed.ui, parsed.displayText);
      } else if (isInteractiveUi(parsed.ui)) {
        const interactionId = newInteractionId();
        const options = renderRichUi(parsed.ui, interactionId, parsed.displayText);
        sent = replyMessage ? await replyMessage.reply(options) : await channel.send(options);
        this.store.saveRichInteraction({
          id: interactionId,
          telegramMessageId: message.id,
          discordMessageId: sent.id,
          kind: parsed.ui.type,
          payloadJson: JSON.stringify(parsed.ui),
        });
      } else {
        sent = replyMessage ? await replyMessage.reply(parsed.displayText) : await channel.send(parsed.displayText);
      }
    } else {
      sent = replyMessage ? await replyMessage.reply(parsed.displayText) : await channel.send(parsed.displayText);
    }

    this.store.save({ discordMessageId: sent.id, discordChannelId: sent.channelId, telegramMessageId: message.id, direction: "telegram_to_discord" });
  }

  private async handleTelegramMediaMessage(message: Api.Message): Promise<void> {
    const channel = await this.discordChannelForTelegram(message);
    const replyMessage = await this.discordReplyTargetForTelegram(message);
    const content = formatTelegramMessageForDiscord(message);
    const media = await this.telegram.downloadMedia(message);

    let sent: Message;
    if (media) {
      const attachment = new AttachmentBuilder(media, { name: telegramFilename(message) });
      sent = replyMessage
        ? await replyMessage.reply({ content, files: [attachment] })
        : await channel.send({ content, files: [attachment] });
    } else {
      sent = replyMessage
        ? await replyMessage.reply(`${content}\n[media download failed]`)
        : await channel.send(`${content}\n[media download failed]`);
    }

    this.store.save({ discordMessageId: sent.id, discordChannelId: sent.channelId, telegramMessageId: message.id, direction: "telegram_to_discord" });
  }

  private async handleDiscordInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isStringSelectMenu()) {
      const [scope, kind, interactionId] = interaction.customId.split(":");
      if (scope !== "poke" || kind !== "select" || !interactionId) return;
      await this.completeRichInteraction(interaction, interactionId, interaction.values);
      return;
    }

    if (interaction.isButton()) {
      const [scope, kind, interactionId, rawIndex] = interaction.customId.split(":");
      if (scope !== "poke" || !interactionId) return;

      const record = this.store.richInteractionById(interactionId);
      if (!record) {
        await interaction.reply({ content: "That Poke action expired.", ephemeral: true });
        return;
      }
      const ui = JSON.parse(record.payloadJson) as InteractiveUi;
      if (kind !== "btn") return;
      const selectedValue = getOptionValueByIndex(ui, Number(rawIndex)) ?? getButtonValueByIndex(ui, Number(rawIndex));
      if (!selectedValue) {
        await interaction.reply({ content: "That Poke option is no longer available.", ephemeral: true });
        return;
      }
      await this.completeRichInteraction(interaction, interactionId, [selectedValue]);
      return;
    }

  }

  private async completeRichInteraction(interaction: Interaction, interactionId: string, selectedValues: string[]): Promise<void> {
    if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;

    const record = this.store.richInteractionById(interactionId);
    if (!record) {
      await interaction.reply({ content: "That Poke action expired.", ephemeral: true });
      return;
    }
    if (record.consumedAt) {
      await interaction.reply({ content: "That Poke action was already used.", ephemeral: true });
      return;
    }

    const ui = JSON.parse(record.payloadJson) as InteractiveUi;
    const selected = selectedValues.map((value) => getOptionValue(ui, value)).join(", ");

    await interaction.update(renderSelectedRichUi(selected) as never);

    this.store.consumeRichInteraction(interactionId);
    const prefix = selectedValues.length > 1 ? "Selected options" : "Selected option";
    await this.telegram.sendText(`${prefix}: ${selected}`, record.telegramMessageId);
  }

  private async sendPoll(channel: BridgeDiscordChannel, ui: PollUi, displayText: string, replyMessage?: Message): Promise<Message> {
    const answers = ui.options.slice(0, 10).map((option) => ({ text: option.label.slice(0, 55) }));
    if (answers.length < 2) {
      return await channel.send(displayText || "Poll needs at least two options.");
    }

    const options: MessageCreateOptions = {
      content: displayText || undefined,
      poll: {
        question: { text: ui.title.slice(0, 300) },
        answers,
        duration: clamp(ui.durationHours ?? 24, 1, 24 * 32),
        allowMultiselect: ui.allowMultiselect ?? false,
      },
    };
    return replyMessage ? await replyMessage.reply(options) : await channel.send(options);
  }

  private async createDiscordThread(channel: BridgeDiscordChannel, ui: ThreadUi, displayText: string, replyMessage?: Message): Promise<Message> {
    const name = ui.title.slice(0, 100);
    const starter = displayText || ui.message || `Thread created: ${name}`;

    if (replyMessage?.inGuild()) {
      const thread = replyMessage.thread ?? await replyMessage.startThread({
        name,
        autoArchiveDuration: ui.autoArchiveDuration,
      });
      const sent = await thread.send(ui.message || starter);
      await this.telegram.sendText(`Discord thread created: ${thread.name} (${thread.id})`, undefined);
      return sent;
    }

    const anyChannel = channel as any;
    if (anyChannel.threads?.create) {
      const thread = await anyChannel.threads.create({
        name,
        type: ChannelType.PublicThread,
        autoArchiveDuration: ui.autoArchiveDuration,
      });
      const sent = await thread.send(ui.message || starter);
      await this.telegram.sendText(`Discord thread created: ${thread.name} (${thread.id})`, undefined);
      return sent;
    }

    return await channel.send(`Cannot create a Discord thread here. Threads require a guild text channel. Requested thread: ${name}`);
  }

  private async sendDiscordThreadMessage(channel: BridgeDiscordChannel, ui: ThreadMessageUi, displayText: string): Promise<Message> {
    const target = ui.threadId
      ? await this.fetchDiscordChannelById(ui.threadId).catch(() => undefined)
      : channel;
    if (!target) return await channel.send(`Could not find Discord thread ${ui.threadId}.`);
    return await target.send(ui.message || displayText);
  }

  private async discordChannelForTelegram(message: Api.Message): Promise<BridgeDiscordChannel> {
    const replyTo = message.replyTo;
    const replyToMsgId = replyTo instanceof Api.MessageReplyHeader ? replyTo.replyToMsgId : undefined;
    if (!replyToMsgId) return await this.getDiscordChannel();

    const mapped = this.store.byTelegramMessageId(replyToMsgId);
    if (!mapped?.discordChannelId) return await this.getDiscordChannel();

    const channel = await this.fetchDiscordChannelById(mapped.discordChannelId).catch(() => undefined);
    return channel ?? await this.getDiscordChannel();
  }

  private isBridgeDiscordMessage(message: Message): boolean {
    if (message.channelId === this.config.DISCORD_CHANNEL_ID) {
      if (this.config.DISCORD_GUILD_ID && message.guildId !== this.config.DISCORD_GUILD_ID) return false;
      return true;
    }

    if (!message.channel?.isThread?.()) return false;
    if (message.channel.parentId !== this.config.DISCORD_CHANNEL_ID) return false;
    if (this.config.DISCORD_GUILD_ID && message.guildId !== this.config.DISCORD_GUILD_ID) return false;
    return true;
  }

  private async forwardPollVote(pollAnswer: unknown, userId: string, action: "voted" | "removed vote"): Promise<void> {
    const answer = pollAnswer as { id?: number; text?: string | null; poll?: { messageId?: string; message?: Message; question?: { text?: string | null } } };
    const messageId = answer.poll?.messageId ?? answer.poll?.message?.id;
    if (!messageId) return;
    const mapped = this.store.byDiscordMessageId(messageId);
    if (!mapped) return;

    const user = await this.discord.users.fetch(userId).catch(() => undefined);
    const who = user ? `${user.displayName} @ ${user.username}` : userId;
    const option = answer.text || `answer ${answer.id ?? "unknown"}`;
    await this.telegram.sendText(`[Discord poll] ${who} ${action}: ${option}`, mapped.telegramMessageId);
  }

  private async telegramReplyTargetForDiscord(message: Message): Promise<number | undefined> {
    const repliedDiscordId = message.reference?.messageId;
    if (!repliedDiscordId) return undefined;
    return this.store.byDiscordMessageId(repliedDiscordId)?.telegramMessageId;
  }

  private async discordReplyTargetForTelegram(message: Api.Message): Promise<Message | undefined> {
    const replyTo = message.replyTo;
    const replyToMsgId = replyTo instanceof Api.MessageReplyHeader ? replyTo.replyToMsgId : undefined;
    if (!replyToMsgId) return undefined;
    const mapped = this.store.byTelegramMessageId(replyToMsgId);
    if (!mapped) return undefined;
    const channel = mapped.discordChannelId
      ? await this.fetchDiscordChannelById(mapped.discordChannelId).catch(() => undefined)
      : await this.getDiscordChannel();
    return await channel?.messages.fetch(mapped.discordMessageId).catch(() => undefined);
  }

  private shouldForwardDiscordTyping(): boolean {
    const now = Date.now();
    if (now - this.lastDiscordTypingToTelegramAt < 4500) return false;
    this.lastDiscordTypingToTelegramAt = now;
    return true;
  }

  private shouldForwardTelegramTyping(): boolean {
    const now = Date.now();
    if (now - this.lastTelegramTypingToDiscordAt < 4500) return false;
    this.lastTelegramTypingToDiscordAt = now;
    return true;
  }

  private async getDiscordChannel(): Promise<BridgeDiscordChannel> {
    if (this.discordChannel) return this.discordChannel;
    const channel = await this.fetchDiscordChannel();
    this.discordChannel = channel;
    return channel;
  }

  private async fetchDiscordChannel(): Promise<BridgeDiscordChannel> {
    return await this.fetchDiscordChannelById(this.config.DISCORD_CHANNEL_ID);
  }

  private async fetchDiscordChannelById(channelId: string): Promise<BridgeDiscordChannel> {
    const channel = await this.discord.channels.fetch(channelId);
    if (!channel?.isSendable() || !("messages" in channel) || typeof channel.sendTyping !== "function") {
      throw new Error(`Discord channel is not sendable text: ${channelId}`);
    }
    return channel as BridgeDiscordChannel;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function appendDiscordUiHint(text: string): string {
  return `${text}\n\n[tip: When a Discord UI/action would help, include a machine-readable block after your normal message: <<<POKE_DISCORD_UI { ...json... } >>> Supported types: choice, multi_choice, buttons, confirm, poll, thread, thread_message. Poll schema: {"type":"poll","title":"Question?","options":[{"label":"A","value":"a"},{"label":"B","value":"b"}],"durationHours":24,"allowMultiselect":false}. Thread schema: {"type":"thread","title":"Thread name","message":"optional starter"}. Thread message schema: {"type":"thread_message","threadId":"optional Discord thread id","message":"text"}. For quick yes/no or actions, use buttons or confirm. Keep labels short. Include values that should be sent back to you when the user chooses. Do not explain the JSON. The bridge will hide it.]`;
}

function telegramFilename(message: Api.Message): string {
  const document = message.media instanceof Api.MessageMediaDocument ? message.media.document : undefined;
  if (document instanceof Api.Document) {
    for (const attr of document.attributes) {
      if (attr instanceof Api.DocumentAttributeFilename) return attr.fileName;
    }
  }
  if (message.media instanceof Api.MessageMediaPhoto) return `telegram-${message.id}.jpg`;
  return `telegram-${message.id}.bin`;
}
