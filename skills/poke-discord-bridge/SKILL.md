---
name: poke-discord-bridge
description: Use the Poke Discord bridge to send normal messages, interactive choices, buttons, confirmations, native Discord polls, and Discord thread actions through Telegram. Trigger when replying as Poke to a Discord-bridged user and deciding whether to include a POKE_DISCORD_UI block for rich Discord UI, polls, thread creation, or thread messages.
---

# Poke Discord Bridge

Use this skill when responding to a user whose message arrived through the Discord bridge. The bridge sends the user's Discord message to Poke over Telegram and can render selected machine-readable blocks back into Discord.

The bridge hides the machine-readable block from Discord users. The user sees the normal text plus any rendered Discord UI/action.

## Hard Protocol Invariant

The normal response and the full `POKE_DISCORD_UI` JSON block must be sent in one Telegram message. Never split the JSON block across multiple messages. Never send the human text in one message and the JSON in a later message.

The bridge processes Telegram messages individually. If the JSON is split across messages, the bridge will not reconstruct it and the Discord UI/action may fail or leak as plain text.

## Core Rule

Always write the normal human response first. If Discord UI/action would help, append exactly one machine-readable block after it in the same message:

```text
<<<POKE_DISCORD_UI
{ ...json... }
>>>
```

Do not explain the JSON. Do not wrap the block in Markdown code fences in the actual Telegram reply. The bridge parses and hides the block.

Good pattern:

```text
A few solid lunch options. Pick what sounds best.

<<<POKE_DISCORD_UI
{"type":"choice","title":"What should Alex get?","options":[{"label":"Sushi","value":"sushi"},{"label":"Burger","value":"burger"},{"label":"Thai","value":"thai"}]}
>>>
```

Bad pattern:

```text
Here is the JSON I will use: {"type":"choice"}
```

## Supported Types

Use only these active types:

- `choice`
- `multi_choice`
- `buttons`
- `confirm`
- `poll`
- `thread`
- `thread_message`

## Message Context

Discord-originated user messages arrive with metadata like:

```text
[Discord: DM/unknown guild / 1234567890123456789 | Alex @ alx.edits | 987654321098765432] yo im lowk hungry what should i get
```

Use this metadata only for context:

- The first segment identifies Discord guild/channel/thread context.
- The second segment identifies the human speaker.
- The last number is the Discord message ID.

Do not repeat this metadata back to the user unless it is directly useful.

## Selection Feedback

For interactive Components V2 types (`choice`, `multi_choice`, `buttons`, `confirm`), the bridge records the interaction. When the Discord user selects something, the bridge sends a Telegram reply back to Poke:

```text
Selected option: sushi
```

or:

```text
Selected options: sushi, thai
```

Treat that as the user's answer. Continue the conversation normally.

## Type Selection Guide

### Use `choice` for one-of-many decisions

Use when the user should choose exactly one item from a list.

Best for:

- Picking one meal, restaurant, time window, plan, product, route, or preference.
- Replacing ad hoc numbered lists.
- Any case where only one answer should come back.

Do not use for yes/no. Use `confirm` for yes/no and `buttons` for named actions.

Schema:

```json
{
  "type": "choice",
  "title": "Pick lunch",
  "options": [
    { "label": "Sushi", "value": "sushi" },
    { "label": "Burger", "value": "burger" },
    { "label": "Thai", "value": "thai" }
  ]
}
```

Example response:

```text
Low-key hungry but not trying to overthink it? Pick one of these.

<<<POKE_DISCORD_UI
{"type":"choice","title":"Pick lunch","options":[{"label":"Sushi","value":"sushi"},{"label":"Burger","value":"burger"},{"label":"Thai","value":"thai"}]}
>>>
```

Field rules:

- `title`: short visible heading.
- `options`: 1 to 25 options, but keep it under 8 when possible.
- `label`: what Discord shows. Keep under 100 characters; short is better.
- `value`: what comes back to Poke. Use stable lowercase identifiers or concise natural strings.
- Optional: `description`, `emoji` may be included, but keep simple.

### Use `multi_choice` when several answers are allowed

Use when the user can select more than one item.

Best for:

- Choosing multiple cuisines.
- Selecting several constraints.
- Picking multiple tasks, priorities, or ingredients.
- Narrowing a set of preferences.

Schema:

```json
{
  "type": "multi_choice",
  "title": "What sounds good?",
  "minValues": 1,
  "maxValues": 3,
  "options": [
    { "label": "Hot", "value": "hot" },
    { "label": "Cheap", "value": "cheap" },
    { "label": "Healthy", "value": "healthy" },
    { "label": "Nearby", "value": "nearby" }
  ]
}
```

Example response:

```text
Tell me the vibe and I’ll narrow it down.

<<<POKE_DISCORD_UI
{"type":"multi_choice","title":"Lunch vibe","minValues":1,"maxValues":3,"options":[{"label":"Hot","value":"hot"},{"label":"Cheap","value":"cheap"},{"label":"Healthy","value":"healthy"},{"label":"Nearby","value":"nearby"}]}
>>>
```

Field rules:

- `minValues`: usually `1`.
- `maxValues`: usually `2` to `5`; never above number of options.
- Avoid too many options. Discord allows up to 25, but dense menus feel bad.

### Use `buttons` for quick actions

Use when the user is choosing among a small set of action verbs or short outcomes.

Best for:

- `Order`, `Skip`, `Show more`, `Try again`.
- Branching actions where a dropdown feels too heavy.
- 2 to 5 high-confidence next steps.

Do not use `buttons` for long lists. Use `choice` or `poll`.

Schema:

```json
{
  "type": "buttons",
  "title": "What next?",
  "body": "I can narrow this down or give you the fastest option.",
  "buttons": [
    { "label": "Fastest", "value": "fastest", "style": "primary" },
    { "label": "Cheapest", "value": "cheapest", "style": "secondary" },
    { "label": "Surprise me", "value": "surprise", "style": "success" }
  ]
}
```

Example response:

```text
I can optimize for speed, price, or chaos.

<<<POKE_DISCORD_UI
{"type":"buttons","title":"Pick a mode","body":"Choose how you want me to decide.","buttons":[{"label":"Fastest","value":"fastest","style":"primary"},{"label":"Cheapest","value":"cheapest","style":"secondary"},{"label":"Surprise me","value":"surprise","style":"success"}]}
>>>
```

Button styles:

- `primary`: normal main action.
- `secondary`: neutral/less important action.
- `success`: positive confirmation or good outcome.
- `danger`: destructive/cancel/negative action.

Rules:

- Max 5 buttons per row; the bridge chunks rows automatically.
- Keep labels short. Discord button labels should scan instantly.
- Always include `value` so Poke receives a stable selection.

### Use `confirm` for yes/no decisions

Use when the user must approve or reject a single proposed action.

Best for:

- Confirmation before committing.
- “Should I do X?”
- Simple accept/cancel.

Schema:

```json
{
  "type": "confirm",
  "title": "Confirm order?",
  "body": "Go with sushi?",
  "confirmLabel": "Yes",
  "cancelLabel": "No",
  "confirmValue": "yes_sushi",
  "cancelValue": "no"
}
```

Example response:

```text
Sushi is probably the move. Want me to lock that in?

<<<POKE_DISCORD_UI
{"type":"confirm","title":"Confirm lunch","body":"Go with sushi?","confirmLabel":"Yes","cancelLabel":"No","confirmValue":"yes_sushi","cancelValue":"no"}
>>>
```

Rules:

- Use `confirm` instead of two buttons when the semantic meaning is approve/reject.
- Make `confirmValue` and `cancelValue` explicit.
- Keep `body` short.

### Use `poll` for group preference collection

Use when Discord should show a native poll and collect votes over time.

Best for:

- Group decisions.
- “What should we choose?” when multiple Discord users might vote.
- Lightweight async decision-making.
- Cases where Poke does not need an immediate single interaction response.

Do not use `poll` when only one user needs to choose and the answer should immediately drive the conversation. Use `choice` for that.

Schema:

```json
{
  "type": "poll",
  "title": "What should we get for lunch?",
  "options": [
    { "label": "Sushi", "value": "sushi" },
    { "label": "Burger", "value": "burger" },
    { "label": "Thai", "value": "thai" }
  ],
  "durationHours": 24,
  "allowMultiselect": false
}
```

Example response:

```text
If everyone’s voting, I’ll make this a poll.

<<<POKE_DISCORD_UI
{"type":"poll","title":"Lunch vote","options":[{"label":"Sushi","value":"sushi"},{"label":"Burger","value":"burger"},{"label":"Thai","value":"thai"}],"durationHours":24,"allowMultiselect":false}
>>>
```

Field rules:

- `title`: poll question. Keep under 300 characters.
- `options`: Discord native polls support up to 10 answers. The bridge truncates to 10.
- `durationHours`: clamped by bridge from 1 to 768 hours, i.e. 32 days.
- `allowMultiselect`: `true` only when multiple votes are meaningful.

Behavior:

- Poll votes may be forwarded back to Poke as:

```text
[Discord poll] Alex @ alx.edits voted: Sushi
```

- Treat vote messages as signals, not as final unless the user says the poll is done.
- Apps/bots cannot vote in Discord polls.

Limitations:

- Native poll behavior is controlled by Discord.
- Poll creation can fail if the Discord client/server context does not support polls or permissions are missing.

### Use `thread` to create a Discord thread

Use when a topic deserves its own focused conversation inside the configured Discord channel.

Best for:

- Splitting a subtask or plan away from the main channel.
- Longer back-and-forth that would clutter the main channel.
- A decision that needs focused discussion.
- Creating a named workspace for a topic.

Do not use threads in DMs. Discord threads require a guild text/news channel.

Schema:

```json
{
  "type": "thread",
  "title": "Lunch ideas",
  "message": "Let’s decide here. Drop constraints or vote above.",
  "autoArchiveDuration": 1440
}
```

Example response:

```text
This might be easier as its own thread.

<<<POKE_DISCORD_UI
{"type":"thread","title":"Lunch ideas","message":"Let’s decide here. What constraints do we have?","autoArchiveDuration":1440}
>>>
```

Field rules:

- `title`: Discord thread name. Max 100 characters; keep it descriptive.
- `message`: optional starter message posted inside the thread.
- `autoArchiveDuration`: optional Discord auto-archive duration in minutes. Common values: `60`, `1440`, `4320`, `10080`, depending on server settings.

Behavior:

- If the Telegram/Poke message is a reply to a Discord message and that Discord message is in a guild, the bridge may start the thread from that message.
- Otherwise it creates a public thread under the configured Discord channel if the channel supports threads.
- After creation, the bridge sends Poke a Telegram message like:

```text
Discord thread created: Lunch ideas (123456789012345678)
```

Save/use the thread ID when sending later `thread_message` blocks.

Limitations:

- Does not work in DMs.
- Requires bot permissions to create public threads and send messages in threads.
- The configured `DISCORD_CHANNEL_ID` must be a guild text/news channel for general thread creation.

### Use `thread_message` to talk inside a Discord thread

Use when Poke should continue a topic inside an existing thread.

Best for:

- Following up inside a thread created earlier.
- Posting focused updates without cluttering the parent channel.
- Continuing when the user is already talking in a bridged thread.

Schema with explicit thread ID:

```json
{
  "type": "thread_message",
  "threadId": "123456789012345678",
  "message": "Here’s the shortlist: Sushi if you want light, Thai if you want warm, burger if you want fast."
}
```

Example response:

```text
I’ll put the details in the thread.

<<<POKE_DISCORD_UI
{"type":"thread_message","threadId":"123456789012345678","message":"Here’s the shortlist: Sushi if you want light, Thai if you want warm, burger if you want fast."}
>>>
```

Schema without explicit thread ID:

```json
{
  "type": "thread_message",
  "message": "Continuing here because this Telegram message replied to a thread-mapped message."
}
```

Behavior:

- If `threadId` is present, the bridge fetches that Discord thread/channel and sends there.
- If `threadId` is omitted, the bridge sends to the current Discord context inferred from the Telegram reply mapping.
- If the Telegram message replies to a Discord-thread-mapped message, the bridge routes back into that same Discord thread.

Rules:

- Prefer replying in Telegram to the relevant thread-mapped message when possible. That lets the bridge infer the thread.
- Include `threadId` when starting a new branch from outside the reply chain.
- Keep the normal human text and `message` aligned. If both exist, the bridge may use the visible text as the Discord message content.

## Choosing the Right Type

Use this decision table:

| Situation | Type |
|---|---|
| User needs to pick one option | `choice` |
| User can pick several options | `multi_choice` |
| User needs quick action buttons | `buttons` |
| User needs yes/no approval | `confirm` |
| Multiple Discord users should vote | `poll` |
| Topic needs a focused Discord sub-conversation | `thread` |
| Poke should send a message into an existing thread | `thread_message` |
| User just needs an answer | Plain text, no block |

Default to plain text unless the UI/action reduces friction.

## JSON Rules

Follow these strictly:

- Emit valid JSON only inside the block.
- Use double quotes, not single quotes.
- No trailing commas.
- Include `type`.
- Keep labels short.
- Include `value` for all selectable options/buttons.
- Use one block per response.
- Put the block after the normal text.
- Keep the complete block in the same Telegram message as the normal text.
- Never split `<<<POKE_DISCORD_UI`, the JSON body, and `>>>` across separate messages.
- Do not mention that the bridge will hide the JSON unless the user asks about implementation.

## Practical Patterns

### Food recommendation

Use `choice` if Alex is deciding alone:

```text
You sound like you want easy comfort food. I’d pick one of these.

<<<POKE_DISCORD_UI
{"type":"choice","title":"Lunch pick","options":[{"label":"Thai curry","value":"thai_curry"},{"label":"Sushi","value":"sushi"},{"label":"Burger","value":"burger"}]}
>>>
```

Use `poll` if a group is deciding:

```text
I’ll make it voteable.

<<<POKE_DISCORD_UI
{"type":"poll","title":"Team lunch?","options":[{"label":"Thai","value":"thai"},{"label":"Sushi","value":"sushi"},{"label":"Burgers","value":"burgers"}],"durationHours":4,"allowMultiselect":false}
>>>
```

### Need confirmation before action

```text
I can go with that plan. Confirm before I treat it as decided.

<<<POKE_DISCORD_UI
{"type":"confirm","title":"Confirm plan","body":"Proceed with this option?","confirmLabel":"Confirm","cancelLabel":"Cancel","confirmValue":"confirmed","cancelValue":"cancelled"}
>>>
```

### Start focused discussion

```text
This is starting to branch. I’ll make a thread for it.

<<<POKE_DISCORD_UI
{"type":"thread","title":"Restaurant shortlist","message":"Use this thread to narrow restaurant options.","autoArchiveDuration":1440}
>>>
```

### Continue in a known thread

```text
I added the next step in the thread.

<<<POKE_DISCORD_UI
{"type":"thread_message","threadId":"123456789012345678","message":"Next step: pick budget and distance, then I’ll narrow to three places."}
>>>
```

## Failure Handling

If the bridge reports an unsupported UI, switch to one of the supported types.

If thread creation fails:

- Check whether the Discord target is a guild text/news channel, not a DM.
- Fall back to plain text or `poll`/`choice` in the current channel.
- Do not keep retrying the same thread block unless the channel context changes.

If a poll fails:

- Reduce answers to 2-10.
- Ensure every answer has a short `label`.
- Try plain text plus `choice` if only one user needs to decide.

If an interactive selection expires or is already used:

- Send a fresh `choice`, `buttons`, or `confirm` block.
- Do not ask the user to debug the bridge.

## Current Bridge Constraints

The bridge currently treats these as stable:

- Plain text
- Attachments/media forwarding
- Replies via message mapping
- Unicode reactions
- `choice`
- `multi_choice`
- `buttons`
- `confirm`
- `poll`
- `thread` in guild text/news channels
- `thread_message` to fetchable Discord threads/channels

## Output Checklist

Before sending a rich/action response, verify:

- The normal human answer comes first.
- The JSON block is last.
- The JSON is valid.
- The `type` is supported.
- The UI is actually useful; otherwise plain text is enough.
- For choices/buttons, labels are short and values are present.
- For polls, there are 2-10 options.
- For threads, the target is likely a guild channel or the response has a graceful fallback.
