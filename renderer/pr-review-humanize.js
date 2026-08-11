// Part of the PrReview surface (window.PrReview); see pr-review.js for the
// core. Drives klaussy's multi-pass humanize over a finding's text: cut
// (content), voice (register), check (did the meaning survive), scrub
// (in-process regex, always runs). Separate model calls because one prompt
// carrying every rule applies the safe mechanical ones and drops voice and
// length. The chain lives here because the renderer already accumulates
// streamed text (see startChat); main's done payload carries none.

(function (PR) {

  PR.HUMANIZE_PASSES = ['cut', 'voice', 'check'];

  // Rejects on error so the chain stops and leaves the draft untouched.
  PR.runHumanizePass = function(pass, text, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var requestId = 'hz-' + pass + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      if (opts.onStart) opts.onStart(requestId);
      var acc = '';
      var unsubData = window.klaus.pr.onHumanizePassData(requestId, function (chunk) {
        acc += chunk;
      });
      window.klaus.pr.onHumanizePassDone(requestId, function (result) {
        if (unsubData) unsubData();
        if (result && result.error) return reject(new Error(result.error));
        if (result && result.cancelled) return reject(new Error('cancelled'));
        var out = acc.trim();
        if (!out) return reject(new Error(pass + ' pass returned nothing'));
        resolve(out);
      });
      window.klaus.pr.humanizePassStart(requestId, {
        worktreePath: PR.aiReview && PR.aiReview.worktreePath,
        pass: pass,
        text: text,
        question: opts.question || null,
        original: opts.original || null,
      }).then(function (r) {
        if (r && r.error) { if (unsubData) unsubData(); reject(new Error(r.error)); }
      });
    });
  };

  // `onProgress(pass, index)` drives the button label so a 3-call chain doesn't
  // look like a hang.
  PR.runHumanizeChain = async function(text, opts) {
    opts = opts || {};
    var original = text;
    var current = text;
    for (var i = 0; i < PR.HUMANIZE_PASSES.length; i++) {
      var pass = PR.HUMANIZE_PASSES[i];
      if (opts.onProgress) opts.onProgress(pass, i + 1);
      current = await PR.runHumanizePass(pass, current, {
        question: opts.question,
        original: original,
        onStart: opts.onStart,
      });
    }
    if (opts.onProgress) opts.onProgress('scrub', 4);
    var scrubbed = await window.klaus.pr.humanizeScrub(current);
    if (scrubbed && scrubbed.text) current = scrubbed.text;
    return { before: original, after: current };
  };

  // Keeps the original text so the card can offer Revert.
  PR.humanizeFinding = function(f) {
    if (f.humanizeBusy) return;
    f.humanizeBusy = 'starting';
    f.humanizeError = null;
    PR.repaintAiReviewTab();

    PR.runHumanizeChain(f.text, {
      question: PR.humanizeQuestionFor(f),
      onStart: function (requestId) { f.humanizeRequestId = requestId; },
      onProgress: function (pass, n) {
        f.humanizeBusy = pass + ' (' + n + '/4)';
        PR.repaintAiReviewTab();
      },
    }).then(function (r) {
      f.humanizeBefore = r.before;
      f.text = r.after;
      f.humanizeBusy = null;
      f.humanizeRequestId = null;
      PR.repaintAiReviewTab();
      PR.saveAiReviewCache();
      // Reshaping the text can move the quoted snippet, so the anchor has to be
      // re-verified exactly as it is after a manual ✎ edit.
      PR.verifyFindingLocations();
    }).catch(function (err) {
      f.humanizeBusy = null;
      f.humanizeRequestId = null;
      var msg = err && err.message ? err.message : String(err);
      // Cancelling is a choice, not a failure — don't leave a red box behind.
      f.humanizeError = msg === 'cancelled' ? null : msg;
      PR.repaintAiReviewTab();
    });
  };

  // The finding keeps whatever text it had, since nothing is written until all
  // four passes finish.
  PR.cancelHumanize = function(f) {
    if (f.humanizeRequestId) window.klaus.pr.humanizePassCancel(f.humanizeRequestId);
    f.humanizeBusy = null;
    f.humanizeRequestId = null;
    PR.repaintAiReviewTab();
  };

  // What the text is answering, which pass 1 cuts against: a finding answers
  // "what's wrong at this location", so hand over the title and location.
  PR.humanizeQuestionFor = function(f) {
    var bits = [];
    if (f.title) bits.push(f.title);
    if (f.path) bits.push('at ' + f.path + (f.line ? ':' + f.line : ''));
    return bits.length ? 'A code review comment about: ' + bits.join(' ') : null;
  };

  PR.revertHumanize = function(f) {
    if (f.humanizeBefore == null) return;
    f.text = f.humanizeBefore;
    f.humanizeBefore = null;
    PR.repaintAiReviewTab();
    PR.saveAiReviewCache();
    PR.verifyFindingLocations();
  };

})(window.PrReview);
