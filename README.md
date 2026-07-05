# Poke Discord Telegram Bridge

A TypeScript Discord bot that lets a Discord channel or DM talk to the Poke Telegram bot through a Telegram user session. Poke remains reachable through Telegram, while Discord users get richer Discord-native interactions.

![Poke Discord Bridge preview](assets/telegram-10439.jpg)

## Features

- Discord messages -> Poke Telegram DM.
- Poke Telegram replies -> Discord.
- One Telegram message maps to one Discord message. The bridge does not batch Poke responses.
- Reply preservation for previously bridged messages.
- Discord message edit notifications to Poke with before/after text.
- Discord attachments -> Telegram files via attachment URL.
- Telegram media -> Discord attachments.
- Unicode reaction forwarding in both directions where possible.
- Discord Components V2 interactions for:
  - `choice`
  - `multi_choice`
  - `buttons`
  - `confirm`
- Native Discord polls via Poke JSON blocks.
- Poll result summaries from existing Discord poll messages.
- Ending Discord polls from Poke.
- Poke-triggered Discord emoji reactions.
- Discord message link generation.
- Explicit Discord reply targeting.
- One-time Discord user context blocks so Poke learns new server participants.
- Discord thread creation and thread message routing for guild text/news channels.
- Discord messages inside threads under the configured parent channel forward back to Telegram.

All Discord users appear to Poke as one Telegram user account. Discord-originated messages include explicit source metadata, including `channelId`, optional `parentChannelId`, `userId`, and `messageId`, so Poke can tell who spoke and target follow-up actions.

## Runtime Requirements

- Node.js 24+.
- pnpm.
- A Discord bot token.
- Telegram API ID/hash from <https://my.telegram.org>.
- A Telegram user session that can message Poke.

Node 24+ is required because this project uses Node's built-in `node:sqlite` module.

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill `bot/.env`. Telegram `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are also loaded from the repo root `.env` if present.

Create a GramJS string session:

```bash
pnpm login
```

Paste the printed value into `TELEGRAM_STRING_SESSION`, or leave `TELEGRAM_STRING_SESSION` empty and use a session file at `TELEGRAM_STRING_SESSION_FILE`.

If converting the existing Telethon session used during development:

```bash
pnpm convert-telethon-session
```

## Running

Development:

```bash
pnpm dev
```

Typecheck/build:

```bash
pnpm check
pnpm build
```

Production build:

```bash
pnpm build
pnpm start
```

Docker:

```bash
docker compose up -d --build
```

The compose file mounts `./data` into the container so SQLite state and Telegram session files survive restarts.

## Discord Requirements

Enable these privileged/intents in the Discord developer portal as needed:

- Message Content intent: required to read Discord message content.
- Poll intents are requested by the bot for poll vote events.
- Guild Presences intent is optional. Enable it only if using presence/status in user context blocks.

The bot needs channel permissions to:

- View channel.
- Read message history.
- Send messages.
- Attach files.
- Add reactions.
- Use external emojis, if desired.
- Create public threads and send messages in threads, if using thread features.

Threads do not work in DMs. Set `DISCORD_CHANNEL_ID` to a guild text/news channel for thread creation.

## Discord message edits

When a bridged Discord message is edited, the bridge sends Poke a Telegram reply to the original bridged message:

```text
[Discord message edited]
[Discord: guild="..." channel="..." channelId=... | author="..." username=... userId=... | messageId=...]
from: old text
to: new text
```

The bridge stores a small `discord_message_snapshot` row for each forwarded Discord message so edits still have reliable before/after text after restarts.

## Discord user context

For guild messages, the bridge stores `(userId, guildId)` in SQLite. The first time a Discord user speaks to Poke in that guild, the Telegram message gets a compact context block before the normal Discord message:

```text
[New Discord user context]
userId=123456789012345678
username=alex
displayName=Alex
globalName=Alex Garcia
serverNickname=alx
avatar=https://cdn.discordapp.com/...
accountCreatedAt=2024-01-01T00:00:00.000Z
joinedServerAt=2025-01-01T00:00:00.000Z
roles=Founder, Engineering

[Discord: guild="..." channel="..." channelId=... | author="..." username=... userId=... | messageId=...] ...
```

The bridge caches profile fields in `user_metadata` only when the user actually sends a bridged message. It does not scan guild members or cache users just because they exist in a server.

Presence/status is optional and only attached to message-triggered user context/status blocks. It requires the `GuildPresences` gateway intent and corresponding developer-portal setting:

```env
BRIDGE_USER_CONTEXT_INCLUDE_PRESENCE=true
BRIDGE_USER_CONTEXT_STATUS_UPDATES=true
```

The bridge does not currently expose Discord profile descriptions or linked accounts because those fields are not available on the `discord.js` `User` object used here.

## Poke UI Protocol

Use this Poke recipe to give Poke the bridge instructions:

```text
https://poke.com/r/NrX10fCvNh0
```

The bridge no longer appends UI instructions to every Discord message. Poke should learn the protocol from the recipe above.

Poke can append one machine-readable block to a normal Telegram message:

```text
Normal message shown to the Discord user.

<<<POKE_DISCORD_UI
{"type":"choice","title":"Pick one","options":[{"label":"A","value":"a"},{"label":"B","value":"b"}]}
>>>
```

The block must be contained in a single Telegram message. The bridge processes Telegram messages individually and will not reconstruct split JSON.

Active supported types:

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

See `skills/poke-discord-bridge/SKILL.md` for full schema guidance and examples.

Poll results can be requested by replying in Telegram to the bridged poll message with:

```text
<<<POKE_DISCORD_UI
{"type":"poll_results"}
>>>
```

or by supplying the Discord poll message ID:

```text
<<<POKE_DISCORD_UI
{"type":"poll_results","messageId":"123456789012345678","channelId":"123456789012345678"}
>>>
```

Poke can end a Discord poll by replying in Telegram to the bridged poll message:

```text
<<<POKE_DISCORD_UI
{"type":"end_poll","summarize":true}
>>>
```

Poke can react to a Discord message by replying in Telegram to the bridged message:

```text
<<<POKE_DISCORD_UI
{"type":"reaction","emoji":"👍"}
>>>
```

or by specifying the Discord message ID:

```text
<<<POKE_DISCORD_UI
{"type":"reaction","emoji":"🔥","messageId":"123456789012345678","channelId":"123456789012345678"}
>>>
```

Poke can generate a Discord message link:

```text
<<<POKE_DISCORD_UI
{"type":"message_link","messageId":"123456789012345678","channelId":"123456789012345678"}
>>>
```

Poke can explicitly reply to a Discord message:

```text
<<<POKE_DISCORD_UI
{"type":"reply","message":"Replying to that specific message.","messageId":"123456789012345678","channelId":"123456789012345678"}
>>>
```

## Data Files

Default local files:

- SQLite map DB: `./data/bridge.sqlite`
- Telegram string session file: `./data/telegram-string-session.txt`
- Temporary media directory: `./data/tmp`
- Development log, if using shell redirection: `./data/bridge-dev.log`

Do not commit `.env`, session files, SQLite databases, logs, or temp media.

## Notes

- Default Poke target username is `interaction_poke_bot`.
- Numeric Telegram user IDs often cannot resolve over MTProto unless the access hash is cached, so username targeting is preferred.
- Custom Discord emoji are skipped for Telegram reactions because Telegram needs custom emoji document IDs, not Discord emoji IDs.
- The Discord bot token used during testing should be rotated before public release.
