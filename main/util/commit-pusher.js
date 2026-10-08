// Pushes an implement run's work whenever HEAD has moved past the last pushed (or failed) commit.
function createCommitPusher({ getHead, push, onResult, log }) {
  let pushedSha = '';
  let failedSha = '';
  let pushing = false;
  let recheck = '';

  // An unreadable starting HEAD leaves pushedSha empty, so the first commit we can read is pushed (a no-op if nothing changed).
  async function start() {
    try {
      pushedSha = await getHead();
    } catch (err) {
      log(`could not read the starting commit: ${(err && err.message) || err}`);
    }
  }

  async function check(reason) {
    // A check during a push re-runs after it, so a commit made meanwhile isn't left unpushed.
    if (pushing) {
      recheck = reason;
      log(`${reason}: push in progress, will check again after it`);
      return;
    }
    pushing = true;
    try {
      let sha;
      try {
        sha = await getHead();
      } catch (err) {
        const error = `Could not read the worktree's commit to push it: ${(err && err.message) || err}`;
        log(`${reason}: ${error}`);
        onResult({ error });
        return;
      }
      if (sha === pushedSha || sha === failedSha) {
        log(`${reason}: no new commit, not pushing`);
        return;
      }
      log(`${reason}: new commit ${sha.slice(0, 7)}, pushing`);
      const result = await push().catch((err) => ({ error: (err && err.message) || String(err) }));
      if (result && result.error) {
        failedSha = sha;
        log(`push failed: ${result.error}`);
      } else {
        pushedSha = sha;
      }
      onResult(result);
    } finally {
      pushing = false;
    }
    if (recheck) {
      const again = recheck;
      recheck = '';
      await check(again);
    }
  }

  return { start, check };
}

module.exports = { createCommitPusher };
