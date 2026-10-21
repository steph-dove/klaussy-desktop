// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Clipboard write that reports whether it worked, so a "Copied" message is only shown when it did.

(function (root) {
  'use strict';

  // `clipboard` defaults to navigator.clipboard; tests pass a stub.
  async function copyCommand(cmd, clipboard) {
    var cb = clipboard !== undefined ? clipboard
      : (typeof navigator !== 'undefined' ? navigator.clipboard : null);
    if (!cb || typeof cb.writeText !== 'function') return false;
    try {
      await cb.writeText(cmd);
      return true;
    } catch (_) {
      return false;
    }
  }

  var api = { copyCommand: copyCommand };
  if (root) root.CopyCommand = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
