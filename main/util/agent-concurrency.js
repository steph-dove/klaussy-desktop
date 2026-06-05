// Guard against concurrent sessions for agents whose CLI signs in with
// single-use, rotating OAuth refresh tokens (Codex today). When two such
// processes refresh the token at the same moment they rotate it out from under
// each other, and OpenAI invalidates both — `refresh_token_reused` /
// `token_invalidated` — forcing a `codex login` before anything works again.
//
// We track how many sessions each provider has live, and when a provider
// flagged `concurrentAuthUnsafe` already has one running we ask the user before
// starting another. Claude and Gemini don't rotate tokens this way, so they
// aren't flagged and never prompt.
//
// Usage:
//   const sess = beginSession(provider.id);
//   if (!sess.ok) return { cancelled: true }; // user declined the overlap
//   ...spawn the process...
//   ptyProc.onExit(() => sess.release());      // release is idempotent
const { dialog } = require('electron');
const { getProvider } = require('../state/ai-providers');

const activeCounts = new Map(); // providerId -> number of live sessions

function count(id) {
  return activeCounts.get(id) || 0;
}

// Begin a session for `providerId`. Returns { ok, release }:
//   ok=false  → another session is live and the user chose not to overlap;
//               the caller must abort (don't spawn).
//   release() → call exactly once when the process exits (idempotent / safe to
//               call more than once).
function beginSession(providerId) {
  const noop = () => {};
  const prov = getProvider(providerId);
  if (!prov || !prov.concurrentAuthUnsafe) return { ok: true, release: noop };

  if (count(providerId) > 0) {
    const label = prov.displayName || providerId;
    const cmd = prov.defaultBin || providerId;
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Cancel', 'Start anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: `${label} is already running`,
      message: `A ${label} session is already active.`,
      detail:
        `${label} signs in with single-use tokens, so running two ${label} sessions at once can `
        + `invalidate each other's login — you'd then have to run \`${cmd} login\` again before it works.\n\n`
        + `Claude and Gemini don't have this limit. Start this ${label} session anyway?`,
    });
    if (choice !== 1) return { ok: false, release: noop };
  }

  activeCounts.set(providerId, count(providerId) + 1);
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      activeCounts.set(providerId, Math.max(0, count(providerId) - 1));
    },
  };
}

function activeCount(providerId) {
  return count(providerId);
}

module.exports = { beginSession, activeCount };
