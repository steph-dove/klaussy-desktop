// Also electron-builder's beforePack hook, so no installer can be built without the verified model.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const manifest = require('../main/util/voice-model.json');

const DEFAULT_DEST = path.join(__dirname, '..', 'vendor', 'voice-model');

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
  for (const [rel, expected] of Object.entries(model.files)) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) missing.push(rel);
    else if (await sha256File(file) !== expected) bad.push(rel);
  }
  return { ok: missing.length === 0 && bad.length === 0, missing, bad };
}

async function fetchModel({ dest = DEFAULT_DEST, fetchImpl = fetch, log = console.log, model = manifest } = {}) {
  const { missing, bad } = await verifyModel(dest, model);
  for (const rel of [...missing, ...bad]) {
    const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${rel}`;
    const file = path.join(dest, rel);
    const part = file + '.part';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    log(`[voice-model] fetching ${rel}`);
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`voice model: ${rel} download failed (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
    const actual = await sha256File(part);
    if (actual !== model.files[rel]) {
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
module.exports.sha256File = sha256File;

if (require.main === module) {
  fetchModel().then(
    (dest) => console.log(`[voice-model] ready in ${dest}`),
    (err) => { console.error(err.message); process.exit(1); },
  );
}
