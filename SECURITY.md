# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use one of these private channels:

- **Preferred:** GitHub's private vulnerability reporting — go to the
  **Security** tab of this repo and click **"Report a vulnerability."**
- **Email:** `doverstephaniem@gmail.com` with the subject line
  `[security] klaussy-desktop`.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof of concept is ideal).
- The Klaussy version (Cmd+K → About Klaussy) and your OS.
- Any relevant logs (Cmd+K → View Logs), with secrets redacted.

We'll acknowledge your report as soon as we can, keep you updated on progress,
and credit you in the release notes once a fix ships (unless you'd prefer to
stay anonymous). Please give us a reasonable window to release a fix before any
public disclosure.

## Supported versions

Security fixes are released against the **latest version** only. Always update
to the newest release: <https://github.com/steph-dove/klaussy-desktop-feedback/releases/latest>.

## Scope notes

Klaussy is a local-first desktop app: it runs coding-agent CLIs in git
worktrees on your own machine, and installs git hooks into repos you point it
at. Reports about credential handling, the IPC/preload boundary, the
prompt-injection read guard, the pre-commit review server's local socket, code
signing, or the auto-updater are especially welcome.
