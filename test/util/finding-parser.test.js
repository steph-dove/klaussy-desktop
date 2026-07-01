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

test('truncated mid-stream: recovers the complete findings, drops the partial tail', () => {
  const inner = '{\n  "findings": [\n    { "severity": "High", "category": "Correctness", "path": "a.js", "line": 1, "side": "RIGHT", "title": "One", "code": "let a = 1;\nlet b = 2;", "body": "First.", "suggestion": "x" },\n    { "severity": "Low", "category": "Design", "path": "b.js", "line": 9, "side": "RIGHT", "title": "Two", "code": "y=2;", "body": "Second.", "suggestion": "z" },\n    { "severity": "Nit", "category": "Readability", "path": "c.js", "line": 3, "side": "RIGHT", "title": "Thre';
  // Note: no closing </FINDINGS_JSON> — mid-stream.
  const r = FP.parseReviewFindings('review\n<FINDINGS_JSON>\n' + inner);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].path, 'a.js');
  assert.equal(r.findings[1].path, 'b.js');
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
