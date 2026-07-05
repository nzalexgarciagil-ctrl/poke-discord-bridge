import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { randomBytes } from "node:crypto";

const UI_BLOCK_RE = /<<<\s*POKE_DISCORD_UI\s*([\s\S]*?)\s*>>>/i;
const ENABLED_UI_TYPES = new Set(["choice", "multi_choice", "buttons", "confirm", "poll", "poll_results", "reaction", "thread", "thread_message"]);
const UNSUPPORTED_UI_MESSAGE = "Poke sent an unsupported Discord UI. Ask it to use choice, multi_choice, buttons, confirm, poll, poll_results, reaction, thread, or thread_message.";

export type RichUi = ChoiceUi | MultiChoiceUi | ButtonsUi | ConfirmUi | PollUi | PollResultsUi | ReactionUi | ThreadUi | ThreadMessageUi;
export type InteractiveUi = ChoiceUi | MultiChoiceUi | ButtonsUi | ConfirmUi;

export interface ChoiceUi {
  type: "choice";
  title: string;
  options: RichUiOption[];
}

export interface MultiChoiceUi {
  type: "multi_choice";
  title: string;
  minValues?: number;
  maxValues?: number;
  options: RichUiOption[];
}

export interface ButtonsUi {
  type: "buttons";
  title: string;
  body?: string;
  buttons: ButtonOption[];
}

export interface ConfirmUi {
  type: "confirm";
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmValue?: string;
  cancelValue?: string;
}

export interface PollUi {
  type: "poll";
  title: string;
  options: RichUiOption[];
  durationHours?: number;
  allowMultiselect?: boolean;
}

export interface PollResultsUi {
  type: "poll_results";
  messageId?: string;
  channelId?: string;
}

export interface ReactionUi {
  type: "reaction";
  emoji: string;
  messageId?: string;
  channelId?: string;
}

export interface ThreadUi {
  type: "thread";
  title: string;
  message?: string;
  autoArchiveDuration?: number;
  createFromReply?: boolean;
  sendAck?: boolean;
}

export interface ThreadMessageUi {
  type: "thread_message";
  threadId?: string;
  message: string;
}

export interface RichUiOption {
  label: string;
  value?: string;
  emoji?: string;
  description?: string;
}

export interface ButtonOption {
  label: string;
  value?: string;
  emoji?: string;
  style?: "primary" | "secondary" | "success" | "danger";
}

export interface ParsedRichUi {
  displayText: string;
  ui?: RichUi;
}

export function parseRichUi(text: string): ParsedRichUi {
  const match = UI_BLOCK_RE.exec(text);
  if (!match) return { displayText: text.trim() };

  const displayText = text.replace(match[0], "").trim();
  const rawJson = match[1]?.trim();
  if (!rawJson) return { displayText };

  try {
    const raw = JSON.parse(rawJson) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || !ENABLED_UI_TYPES.has(String(raw.type))) {
      return { displayText: displayText || UNSUPPORTED_UI_MESSAGE };
    }
    const ui = normalizeRichUi(raw);
    if (!isRenderable(ui)) return { displayText: displayText || `Poke sent an invalid ${ui.type} UI payload.` };
    return { displayText, ui };
  } catch {
    return { displayText: text.trim() };
  }
}

export function newInteractionId(): string {
  return randomBytes(8).toString("hex");
}

export function isInteractiveUi(ui: RichUi): ui is InteractiveUi {
  return ui.type === "choice" || ui.type === "multi_choice" || ui.type === "buttons" || ui.type === "confirm";
}

export function renderRichUi(ui: InteractiveUi, interactionId: string, fallbackText?: string): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [renderContainer(ui, interactionId, fallbackText)],
  };
}

export function renderSelectedRichUi(selectedValue: string): MessageCreateOptions {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ✓ ${selectedValue}\nSelected option`));

  return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

export function getOptionValue(ui: InteractiveUi, selectedValue: string): string {
  const found = flattenOptions(ui).find((option) => optionValue(option) === selectedValue);
  return found?.value || found?.label || selectedValue;
}

export function getOptionValueByIndex(ui: InteractiveUi, index: number): string | undefined {
  const option = flattenOptions(ui)[index];
  return option ? option.value || option.label : undefined;
}

export function getButtonValueByIndex(ui: InteractiveUi, index: number): string | undefined {
  const button = buttonOptions(ui)[index];
  return button ? button.value || button.label : undefined;
}

function isRenderable(ui: RichUi): boolean {
  if ((ui.type === "choice" || ui.type === "multi_choice") && ui.options.length === 0) return false;
  if (ui.type === "buttons" && ui.buttons.length === 0) return false;
  if (ui.type === "reaction" && !ui.emoji) return false;
  return true;
}

function renderContainer(ui: InteractiveUi, interactionId: string, fallbackText?: string): ContainerBuilder {
  const container = baseContainer(ui.title, fallbackText || ("body" in ui ? ui.body : undefined));

  if (ui.type === "choice") {
    container.addActionRowComponents(selectRow(ui.options, interactionId, "Make a selection", 1, 1));
  } else if (ui.type === "multi_choice") {
    container.addActionRowComponents(selectRow(ui.options, interactionId, "Make selections", ui.minValues ?? 1, ui.maxValues ?? Math.min(ui.options.length, 25)));
  } else if (ui.type === "buttons") {
    addButtonRows(container, ui.buttons, interactionId);
  } else {
    addButtonRows(container, [
      { label: ui.confirmLabel || "Confirm", value: ui.confirmValue || "Confirm", style: "success" },
      { label: ui.cancelLabel || "Cancel", value: ui.cancelValue || "Cancel", style: "danger" },
    ], interactionId);
  }

  return container;
}

function baseContainer(title: string, body?: string): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(0x0099ff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title.slice(0, 256)}`));
  if (body) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body.slice(0, 4000)));
  return container;
}

function addButtonRows(container: ContainerBuilder, buttons: ButtonOption[], interactionId: string): void {
  let index = 0;
  for (let i = 0; i < buttons.length; i += 5) {
    const rowButtons = buttons.slice(i, i + 5).map((button) => {
      const builder = new ButtonBuilder()
        .setCustomId(`poke:btn:${interactionId}:${index++}`)
        .setLabel(button.label.slice(0, 80))
        .setStyle(buttonStyle(button.style));
      if (button.emoji) builder.setEmoji(button.emoji);
      return builder;
    });
    if (rowButtons.length > 0) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons));
  }
}

function selectRow(options: RichUiOption[], interactionId: string, placeholder: string, minValues: number, maxValues: number): ActionRowBuilder<StringSelectMenuBuilder> {
  const cappedOptions = options.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`poke:select:${interactionId}`)
    .setPlaceholder(placeholder)
    .setMinValues(clamp(minValues, 0, cappedOptions.length || 1))
    .setMaxValues(clamp(maxValues, 1, cappedOptions.length || 1))
    .addOptions(cappedOptions.map((option) => {
      const builder = new StringSelectMenuOptionBuilder()
        .setLabel(option.label.slice(0, 100))
        .setValue(optionValue(option));
      if (option.description) builder.setDescription(option.description.slice(0, 100));
      if (option.emoji) builder.setEmoji(option.emoji);
      return builder;
    }));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function flattenOptions(ui: InteractiveUi): RichUiOption[] {
  return "options" in ui ? ui.options : [];
}

function buttonOptions(ui: InteractiveUi): ButtonOption[] {
  if (ui.type === "buttons") return ui.buttons;
  if (ui.type === "confirm") return [
    { label: ui.confirmLabel || "Confirm", value: ui.confirmValue || "Confirm", style: "success" },
    { label: ui.cancelLabel || "Cancel", value: ui.cancelValue || "Cancel", style: "danger" },
  ];
  return [];
}

function optionValue(option: RichUiOption): string {
  return (option.value || option.label).slice(0, 100);
}

function buttonStyle(style?: ButtonOption["style"]): ButtonStyle {
  if (style === "danger") return ButtonStyle.Danger;
  if (style === "success") return ButtonStyle.Success;
  if (style === "secondary") return ButtonStyle.Secondary;
  return ButtonStyle.Primary;
}

function normalizeRichUi(value: Record<string, unknown>): RichUi {
  const type = value.type;
  if (type === "choice") return { type, title: stringField(value.title, "Choose an option"), options: optionsField(value.options) };
  if (type === "multi_choice") return { type, title: stringField(value.title, "Choose options"), minValues: numberField(value.minValues), maxValues: numberField(value.maxValues), options: optionsField(value.options) };
  if (type === "buttons") return { type, title: stringField(value.title, "Choose an action"), body: optionalString(value.body), buttons: arrayField(value.buttons).map(normalizeButton) };
  if (type === "confirm") return { type, title: stringField(value.title, "Confirm?"), body: optionalString(value.body), confirmLabel: optionalString(value.confirmLabel), cancelLabel: optionalString(value.cancelLabel), confirmValue: optionalString(value.confirmValue), cancelValue: optionalString(value.cancelValue) };
  if (type === "poll") return {
    type,
    title: stringField(value.title, stringField(value.question, "Poll")),
    options: optionsField(arrayField(value.options).length > 0 ? value.options : value.answers),
    durationHours: numberField(value.durationHours) ?? numberField(value.duration),
    allowMultiselect: booleanField(value.allowMultiselect) ?? booleanField(value.multiSelect),
  };
  if (type === "poll_results") return {
    type,
    messageId: optionalString(value.messageId) ?? optionalString(value.pollMessageId),
    channelId: optionalString(value.channelId),
  };
  if (type === "reaction") return {
    type,
    emoji: stringField(value.emoji, stringField(value.emote, "")),
    messageId: optionalString(value.messageId),
    channelId: optionalString(value.channelId),
  };
  if (type === "thread") return {
    type,
    title: stringField(value.title, stringField(value.name, "Poke thread")),
    message: optionalString(value.message) ?? optionalString(value.body) ?? optionalString(value.text),
    autoArchiveDuration: numberField(value.autoArchiveDuration),
    createFromReply: booleanField(value.createFromReply) ?? booleanField(value.replyToCurrentMessage),
    sendAck: booleanField(value.sendAck),
  };
  if (type === "thread_message") return {
    type,
    threadId: optionalString(value.threadId) ?? optionalString(value.channelId),
    message: stringField(value.message, stringField(value.body, stringField(value.text, ""))),
  };
  throw new Error("unsupported rich ui type");
}

function optionsField(value: unknown): RichUiOption[] {
  return arrayField(value).map(normalizeOption).filter((option) => option.label.length > 0);
}

function normalizeOption(value: unknown): RichUiOption {
  if (typeof value === "string") return { label: value, value };
  const option = objectField(value);
  const label = stringField(option.label, stringField(option.title, stringField(option.name, "")));
  return {
    label,
    value: optionalString(option.value) ?? optionalString(option.id) ?? label,
    description: optionalString(option.description) ?? optionalString(option.subtitle),
    emoji: optionalString(option.emoji),
  };
}

function normalizeButton(value: unknown): ButtonOption {
  if (typeof value === "string") return { label: value, value };
  const button = objectField(value);
  const label = stringField(button.label, stringField(button.title, "Choose"));
  return {
    label,
    value: optionalString(button.value) ?? optionalString(button.id) ?? label,
    emoji: optionalString(button.emoji),
    style: button.style === "danger" || button.style === "success" || button.style === "secondary" || button.style === "primary" ? button.style : "primary",
  };
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringField(value: unknown, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
