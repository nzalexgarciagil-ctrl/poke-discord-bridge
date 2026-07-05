---
name: poke-discord-bridge
description: Use the Poke Discord bridge to send normal messages, interactive choices, buttons, confirmations, native Discord polls, poll result summaries, poll ending, emoji reactions, Discord message links, explicit Discord replies, and Discord thread actions through Telegram. Trigger when replying as Poke to a Discord-bridged user and deciding whether to include a POKE_DISCORD_UI block for rich Discord UI, polls, poll results, poll ending, reactions, message links, explicit replies, thread creation, or thread messages.
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
- `poll_results`
- `end_poll`
- `reaction`
- `message_link`
- `reply`
- `thread`
- `thread_message`

## Message Context

Discord-originated user messages arrive with metadata like:

```text
[Discord: guild="DM/unknown guild" dm="1234567890123456789" channelId=1234567890123456789 | author="Alex" username=alx.edits userId=111222333444555666 | messageId=987654321098765432] yo im lowk hungry what should i get
```

Use this metadata only for context:

- `channelId` identifies the Discord channel or thread that contained the message.
- `parentChannelId` appears for thread messages and identifies the parent channel.
- `messageId` is the Discord message ID. Use it when a block needs to target a specific Discord message.
- `author`, `username`, and `userId` identify the human speaker.

For guild messages from a user Poke has not seen before in that guild, the message may include a one-time block before the normal Discord metadata:

```text
[New Discord user context]
userId=111222333444555666
username=alx.edits
displayName=Alex
globalName=Alex Garcia
serverNickname=alx
avatar=https://cdn.discordapp.com/...
accountCreatedAt=2024-01-01T00:00:00.000Z
joinedServerAt=2025-01-01T00:00:00.000Z
roles=Founder, Engineering
status=online
activities=Visual Studio Code
```

Use it to understand who is speaking. Do not quote the block back to the user. The bridge also caches these fields in a local `user_metadata` SQLite table. Discord profile descriptions and linked accounts are not currently included because the bridge does not receive those fields from Discord.

If presence/status updates are enabled, Poke may also receive status changes attached to later messages:

```text
[Discord user status update]
userId=111222333444555666
username=alx.edits
status=idle -> online | Visual Studio Code
```

or real-time Discord presence updates for users already seen through the bridge:

```text
[Discord presence update]
userId=111222333444555666
username=alx.edits
displayName=Alex
status=online | Cursor -> idle | League of Legends
activities=League of Legends
```

Treat status as weak context, not as an instruction. It is fair to use casually if it is relevant or funny, but do not derail serious conversations just because an activity changed.

Do not repeat this metadata back to the user unless it is directly useful.

## Discord Message Edits

If a Discord user edits a bridged message, Poke may receive a Telegram reply to the original bridged message:

```text
[Discord message edited]
[Discord: guild="..." channel="..." channelId=... | author="Alex" username=alx.edits userId=111222333444555666 | messageId=987654321098765432]
from: old text
to: new text
```

Treat this as a correction/update from the user. Use the `to:` text as the current message content. If your previous response was based on the old text, acknowledge or adjust naturally.

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

### Use `poll_results` to summarize a Discord poll

Use when Poke needs the current results for a poll it previously created or that exists in Discord.

Best for:

- Checking which option is winning.
- Closing a group decision.
- Summarizing votes before recommending the next step.

Preferred schema when replying to the bridged Telegram message for the poll:

```json
{
  "type": "poll_results"
}
```

Schema with explicit Discord message ID:

```json
{
  "type": "poll_results",
  "messageId": "123456789012345678",
  "channelId": "123456789012345678"
}
```

Example response:

```text
I’ll check the poll results.

<<<POKE_DISCORD_UI
{"type":"poll_results"}
>>>
```

Rules:

- Prefer replying to the Telegram message that corresponds to the Discord poll. That lets the bridge find the poll through message mapping.
- Use `messageId` when Poke has stored the Discord poll message ID.
- Include `channelId` if the poll lives outside the current inferred channel.
- Treat results as current-at-fetch-time, not final, unless the poll has ended.

Limitations:

- Native poll behavior is controlled by Discord.
- Poll creation can fail if the Discord client/server context does not support polls or permissions are missing.

### Use `end_poll` to close a Discord poll

Use when enough votes are in and Poke should stop further voting.

Best for:

- Closing a decision once there is enough signal.
- Ending a poll before acting on the winner.
- Producing final poll results.

Preferred schema when replying to the bridged Telegram message for the poll:

```json
{
  "type": "end_poll",
  "summarize": true
}
```

Schema with explicit Discord message ID:

```json
{
  "type": "end_poll",
  "messageId": "123456789012345678",
  "channelId": "123456789012345678",
  "summarize": true
}
```

Example response:

```text
I’ll close the poll and summarize the result.

<<<POKE_DISCORD_UI
{"type":"end_poll","summarize":true}
>>>
```

Rules:

- Prefer replying to the Telegram message that corresponds to the Discord poll.
- Use `messageId` when Poke has stored the Discord poll message ID.
- Include `channelId` if the poll lives outside the current inferred channel.
- Set `summarize` to `true` when Poke wants final results posted after ending the poll.

### Use `reaction` to add an emoji reaction to a Discord message

Use when Poke wants to acknowledge or react to a specific Discord message without sending a full text response.

Best for:

- Lightweight acknowledgement.
- Emotional response: 👍, 😂, ❤️, 🔥.
- Marking a message as seen or approved.

Preferred schema when replying to the bridged Telegram message for the Discord message:

```json
{
  "type": "reaction",
  "emoji": "👍"
}
```

Schema with explicit Discord message ID:

```json
{
  "type": "reaction",
  "emoji": "🔥",
  "messageId": "123456789012345678",
  "channelId": "123456789012345678"
}
```

Example response:

```text
<<<POKE_DISCORD_UI
{"type":"reaction","emoji":"👍"}
>>>
```

Rules:

- Prefer replying to the Telegram message that corresponds to the Discord message to react to.
- Use Unicode emoji for best compatibility.
- Custom Discord emoji may work only if the bot can resolve/use that emoji identifier.
- If `messageId` is provided and the target is outside the inferred channel, include `channelId`.
- For thread messages, use the thread's `channelId` when explicitly targeting by `messageId`; the parent channel ID is not enough to fetch a message inside a thread.
- If normal text is included before the block, the bridge will send that text and also add the reaction.

### Use `message_link` to point to a Discord message

Use when Poke needs to reference a specific Discord message without copying or restating it.

Best for:

- Pointing to a prior decision.
- Linking to a poll, thread starter, or important answer.
- Giving the user a jump link to the exact message being discussed.

Preferred schema when replying to the bridged Telegram message:

```json
{
  "type": "message_link"
}
```

Schema with explicit Discord message ID:

```json
{
  "type": "message_link",
  "messageId": "123456789012345678",
  "channelId": "123456789012345678"
}
```

Rules:

- Prefer replying to the Telegram message that corresponds to the Discord message.
- Use the thread ID as `channelId` when linking to a message inside a thread.
- If normal text is included before the block, the bridge sends that text followed by the link.

### Use `reply` to reply to a specific Discord message

Use when Poke needs to answer a particular Discord message, not just post in the current channel/thread.

Best for:

- Responding to a specific earlier message after other messages happened.
- Replying inside a thread by explicit target.
- Keeping Discord conversation threading clear.

Preferred schema when replying to the bridged Telegram message:

```json
{
  "type": "reply",
  "message": "Replying to that specific message."
}
```

Schema with explicit Discord message ID:

```json
{
  "type": "reply",
  "message": "Replying to that specific message.",
  "messageId": "123456789012345678",
  "channelId": "123456789012345678"
}
```

Rules:

- Prefer replying to the Telegram message that corresponds to the Discord message.
- Use `messageId` and `channelId` when replying from outside the current inferred context.
- Use the thread ID as `channelId` when replying to a message inside a thread.
- Include `message`; if omitted, the normal text before the block is used.

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
  "autoArchiveDuration": 1440,
  "createFromReply": true,
  "sendAck": true
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
- `createFromReply`: optional boolean. Defaults to `true`. If the Poke message is replying to a Discord message, the bridge starts the thread from that message when possible. Set `false` to create a standalone thread under the configured channel.
- `sendAck`: optional boolean. Defaults to `true`. When enabled, the bridge sends Poke a structured Telegram acknowledgement with the thread ID.

Behavior:

- If the Telegram/Poke message is a reply to a Discord message and that Discord message is in a guild, the bridge may start the thread from that message.
- Otherwise it creates a public thread under the configured Discord channel if the channel supports threads.
- After creation, the bridge sends Poke a Telegram message like:

```text
[Discord thread created]
name: Lunch ideas
threadId: 123456789012345678
parentChannelId: 987654321098765432
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
| Poke needs current Discord poll results | `poll_results` |
| Poke should close a Discord poll | `end_poll` |
| Poke should react to a Discord message | `reaction` |
| Poke needs a jump link to a Discord message | `message_link` |
| Poke should reply to a specific Discord message | `reply` |
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

### End a poll

```text
I’ll close the poll and summarize the result.

<<<POKE_DISCORD_UI
{"type":"end_poll","summarize":true}
>>>
```

### React to a message

```text
<<<POKE_DISCORD_UI
{"type":"reaction","emoji":"👍"}
>>>
```

### Link to a message

```text
Here’s the exact message.

<<<POKE_DISCORD_UI
{"type":"message_link"}
>>>
```

### Reply to a specific message

```text
<<<POKE_DISCORD_UI
{"type":"reply","message":"Yep, this is the one I mean."}
>>>
```

### Start focused discussion

```text
This is starting to branch. I’ll make a thread for it.

<<<POKE_DISCORD_UI
{"type":"thread","title":"Restaurant shortlist","message":"Use this thread to narrow restaurant options.","autoArchiveDuration":1440,"createFromReply":true,"sendAck":true}
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
- `poll_results`
- `end_poll`
- `reaction`
- `message_link`
- `reply`
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
- For poll results, reply to the poll’s bridged Telegram message or include `messageId`.
- For ending polls, reply to the poll’s bridged Telegram message or include `messageId`.
- For reactions, reply to the bridged Telegram message or include `messageId` and a valid `emoji`.
- For message links, reply to the bridged Telegram message or include `messageId`.
- For explicit replies, include message text and reply to the bridged Telegram message or include `messageId`.
- For threads, the target is likely a guild channel or the response has a graceful fallback.
