# Discord (`frogg.discord`)

Mirrors a Frogg host's agents into a Discord server and, once you allow it, lets you drive
them from there. Daemon plugin, Plugins API v2. The bot only makes outbound connections
(Discord Gateway WebSocket + REST), so a host behind NAT needs no open port or public URL.

## What it does

- **A thread per agent** in one text or forum channel. Its first message is a status card
  (status, provider and model, branch, diff stats, usage, PR link), edited in place.
- **Turn progress:** each prompt gets one message listing its tool calls as they run, edited
  as the turn goes. Turn **Show tool calls** off to keep just the prompt.
- **Final answers** posted when an agent finishes or errors, with `+added −removed`. Answers
  too long for a message come as a preview plus an `answer-<id>.md` attachment.
- **Alerts:** the users in **Ping on alerts** are mentioned when an agent finishes, errors or
  asks for permission. Like push notifications, there's no ping while a Frogg app is in active
  use, unless **Ping even while I'm in the app** is on. The thread updates either way.
- **Approve / Deny / Always buttons** on permission requests, showing how long ago each was
  asked. Always only appears when the provider offers a standing rule. Requests answered in
  Frogg first get closed in Discord.
- **`/frogg` commands:**

  | Command | Does | Needs remote control |
  |---|---|---|
  | `/frogg status` | Running, waiting, errored and idle counts | No |
  | `/frogg agents` | Agents with links to their threads | No |
  | `/frogg new workspace prompt [provider] [model] [title]` | Starts an agent and opens its thread | Yes |
  | `/frogg stop [agent]` | Cancels the current turn | Yes |
  | `/frogg reply text [agent] [attachment]` | Sends a message (and an image or file) to the agent | Yes |
  | `/frogg todo add title [description] [project] [priority]` | Adds a project to-do | Yes |

  `agent` and `project` default to the thread you run the command in. Agents started with
  `/frogg new` are labelled `discord.origin=discord` (and `discord.user=<id>`), which is how
  **Open a thread for: Only agents started from Discord** finds them. `workspace`, `provider`,
  `agent` and `project` autocomplete.
- **Plain replies in threads** (optional): with **Read thread messages** on, anything an
  allowlisted user types in an agent's thread goes to that agent (images and files included).
  ✅ means it was delivered and 🔒 means remote control is off.
- **Bot status** shows how many agents are running or waiting.

## Security model

A Discord account that can message an agent can make it run code on your host. So:

1. **Bound to one server and channel.** The plugin only answers in the configured server, in
   the agents channel, its threads, and any **Extra command channel IDs**.
2. **User allowlist.** Only users listed in **Allowed Discord user IDs** can run commands, use
   autocomplete, press buttons or have their thread messages forwarded. An empty list means
   nobody. Server roles and permissions are not trusted.
3. **Read-only until remote control is on.** `agent.manage`, `agent.permissions`,
   `todos.write` and replies to agents are installed switched off, and the host enforces it.
   The host owner enables it with:

   ```bash
   frogg plugins remote-control frogg.discord on
   ```

   Until then, permission requests don't reach Discord and every write command explains that
   remote control is off. The switch applies live: turning it on posts any pending requests
   with buttons, and turning it off removes the buttons from open requests.
4. **Audited.** Every write names the Discord user who caused it (`actor: "discord:<userId>"`)
   in the host's audit log.
5. **No mass pings.** Agent text has `@everyone`, `@here` and role mentions defused. Messages
   only ever ping the users in **Ping on alerts**.

## Setup

### 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create
   a **New Application**.
2. Under **Bot**, click **Reset Token** and copy the token. Leave **Public Bot** off.
3. **Privileged Gateway Intents:** none are needed. Enable **Message Content Intent** only if
   you'll turn on **Read thread messages**. Otherwise login fails with a "disallowed intents"
   error, which the plugin's panel explains.

### 2. Collect IDs

In Discord, go to **User Settings → Advanced** and turn on **Developer Mode**. Then right-click
to **Copy ID** on:

- the server (**Server ID**);
- the channel agents should live in (**Agents channel ID**). Use a text channel for plain
  threads or a forum channel for one post per agent;
- each person allowed to drive Frogg (**Allowed Discord user IDs**, comma-separated).

### 3. Install and configure

Install **Discord** from the plugin catalog (or `frogg plugins link .` in developer mode), then
fill in its settings. The **Discord** panel shows the connection state and, once the token is
in, an invite link scoped to your server.

You can also build the invite link by hand:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=326417632320&guild_id=<SERVER_ID>
```

`326417632320` covers View Channel, Send Messages, Send Messages in Threads, Create Public
Threads, Manage Threads (to archive finished agents), Embed Links, Attach Files, Read Message
History and Add Reactions. The bot never asks for Administrator.

Slash commands are registered to the configured server when the bot connects, so they appear
immediately. Settings changes reconnect the bot automatically. **Discord: reconnect** in the
Command Center forces it.

### Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `botToken` | secret | required | Bot token |
| `guildId` | string | required | The one server this host is bound to |
| `channelId` | string | required | Text or forum channel for agent threads |
| `allowedUserIds` | string | required | Comma-separated user IDs allowed to drive Frogg |
| `extraChannelIds` | string | empty | More channels where `/frogg` is accepted |
| `mentionUserIds` | string | empty | Users pinged on alerts |
| `threads` | select | `all` | `all`: every agent that runs; `discord`: only agents started from Discord |
| `alertWhenAppActive` | boolean | `false` | Ping even while a Frogg app is in active use |
| `readThreadMessages` | boolean | `false` | Forward plain thread messages (needs Message Content intent) |
| `showToolCalls` | boolean | `true` | List tool calls in turn progress messages |
| `presence` | boolean | `true` | Show the agent count as the bot's status |
| `threadArchiveMinutes` | select | `1440` | Discord's auto-archive for idle threads (60, 1440, 4320, 10080) |

## Rate limits

Status cards and turn progress messages are debounced per message: at most one edit every
2–2.5 seconds, and never more than 6–8 seconds behind. Bot status updates are debounced to
10–30 seconds. discord.js queues anything Discord still rate-limits. Threads are never renamed
(Discord allows two renames per thread per 10 minutes), so status lives in the card.

## State

`<dataDir>/state.json` maps agents to their thread, status message and timeline cursor, and
pending permission buttons to their requests. After a restart the bot keeps editing the same
threads and replays up to 500 timeline entries per agent from where it left off. It closes
permission messages that were answered while it was offline and posts any it missed. Deleting
a thread or its status message by hand makes the plugin forget it, and a new thread opens on
the agent's next activity.

## Develop

```bash
npm install                  # from the repo root
npm run typecheck --workspace=frogg.discord
npm test --workspace=frogg.discord     # node --test; pure modules only
npm run build --workspace=frogg.discord  # bundles discord.js into dist/daemon.js
frogg plugins link plugins/integrations/frogg.discord   # developer mode
```

Layout: `src/daemon.ts` (lifecycle, panel), `src/bridge.ts` (Frogg → Discord),
`src/interactions.ts` (Discord → Frogg), and pure `config.ts`, `access.ts`, `format.ts`,
`debounce.ts`, `state.ts` and `commands.ts`.

## Not yet

- **Voice notes.** Discord voice messages are OGG/Opus, but `ctx.speech.transcribe` takes raw
  PCM16. This needs the host to accept encoded audio, or an Opus decoder bundled here.
