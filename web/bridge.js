// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Browser side of browser mode. Loaded before /web/preload.js (the real
// preload.js, wrapped by web/helper.js), it provides what that file expects
// from require('electron'): contextBridge, ipcRenderer and webUtils, with
// ipcRenderer carried over a WebSocket to the local helper.
//
// It also answers the helper's dialog requests (message boxes, folder and save
// pickers) with in-page modals, since there are no native dialogs here.

(function () {
  'use strict';

  var TOKEN_KEY = 'maussian.token';
  var WIN_KEY = 'maussian.win';

  // ---- token (arrives once in the URL fragment the helper opens) -----------
  // Kept in sessionStorage, so it lives only as long as this tab: nothing
  // persistent for an injected script to collect. A new tab without it shows
  // the connect card, and `npm run web` opens a signed-in one. The plan
  // replaces the token with a per-browser key pair (docs/browser-mode.md).
  function store(kind) { try { return window[kind]; } catch (_e) { return null; } }
  var session = store('sessionStorage');
  // Earlier builds kept it in localStorage; don't leave it behind.
  try { var local = store('localStorage'); if (local) local.removeItem(TOKEN_KEY); } catch (_e) { /* storage blocked */ }

  var m = location.hash.match(/(?:^#|&)token=([A-Za-z0-9_-]{43})/);
  if (m) {
    if (session) session.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
  var token = (session && session.getItem(TOKEN_KEY)) || (m && m[1]) || '';

  function showConnect(reason) {
    var paint = function () {
      document.body.innerHTML = '';
      document.body.style.cssText = 'margin:0;font:15px/1.5 system-ui,sans-serif;background:#f6f5f2;color:#1d1d1b;display:flex;align-items:center;justify-content:center;min-height:100vh';
      var card = document.createElement('div');
      card.style.cssText = 'max-width:460px;padding:32px;background:#fff;border:1px solid #dddcd7;border-radius:12px';
      var h = document.createElement('h1');
      h.textContent = 'Connect your computer';
      h.style.cssText = 'font-size:20px;margin:0 0 8px';
      var p = document.createElement('p');
      p.textContent = reason || 'Maussian runs on your machine. Start it in a terminal, and it opens this page signed in:';
      var code = document.createElement('pre');
      code.textContent = 'npm run web';
      code.style.cssText = 'background:#f0efec;padding:10px 12px;border-radius:8px;font-size:14px';
      card.appendChild(h); card.appendChild(p); card.appendChild(code);
      document.body.appendChild(card);
    };
    if (document.body) paint(); else document.addEventListener('DOMContentLoaded', paint);
  }

  // ---- encoding (Uint8Array <-> base64, mirrored in web/helper.js) ----------
  function toB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    var s = atob(b64);
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  function encode(obj) {
    return JSON.stringify(obj, function (_k, v) {
      if (v instanceof ArrayBuffer) v = new Uint8Array(v);
      if (v instanceof Uint8Array) return { __b64: toB64(v) };
      return v;
    });
  }
  function decode(text) {
    return JSON.parse(text, function (_k, v) {
      return v && typeof v.__b64 === 'string' && Object.keys(v).length === 1 ? fromB64(v.__b64) : v;
    });
  }

  function syncPost(url, body) {
    var x = new XMLHttpRequest();
    x.open('POST', url, false);
    x.setRequestHeader('Content-Type', 'application/json');
    x.setRequestHeader('X-Maussian-Token', token);
    x.send(encode(body));
    if (x.status === 401) { var e = new Error('Unauthorized'); e.status = 401; throw e; }
    if (x.status !== 200) throw new Error('Helper answered ' + x.status);
    return decode(x.responseText);
  }

  // ---- bind this tab to a window in the helper -------------------------------
  var bound;
  try {
    if (!token) throw Object.assign(new Error('No token'), { status: 401 });
    bound = syncPost('/__bind', { winId: session && session.getItem(WIN_KEY) });
  } catch (err) {
    if (err.status === 401 && session) session.removeItem(TOKEN_KEY);
    showConnect(err.status === 401 ? null : 'Maussian isn’t running on this computer. Start it in a terminal:');
    window.__maussianRequire = function () { throw new Error('Maussian is not connected'); };
    return;
  }
  if (session) session.setItem(WIN_KEY, String(bound.winId));
  // A secondary window's renderer reads ?secondary=1 at load, so fix the URL
  // before any renderer script runs.
  if ((bound.query || '') !== location.search) {
    location.replace(location.pathname + (bound.query || ''));
    window.__maussianRequire = function () { throw new Error('Reloading'); };
    return;
  }

  // ---- ipcRenderer over the socket -----------------------------------------
  var listeners = Object.create(null);
  var pending = Object.create(null);
  var queue = [];
  var seq = 0;
  var ws = null;
  var ready = false;
  var everConnected = false;
  var retries = 0;
  var banner = null;
  // Messages wait here while connecting or reconnecting. A helper that stays
  // away shouldn't grow this without limit.
  var QUEUE_MAX = 1000;

  function emit(ch, args) {
    var set = listeners[ch];
    if (!set) return;
    var event = { sender: ipcRenderer, senderId: 0 };
    set.slice().forEach(function (fn) {
      try { fn.apply(null, [event].concat(args || [])); } catch (e) { console.error('[bridge] listener for ' + ch + ' threw', e); }
    });
  }

  // Send now if the socket is open; returns false otherwise.
  function trySend(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encode(msg));
    return true;
  }

  function post(msg) {
    if (ready && trySend(msg)) return;
    if (queue.length >= QUEUE_MAX) {
      var p = msg.t === 'invoke' && pending[msg.id];
      if (p) {
        delete pending[msg.id];
        p.reject(new Error("Error invoking remote method '" + p.ch + "': Maussian is not connected"));
      }
      return;
    }
    queue.push(msg);
  }

  function setBanner(text) {
    if (!text) { if (banner) { banner.remove(); banner = null; } return; }
    if (!document.body) return;
    if (!banner) {
      banner = document.createElement('div');
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;background:#1d1d1b;color:#fff;padding:8px 14px;border-radius:8px;font:13px system-ui,sans-serif';
      document.body.appendChild(banner);
    }
    banner.textContent = text;
  }

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__ws');
    ws.onopen = function () {
      // resume: this page kept its terminals through a dropped connection, so
      // the helper resets and repaints them with what they missed.
      trySend({ t: 'hello', token: token, winId: bound.winId, resume: everConnected });
    };
    ws.onmessage = function (e) {
      var msg = decode(e.data);
      if (msg.t === 'welcome') {
        ready = true;
        everConnected = true;
        retries = 0;
        setBanner(null);
        var q = queue; queue = [];
        q.forEach(function (x) { post(x); });
        return;
      }
      if (msg.t === 'res') {
        var p = pending[msg.id];
        if (!p) return;
        delete pending[msg.id];
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error("Error invoking remote method '" + p.ch + "': Error: " + msg.error));
        return;
      }
      if (msg.t === 'evt') return handleEvent(msg.ch, msg.args);
      if (msg.t === 'req') return handleRequest(msg);
    };
    ws.onclose = function (e) {
      ready = false;
      Object.keys(pending).forEach(function (id) {
        pending[id].reject(new Error("Error invoking remote method '" + pending[id].ch + "': lost connection to Maussian"));
        delete pending[id];
      });
      if (e.code === 4401) {
        if (session) session.removeItem(TOKEN_KEY);
        return showConnect('This tab is no longer signed in to Maussian. Start it again in a terminal to reconnect:');
      }
      if (e.code === 4409 && session) {
        // Our window was taken or closed while we were away: bind afresh.
        session.removeItem(WIN_KEY);
        return location.reload();
      }
      setBanner(everConnected ? 'Lost connection to Maussian. Reconnecting…' : 'Connecting to Maussian…');
      // 1 s, 2 s, 4 s ... capped at 10 s.
      setTimeout(connect, Math.min(1000 * Math.pow(2, retries++), 10000));
    };
  }

  function handleEvent(ch, args) {
    if (ch === '__web:reload') return location.reload();
    if (ch === '__web:title') { document.title = args[0] || 'Maussian'; return; }
    if (ch === '__web:focus') { window.focus(); return; }
    if (ch === '__web:notification') return notify(args[0] || {});
    if (ch === '__web:error-box') { messageDialog('error', args[0] || {}); return; }
    emit(ch, args);
  }

  function notify(n) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') { new Notification(n.title || 'Maussian', { body: n.body || '' }); return; }
    if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(function (p) {
        if (p === 'granted') new Notification(n.title || 'Maussian', { body: n.body || '' });
      });
    }
  }

  var ipcRenderer = {
    invoke: function (ch) {
      var args = Array.prototype.slice.call(arguments, 1);
      var id = ++seq;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject, ch: ch };
        post({ t: 'invoke', id: id, ch: ch, args: args });
      });
    },
    send: function (ch) {
      post({ t: 'send', ch: ch, args: Array.prototype.slice.call(arguments, 1) });
    },
    sendSync: function (ch) {
      return syncPost('/__sync', { winId: bound.winId, ch: ch, args: Array.prototype.slice.call(arguments, 1) }).value;
    },
    on: function (ch, fn) {
      (listeners[ch] = listeners[ch] || []).push(fn);
      return ipcRenderer;
    },
    once: function (ch, fn) {
      var wrapper = function () { ipcRenderer.removeListener(ch, wrapper); return fn.apply(null, arguments); };
      wrapper.__orig = fn;
      return ipcRenderer.on(ch, wrapper);
    },
    removeListener: function (ch, fn) {
      var set = listeners[ch];
      if (!set) return ipcRenderer;
      for (var i = set.length - 1; i >= 0; i--) {
        if (set[i] === fn || set[i].__orig === fn) { set.splice(i, 1); break; }
      }
      return ipcRenderer;
    },
    removeAllListeners: function (ch) {
      if (ch) delete listeners[ch]; else listeners = Object.create(null);
      return ipcRenderer;
    },
  };
  ipcRenderer.off = ipcRenderer.removeListener;
  ipcRenderer.addListener = ipcRenderer.on;

  var contextBridge = {
    exposeInMainWorld: function (name, api) {
      Object.defineProperty(window, name, { value: Object.freeze(api), configurable: false, writable: false });
    },
  };
  // Browsers never reveal a dropped file's path.
  var webUtils = { getPathForFile: function () { return ''; } };

  window.__maussianRequire = function (name) {
    if (name === 'electron') return { contextBridge: contextBridge, ipcRenderer: ipcRenderer, webUtils: webUtils };
    throw new Error("Cannot find module '" + name + "' in browser mode");
  };

  window.addEventListener('focus', function () { if (ready) trySend({ t: 'focus' }); });

  // ---- dialogs ------------------------------------------------------------
  // The helper waits on a dialog for as long as the person takes; a tab that
  // goes away fails the request on the helper's side (TabSocket.failPending).
  function handleRequest(msg) {
    var work = msg.method === 'dialog' ? showDialog(msg.params.kind, msg.params.opts || {})
      : Promise.reject(new Error('Unknown request ' + msg.method));
    work.then(function (value) {
      if (!trySend({ t: 'res', id: msg.id, ok: true, value: value })) console.warn('[bridge] dialog answered after the connection dropped');
    }, function (err) {
      trySend({ t: 'res', id: msg.id, ok: false, error: String(err && err.message || err) });
    });
  }

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  var BTN = 'font:13px system-ui,sans-serif;padding:6px 14px;border-radius:6px;border:1px solid #c9c8c2;background:#fff;color:#1d1d1b;cursor:pointer';
  var BTN_MAIN = 'font:13px system-ui,sans-serif;padding:6px 14px;border-radius:6px;border:1px solid #1d1d1b;background:#1d1d1b;color:#fff;cursor:pointer';
  var INPUT = 'font:13px ui-monospace,monospace;padding:8px;border:1px solid #c9c8c2;border-radius:6px;width:100%;box-sizing:border-box';
  var dialogSeq = 0;

  var FOCUSABLE = 'button, input, [tabindex="0"]';

  // A modal: labelled by its own title, Tab kept inside it, and focus handed
  // back to whatever had it when the modal closes. It usually opens over one of
  // the app's own modals (the picker behind Browse), whose focus trap would pull
  // Tab back into itself; in Electron a native dialog sits outside the page, so
  // this one takes Tab at the document, in the capture phase, before that trap
  // sees it.
  function modal(title) {
    var id = 'maussian-dialog-' + (++dialogSeq);
    var returnFocus = document.activeElement;
    var overlay = el('div', 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center');
    var box = el('div', 'width:min(520px,calc(100vw - 32px));max-height:80vh;display:flex;flex-direction:column;gap:12px;background:#fff;color:#1d1d1b;border-radius:12px;padding:20px;font:14px/1.45 system-ui,sans-serif;box-sizing:border-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    var h = el('h2', 'margin:0;font-size:16px', title || 'Maussian');
    h.id = id + '-title';
    box.setAttribute('aria-labelledby', h.id);
    box.appendChild(h);
    var trapTab = function (e) {
      if (e.key !== 'Tab' || !document.body.contains(overlay)) return;
      var items = Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), function (n) { return !n.disabled; });
      if (!items.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var i = items.indexOf(document.activeElement);
      var next = i === -1 ? 0 : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener('keydown', trapTab, true);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return {
      id: id,
      overlay: overlay,
      box: box,
      close: function () {
        document.removeEventListener('keydown', trapTab, true);
        overlay.remove();
        if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus();
      },
    };
  }

  function labelledInput(d, labelText, suffix) {
    var label = el('label', 'font-size:13px;color:#55544f', labelText);
    var input = el('input', INPUT);
    input.id = d.id + '-' + suffix;
    label.htmlFor = input.id;
    d.box.appendChild(label);
    d.box.appendChild(input);
    return input;
  }

  function buttonsRow() { return el('div', 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap'); }

  function showDialog(kind, opts) {
    if (kind === 'message' || kind === 'error') return messageDialog(kind, opts);
    if (kind === 'open') return openDialog(opts);
    if (kind === 'save') return saveDialog(opts);
    return Promise.reject(new Error('Unknown dialog ' + kind));
  }

  function messageDialog(kind, opts) {
    return new Promise(function (resolve) {
      var buttons = opts.buttons && opts.buttons.length ? opts.buttons : ['OK'];
      var cancelId = opts.cancelId != null ? opts.cancelId : (kind === 'error' ? 0 : buttons.length - 1);
      var d = modal(opts.title || (kind === 'error' ? 'Error' : 'Maussian'));
      if (opts.message) d.box.appendChild(el('p', 'margin:0;font-weight:600', opts.message));
      if (opts.detail) d.box.appendChild(el('p', 'margin:0;white-space:pre-wrap;color:#55544f', opts.detail));
      var check = null;
      if (opts.checkboxLabel) {
        var label = el('label', 'display:flex;gap:8px;align-items:center');
        check = el('input');
        check.type = 'checkbox';
        check.checked = !!opts.checkboxChecked;
        label.appendChild(check);
        label.appendChild(document.createTextNode(opts.checkboxLabel));
        d.box.appendChild(label);
      }
      var row = buttonsRow();
      var done = function (i) {
        document.removeEventListener('keydown', onKey, true);
        d.close();
        resolve({ response: i, checkboxChecked: check ? check.checked : false });
      };
      var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(cancelId); } };
      document.addEventListener('keydown', onKey, true);
      var defaultId = opts.defaultId != null ? opts.defaultId : 0;
      buttons.forEach(function (text, i) {
        var b = el('button', i === defaultId ? BTN_MAIN : BTN, text);
        b.type = 'button';
        b.onclick = function () { done(i); };
        row.appendChild(b);
        if (i === defaultId) setTimeout(function () { b.focus(); }, 0);
      });
      d.box.appendChild(row);
    });
  }

  function openDialog(opts) {
    var props = opts.properties || [];
    var wantDir = props.indexOf('openDirectory') !== -1;
    var wantFile = props.indexOf('openFile') !== -1 || !wantDir;
    return new Promise(function (resolve) {
      var d = modal(opts.title || (wantDir ? 'Choose a folder' : 'Choose a file'));
      var input = labelledInput(d, 'Path (press Enter to go there)', 'path');
      var listLabel = el('div', 'font-size:13px;color:#55544f', wantFile ? 'Folders and files' : 'Folders');
      listLabel.id = d.id + '-list-label';
      var list = el('ul', 'list-style:none;margin:0;padding:0;overflow:auto;flex:1;min-height:200px;border:1px solid #e3e2dd;border-radius:6px');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-labelledby', listLabel.id);
      var current = null;
      var chosenFile = null;

      // One option in the Tab order at a time; arrows move between them.
      function options() { return Array.prototype.slice.call(list.querySelectorAll('[role=option]')); }
      function select(li) {
        options().forEach(function (o) {
          var on = o === li;
          o.setAttribute('aria-selected', on ? 'true' : 'false');
          o.tabIndex = on ? 0 : -1;
          o.style.background = on ? '#f0efec' : '';
        });
        if (li) li.focus();
      }

      function item(label, activate, bold) {
        var li = el('li', 'padding:6px 10px;cursor:pointer;' + (bold ? 'font-weight:600' : ''), label);
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.tabIndex = -1;
        li.onclick = function () { select(li); activate(); };
        li.onkeydown = function (e) {
          var all = options();
          var i = all.indexOf(li);
          if (e.key === 'Enter') { e.preventDefault(); activate(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); select(all[Math.min(i + 1, all.length - 1)]); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); select(all[Math.max(i - 1, 0)]); }
          else if (e.key === 'Home') { e.preventDefault(); select(all[0]); }
          else if (e.key === 'End') { e.preventDefault(); select(all[all.length - 1]); }
        };
        list.appendChild(li);
      }

      function load(dir) {
        ipcRenderer.invoke('__web:list-dir', dir).then(function (r) {
          current = r;
          chosenFile = null;
          input.value = r.path;
          input.removeAttribute('aria-invalid');
          input.style.borderColor = '';
          list.innerHTML = '';
          if (r.parent) item('↑ ..', function () { load(r.parent); });
          r.dirs.forEach(function (name) { item(name + r.sep, function () { load(r.path + r.sep + name); }, true); });
          if (wantFile) r.files.forEach(function (name) {
            item(name, function () { chosenFile = r.path + r.sep + name; input.value = chosenFile; });
          });
          var first = options()[0];
          if (first) first.tabIndex = 0;
        }, function (err) {
          input.style.borderColor = '#c0392b';
          input.setAttribute('aria-invalid', 'true');
          input.title = err.message;
        });
      }

      input.onkeydown = function (e) {
        if (e.key === 'Enter') load(input.value);
        if (e.key === 'ArrowDown') { e.preventDefault(); select(options()[0]); }
      };
      var row = buttonsRow();
      var cancel = el('button', BTN, 'Cancel');
      var ok = el('button', BTN_MAIN, opts.buttonLabel || (wantDir ? 'Choose folder' : 'Open'));
      cancel.type = ok.type = 'button';
      var done = function (result) {
        document.removeEventListener('keydown', onKey, true);
        d.close();
        resolve(result);
      };
      var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done({ canceled: true, filePaths: [] }); } };
      document.addEventListener('keydown', onKey, true);
      cancel.onclick = function () { done({ canceled: true, filePaths: [] }); };
      ok.onclick = function () {
        var picked = chosenFile || (wantDir && current ? current.path : input.value);
        done(picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] });
      };
      row.appendChild(cancel);
      row.appendChild(ok);
      d.box.appendChild(listLabel);
      d.box.appendChild(list);
      d.box.appendChild(row);
      load(opts.defaultPath || bound.home);
      setTimeout(function () { input.focus(); }, 0);
    });
  }

  function saveDialog(opts) {
    return new Promise(function (resolve) {
      var d = modal(opts.title || 'Save as');
      var input = labelledInput(d, 'Save to', 'path');
      input.value = opts.defaultPath || bound.home;
      var row = buttonsRow();
      var cancel = el('button', BTN, 'Cancel');
      var ok = el('button', BTN_MAIN, opts.buttonLabel || 'Save');
      cancel.type = ok.type = 'button';
      var done = function (r) { d.close(); resolve(r); };
      cancel.onclick = function () { done({ canceled: true, filePath: undefined }); };
      ok.onclick = function () { done(input.value ? { canceled: false, filePath: input.value } : { canceled: true }); };
      input.onkeydown = function (e) {
        if (e.key === 'Enter') ok.onclick();
        if (e.key === 'Escape') cancel.onclick();
      };
      row.appendChild(cancel);
      row.appendChild(ok);
      d.box.appendChild(row);
      setTimeout(function () { input.focus(); input.select(); }, 0);
    });
  }

  connect();
})();
