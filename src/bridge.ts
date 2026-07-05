import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, Message, Partials, type GuildMember, type Interaction, type MessageCreateOptions, type PartialMessage, type Presence, type SendableChannels } from "discord.js";
import { mkdirSync } from "node:fs";
import { Api } from "telegram";
import type { AppConfig } from "./config.js";
import { discordEmojiToUnicode, formatDiscordMessageForTelegram, formatDiscordSource, formatTelegramMessageForDiscord, truncateTelegram } from "./format.js";
import { logger } from "./logger.js";
import { getButtonValueByIndex, getOptionValue, getOptionValueByIndex, isInteractiveUi, newInteractionId, parseRichUi, renderRichUi, renderSelectedRichUi, type EndPollUi, type InteractiveUi, type MessageLinkUi, type PollResultsUi, type PollUi, type ReactionUi, type ReplyUi, type ThreadMessageUi, type ThreadUi } from "./rich-ui.js";
import { BridgeStore, type DiscordUserMetadataRecord } from "./store.js";
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
    const intents = [
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
    ];
    if (config.BRIDGE_USER_CONTEXT_INCLUDE_PRESENCE || config.BRIDGE_USER_CONTEXT_STATUS_UPDATES) {
      intents.push(GatewayIntentBits.GuildPresences);
    }

    this.discord = new Client({
      intents,
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

    this.discord.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      try {
        await this.handleDiscordMessageUpdate(oldMessage, newMessage);
      } catch (error) {
        logger.error({ err: error, messageId: newMessage.id }, "failed to bridge discord message edit");
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
    const context = this.discordContextPrefixForMessage(message);
    const text = truncateTelegram(`${context}${formatDiscordMessageForTelegram(message)}`);

    if (message.attachments.size === 0) {
      const sent = await this.telegram.sendText(text, replyTo);
      this.store.save({ discordMessageId: message.id, discordChannelId: message.channelId, telegramMessageId: sent.id, direction: "discord_to_telegram" });
      this.store.saveDiscordMessageSnapshot({ discordMessageId: message.id, content: discordMessageSnapshotText(message) });
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
      this.store.saveDiscordMessageSnapshot({ discordMessageId: message.id, content: discordMessageSnapshotText(message) });
    }
  }

  private async handleDiscordMessageUpdate(oldMessage: Message | PartialMessage, newMessage: Message): Promise<void> {
    if (newMessage.author?.bot) return;
    if (!this.isBridgeDiscordMessage(newMessage)) return;

    const mapped = this.store.byDiscordMessageId(newMessage.id);
    if (!mapped || mapped.direction !== "discord_to_telegram") return;

    const after = discordMessageSnapshotText(newMessage);
    const before = this.store.discordMessageSnapshot(newMessage.id)?.content
      ?? ("content" in oldMessage ? oldMessage.content?.trim() : undefined)
      ?? "[unknown previous content]";

    if (before === after) return;

    const text = truncateTelegram(`${formatDiscordSourceForEdit(newMessage)}\nfrom: ${before}\nto: ${after}`);
    await this.telegram.sendText(text, mapped.telegramMessageId);
    this.store.saveDiscordMessageSnapshot({ discordMessageId: newMessage.id, content: after });
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
      } else if (parsed.ui.type === "poll_results") {
        sent = await this.sendPollResults(channel, parsed.ui, message, parsed.displayText);
      } else if (parsed.ui.type === "end_poll") {
        sent = await this.endPoll(channel, parsed.ui, message, parsed.displayText);
      } else if (parsed.ui.type === "reaction") {
        sent = await this.sendDiscordReaction(channel, parsed.ui, message, parsed.displayText, replyMessage);
      } else if (parsed.ui.type === "message_link") {
        sent = await this.sendMessageLink(channel, parsed.ui, message, parsed.displayText);
      } else if (parsed.ui.type === "reply") {
        sent = await this.sendExplicitReply(channel, parsed.ui, message, parsed.displayText);
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

  private async sendPollResults(channel: BridgeDiscordChannel, ui: PollResultsUi, telegramMessage: Api.Message, displayText: string): Promise<Message> {
    const pollMessage = await this.resolveDiscordMessage(channel, telegramMessage, ui.messageId, ui.channelId);
    const freshPollMessage = await pollMessage?.fetch().catch(() => pollMessage);
    if (!freshPollMessage?.poll) return await channel.send(displayText || "Could not find a Discord poll for results.");
    return await channel.send(formatPollResults(freshPollMessage, displayText));
  }

  private async endPoll(channel: BridgeDiscordChannel, ui: EndPollUi, telegramMessage: Api.Message, displayText: string): Promise<Message> {
    const pollMessage = await this.resolveDiscordMessage(channel, telegramMessage, ui.messageId, ui.channelId);
    const freshPollMessage = await pollMessage?.fetch().catch(() => pollMessage);
    if (!freshPollMessage?.poll) return await channel.send(displayText || "Could not find a Discord poll to end.");

    const endedMessage = await freshPollMessage.poll.end();
    if (ui.summarize === false) return await channel.send(displayText || `Ended poll: ${endedMessage.url}`);
    return await channel.send(formatPollResults(endedMessage, displayText || "Poll ended."));
  }

  private async sendDiscordReaction(channel: BridgeDiscordChannel, ui: ReactionUi, telegramMessage: Api.Message, displayText: string, replyMessage?: Message): Promise<Message> {
    const target = await this.resolveDiscordMessage(channel, telegramMessage, ui.messageId, ui.channelId);
    if (!target) return await channel.send(displayText || `Could not find a Discord message to react to with ${ui.emoji}.`);

    await target.react(ui.emoji);
    if (displayText) return replyMessage ? await replyMessage.reply(displayText) : await channel.send(displayText);
    return target;
  }

  private async sendMessageLink(channel: BridgeDiscordChannel, ui: MessageLinkUi, telegramMessage: Api.Message, displayText: string): Promise<Message> {
    const target = await this.resolveDiscordMessage(channel, telegramMessage, ui.messageId, ui.channelId);
    if (!target) return await channel.send(displayText || "Could not find a Discord message to link.");
    return await channel.send(displayText ? `${displayText}\n${target.url}` : target.url);
  }

  private async sendExplicitReply(channel: BridgeDiscordChannel, ui: ReplyUi, telegramMessage: Api.Message, displayText: string): Promise<Message> {
    const target = await this.resolveDiscordMessage(channel, telegramMessage, ui.messageId, ui.channelId);
    const content = ui.message || displayText;
    if (!target) return await channel.send(content || "Could not find a Discord message to reply to.");
    if (!content) return await channel.send("Reply action needs message text.");
    return await target.reply(content);
  }

  private async resolveDiscordMessage(channel: BridgeDiscordChannel, telegramMessage: Api.Message, messageId?: string, channelId?: string): Promise<Message | undefined> {
    if (messageId) {
      const targetChannel = channelId ? await this.fetchDiscordChannelById(channelId).catch(() => undefined) : channel;
      return await targetChannel?.messages.fetch(messageId).catch(() => undefined);
    }

    const replyTo = telegramMessage.replyTo;
    const replyToMsgId = replyTo instanceof Api.MessageReplyHeader ? replyTo.replyToMsgId : undefined;
    if (!replyToMsgId) return undefined;
    const mapped = this.store.byTelegramMessageId(replyToMsgId);
    if (!mapped) return undefined;
    const targetChannel = mapped.discordChannelId ? await this.fetchDiscordChannelById(mapped.discordChannelId).catch(() => undefined) : channel;
    return await targetChannel?.messages.fetch(mapped.discordMessageId).catch(() => undefined);
  }

  private async createDiscordThread(channel: BridgeDiscordChannel, ui: ThreadUi, displayText: string, replyMessage?: Message): Promise<Message> {
    const name = ui.title.slice(0, 100);
    const starter = displayText || ui.message || `Thread created: ${name}`;
    const shouldStartFromReply = ui.createFromReply ?? true;

    if (shouldStartFromReply && replyMessage?.inGuild()) {
      const thread = replyMessage.thread ?? await replyMessage.startThread({
        name,
        autoArchiveDuration: ui.autoArchiveDuration,
      });
      const sent = await thread.send(ui.message || starter);
      if (ui.sendAck !== false) await this.telegram.sendText(threadAck(thread.name, thread.id, thread.parentId), undefined);
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
      if (ui.sendAck !== false) await this.telegram.sendText(threadAck(thread.name, thread.id, thread.parentId), undefined);
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

  private discordContextPrefixForMessage(message: Message): string {
    if (!message.guildId) return "";

    const member = message.member ?? undefined;
    const presence = this.config.BRIDGE_USER_CONTEXT_INCLUDE_PRESENCE || this.config.BRIDGE_USER_CONTEXT_STATUS_UPDATES
      ? member?.presence ?? undefined
      : undefined;
    const statusSignature = presence ? discordPresenceSignature(presence) : undefined;
    const previous = this.store.discordUserContext(message.author.id, message.guildId);
    this.store.saveDiscordUserMetadata(discordUserMetadataFromMessage(message, member, statusSignature));
    this.store.saveDiscordUserContext({ userId: message.author.id, guildId: message.guildId, statusSignature });

    if (!previous) return `${formatNewDiscordUserContext(message, member, presence)}\n\n`;

    const previousStatus = previous.lastStatusSignature;
    const statusChanged = this.config.BRIDGE_USER_CONTEXT_STATUS_UPDATES
      && statusSignature
      && previousStatus
      && statusSignature !== previousStatus;
    if (!statusChanged || !previousStatus || !statusSignature) return "";
    return `${formatDiscordStatusUpdate(message, previousStatus, statusSignature)}\n\n`;
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

function discordMessageSnapshotText(message: Message): string {
  const content = message.content?.trim();
  const attachments = [...message.attachments.values()].map((attachment) => `[attachment: ${attachment.name ?? attachment.url}]`);
  return [content || "[no text]", ...attachments].join("\n");
}

function formatDiscordSourceForEdit(message: Message): string {
  return `[Discord message edited]\n${formatDiscordSource(message)}`;
}

function discordUserMetadataFromMessage(message: Message, member?: GuildMember, statusSignature?: string): DiscordUserMetadataRecord {
  return discordUserMetadataFromUserLike({
    user: message.author,
    guildId: message.guildId ?? "dm",
    member,
    statusSignature,
  });
}

function discordUserMetadataFromUserLike(input: { user: Message["author"]; guildId: string; member?: GuildMember; statusSignature?: string }): DiscordUserMetadataRecord {
  return {
    userId: input.user.id,
    guildId: input.guildId,
    username: input.user.username,
    globalName: input.user.globalName,
    displayName: input.user.displayName,
    serverDisplayName: input.member?.displayName,
    serverNickname: input.member?.nickname,
    avatarUrl: input.user.displayAvatarURL(),
    bannerUrl: input.user.bannerURL(),
    accentColor: input.user.hexAccentColor,
    accountCreatedAt: input.user.createdAt.toISOString(),
    joinedServerAt: input.member?.joinedAt?.toISOString(),
    roles: discordMemberRoleNames(input.member),
    bot: input.user.bot,
    system: input.user.system,
    statusSignature: input.statusSignature,
  };
}

function formatNewDiscordUserContext(message: Message, member?: GuildMember, presence?: Presence): string {
  const lines = [
    "[New Discord user context]",
    `userId=${message.author.id}`,
    `username=${message.author.username}`,
    `displayName=${message.author.displayName}`,
  ];

  if (message.author.globalName) lines.push(`globalName=${message.author.globalName}`);
  if (member?.displayName && member.displayName !== message.author.displayName) lines.push(`serverDisplayName=${member.displayName}`);
  if (member?.nickname) lines.push(`serverNickname=${member.nickname}`);
  lines.push(`avatar=${message.author.displayAvatarURL()}`);
  const banner = message.author.bannerURL();
  if (banner) lines.push(`banner=${banner}`);
  const accent = message.author.hexAccentColor;
  if (accent) lines.push(`accentColor=${accent}`);
  lines.push(`accountCreatedAt=${message.author.createdAt.toISOString()}`);
  if (member?.joinedAt) lines.push(`joinedServerAt=${member.joinedAt.toISOString()}`);
  const roles = discordMemberRoleNames(member);
  if (roles.length) lines.push(`roles=${roles.join(", ")}`);
  if (presence) lines.push(...formatDiscordPresenceLines(presence));
  return lines.join("\n");
}

function formatDiscordStatusUpdate(message: Message, previous: string, current: string): string {
  return [
    "[Discord user status update]",
    `userId=${message.author.id}`,
    `username=${message.author.username}`,
    `status=${previous} -> ${current}`,
  ].join("\n");
}

function discordMemberRoleNames(member?: GuildMember): string[] {
  if (!member) return [];
  return [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .slice(0, 15)
    .map((role) => role.name);
}

function formatDiscordPresenceLines(presence: Presence): string[] {
  const lines = [`status=${presence.status}`];
  const activities = presence.activities.map((activity) => discordActivityLabel(activity)).filter(Boolean).slice(0, 5);
  if (activities.length) lines.push(`activities=${activities.join("; ")}`);
  return lines;
}

function discordPresenceSignature(presence: Presence): string {
  const activities = presence.activities.map((activity) => discordActivityLabel(activity)).filter(Boolean).sort().join(";");
  return activities ? `${presence.status} | ${activities}` : presence.status;
}

function discordActivityLabel(activity: Presence["activities"][number]): string {
  const details = [activity.details, activity.state].filter(Boolean).join(" / ");
  return details ? `${activity.name} (${details})` : activity.name;
}

function formatPollResults(message: Message, prefix?: string): string {
  if (!message.poll) return prefix || "Poll results unavailable.";
  const answers = [...message.poll.answers.values()].map((answer) => {
    const a = answer as { text?: string | null; voteCount?: number; id?: number };
    return { label: a.text || `Answer ${a.id ?? "?"}`, votes: a.voteCount ?? 0 };
  }).sort((a, b) => b.votes - a.votes);

  const total = answers.reduce((sum, answer) => sum + answer.votes, 0);
  const lines = answers.map((answer, index) => `${index + 1}. ${answer.label}: ${answer.votes} vote${answer.votes === 1 ? "" : "s"}`);
  return `${prefix ? `${prefix}\n\n` : ""}Poll results for ${message.url}\nTotal votes: ${total}\n${lines.join("\n")}`;
}

function threadAck(name: string, threadId: string, parentChannelId?: string | null): string {
  return `[Discord thread created]\nname: ${name}\nthreadId: ${threadId}${parentChannelId ? `\nparentChannelId: ${parentChannelId}` : ""}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
