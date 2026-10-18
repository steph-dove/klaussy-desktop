# Environment variables

Klaussy runs fine with none of these set. They change where it looks for
things, which credentials it falls back to, and how much it logs.

## Shell, paths and system

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `HOME` | Home directory used to find agent data (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.copilot`, `~/.kimi-code`, `~/.local/share`), Claude settings and MCP config. | `os.homedir()` | `main/ipc/files.js`, `main/ipc/tasks.js`, `main/state/ai-providers.js`, `main/state/instances.js`, `main/state/token-usage.js`, `main/util/agent-transcript.js`, `main/util/claude-paths.js`, `main/util/copilot-sessions.js`, `main/util/mcp-config.js` |
| `USERPROFILE` | Home directory for locating `Downloads` when Electron can't report the downloads folder and `HOME` is unset. | `os.homedir()` | `main/ipc/files.js` |
| `SHELL` | Shell for embedded terminals on macOS and Linux, used only if the path exists. Also the shell run as `$SHELL -lic` to read your login `PATH`. | Terminals: first of `/bin/zsh`, `/bin/bash`, `/bin/sh` that exists. Login `PATH` probe: `/bin/bash`. | `main/util/platform.js`, `main/util/spawn-path.js` |
| `PATH` | Search path for the CLIs klaussy launches. Klaussy prepends known install dirs (pipx, pip `--user`, Homebrew and others), then merges in your login shell's `PATH` (macOS/Linux) or the registry `Path` (Windows), and writes the result back so child processes inherit it. | Inherited from the launching process | `main/util/spawn-path.js` |
| `TERMINAL` | Linux only. Terminal emulator opened for `claude mcp login`, tried before `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `alacritty`, `kitty` and `xterm`. | Unset (first of that list on `PATH`) | `main/ipc/mcp.js` |
| `APPDATA` | Windows. Where pip `--user` scripts are looked for (`%APPDATA%\Python\*\Scripts`), and opencode's config dir when `XDG_CONFIG_HOME` is unset. Last fallback for opencode's data dir. | Unset | `main/util/spawn-path.js`, `main/state/opencode-config.js` |
| `LOCALAPPDATA` | Windows. opencode's data dir (sessions, `opencode.db`) when `XDG_DATA_HOME` is unset. | Unset | `main/state/ai-providers.js`, `main/state/opencode-config.js`, `main/state/token-usage.js` |
| `XDG_CONFIG_HOME` | opencode's config dir, on every platform. | `~/.config` (or `%APPDATA%` on Windows) | `main/state/opencode-config.js` |
| `XDG_DATA_HOME` | opencode's data dir, on every platform. Klaussy reads opencode sessions and token usage from `<dir>/opencode`. | `~/.local/share` (or `%LOCALAPPDATA%` on Windows) | `main/state/ai-providers.js`, `main/state/opencode-config.js`, `main/state/token-usage.js` |

## AI providers

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `KIMI_CODE_HOME` | Kimi Code's home directory, where klaussy reads its sessions. Blank values are ignored. | `$HOME/.kimi-code` | `main/state/ai-providers.js` |

## GitHub

Klaussy doesn't authenticate with these, `gh` does. Klaussy only reads them to
explain failures. While either is set, `gh` uses it over any signed-in
account, so switching accounts won't fix a 404 or 403.

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `GH_TOKEN` | If set, a "not found" error from `gh` names this variable and suggests unsetting it. If the token is a fine-grained PAT, the message says it only reaches the repositories it was granted. | Unset | `main/util/gh-error.js` |
| `GITHUB_TOKEN` | Same as `GH_TOKEN`; checked only when `GH_TOKEN` is unset. | Unset | `main/util/gh-error.js` |

## GitLab

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `GITLAB_TOKEN` | GitLab token, used only when `glab config get token` returns nothing for the host or globally. Klaussy passes it to `glab` as `GL_TOKEN` (with `GL_HOST`) and uses it to clone GitLab repos for PR review. Also named in auth error messages. | Unset | `main/util/glab-exec.js`, `main/util/glab-error.js` |
| `GL_TOKEN` | Same as `GITLAB_TOKEN`; checked only when `GITLAB_TOKEN` is unset. | Unset | `main/util/glab-exec.js`, `main/util/glab-error.js` |
| `CI_JOB_TOKEN` | Only named in auth error messages, when neither of the above is set. Klaussy never uses it as a token. | Unset | `main/util/glab-error.js` |

## Bitbucket

Klaussy looks for Bitbucket credentials in this order: accounts saved under
**Preferences → Git Accounts**, a token or password in the app config, these
environment variables, `~/.netrc`, then the git credential helper.

Within the environment it tries a token first:

1. `BITBUCKET_TOKEN`, else `BITBUCKET_BEARER_TOKEN`. The username is the first
   of `BITBUCKET_EMAIL`, `BITBUCKET_USERNAME`, `BITBUCKET_USER` that's set.
   With a username, the token is sent as a basic-auth password. Without one,
   it's sent as a bearer token, unless it starts with `ATATT` (an Atlassian API
   token), which always needs a username.
2. Otherwise `BITBUCKET_APP_PASSWORD`, else `BITBUCKET_PASSWORD`, together with
   `BITBUCKET_USERNAME`, else `BITBUCKET_USER`. Both halves must be set.

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `BITBUCKET_TOKEN` | Bitbucket access token or Atlassian API token. | Unset | `main/util/bitbucket-api.js` |
| `BITBUCKET_BEARER_TOKEN` | Same as `BITBUCKET_TOKEN`; used when it's unset. | Unset | `main/util/bitbucket-api.js` |
| `BITBUCKET_EMAIL` | Username sent with a token. With an `ATATT` token and no username containing `@`, this is used as the account email if it contains `@`; otherwise klaussy falls back to `git config user.email`. | Unset | `main/util/bitbucket-api.js` |
| `BITBUCKET_USERNAME` | Username sent with a token (if `BITBUCKET_EMAIL` is unset) or with an app password. | Unset | `main/util/bitbucket-api.js` |
| `BITBUCKET_USER` | Same as `BITBUCKET_USERNAME`; used when it's unset. | Unset | `main/util/bitbucket-api.js` |
| `BITBUCKET_APP_PASSWORD` | App password, used with `BITBUCKET_USERNAME` or `BITBUCKET_USER`. | Unset | `main/util/bitbucket-api.js` |
| `BITBUCKET_PASSWORD` | Same as `BITBUCKET_APP_PASSWORD`; used when it's unset. | Unset | `main/util/bitbucket-api.js` |

## Pre-commit review hook

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `KLAUSSY_REVIEW_SOCK` | Socket the review hook clients try first, so a commit made in a klaussy terminal is reviewed in that window. They then try every instance registered in `~/.klaussy/sockets`. Klaussy sets this for its own terminals (see below); you don't normally set it. | Set by klaussy | The hook client scripts generated by `main/state/precommit-hook.js` and `main/util/claude-hooks.js` |

## Debugging and testing

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `KLAUSSY_E2E` | Any non-empty value skips the single-instance lock and the dev `userData` isolation, the external CLI check, the background install/upgrade of the repo-analysis CLIs, and the opencode context check at startup. Meant for the Playwright tests. | Unset | `main/bootstrap/app-events.js`, `main/bootstrap/single-instance.js` |
| `KLAUSSY_DEBUG_MIRROR` | Any non-empty value logs a `[mirror]` line for each piece of terminal text mirrored into chat, showing whether it came from a transcript or a screen scrape. | Unset | `main/state/instances.js` |
| `KLAUSSY_WATCH_DEBUG` | Set to `1` to log every file change that gets past the watcher's ignore list. Useful for tracking down an endless reload. | Unset | `main/state/watcher.js` |

## Release script

| Variable | What it changes | Default | Read in |
|---|---|---|---|
| `RELEASE_GH_USER` | GitHub account `npm run release:mac` switches `gh` to before publishing. If that account isn't logged in, the script keeps the current one. | The publishing repo's owner | `scripts/release-mac.js` |

## Variables klaussy sets for child processes

Klaussy puts these in the environment of the terminals and commands it
starts. You shouldn't need to set any of them, except maybe
`KLAUSSY_SKIP_REVIEW`.

| Variable | Value | Set in |
|---|---|---|
| `TERM` | `xterm-256color`, for every embedded terminal | `main/ipc/tasks.js`, `main/state/instances.js`, `main/state/pr-chat-pty.js`, `main/state/pr-implement-pty.js` |
| `KLAUSSY_REVIEW_SOCK` | This instance's review socket, set on klaussy's own process once the review server is listening, so its terminals inherit it | `main/state/precommit-hook.js` |
| `KLAUSSY_SESSION_NOTES_DIR` | The shared session-notes directory, for agent terminals | `main/state/session-context.js` |
| `KLAUSSY_SESSION_ID` | An ID for the terminal, set alongside `KLAUSSY_SESSION_NOTES_DIR` | `main/state/session-context.js` |
| `KLAUSSY_SKIP_REVIEW` | `1`, for commits made from the diff panel (which runs its own review) and for autofix commits | `main/ipc/git.js`, `main/state/pr-monitor.js` |

The pre-commit and pre-push hooks klaussy installs exit straight away when
`KLAUSSY_SKIP_REVIEW` is non-empty. Set it yourself
(`KLAUSSY_SKIP_REVIEW=1 git commit ...`) to skip the review for one commit or
push. The commit-msg and post-commit hooks ignore it.