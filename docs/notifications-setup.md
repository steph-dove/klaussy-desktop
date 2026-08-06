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
5. Invite the bot to the channel. Installing the app to the workspace does not
   put it in any channel — open the channel in Slack and send `/invite @Klaussy`
   (use whatever you named the app). Without this, posting fails with
   `not_in_channel`.
6. Copy the **channel ID** into **Slack channel**: right-click the channel →
   **View channel details** → scroll to the bottom, where the ID reads `C0…`.
   That's the ID, not the `#name`.
7. Get your own **member ID**: click your avatar → **Profile** → the **⋯**
   button → **Copy member ID** (`U0…`). Put it in **Who may approve**.

### Discord two-way

Discord needs a bot: a plain channel webhook cannot carry buttons at all.

This uses three separate places. Everything in part A happens **in your web
browser** on the Discord Developer Portal — which is a different site from the
Discord app, and each has its own left-hand menu, so it's worth keeping track of
which one you're in.

**Part A — in the browser, at <https://discord.com/developers/applications>**

1. **New Application** (top right) → name it `Klaussy` → **Create**.

   You land on that application's settings page. Down the **left-hand menu of
   this web page** is a list: *General Information, Installation, OAuth2, Bot,
   …*. That menu is what every "click X" below refers to — not anything in the
   Discord app itself.

2. Click **Bot** in that menu. (On recent portals the bot already exists; if you
   see an **Add Bot** button, click it and confirm.)
3. Click **Reset Token** → **Yes, do it** → **Copy**. This is your **bot
   token** — paste it straight into Klaussy's *Discord bot token* field, since
   the portal will not show it again.
4. Stay on the **Bot** page and scroll to **Privileged Gateway Intents**. Turn
   on **MESSAGE CONTENT INTENT** and save.
   *Only needed for text replies. Without it, buttons still work but replies
   arrive blank.*
5. Now invite the bot. Creating the application did **not** put it in any
   server — you open an invite link yourself.

   Click **General Information** in the left-hand menu, copy the **Application
   ID**, and open this in a new browser tab with your ID pasted in:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=292057844736
   ```

   Then pick your server in the **Add to Server** dropdown → **Continue** →
   **Authorize**.

   `292057844736` is View Channel, Send Messages, Read Message History, Create
   Public Threads, and Send Messages in Threads — Klaussy opens one thread per
   agent session and talks to you inside it.

   *Why not the portal's own generator?* Its Bot Permissions calculator has no
   **Send Messages** checkbox — the one permission that actually posts the
   alerts. (It lists *Send Messages in Threads*, which is a different
   permission and not what's needed.) The integer above sidesteps the calculator
   entirely and doesn't drift when the portal is redesigned.

   If you're already on that OAuth2 page, the quickest route is to tick
   **`bot`** under Scopes (that one alone), copy the **Generated URL** at the
   bottom — it already contains your client_id — and replace its
   `permissions=…` value with `292057844736` before opening it.

**Part B — in the Discord app**

6. Enable **User Settings** (gear, bottom left) **→ Advanced → Developer Mode**.
   Without this the "Copy ID" options don't exist.
7. Right-click the channel you want alerts in → **Copy Channel ID**.
8. Right-click your own name in the member list → **Copy User ID**.

**Part C — in Klaussy, Preferences → Slack & Discord Notifications**

9. Paste the bot token (step 3), channel ID (step 7), and your user ID into
   **Who may approve** (step 8). The status line under that section goes
   *connecting…* → *connected*.

The bot shows **offline** in your server's member list until Klaussy connects —
that's expected, not a failed install.

Two things that quietly block part A:
- You need **Manage Server** permission on a server for it to appear in the
  **Add to Server** dropdown. A server you created yourself always works.
- Recent portals also have an **Installation** page with its own install link.
  Either route works; use the OAuth2 one above if the two disagree.

---

## Using it

Each agent session gets **its own thread**, opened the first time that session
has something to say and named after its worktree and agent
(`auth-refactor (Claude)`). Everything for that session lands in that thread, so
several agents can run at once without their alerts interleaving.

- **Approve / Reject** — buttons appear on approval alerts once two-way is set
  up. Clicking one sends `y` or `n` to the agent and edits the message to record
  who decided. Approval alerts are also surfaced in the parent channel, so one
  waiting on you isn't buried in a thread you haven't opened.
- **Text replies** — just type in the session's thread. Whatever you send is
  pasted into that agent's terminal, which is how you answer a prompt that wants
  something other than y/n — a numbered menu, say: send `1`.
- **Went quiet** — if an agent stops for a while without asking anything (often
  a wall of output waiting to be read), you get a 💤 alert carrying the tail of
  what it wrote, so you can decide from chat whether it needs you. The threshold
  is configurable and defaults to 2 minutes; it's deliberately much longer than
  the 15-second desktop idle notification, which would be unbearable in a
  channel.
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
| Discord alerts post flat, with no thread | The bot lacks **Create Public Threads**. Re-open the `permissions=292057844736` link to re-authorize. |
| Replies in an old thread are ignored | Threads stop routing once their agent exits — the thread stays as history. |
| Nothing arrives at all | Check the session's 🔔 is on and the event type isn't unticked. |
| Too many "went quiet" alerts | Raise the seconds field next to that checkbox, or untick it. |
| Discord bot shows offline in the member list | Expected until Klaussy connects. If it stays offline after saving the token, check the status line in Preferences. |
| Your server isn't in the "Add to Server" dropdown | You need **Manage Server** permission on it. |
| Can't find "Send Messages" in the portal's permission checkboxes | It isn't offered there. Use the `permissions=292057844736` invite link above. |
| Bot is in the server but alerts never post | It was invited without Send Messages. Re-open the `permissions=292057844736` link to re-authorize; no need to remove it first. |
| Slack posts fail with `not_in_channel` | The app is installed but not in the channel — `/invite @Klaussy` there. |

## Where the credentials live

Tokens are stored in plaintext in Klaussy's `config.json`
(`~/Library/Application Support/Klaussy/config.json` on macOS). Anyone who can
read that file can post as your bot and, if allow-listed, drive your agents.
Revoke a leaked token in the Slack app dashboard or the Discord developer portal.
