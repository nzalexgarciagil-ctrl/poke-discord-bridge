import type { Message } from "discord.js";
import { Api } from "telegram";

const TELEGRAM_LIMIT = 3900;
const DISCORD_LIMIT = 1900;

export function formatDiscordSource(message: Message): string {
  const guild = message.guild?.name ?? "DM/unknown guild";
  const channelName = "name" in message.channel && typeof message.channel.name === "string"
    ? message.channel.name
    : message.channel.id;
  const channelKind = message.channel.isThread() ? "thread" : message.guild ? "channel" : "dm";
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : undefined;
  const memberName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
  const parent = parentChannelId ? ` parentChannelId=${parentChannelId}` : "";
  return `[Discord: guild="${guild}" ${channelKind}="${channelName}" channelId=${message.channelId}${parent} | author="${memberName}" username=${message.author.username} userId=${message.author.id} | messageId=${message.id}]`;
}

export function formatDiscordMessageForTelegram(message: Message): string {
  const content = message.content?.trim() || "[no text]";
  return truncateTelegram(`${formatDiscordSource(message)} ${content}`);
}

export function formatTelegramMessageForDiscord(message: Api.Message): string {
  const body = message.message?.trim() || (message.media ? "[media]" : "[no text]");
  return truncateDiscord(body);
}

export function truncateTelegram(text: string): string {
  return text.length > TELEGRAM_LIMIT ? `${text.slice(0, TELEGRAM_LIMIT - 1)}…` : text;
}

export function truncateDiscord(text: string): string {
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}

export function discordEmojiToUnicode(name: string | null): string | undefined {
  if (!name) return undefined;
  return /^\p{Emoji}$/u.test(name) || [...name].some((char) => /\p{Emoji}/u.test(char)) ? name : undefined;
}
