// Phase detection for the dev loop, kept free of DOM and storage and UMD-wrapped
// so node unit tests exercise the shipping regexes instead of copies that drift.
(function (root) {
  // Explicit action headers emitted during execution: "## Phase 1 — Plan",
  // "Starting Phase 4". Prose that merely mentions a phase must not match.
  var PHASE_HEADER = /(?:##\s*|(?:Starting|Entering|Moving to|Executing|Beginning|Working on|Now on)\s+)Phase\s*([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;

  // A bare number counts only when punctuation marks it as a list ordinal
  // ("2. Implement"); otherwise "- [x] 3 tests added" reads as Phase 3 and
  // skips the loop ahead to QA.
  var DONE_TODO = /\[[xX✓]\]\s*(?:Phase\s*([1-9])(?:\s*[-—:.]\s*|\.|\s+)|([1-9])\s*[-—:.]\s*)([^\n\r]*)/gi;
  var ACTIVE_TODO = /\[(?:[>•~]|in[ _-]progress|running)\]\s*(?:Phase\s*([1-9])(?:\s*[-—:.]\s*|\.|\s+)|([1-9])\s*[-—:.]\s*)([^\n\r]*)/gi;

  var PLAN_SAVED = /(?:Write\([^)]*plan\.md\)|Wrote \d+ lines to [^\n\r]*plan\.md|Saved (?:the )?plan|Plan established|Plan approved|Plan completed|Implementation plan created)/i;

  // Milestone phrases, highest phase first: the first one that matches wins, so
  // a chunk naming several stages settles on the furthest along.
  var MILESTONES = [
    { phase: 9, summary: 'CI green & ready to merge', re: /(?:All CI checks green|Landing the owl|PR is ready for (?:human )?merge|Merge gate reached|Dev loop complete)/i },
    { phase: 8, summary: 'Resolving review comments', re: /(?:gh pr view\s+--comments|polling for (?:code )?review|review comments? resolved|review feedback resolved|pulling review comments)/i },
    { phase: 7, summary: 'Polling CI checks', re: /(?:gh pr checks|polling CI checks|monitoring CI checks|waiting for CI)/i },
    { phase: 6, summary: 'Reviewing published PR', re: /(?:Re-review(?:ing)?\s+(?:the\s+)?PR|reviewing published PR|inspecting remote PR diff)/i },
    { phase: 5, summary: 'Creating pull request', re: /(?:gh pr create\b|glab mr create\b|Creating (?:the )?pull request|Opening (?:the )?PR\b)/i },
    { phase: 4, summary: 'Running QA & capturing media', re: /(?:Capturing artifacts for the PR|scroll-through recording|Playwright screen recording|Capturing QA recording|Running QA|Starting Phase 4|Starting QA|QA the change|Capturing (?:before and after|screenshot)|Recording (?:full-flow|video|demo|walkthrough|interaction|screen)|screencapture\b|ffmpeg\b|test:e2e|playwright test|cypress run|Testing (?:the )?(?:changes|implementation|UI)|Verifying (?:the )?changes|QA verification)/i },
    { phase: 3, summary: 'Local review & self-review', re: /(?:Reviewing the working diff|git diff main\.\.\.HEAD|Running self-review pass|Local review and fix|Reviewing (?:the )?changes for bugs|Self-review pass)/i },
    { phase: 2, summary: 'Implementing solution', re: /(?:Starting implementation|Implementing with TDD|Writing implementation batches|Beginning implementation|Implementing the solution|Working on implementation|Writing tests for|Applying changes|Writing implementation)/i },
  ];

  var PR_URL = /https:\/\/(?:github\.com|gitlab\.com)\/([^\s\n\r/]+)\/([^\s\n\r/]+)\/(?:pull|merge_requests)\/(\d+)/i;
  var MEDIA = /(?:[a-zA-Z0-9_.~/-]+\.(?:mp4|webm|mov|png|jpg|jpeg|webp))/gi;
  var VIDEO_EXT = /\.(mp4|webm|mov)$/i;
  var IMG_EXT = /\.(png|jpg|jpeg|webp)$/i;
  var QA_PATH = /(?:Downloads|e2e|qa|screenshot|screen-shot|screen_shot|artifact|test-result|cypress)/i;
  var APP_ASSET = /(?:node_modules|\.git|src[\\/]assets|public[\\/]|styles[\\/]|icons[\\/]|renderer[\\/])/i;

  function stripAnsi(str) {
    if (!str) return '';
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  // Phase number lands in either the "Phase N" or the bare-ordinal group.
  function scanTodos(re, clean) {
    var out = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(clean)) !== null) {
      var num = parseInt(m[1] || m[2], 10);
      if (num) out.push({ phase: num, text: (m[3] || '').trim() });
    }
    return out;
  }

  function parseArtifacts(clean) {
    var found = clean.match(MEDIA);
    if (!found) return [];
    var out = [];
    found.forEach(function (file) {
      var isVideo = VIDEO_EXT.test(file);
      var isImg = IMG_EXT.test(file);
      if ((isVideo || (isImg && QA_PATH.test(file))) && !APP_ASSET.test(file)) {
        out.push({
          name: file.split('/').pop(),
          path: file,
          type: isVideo ? 'video' : 'image',
        });
      }
    });
    return out;
  }

  // Advances come back in the order they should be applied; the caller owns the
  // state and decides what is actually new.
  function detect(rawData) {
    var clean = stripAnsi(rawData);
    var result = {
      advances: [],
      completions: [],
      planWritten: false,
      prUrl: null,
      prNumber: null,
      artifacts: [],
    };
    if (!clean) return result;

    var m;
    PHASE_HEADER.lastIndex = 0;
    while ((m = PHASE_HEADER.exec(clean)) !== null) {
      result.advances.push({ phase: parseInt(m[1], 10), summary: (m[2] || '').trim() });
    }

    scanTodos(DONE_TODO, clean).forEach(function (item) {
      if (item.phase < 9) result.advances.push({ phase: item.phase + 1, summary: '' });
      else result.completions.push(9);
    });

    scanTodos(ACTIVE_TODO, clean).forEach(function (item) {
      result.advances.push({ phase: item.phase, summary: item.text });
    });

    if (PLAN_SAVED.test(clean)) {
      result.planWritten = true;
      result.advances.push({ phase: 2, summary: 'Implementation plan created & saved' });
    }

    for (var i = 0; i < MILESTONES.length; i++) {
      if (MILESTONES[i].re.test(clean)) {
        result.advances.push({ phase: MILESTONES[i].phase, summary: MILESTONES[i].summary });
        break;
      }
    }

    var pr = clean.match(PR_URL);
    if (pr) {
      result.prUrl = pr[0];
      result.prNumber = pr[3];
    }

    result.artifacts = parseArtifacts(clean);
    return result;
  }

  var api = {
    detect: detect,
    stripAnsi: stripAnsi,
  };

  if (root) root.DevLoopDetect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
