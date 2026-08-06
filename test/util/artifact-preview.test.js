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

test('buildDoc passes HTML through under an egress-blocking CSP', () => {
  const html = '<h1>Hi</h1><script>console.log(1)</script>';
  const doc = artifact.buildDoc('html', html);
  assert.ok(doc.endsWith(html), 'the original HTML is preserved verbatim');
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /default-src 'none'/);
});

test('buildDoc wraps a bare SVG in a centering document with a CSP', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const doc = artifact.buildDoc('svg', svg);
  assert.match(doc, /^<!doctype html>/);
  assert.ok(doc.includes(svg), 'wrapped doc contains the original SVG');
  assert.match(doc, /align-items:center/);
  assert.match(doc, /Content-Security-Policy/);
});

test('buildDoc coerces nullish content to the CSP-only document', () => {
  // No body, but still the egress-blocking CSP — never a document with content.
  const empty = artifact.buildDoc('html', null);
  assert.match(empty, /Content-Security-Policy/);
  assert.ok(empty.endsWith('">'), 'nothing follows the CSP meta');
  assert.equal(artifact.buildDoc('html', undefined), empty);
});

// The live-preview reload path (refreshArtifactForTab in file-browser.js) drives
// render with the new buffer, so assert render swaps the iframe on a content
// change. file-browser.js isn't loadable under `node --test`; this hits the seam.
test('render swaps the iframe srcdoc when content changes', () => {
  // Minimal DOM: render() only needs createElement + a container it can clear
  // (innerHTML = '') and append into.
  function makeEl() {
    const el = { className: '', attrs: {}, children: [], _html: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); } };
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._html; },
      set(v) { el._html = v; if (v === '') el.children = []; },
    });
    return el;
  }
  global.document = { createElement: () => makeEl() };
  try {
    const container = makeEl();
    artifact.render(container, 'html', '<h1>One</h1>', 'a.html');
    const first = container.children[0].srcdoc;
    assert.match(first, /One/);

    artifact.render(container, 'html', '<h1>Two</h1>', 'a.html');
    assert.equal(container.children.length, 1, 'the stale iframe is cleared');
    const second = container.children[0].srcdoc;
    assert.match(second, /Two/);
    assert.notEqual(first, second, 'the pane reflects the new content');
  } finally {
    delete global.document;
  }
});
