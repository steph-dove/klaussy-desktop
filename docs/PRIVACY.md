# Privacy Policy

**Draft — requires legal review before publication.**

*Last updated: {{DATE}}*

## 1. What Klaussy collects

Klaussy is a desktop application. It does not host a backend service of its own.
Information you interact with from within Klaussy goes to third parties whose
policies govern what they collect:

- **Claude Code / Anthropic API.** When you use the terminal, the Plan / Debug
  / Review actions, "Explain diff", inline AI edit, or AI commit-message
  generation, Claude reads the prompt and repository context you provide.
  See Anthropic's privacy policy.
- **GitHub.** When you view / comment on / merge PRs or run CI checks through
  Klaussy, those requests go through your local `gh` CLI to GitHub.
  See GitHub's privacy policy.
- **Ollama (optional).** If you enable inline AI completion, Klaussy runs
  `qwen2.5-coder:1.5b` locally via Ollama. No data leaves your machine.
- **Paddle.** If you purchase a license, Paddle processes your payment and
  emails you the license key. See Paddle's privacy policy.

## 2. What Klaussy stores locally

- Your project list, terminal sessions, notes, and preferences, in
  `~/Library/Application Support/Klaussy/config.json`.
- Logs of main-process activity (errors, updater, license verify), in
  `~/Library/Logs/Klaussy/main.log`. No prompt contents are logged.
- If you activate a license, the license key, associated email, and a
  derived device fingerprint, stored in the same `config.json`.

None of this leaves your machine unless you explicitly sync your home
directory to iCloud, Dropbox, etc.

## 3. What Klaussy sends off-device

- **License verification.** On activation, and weekly thereafter, Klaussy
  sends your license key and a device fingerprint (a non-reversible hash of
  your hostname + username + platform) to Paddle to confirm the license is
  still valid.
- **Update check.** On launch, Klaussy checks our update feed for a newer
  version. The request reveals your IP and the current app version; no
  personal data is sent.

## 4. Telemetry

Klaussy does not send usage analytics or telemetry. We do not track which
features you use, what projects you open, or how often you launch the app.

## 5. Third-party services

Klaussy orchestrates several tools you choose to use. Their policies apply:

- Anthropic (Claude): https://www.anthropic.com/legal/privacy
- GitHub: https://docs.github.com/en/site-policy/privacy-policies
- Paddle: https://www.paddle.com/legal/privacy
- Ollama (local, no data sent off-device)

## 6. Your rights

You can at any time:
- Deactivate your license (About → Manage License).
- Delete your local data by removing
  `~/Library/Application Support/Klaussy` and `~/Library/Logs/Klaussy`.
- Request deletion of the email Paddle associates with your license, by
  contacting Paddle directly (we don't store a customer DB of our own).

## 7. Contact

{{SUPPORT_EMAIL}} — for any privacy-related question.

## 8. Changes to this policy

We'll update this file and bump the "Last updated" date at the top. Material
changes will be noted in the release notes of the version that introduces
them.

{{LAWYER REVIEW: specifically, confirm this is GDPR-compliant for any EU
customers, adjust for CCPA if CA customers are expected, and decide whether
you need a DPA template for any enterprise customers.}}
