// Removes the per-run temp root playwright.config.js made, which every spec's
// temp repos live under.
const fs = require('fs');

module.exports = async () => {
  const root = process.env.MAUSSIAN_E2E_ROOT;
  if (root && root.includes('maussian-e2e-root-')) fs.rmSync(root, { recursive: true, force: true });
};
