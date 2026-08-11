const test = require('node:test');
const assert = require('node:assert/strict');

// finding-parser.js is a renderer IIFE that assigns to window.FindingParser.
// It touches no Electron/DOM API, so we can load it by stubbing `window` and
// requiring the file, then read the parser off the stub.
global.window = global.window || {};
require('../../renderer/finding-parser');
const FP = global.window.FindingParser;

function wrap(inner) {
  return 'Here is my review.\n<FINDINGS_JSON>\n' + inner + '\n</FINDINGS_JSON>';
}

// Regression: raw newlines / unescaped quotes in the `code`/`body` string
// values made JSON.parse throw and collapsed the review to one "unparsed"
// card. The lenient-repair fallback must recover these.

test('valid JSON contract yields structured findings + summary', () => {
  const r = FP.parseReviewFindings(wrap(JSON.stringify({
    findings: [{ severity: 'High', category: 'Correctness', path: 'main.js', line: 42, side: 'RIGHT', title: 'Null deref', code: 'const x = foo.bar;', body: 'Guard the null case.', suggestion: 'if (!foo) return;' }],
    summary: { verdict: 'Request Changes', highestRisk: ['null deref'], testCoverage: 'no tests' },
  })));
  assert.equal(r.structured, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'high');
  assert.equal(r.findings[0].path, 'main.js');
  assert.equal(r.summary.verdict, 'Request Changes');
});

test('recovers findings when code contains a raw (unescaped) newline', () => {
  const inner = '{\n  "findings": [\n    { "severity": "High", "category": "Correctness", "path": "main.js", "line": 42, "side": "RIGHT", "title": "Null deref", "code": "const x = foo.bar;\nconst y = x.baz;", "body": "Guard it.", "suggestion": "if (!foo) return;" }\n  ],\n  "summary": { "verdict": "Request Changes", "highestRisk": ["null deref"], "testCoverage": "no tests" }\n}';
  const r = FP.parseReviewFindings(wrap(inner));
  assert.equal(r.findings.length, 1);
  assert.equal(r.structured, true);
  assert.equal(r.summary.verdict, 'Request Changes');
});

test('recovers findings when body contains an unescaped double-quote', () => {
  const inner = '{ "findings": [ { "severity": "High", "category": "Correctness", "path": "m.js", "line": 5, "side": "RIGHT", "title": "Bad", "code": "x=1;", "body": "The "foo" variable is wrong.", "suggestion": "rename it" } ], "summary": { "verdict": "Block", "highestRisk": ["x"], "testCoverage": "none" } }';
  const r = FP.parseReviewFindings(wrap(inner));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'high');
});

test('recovers findings when body has an inner quote followed by a comma (verdict-but-no-cards regression)', () => {
  // Regression: an inner quote followed by `,`/`}`/`]`/`:` ("returns "ok", but
  // …") was misread as the value's closing quote, corrupting the object so
  // every finding was dropped while the quote-free summary survived — the exact
  // "Request Changes verdict shows, zero cards render" symptom.
  const inner = '{ "findings": [ { "severity": "High", "category": "Correctness", "path": "m.js", "line": 5, "side": "RIGHT", "title": "Ignored return", "code": "x=1;", "body": "The call returns "ok", but the caller ignores it.", "suggestion": "check the result" } ], "summary": { "verdict": "Request Changes", "highestRisk": ["ignored return"], "testCoverage": "none" } }';
  const r = FP.parseReviewFindings(wrap(inner));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'high');
  assert.equal(r.findings[0].path, 'm.js');
  assert.equal(r.summary.verdict, 'Request Changes');
});

test('truncated mid-stream: recovers the complete findings, drops the partial tail', () => {
  const inner = '{\n  "findings": [\n    { "severity": "High", "category": "Correctness", "path": "a.js", "line": 1, "side": "RIGHT", "title": "One", "code": "let a = 1;\nlet b = 2;", "body": "First.", "suggestion": "x" },\n    { "severity": "Low", "category": "Design", "path": "b.js", "line": 9, "side": "RIGHT", "title": "Two", "code": "y=2;", "body": "Second.", "suggestion": "z" },\n    { "severity": "Nit", "category": "Readability", "path": "c.js", "line": 3, "side": "RIGHT", "title": "Thre';
  // Note: no closing </FINDINGS_JSON> — mid-stream.
  const r = FP.parseReviewFindings('review\n<FINDINGS_JSON>\n' + inner);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].path, 'a.js');
  assert.equal(r.findings[1].path, 'b.js');
});

test('recovers findings when a value contains a fenced ``` code block (unfenced JSON)', () => {
  // Regression: the trailing-fence strip used lastIndexOf('```'), which grabbed
  // the ``` inside a finding's suggestion/body and truncated the JSON mid-value
  // whenever the block itself was not wrapped in an outer ```json fence.
  const inner = JSON.stringify({
    findings: [{ severity: 'High', category: 'Correctness', path: 'm.js', line: 7, side: 'RIGHT', title: 'Guard null', code: 'x = foo.bar;', body: 'Add a guard.', suggestion: '```js\nif (!foo) return null;\n```' }],
    summary: { verdict: 'Request Changes', highestRisk: ['null deref'], testCoverage: 'none' },
  });
  const r = FP.parseReviewFindings(wrap(inner));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'high');
  assert.equal(r.findings[0].path, 'm.js');
  assert.equal(r.summary.verdict, 'Request Changes');
});

test('clean approve: zero findings + summary renders as structured (not an unparsed dump)', () => {
  const r = FP.parseReviewFindings(wrap('{ "findings": [], "summary": { "verdict": "Approve", "highestRisk": [], "testCoverage": "good" } }'));
  assert.equal(r.structured, true);
  assert.equal(r.findings.length, 0);
  assert.equal(r.summary.verdict, 'Approve');
});

test('genuinely unstructured text still falls back cleanly (no throw, no findings from JSON)', () => {
  const r = FP.parseReviewFindings('Just some prose with no contract and no severity anchors.');
  assert.equal(r.structured, false);
  assert.equal(r.findings.length, 0);
});

// Regression: the model sometimes wraps a path in markdown/quotes (a `path` in
// a JSON value, or a `[Location: `path:line`]` marker leaving a leading
// backtick), which made the path miss the diff's exact `b/`-path key so the
// finding posted as a floating comment instead of inline. cleanPath de-wraps it.
test('cleanPath strips backticks, quotes, asterisks, and a leading ./', () => {
  assert.equal(FP.cleanPath('`src/app.ts`'), 'src/app.ts');
  assert.equal(FP.cleanPath('`celery_worker/modules/handler.py'), 'celery_worker/modules/handler.py');
  assert.equal(FP.cleanPath('"src/app.ts"'), 'src/app.ts');
  assert.equal(FP.cleanPath("'src/app.ts'"), 'src/app.ts');
  assert.equal(FP.cleanPath('**src/app.ts**'), 'src/app.ts');
  assert.equal(FP.cleanPath('<src/app.ts>'), 'src/app.ts');
  assert.equal(FP.cleanPath('./src/app.ts'), 'src/app.ts');
  assert.equal(FP.cleanPath('  `src/app.ts`  '), 'src/app.ts');
});

test('cleanPath leaves an already-clean path and null/empty untouched', () => {
  assert.equal(FP.cleanPath('src/app.ts'), 'src/app.ts');
  assert.equal(FP.cleanPath('a-b_c/d.e.js'), 'a-b_c/d.e.js');
  assert.equal(FP.cleanPath(null), null);
  assert.equal(FP.cleanPath(undefined), undefined);
  assert.equal(FP.cleanPath(''), '');
});

test('a backtick-wrapped JSON path is de-wrapped so it can anchor inline', () => {
  const inner = JSON.stringify({
    findings: [{ severity: 'High', category: 'Correctness', path: '`src/server/index.js`', line: 42, side: 'RIGHT', title: 'Bug', code: 'x=1;', body: 'Fix it.', suggestion: 'y=2;' }],
    summary: { verdict: 'Request Changes', highestRisk: ['x'], testCoverage: 'none' },
  });
  const r = FP.parseReviewFindings(wrap(inner));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].path, 'src/server/index.js');
});

// A suggestion that quotes code inline inside a sentence used to be fenced as a
// code block, because the braces in `[\p{L}\p{N}_]` matched the code heuristic.
// The result rendered monospace and scrolled sideways instead of wrapping.
function suggestionText(suggestion) {
  const inner = JSON.stringify({
    findings: [{ severity: 'Low', category: 'Readability', path: 'a.js', line: 1, side: 'RIGHT', title: 'T', code: 'x', body: 'Because it breaks on unicode.', suggestion }],
    summary: { verdict: 'Comment', highestRisk: [], testCoverage: 'n/a' },
  });
  return FP.parseReviewFindings(wrap(inner)).findings[0].text;
}

test('a sentence quoting code inline stays prose', () => {
  const text = suggestionText('Use `[\\p{L}\\p{N}_]` with the `u` flag in place of `\\w` for the lookbehinds here.');
  assert.doesNotMatch(text, /```/, 'prose must not be fenced');
  assert.match(text, /Use `\[/);
});

test('real code with braces is still fenced', () => {
  const text = suggestionText('if (!user) {\n  return null;\n}');
  assert.match(text, /```/);
});

test('a bare inline-code suggestion is judged on its own text', () => {
  // Almost no words outside the span, so the span itself decides.
  const text = suggestionText('`const cfg = { retries: 3 };`');
  assert.match(text, /```/);
});

test('a plain sentence with no code stays prose', () => {
  const text = suggestionText('Guard the null case before dereferencing.');
  assert.doesNotMatch(text, /```/);
});

test('prose wrapped around a fenced block passes through intact', () => {
  // Wrapping this in another fence made the inner ```js close the outer one,
  // leaking "js" and a trailing ``` as literal text in the card.
  const text = suggestionText("Add to the same block:\n```js\nassert.equal(f('a'), 'b');\n```");
  assert.match(text, /Add to the same block:/);
  assert.match(text, /```js\n/, 'inner fence keeps its language tag');
  assert.equal((text.match(/```/g) || []).length, 2, 'exactly one fence pair');
});

test('an already-fenced suggestion is not double-fenced', () => {
  const text = suggestionText('```\nconst x = 1;\n```');
  assert.equal((text.match(/```/g) || []).length, 2);
});

test('an unbalanced fence is closed so the renderer can match it', () => {
  const text = suggestionText('```js\nconst x = 1;');
  assert.equal((text.match(/```/g) || []).length, 2);
  assert.match(text, /```$/);
});
