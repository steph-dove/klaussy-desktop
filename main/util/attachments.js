// Persists bytes the renderer dropped or pasted but has no file for: a browser
// drag or a clipboard screenshot, which carry no backing OS path.
//
// The renderer only suggests a name, main picks the directory — so there is no
// renderer-supplied path for the path-gate to have to defend.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Large enough for a retina screenshot or a short screen recording, small
// enough that a runaway paste can't fill the disk.
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

const ATTACHMENT_ROOT = 'klaussy-attachments';

// Reduce whatever the renderer sent to a plain basename. Stripped rather than
// rejected so a pasted image still lands instead of erroring at the user.
function safeAttachmentName(name) {
  const base = String(name == null ? '' : name).split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '').trim();
  if (!cleaned) return 'pasted-image.png';
  return cleaned.length > 120 ? cleaned.slice(-120) : cleaned;
}

// Each call gets its own directory, so two screenshots both named
// "Screenshot.png" don't clobber each other and the name the user recognizes
// survives into the prompt.
function saveAttachment(bytes, name) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buf.length === 0) return { error: 'attachment is empty' };
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    return { error: `attachment is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB` };
  }
  try {
    const dir = path.join(os.tmpdir(), ATTACHMENT_ROOT, crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, safeAttachmentName(name));
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { safeAttachmentName, saveAttachment, MAX_ATTACHMENT_BYTES };
