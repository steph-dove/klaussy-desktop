require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const artifact = require('../../renderer/artifact-preview');

test('classify maps HTML extensions to "html"', () => {
  assert.equal(artifact.classify('index.html'), 'html');
  assert.equal(artifact.classify('/abs/path/page.HTM'), 'html');
});

test('classify maps SVG to "svg"', () => {
  assert.equal(artifact.classify('logo.svg'), 'svg');
});

test('classify maps the markdown family to "markdown"', () => {
  for (const p of ['README.md', 'notes.markdown', 'a.mdown', 'b.mkd']) {
    assert.equal(artifact.classify(p), 'markdown', p);
  }
});

test('classify returns null for non-previewable files', () => {
  for (const p of ['app.js', 'style.css', 'data.json', 'noext', '', null]) {
    assert.equal(artifact.classify(p), null, String(p));
  }
});

test('classify ignores a dot that is not the extension', () => {
  // A dotfile with no extension, and a path whose only dot is a directory.
  assert.equal(artifact.classify('.gitignore'), null);
  assert.equal(artifact.classify('my.dir/file'), null);
});

test('isArtifactPath mirrors classify', () => {
  assert.equal(artifact.isArtifactPath('x.html'), true);
  assert.equal(artifact.isArtifactPath('x.txt'), false);
});

test('buildDoc passes HTML through unchanged', () => {
  const html = '<h1>Hi</h1><script>console.log(1)</script>';
  assert.equal(artifact.buildDoc('html', html), html);
});

test('buildDoc wraps a bare SVG in a centering document', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const doc = artifact.buildDoc('svg', svg);
  assert.match(doc, /^<!doctype html>/);
  assert.ok(doc.includes(svg), 'wrapped doc contains the original SVG');
  assert.match(doc, /align-items:center/);
});

test('buildDoc coerces nullish content to an empty string', () => {
  assert.equal(artifact.buildDoc('html', null), '');
  assert.equal(artifact.buildDoc('html', undefined), '');
});
