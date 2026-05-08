// electron-builder Windows sign hook: signs each .exe via SSL.com eSigner
// CodeSignTool. Required env (set as GitHub Actions secrets in CI):
//   ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_TOTP_SECRET, ESIGNER_CREDENTIAL_ID
// Plus CODESIGNTOOL_PATH pointing at the unzipped CodeSignTool root.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Calling java -jar directly bypasses cmd.exe entirely — no .bat dispatch, no
// shell metachar escaping needed for secrets containing & | < > ^ etc.
function findJar(toolDir) {
  const candidates = [path.join(toolDir, 'jar'), toolDir, path.join(toolDir, 'lib')];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const jar = fs.readdirSync(dir).find((f) => /^code_sign_tool.*\.jar$/i.test(f));
    if (jar) return path.join(dir, jar);
  }
  throw new Error(`[win-sign] code_sign_tool jar not found under ${toolDir}`);
}

// Standard RFC 6238 TOTP — SHA1, 6 digits, 30s period. Matches Authy/oathtool;
// using this instead of CodeSignTool's -totp_secret= flag because their Java
// impl rejected codes that Authy + oathtool agree on.
function base32Decode(input) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = '';
  for (const c of cleaned) {
    const v = alpha.indexOf(c);
    if (v < 0) throw new Error(`invalid base32 char: ${c}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, when = Date.now()) {
  const counter = Math.floor(when / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24)
    | ((hmac[off + 1] & 0xff) << 16)
    | ((hmac[off + 2] & 0xff) << 8)
    | (hmac[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

exports.default = async function sign(configuration) {
  const filePath = configuration.path;
  if (!filePath) return;

  const {
    ESIGNER_USERNAME,
    ESIGNER_PASSWORD,
    ESIGNER_TOTP_SECRET,
    ESIGNER_CREDENTIAL_ID,
    CODESIGNTOOL_PATH,
  } = process.env;

  const required = { ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_TOTP_SECRET, ESIGNER_CREDENTIAL_ID, CODESIGNTOOL_PATH };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.log(`[win-sign] skipping ${path.basename(filePath)} — missing env: ${missing.join(', ')}`);
    return;
  }

  // Diagnostic info — none of these reveal the secret. Helps pinpoint
  // whether the issue is clock skew, wrong seed length, or seed corruption.
  const seedHash = crypto.createHash('sha256').update(ESIGNER_TOTP_SECRET).digest('hex').slice(0, 12);
  console.log(`[win-sign] runner UTC: ${new Date().toISOString()}`);
  console.log(`[win-sign] seed length: ${ESIGNER_TOTP_SECRET.length}, sha256[:12]: ${seedHash}`);

  const jar = findJar(CODESIGNTOOL_PATH);
  const inputDir = path.dirname(filePath);
  const outputDir = path.join(inputDir, 'signed');
  fs.mkdirSync(outputDir, { recursive: true });

  // Log the locally-computed OTP and the time slot so the user can verify
  // against Authy/oathtool what the OTP "should" be at this exact moment.
  // Each TOTP is valid for ~30s and rotates, so logging it has minimal
  // security risk — this is purely diagnostic.
  const nowSec = Math.floor(Date.now() / 1000);
  const otp = generateTotp(ESIGNER_TOTP_SECRET);
  console.log(`[win-sign] local OTP for slot ${Math.floor(nowSec / 30)} (unix=${nowSec}): ${otp}`);
  console.log(`[win-sign] signing ${path.basename(filePath)} via SSL.com eSigner…`);
  const result = spawnSync('java', [
    '-jar', jar,
    'sign',
    `-username=${ESIGNER_USERNAME}`,
    `-password=${ESIGNER_PASSWORD}`,
    `-totp_secret=${ESIGNER_TOTP_SECRET}`,
    `-credential_id=${ESIGNER_CREDENTIAL_ID}`,
    `-input_file_path=${filePath}`,
    `-output_dir_path=${outputDir}`,
  ], { cwd: CODESIGNTOOL_PATH, encoding: 'utf8' });

  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`[win-sign] CodeSignTool exited with status ${result.status}`);
  }
  if (/^Error:/m.test(result.stdout || '')) {
    throw new Error('[win-sign] CodeSignTool reported an error in stdout (see above)');
  }

  const signed = path.join(outputDir, path.basename(filePath));
  if (!fs.existsSync(signed)) {
    throw new Error(`[win-sign] expected signed output at ${signed} not found`);
  }
  fs.renameSync(signed, filePath);
  console.log(`[win-sign] signed ${path.basename(filePath)} ✓`);
};
