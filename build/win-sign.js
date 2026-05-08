// electron-builder Windows sign hook: signs each .exe via SSL.com eSigner
// CodeSignTool. Required env (set as GitHub Actions secrets in CI):
//   ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_TOTP_SECRET, ESIGNER_CREDENTIAL_ID
// Plus CODESIGNTOOL_PATH pointing at the unzipped CodeSignTool root.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

  const tool = process.platform === 'win32'
    ? path.join(CODESIGNTOOL_PATH, 'CodeSignTool.bat')
    : path.join(CODESIGNTOOL_PATH, 'CodeSignTool.sh');
  if (!fs.existsSync(tool)) {
    throw new Error(`[win-sign] CodeSignTool not found at ${tool}`);
  }

  const inputDir = path.dirname(filePath);
  const outputDir = path.join(inputDir, 'signed');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[win-sign] signing ${path.basename(filePath)} via SSL.com eSigner…`);
  execFileSync(tool, [
    'sign',
    `-username=${ESIGNER_USERNAME}`,
    `-password=${ESIGNER_PASSWORD}`,
    `-totp_secret=${ESIGNER_TOTP_SECRET}`,
    `-credential_id=${ESIGNER_CREDENTIAL_ID}`,
    `-input_file_path=${filePath}`,
    `-output_dir_path=${outputDir}`,
  ], { stdio: 'inherit', cwd: CODESIGNTOOL_PATH });

  // CodeSignTool writes a signed copy with the same basename into outputDir.
  // Move it back over the original so electron-builder's downstream steps
  // (latest.yml hashing, NSIS bundling) see the signed binary.
  const signed = path.join(outputDir, path.basename(filePath));
  if (!fs.existsSync(signed)) {
    throw new Error(`[win-sign] expected signed output at ${signed} not found`);
  }
  fs.renameSync(signed, filePath);
  console.log(`[win-sign] signed ${path.basename(filePath)} ✓`);
};
