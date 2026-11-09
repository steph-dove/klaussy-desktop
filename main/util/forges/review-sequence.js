// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Review submission for forges with no atomic review API: one comment at a time, then the vote.

const { humanizeComment } = require('../humanize-comment');

// A draft built by klaussy's review-post is already in the bot's final form.
function outboundBody(draft, text) {
  return draft && draft.humanized ? text : humanizeComment(text);
}

// Posts inline comments, summary, follow-ups, then the vote, which is cast even if some posts failed.
// A rejected inline comment (e.g. a line outside the diff) is reposted as a general comment naming the file and line.
async function submitReviewSequential({ inlineComments, body, issueCommentDrafts, postInline, postGeneral, vote }) {
  const errors = [];
  let postedCount = 0;

  for (const c of inlineComments) {
    if (!c.body || !c.body.trim()) continue;
    try {
      await postInline(c);
      postedCount += 1;
    } catch (err) {
      const fallbackBody = `**[${c.path}${typeof c.line === 'number' ? `:${c.line}` : ''}]**\n\n${c.body}`;
      try {
        await postGeneral(outboundBody(c, fallbackBody));
        postedCount += 1;
      } catch (fbErr) {
        // The inline rejection says which draft failed; the fallback's error is only a backup.
        errors.push(err.message || fbErr.message);
      }
    }
  }

  if (body && body.trim()) {
    try {
      await postGeneral(humanizeComment(body));
      postedCount += 1;
    } catch (err) {
      errors.push(err.message);
    }
  }

  for (const draft of issueCommentDrafts) {
    if (!draft.body || !draft.body.trim()) continue;
    try {
      await postGeneral(outboundBody(draft, draft.body));
      postedCount += 1;
    } catch (err) {
      errors.push(err.message);
    }
  }

  try {
    await vote();
  } catch (err) {
    errors.push(err.message);
  }

  if (errors.length) {
    if (postedCount === 0) return { error: `Nothing was posted: ${errors.join('; ')}` };
    return { ok: true, warning: `Review posted, but some actions had warnings: ${errors.join('; ')}` };
  }
  return { ok: true };
}

module.exports = { submitReviewSequential, outboundBody };
