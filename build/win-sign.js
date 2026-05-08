// electron-builder Windows sign hook: signs each .exe via SSL.com eSigner
// CodeSignTool. Required env (set as GitHub Actions secrets in CI):
//   ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_TOTP_SECRET, ESIGNER_CREDENTIAL_ID
// Plus CODESIGNTOOL_PATH pointing at the unzipped CodeSignTool root.
//
// ESIGNER_TOTP_SECRET must be the BASE64 "secret code" SSL.com displays under
// the eSigner QR — not the base32 seed embedded in the QR itself. Authenticator
// apps consume the base32 form for web 2FA; CodeSignTool consumes base64.

const { spawnSync } = require('child_process');
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

  const jar = findJar(CODESIGNTOOL_PATH);
  const inputDir = path.dirname(filePath);
  const outputDir = path.join(inputDir, 'signed');
  fs.mkdirSync(outputDir, { recursive: true });

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
