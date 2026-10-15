// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Also electron-builder's beforePack hook, so no installer can be built without the verified model and runtime.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const manifest = require('../main/util/voice-model.json');
const { voiceFiles } = require('../main/util/voice-files');

const DEFAULT_DEST = path.join(__dirname, '..', 'vendor', 'voice-model');
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [2000, 8000];

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyModel(dir, model = manifest) {
  const missing = [];
  const bad = [];
  for (const { rel, sha256 } of voiceFiles(model)) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) missing.push(rel);
    else if (await sha256File(file) !== sha256) bad.push(rel);
  }
  return { ok: missing.length === 0 && bad.length === 0, missing, bad };
}

async function download(url, part, fetchImpl, delays, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (!res.ok || !res.body) {
        const err = new Error(`HTTP ${res.status}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
      return;
    } catch (err) {
      if (err.retryable === false || attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}

async function fetchModel({
  dest = DEFAULT_DEST,
  fetchImpl = fetch,
  log = console.log,
  model = manifest,
  delays = RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const { missing, bad } = await verifyModel(dest, model);
  const todo = new Set([...missing, ...bad]);
  for (const { rel, sha256, url } of voiceFiles(model)) {
    if (!todo.has(rel)) continue;
    const file = path.join(dest, rel);
    const part = file + '.part';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    log(`[voice-model] fetching ${rel}`);
    try {
      await download(url, part, fetchImpl, delays, sleep);
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw new Error(`voice model: ${rel} download failed (${err.message})`);
    }
    const actual = await sha256File(part);
    if (actual !== sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`voice model: ${rel} sha256 mismatch (got ${actual})`);
    }
    fs.renameSync(part, file);
  }
  return dest;
}

module.exports = async function beforePack() {
  await fetchModel();
};
module.exports.fetchModel = fetchModel;
module.exports.verifyModel = verifyModel;

if (require.main === module) {
  fetchModel().then(
    (dest) => console.log(`[voice-model] ready in ${dest}`),
    (err) => { console.error(err.message); process.exit(1); },
  );
}
