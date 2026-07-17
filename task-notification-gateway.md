# Task: Slack & Discord Notification Gateway (via Nemesis8 Events)

## 📋 Context & Goal
Provide a webhook notification gateway to monitor and steer running agents remotely. Instead of parsing messy, raw terminal stdout streams for input prompt markers, we will subscribe directly to the **Nemesis8** container lifecycle events. This ensures precise alerts for task completions, crashes, or when an agent is waiting for tool approval.

---

## 📂 Files to Touch
*   `main/util/config.js` (Webhook URL preference mapping)
*   `main/util/nemesis-client.js` (Event listener subscription hook)
*   `main/state/instances.js` (Routing container state changes to the webhook controller)

---

## ⚙️ Functional Requirements
1.  **Event Subscription:** Subscribe to Nemesis8 event streams (WS or HTTP SSE) for active agent containers.
2.  **Notification Triggers:** Dispatch webhooks to Slack/Discord on the following events:
    *   `agent:completed` — Agent finishes its run successfully.
    *   `agent:failed` — Tool execution throws an unhandled error or exit status code != 0.
    *   `agent:approval-required` — Agent is paused, waiting for manual tool approval (Model Context Protocol authorization).
3.  **Contextual Alerts:** Webhooks must list the active workspace path, the container ID, and the exact tool or step requesting authorization.

---

## 🛠️ Implementation Steps
1.  In `main/util/nemesis-client.js`, add an event subscription listener connected to Nemesis8's SSE or WebSocket event API.
2.  In `main/state/instances.js`, bind container lifecycle changes to the notification manager.
3.  Implement a formatting module that converts Nemesis8 events (like approval requests) into Slack/Discord block layouts containing an "Approved / Reject" context overview.

---

## 🧪 Verification Plan
*   **Test Case 1:** Start a mock Nemesis8 runner that triggers an `agent:approval-required` state change event.
*   **Test Case 2:** Verify that the registered Slack/Discord webhook immediately receives a formatted block indicating which tool (e.g., file-write, shell-exec) requires approval.
*   **Test Case 3:** Verify that final exit state events dispatch standard completion or failure notifications with truncated container logs.
