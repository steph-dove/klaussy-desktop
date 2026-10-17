// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Builds each AI finding's comment with klaussy's own review-post, so the desktop
// posts exactly what the klaussy-review bot would.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execToolP } = require('./exec');

const FINDING_LINE = /^\*\*[^*\n]*·[^*\n]*\*\*[ \t]*$/gm;

function metaPart(s, fallback) {
  const clean = String(s || '').replace(/[*·\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || fallback;
}

// One report finding per input, each placed on its own one-line file so every
// finding lands in `comments` in input order instead of the review body.
function buildReportAndDiff(findings) {
  const report = [];
  const diff = [];
  findings.forEach((f, i) => {
    const file = `f${i}.txt`;
    report.push(`**${metaPart(f.severity, 'Note')} · ${metaPart(f.category, 'General')} · \`${file}:1\`**\n`);
    report.push(String(f.text || '').replace(FINDING_LINE, '').trim() + '\n');
    diff.push(`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1,1 @@', '+x');
  });
  return { report: report.join('\n'), diff: diff.join('\n') + '\n' };
}

// Comment bodies in input order, or null when klaussy can't build them.
async function botCommentBodies(findings) {
  if (!Array.isArray(findings) || !findings.length) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-bot-comment-'));
  try {
    const { report, diff } = buildReportAndDiff(findings);
    const reportPath = path.join(dir, 'REVIEW_OUTPUT.md');
    const diffPath = path.join(dir, 'pr.diff');
    fs.writeFileSync(reportPath, report);
    fs.writeFileSync(diffPath, diff);
    const { stdout } = await execToolP('klaussy', ['review-post', '--report', reportPath, '--diff', diffPath], {
      timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    });
    const bodies = new Array(findings.length).fill(null);
    for (const c of JSON.parse(stdout).comments || []) {
      const m = /^f(\d+)\.txt$/.exec(c.path || '');
      if (m && +m[1] < bodies.length) bodies[+m[1]] = c.body;
    }
    return bodies.every((b) => typeof b === 'string') ? bodies : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { botCommentBodies, buildReportAndDiff };
