# Slack & Discord notifications

Klaussy can post to a chat channel when an agent finishes, fails, or stops to ask
for permission — and, if you set it up for two-way, let you answer from that
channel without going back to the app.

There are two levels. Pick the one you want; the second is a superset.

| | What you get | What you need |
|---|---|---|
| **Notify only** | Messages arrive in the channel | One webhook URL |
| **Two-way** | Plus **Approve** / **Reject** buttons and text replies | A Slack app or Discord bot |

Everything is configured in **Preferences → Slack & Discord Notifications**.

---

## Level 1 — notify only (2 minutes)

### Slack

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g. `Klaussy`) and pick your workspace.
3. **Incoming Webhooks** → toggle **Activate Incoming Webhooks** on.
4. **Add New Webhook to Workspace**, choose a channel, **Allow**.
5. Copy the `https://hooks.slack.com/services/…` URL into **Slack webhook URL**.

### Discord

1. In your server: **Server Settings → Integrations → Webhooks → New Webhook**.
2. Choose a channel, then **Copy Webhook URL**.
3. Paste it into **Discord webhook URL**.

Click **Send a test message** to confirm it lands. Done — you'll get alerts, but
they're read-only.

---

## Level 2 — two-way (buttons and replies)

A webhook is one-directional: it's a URL you post *to*, so Slack and Discord have
no way to reach back to your machine. To receive a button click, Klaussy opens an
outbound WebSocket to the platform instead. That needs real app credentials, and
no public URL or tunnel — which is why this works from a laptop behind NAT.

> **Read this first.** A button in a channel means **anyone you allow can approve
> a permission prompt on your machine** — including an agent asking to run a
> destructive command. Klaussy requires an explicit allow-list of user IDs, and
> approvals are single-use and expire after 30 minutes. Use a private channel.

### Slack two-way

Continue with the app you made above.

1. **Socket Mode** → toggle **Enable Socket Mode** on.
   - It prompts you to create an **app-level token**. Name it anything, add the
     `connections:write` scope, and **Generate**.
   - Copy the `xapp-…` token into **Slack app-level token**.
2. **OAuth & Permissions** → **Scopes → Bot Token Scopes**, add:
   - `chat:write` — post the alerts
   - `channels:history` (public channels) or `groups:history` (private) — read
     your threaded replies
3. **Install App** → **Install to Workspace** → **Allow**.
   - Copy the **Bot User OAuth Token** (`xoxb-…`) into **Slack bot token**.
4. **Event Subscriptions** → toggle on, then under **Subscribe to bot events**
   add `message.channels` (or `message.groups` for a private channel).
   *Skip this if you only want buttons, not text replies.*
5. In Slack, invite the bot to the channel: `/invite @Klaussy`.
6. Copy the **channel ID** into **Slack channel**. (In Slack: right-click the
   channel → **View channel details** → the ID is at the bottom, `C0…`.)
7. Get your own **member ID** (click your avatar → **Profile** → **⋯** → **Copy
   member ID**, `U0…`) and add it to **Who may approve**.

### Discord two-way

Discord needs a bot: a plain channel webhook cannot carry buttons at all.

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → **Add Bot**.
3. **Reset Token** → copy it into **Discord bot token**.
4. Still on the Bot page, under **Privileged Gateway Intents**, enable
   **MESSAGE CONTENT INTENT**.
   *Required for text replies. Without it replies arrive blank; buttons still
   work.*
5. **OAuth2 → URL Generator**: scopes `bot`, bot permissions **Send Messages**
   and **Read Message History**. Open the generated URL and add the bot to your
   server.
6. In Discord, enable **User Settings → Advanced → Developer Mode**, then
   right-click your channel → **Copy Channel ID** → paste into **Discord
   channel**.
7. Right-click your own name → **Copy User ID** and add it to **Who may
   approve**.

---

## Using it

- **Approve / Reject** — buttons appear on approval alerts once two-way is set
  up. Clicking one sends `y` or `n` to the agent and edits the message to record
  who decided.
- **Text replies** — reply *in the thread* (Slack) or use **Reply** on the
  message (Discord). The text is pasted into that agent's terminal. Use this for
  prompts that want something other than y/n, such as a numbered menu — send
  `1`.
- **Per session** — each task row in the sidebar has a 🔔. It starts in the
  position set by *Turn the bell on for new sessions*, and your click for a given
  task sticks.

Replies only reach a session while its agent is still running. Once an agent
exits, Klaussy turns that tab into a plain shell — replies to its old alerts are
refused rather than typed into your shell.

## If something doesn't work

| Symptom | Cause |
|---|---|
| Test message works, buttons don't appear | Two-way isn't configured — buttons need the app/bot tokens, not just a webhook. |
| Buttons appear, clicking says "not on the allow-list" | Your user ID isn't in **Who may approve**. It must be the ID (`U0…` / a long number), not your display name. |
| "That request expired" | Approvals last 30 minutes; answer in Klaussy. |
| "That request was already answered" | Single-use by design — someone clicked first, or the prompt was answered in the app. |
| Discord replies arrive empty | **MESSAGE CONTENT INTENT** is off. |
| Slack thread replies do nothing | Missing `message.channels` / `message.groups` event subscription, or the bot isn't in the channel. |
| Nothing arrives at all | Check the session's 🔔 is on and the event type isn't unticked. |

## Where the credentials live

Tokens are stored in plaintext in Klaussy's `config.json`
(`~/Library/Application Support/Klaussy/config.json` on macOS). Anyone who can
read that file can post as your bot and, if allow-listed, drive your agents.
Revoke a leaked token in the Slack app dashboard or the Discord developer portal.
