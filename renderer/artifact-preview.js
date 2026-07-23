// Live artifact preview: HTML/SVG in a sandboxed iframe (allow-scripts only,
// so an opaque origin that can't touch the app), Markdown via MarkdownPreview.
// UMD-wrapped so node unit tests can require the pure helpers.
(function (root) {
  // Map a file extension to its artifact kind, or null for files we don't preview.
  function classify(filePath) {
    var m = /\.([a-z0-9]+)$/i.exec(filePath || '');
    if (!m) return null;
    switch (m[1].toLowerCase()) {
      case 'html':
      case 'htm':
        return 'html';
      case 'svg':
        return 'svg';
      case 'md':
      case 'markdown':
      case 'mdown':
      case 'mkd':
        return 'markdown';
      default:
        return null;
    }
  }

  function isArtifactPath(filePath) {
    return classify(filePath) !== null;
  }

  // Egress-blocking CSP prepended to every previewed document; inline scripts
  // stay allowed so live scripted previews still work.
  var CSP_META = '<meta http-equiv="Content-Security-Policy" content="' +
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; font-src data:" +
    '">';

  // Document for the iframe. HTML passes through; a bare SVG gets wrapped in
  // minimal centering HTML since it isn't a document on its own.
  function buildDoc(kind, content) {
    var body = content == null ? '' : String(content);
    if (kind === 'svg') {
      return '<!doctype html><meta charset="utf-8">' + CSP_META +
        '<style>html,body{margin:0;height:100%}' +
        'body{display:flex;align-items:center;justify-content:center;background:#fff}' +
        'svg{max-width:100%;max-height:100%}</style>' + body;
    }
    return CSP_META + body;
  }

  // (Re)render into `container`: Markdown inline as sanitized HTML, html/svg in
  // a fresh sandboxed iframe. A new iframe per render (vs reassigning srcdoc)
  // makes the artifact's scripts re-run cleanly on reload.
  function render(container, kind, content, filePath) {
    if (!container) return;
    if (kind === 'markdown') {
      // The link interceptor is delegated, so file-browser.js attaches it once
      // to this pane at init — don't re-attach here or listeners would stack up
      // on every refresh.
      container.className = 'file-artifact-preview artifact-markdown file-md-preview';
      var src = content == null ? '' : String(content);
      container.innerHTML = root && root.MarkdownPreview
        ? root.MarkdownPreview.render(src)
        : '';
      container.scrollTop = 0;
      return;
    }
    container.className = 'file-artifact-preview artifact-frame';
    container.innerHTML = '';
    var frame = document.createElement('iframe');
    frame.className = 'artifact-iframe';
    // allow-scripts alone → opaque origin. Do NOT add allow-same-origin: that
    // would give the artifact this window's origin and let it touch the app.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', filePath ? 'Preview of ' + filePath : 'Artifact preview');
    frame.srcdoc = buildDoc(kind, content);
    container.appendChild(frame);
  }

  function clear(container) {
    if (container) container.innerHTML = '';
  }

  var api = {
    classify: classify,
    isArtifactPath: isArtifactPath,
    buildDoc: buildDoc,
    render: render,
    clear: clear,
  };

  if (root) root.ArtifactPreview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
