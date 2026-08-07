// Agents write GitHub-flavoured markdown, and a code fence shows its source
// rather than its formatting, so each platform gets the dialect it renders.

// Discord 2000 / Slack 3000, minus room for the trailing notice.
const DISCORD_MAX = 1900;
const SLACK_MAX = 2800;

// HTML neither platform renders; <details> is the common one, since agents
// reach for it to fold long answers.
function unwrapHtml(text) {
  return String(text || '')
    .replace(/<summary>\s*(.*?)\s*<\/summary>/gis, '**$1**')
    .replace(/<\/?details>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|span|kbd|sub|sup)>/gi, '');
}

function trim(text, max) {
  const s = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= max) return s;
  // Cut at a line boundary so a sentence isn't sheared mid-word.
  const cut = s.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.6 ? cut.slice(0, nl) : cut) + '\n…';
}

function forDiscord(text) {
  return trim(unwrapHtml(text), DISCORD_MAX);
}

// Slack's mrkdwn predates commonmark: bold is *one* asterisk, italic is
// underscores, and headings and bullets have no syntax at all.
function forSlack(text) {
  const out = unwrapHtml(text)
    // Fenced code first, so its contents are never treated as markup.
    .split(/(```[\s\S]*?```)/g)
    .map((chunk) => {
      if (chunk.startsWith('```')) return chunk;
      return chunk
        .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\*\*(.+?)\*\*/gs, '*$1*')
        .replace(/(^|[\s(])_(?!_)(.+?)_(?=[\s.,!?)]|$)/gs, '$1_$2_')
        .replace(/^(\s*)[-*+]\s+/gm, '$1• ');
    })
    .join('');
  return trim(out, SLACK_MAX);
}

module.exports = { forDiscord, forSlack, unwrapHtml, DISCORD_MAX, SLACK_MAX };
