# Task: Remote Containerized Execution (via Nemesis8)

## 📋 Context & Goal
Support offloading agent processing to a remote environment. Instead of setting up raw remote Git directories and manually managing SSH environments, Klaussy Desktop will integrate with a remote **Nemesis8** daemon (https://github.com/DeepBlueDynamics/nemesis8). This allows us to execute terminal agents inside sealed, isolated Docker containers, eliminating remote dependency issues and securing the agent's blast radius.

---

## 📂 Files to Touch
*   `main/util/nemesis-client.js` (New client wrapper to interact with Nemesis8 CLI/HTTP API)
*   `main/state/instances.js` (Modify terminal PTY lifecycles to bridge to Nemesis8 containers)
*   `main/util/config.js` (Configure remote Nemesis8 host addresses and authentication tokens)

---

## ⚙️ Functional Requirements
1.  **Nemesis8 Client:** Connect to a remote Nemesis8 daemon API using client credentials.
2.  **Container Lifecycle:** When a new tab/task is spawned in Klaussy, trigger `nemesis8 run --volume <workspace> --image <agent-image>` to spin up a sealed container.
3.  **PTY Stream Bridging:** Hook the local Electron xterm pane directly into the remote container's standard input/output streams.
4.  **State Serialization:** Leverage Nemesis8's session save/resume features to support session persistence and seamless cross-agent handoffs.

---

## 🛠️ Implementation Steps
1.  Create `main/util/nemesis-client.js` with helper functions to connect to the Nemesis8 server, list active containers, run a new agent task, and capture stdout/stdin sockets.
2.  In `main/state/instances.js`, modify `spawnInstance` to check if remote execution is active. If so, instead of spawning a local node-pty shell, call `nemesisClient.spawnContainer` and pipe the resulting socket stream directly to the renderer's xterm subscribers.
3.  Implement file-watching sync via Nemesis8's workspace mounting or file-write hooks, ensuring edits made inside the sealed container are synced back to the local repository.

---

## 🧪 Verification Plan
*   **Test Case 1:** Start a local Nemesis8 daemon. Configure Klaussy to point to localhost.
*   **Test Case 2:** Open a task tab, type `uname -a`, and verify it runs inside the Docker container environment (e.g. Linux container kernel) rather than the local host macOS.
*   **Test Case 3:** Close the tab, reopen it, and verify that the session rehydrates to its previous terminal prompt state using Nemesis8's state serialization.
