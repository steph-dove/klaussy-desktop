const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { instances } = require('./instances');
const { ghExecP, execFileP } = require('../util/exec');
const { getProvider, binFor, defaultAgentProvider } = require('./ai-providers');
const { allWindows } = require('./windows');
const { loadConfig } = require('../util/config');

let monitorIntervalId = null;
const processedKeys = new Set(); // Track processed SHAs/commentIds to prevent double-runs
const activeFixes = new Set(); // Track taskId currently being fixed to prevent concurrent runs

function startPrMonitor() {
  if (monitorIntervalId) {
    clearInterval(monitorIntervalId);
  }

  const poll = async () => {
    for (const [id, inst] of instances.entries()) {
      if (!inst.alive || !inst.worktreePath || !inst.branch || activeFixes.has(id)) {
        continue;
      }

      try {
        // Query PR info using gh CLI
        const { stdout } = await ghExecP([
          'pr', 'view', inst.branch,
          '--json', 'state,number,url,statusCheckRollup,comments,reviews,headRefOid'
        ], { cwd: inst.worktreePath, timeout: 15000 });

        const pr = JSON.parse(stdout);
        if (!pr || pr.state !== 'OPEN') continue;

        // 1. Check CI status
        const rollup = pr.statusCheckRollup || [];
        const failingChecks = rollup.filter(c => c.conclusion === 'FAILURE' || c.state === 'FAILURE');
        if (failingChecks.length > 0) {
          const ciKey = `ci-${id}-${pr.headRefOid}`;
          if (!processedKeys.has(ciKey)) {
            processedKeys.add(ciKey);
            triggerAutoFix(inst, pr, {
              type: 'ci',
              checks: failingChecks,
              headRefOid: pr.headRefOid
            });
            continue; // Only run one fix at a time per task
          }
        }

        // 2. Check PR comments
        const newComments = [];
        // PR level comments
        if (Array.isArray(pr.comments)) {
          for (const c of pr.comments) {
            // Ignore comments from bots or the user themselves (or empty comments)
            if (!c || !c.id || !c.body || c.author?.login === 'steph-dove' || c.author?.login === 'klaussy-bot') continue;
            const commentKey = `comment-${c.id}`;
            if (!processedKeys.has(commentKey)) {
              newComments.push(c);
            }
          }
        }
        // Inline code comments inside reviews
        if (Array.isArray(pr.reviews)) {
          for (const r of pr.reviews) {
            if (Array.isArray(r.comments)) {
              for (const c of r.comments) {
                if (!c || !c.id || !c.body || c.author?.login === 'steph-dove' || c.author?.login === 'klaussy-bot') continue;
                const commentKey = `comment-${c.id}`;
                if (!processedKeys.has(commentKey)) {
                  newComments.push(c);
                }
              }
            }
          }
        }

        if (newComments.length > 0) {
          // Sort by creation time and take the latest one or process them
          const latestComment = newComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
          const commentKey = `comment-${latestComment.id}`;
          processedKeys.add(commentKey);
          // Mark all unseen comments as processed so we don't double-trigger
          newComments.forEach(c => processedKeys.add(`comment-${c.id}`));

          triggerAutoFix(inst, pr, {
            type: 'comment',
            comment: latestComment
          });
        }
      } catch (err) {
        // Ignore errors (e.g. no PR found for branch)
      }
    }
  };

  // Poll every 45 seconds
  monitorIntervalId = setInterval(poll, 45000);
}

function stopPrMonitor() {
  if (monitorIntervalId) {
    clearInterval(monitorIntervalId);
    monitorIntervalId = null;
  }
}

async function triggerAutoFix(inst, pr, event) {
  const taskId = inst.id;
  activeFixes.add(taskId);

  const broadcastStatus = (status, message) => {
    for (const win of allWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('pr-autofix-status', { taskId, status, message, prUrl: pr.url });
      }
    }
  };

  broadcastStatus('started', `Klaussy: Auto-fix triggered for ${event.type === 'ci' ? 'CI failure' : 'new comment'}`);

  const tempWorktreePath = path.join(os.tmpdir(), `klaussy-autofix-${taskId}-${Date.now()}`);
  const tempBranch = `autofix-${taskId}-${Date.now()}`;

  try {
    // 1. Create temporary background worktree
    broadcastStatus('running', 'Creating background worktree...');
    await execFileP('git', ['worktree', 'add', '-b', tempBranch, tempWorktreePath, inst.branch], {
      cwd: inst.worktreePath,
      timeout: 15000
    });

    // 2. Formulate prompt based on event type
    let promptText = '';
    if (event.type === 'ci') {
      const checkNames = event.checks.map(c => c.name || c.context).join(', ');
      promptText = `The CI checks (${checkNames}) failed on this branch. Run the test suite and fix any failures. Ensure the code compiles and tests pass.`;
    } else {
      promptText = `A reviewer left a comment on the PR: "${event.comment.body}"${event.comment.path ? ` in file ${event.comment.path}` : ''}. Please investigate the issue and apply code fixes in the worktree to address this feedback.`;
    }

    // 3. Spawn headless agent inside the background worktree
    broadcastStatus('running', 'Spawning AI agent to resolve the issue...');
    const config = loadConfig();
    const providerId = inst.mode || defaultAgentProvider();
    const provider = getProvider(providerId);
    const bin = binFor(providerId, config);

    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const headless = provider.buildHeadlessRun(bin, {
      prompt: promptText,
      mode: 'text',
      allowEdits: true,
      model: config.agentModel?.[providerId] || ''
    });

    await execFileP(bin, headless.args, {
      cwd: tempWorktreePath,
      timeout: 5 * 60 * 1000 // 5 minutes max budget
    });

    // 4. Check if changes were made
    broadcastStatus('running', 'Verifying agent modifications...');
    const statusOut = (await execFileP('git', ['status', '--porcelain'], { cwd: tempWorktreePath })).stdout.trim();
    
    if (statusOut) {
      // Commit changes
      broadcastStatus('running', 'Committing fixes...');
      await execFileP('git', ['add', '-A'], { cwd: tempWorktreePath });
      await execFileP('git', ['commit', '-m', `style(autofix): address PR ${event.type === 'ci' ? 'CI failure' : 'feedback'}`], {
        cwd: tempWorktreePath,
        env: { ...process.env, KLAUSSY_SKIP_REVIEW: '1' }
      });

      // Push changes back to original PR branch
      broadcastStatus('running', 'Pushing fixes to remote branch...');
      await execFileP('git', ['push', 'origin', `HEAD:${inst.branch}`], { cwd: tempWorktreePath, timeout: 30000 });

      // Add a comment on the PR explaining what was fixed
      const commentBody = `🤖 **Klaussy Auto-Fixer**: Applied a fix to address the ${event.type === 'ci' ? 'CI failure' : 'PR comment'}.\n\n*Fix Prompt*: _"${promptText}"_\n*Status*: Pushed successfully.`;
      await ghExecP(['pr', 'comment', pr.url, '--body', commentBody], { cwd: inst.worktreePath, timeout: 15000 });

      broadcastStatus('success', 'Fix applied and pushed successfully!');
    } else {
      broadcastStatus('idle', 'No changes were needed or made.');
    }
  } catch (err) {
    console.error('[pr-monitor] auto-fix failed:', err.message);
    broadcastStatus('error', `Auto-fix failed: ${err.message}`);
  } finally {
    // 5. Cleanup temporary worktree and branch
    try {
      if (fs.existsSync(tempWorktreePath)) {
        await execFileP('git', ['worktree', 'remove', '--force', tempWorktreePath], { cwd: inst.worktreePath });
      }
      await execFileP('git', ['branch', '-D', tempBranch], { cwd: inst.worktreePath });
    } catch (cleanupErr) {
      console.warn('[pr-monitor] cleanup warning:', cleanupErr.message);
    }
    activeFixes.delete(taskId);
  }
}

module.exports = {
  startPrMonitor,
  stopPrMonitor
};
