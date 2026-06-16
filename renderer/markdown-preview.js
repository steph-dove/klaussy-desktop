// Shared markdown renderer used by the file viewer and the diff/Changes
// panel. markdown-it for parsing, hljs for fenced-code highlighting,
// DOMPurify for sanitization. Singleton markdown-it instance — created on
// first render and reused.
window.MarkdownPreview = (function () {
  // Two cached instances: default (breaks:false, correct markdown — file
  // viewer) and a breaks:true variant for chat/comment bodies, which render
  // soft line breaks as <br> the way GitHub comments do.
  var _md = null;
  var _mdBreaks = null;
  var _warned = false;

  function buildRenderer(breaks) {
    if (typeof window.markdownit !== 'function') {
      if (!_warned) {
        console.warn('[markdown-preview] window.markdownit is not defined; falling back to plain text');
        _warned = true;
      }
      return null;
    }
    return window.markdownit({
      html: false,
      linkify: true,
      typographer: true,
      breaks: breaks,
      highlight: function (str, lang) {
        if (typeof hljs === 'undefined') return '';
        try {
          if (lang && hljs.getLanguage && hljs.getLanguage(lang)) {
            return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
          }
          return hljs.highlightAuto(str).value;
        } catch (_) {
          return '';
        }
      },
    });
  }

  function getRenderer(breaks) {
    if (breaks) {
      if (!_mdBreaks) _mdBreaks = buildRenderer(true);
      return _mdBreaks;
    }
    if (!_md) _md = buildRenderer(false);
    return _md;
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(text, opts) {
    var src = text == null ? '' : String(text);
    var md = getRenderer(!!(opts && opts.breaks));
    var html;
    if (md) {
      try { html = md.render(src); }
      catch (_) { html = '<pre>' + escHtml(src) + '</pre>'; }
    } else {
      html = '<pre>' + escHtml(src) + '</pre>';
    }
    if (typeof window.DOMPurify !== 'undefined') {
      html = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return html;
  }

  function isMarkdownPath(p) {
    return /\.(md|markdown|mdown|mkd)$/i.test(p || '');
  }

  // Intercept clicks on rendered links: http(s) go through the main process
  // (opens in the user's browser); other relative links are swallowed so
  // they can't navigate the renderer.
  function attachLinkInterceptor(rootEl) {
    if (!rootEl) return;
    rootEl.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        e.preventDefault();
        if (window.klaus && window.klaus.gh && window.klaus.gh.openExternal) {
          window.klaus.gh.openExternal(href);
        }
      } else if (href && href.charAt(0) !== '#') {
        e.preventDefault();
      }
    });
  }

  return {
    render: render,
    isMarkdownPath: isMarkdownPath,
    attachLinkInterceptor: attachLinkInterceptor,
  };
})();
