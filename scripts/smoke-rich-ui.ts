import { isInteractiveUi, newInteractionId, parseRichUi, renderRichUi, type RichUi } from "../src/rich-ui.js";

const samples: RichUi[] = [
  { type: "choice", title: "Pick one", options: [{ label: "A" }, { label: "B" }] },
  { type: "multi_choice", title: "Pick many", options: [{ label: "A" }, { label: "B" }], maxValues: 2 },
  { type: "buttons", title: "Actions", buttons: [{ label: "Go", value: "go" }] },
  { type: "confirm", title: "Confirm?" },
  { type: "poll", title: "Poll?", options: [{ label: "A" }, { label: "B" }], durationHours: 24 },
  { type: "poll_results", messageId: "123" },
  { type: "end_poll", messageId: "123", summarize: true },
  { type: "reaction", emoji: "👍", messageId: "123" },
  { type: "thread", title: "Thread", message: "Starter", createFromReply: false, sendAck: true },
  { type: "thread_message", threadId: "123", message: "Hello" },
];

for (const sample of samples) {
  const parsed = parseRichUi(`text <<<POKE_DISCORD_UI ${JSON.stringify(sample)} >>>`);
  if (parsed.ui?.type !== sample.type) throw new Error(`parse failed for ${sample.type}`);
  if (isInteractiveUi(parsed.ui)) JSON.stringify(renderRichUi(parsed.ui, newInteractionId(), "fallback"));
  console.log(sample.type + " ok");
}
