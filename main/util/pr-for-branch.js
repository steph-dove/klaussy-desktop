// Looks up the PR for a worktree's branch for the PR tab and the dev-loop panel.
// Runs on the main process, so every gh call here must be async.
const { classifyGhError, activeGhAccountP } = require('./gh-error');

const PR_JSON_FIELDS = 'number,title,state,body,url,headRefName,baseRefName,headRefOid,additions,deletions,reviewDecision,comments,reviews,mergeable,mergeStateStatus,isDraft';
const GH_OPTS = { timeout: 15000, maxBuffer: 10 * 1024 * 1024 };

function errText(err) {
  return String((err && (err.stderr || err.message)) || '');
}

// Never rejects: pr-panel reads result.error without a try/catch.
async function prForBranch(worktreePath, { hint, gh }) {
  // A worktree from "Check out locally" knows its PR number and base repo,
  // which branch matching misses for fork PRs.
  if (hint && hint.prNumber) {
    try {
      const args = ['pr', 'view', String(hint.prNumber), '--json', PR_JSON_FIELDS];
      if (hint.prBaseOwner && hint.prBaseRepo) args.push('-R', `${hint.prBaseOwner}/${hint.prBaseRepo}`);
      const { stdout } = await gh(args, { cwd: worktreePath, ...GH_OPTS });
      return { pr: JSON.parse(stdout) };
    } catch { /* fall through to branch matching */ }
  }

  try {
    const { stdout } = await gh(['pr', 'view', '--json', PR_JSON_FIELDS], { cwd: worktreePath, ...GH_OPTS });
    return { pr: JSON.parse(stdout) };
  } catch (err) {
    const msg = errText(err);
    if (msg.includes('no pull requests found')) return { pr: null };
    // errorKind drives the PR tab's switch-account / sign-in affordances.
    let account = null;
    try { account = await activeGhAccountP(); } catch { /* unknown account */ }
    const cls = classifyGhError(msg, { account });
    return { pr: null, error: cls.summary, errorKind: cls.kind, errorSummary: cls.summary, errorFix: cls.fix };
  }
}

module.exports = { prForBranch, PR_JSON_FIELDS };
