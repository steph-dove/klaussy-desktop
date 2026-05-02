// Regenerates icon.ico from icon.png when the source icon changes.
//
// Standard Windows ICO sizes are 16, 32, 48, 256. We render each by
// downsampling icon.png with sips (built into macOS), then combine them
// into a multi-resolution .ico via the png-to-ico npm package (run via
// npx so we don't permanently add it to devDependencies — this script
// only needs to run when the icon source changes, not per-install).
//
// On non-macOS hosts, swap the sips block for ImageMagick or sharp.
//
// Usage: node scripts/generate-icon-ico.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.error('This generator uses sips, which only ships on macOS. Install ImageMagick or run on a Mac.');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(repoRoot, 'icon.png');
const output = path.join(repoRoot, 'icon.ico');

if (!fs.existsSync(source)) {
  console.error(`Source not found: ${source}`);
  process.exit(1);
}

const sizes = [16, 32, 48, 256];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-ico-'));
try {
  const renders = [];
  for (const size of sizes) {
    const out = path.join(tmpDir, `icon-${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), source, '--out', out], {
      stdio: 'pipe',
    });
    renders.push(out);
  }

  // png-to-ico's CLI writes the ICO bytes to stdout. We capture and write.
  const result = spawnSync('npx', ['--yes', 'png-to-ico', ...renders], {
    encoding: 'buffer',
  });
  if (result.status !== 0) {
    console.error('png-to-ico failed:', result.stderr.toString());
    process.exit(1);
  }
  fs.writeFileSync(output, result.stdout);
  const kb = (result.stdout.length / 1024).toFixed(1);
  console.log(`Wrote ${output} (${kb} KB, ${sizes.join('/')})`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
