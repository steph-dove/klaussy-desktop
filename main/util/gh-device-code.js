'use strict';

// Older gh prints "one-time code: ABCD-1234"; 2.102 prints "One-time code (ABCD-1234) copied to clipboard".
function parseGhDeviceCode(text) {
  const m = /one-time code\W+([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(String(text || ''));
  return m ? m[1].toUpperCase() : null;
}

// Without a TTY gh asks the user to open the URL instead of opening it.
function ghWantsUserToOpenBrowser(text) {
  return /open this url/i.test(String(text || ''));
}

module.exports = { parseGhDeviceCode, ghWantsUserToOpenBrowser };
