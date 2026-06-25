const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const options = [
  {
    name: 'option-a-loom',
    src: '/Users/stephaniedover/.gemini/antigravity-cli/brain/b2900144-3a33-4375-a846-940e92cdeacf/neon_loom_frameless_1782416432288.jpg'
  },
  {
    name: 'option-b-prism',
    src: '/Users/stephaniedover/.gemini/antigravity-cli/brain/b2900144-3a33-4375-a846-940e92cdeacf/code_prism_icon_1782414531273.jpg'
  },
  {
    name: 'option-c-sentinel',
    src: '/Users/stephaniedover/.gemini/antigravity-cli/brain/b2900144-3a33-4375-a846-940e92cdeacf/git_nodes_icon_1782414542249.jpg'
  }
];

const targetBase = path.resolve(__dirname, '..', 'icon-options');

if (!fs.existsSync(targetBase)) {
  fs.mkdirSync(targetBase, { recursive: true });
}

for (const option of options) {
  console.log(`Processing ${option.name}...`);
  const outDir = path.join(targetBase, option.name);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 1. Generate PNGs: icon.png (512x512), icon-1024.png (1024x1024), icon-2048.png (2048x2048), icon-square-1024.png, icon-square-2048.png
  // First convert src to a temp 2048x2048 png to work with
  const tempPngRaw = path.join(outDir, 'temp-source-raw.png');
  execFileSync('sips', ['-s', 'format', 'png', option.src, '--out', tempPngRaw]);
  execFileSync('sips', ['-z', '2048', '2048', tempPngRaw]);

  // Clip the corners using Electron's browser-based canvas for standard (rounded) icons
  console.log(`Clipping corners for ${option.name}...`);
  const tempPng = path.join(outDir, 'temp-source.png');
  execFileSync('npx', ['electron', path.resolve(__dirname, 'clip-icon.js'), tempPngRaw, tempPng, '0.223']);

  // Generate target standard PNGs (with transparent clipped corners)
  execFileSync('sips', ['-z', '512', '512', tempPng, '--out', path.join(outDir, 'icon.png')]);
  execFileSync('sips', ['-z', '1024', '1024', tempPng, '--out', path.join(outDir, 'icon-1024.png')]);
  execFileSync('sips', ['-z', '2048', '2048', tempPng, '--out', path.join(outDir, 'icon-2048.png')]);
  
  // Generate square standard PNGs (without clipped corners)
  execFileSync('sips', ['-z', '1024', '1024', tempPngRaw, '--out', path.join(outDir, 'icon-square-1024.png')]);
  execFileSync('sips', ['-z', '2048', '2048', tempPngRaw, '--out', path.join(outDir, 'icon-square-2048.png')]);

  // 2. Generate icon.ico using png-to-ico
  console.log(`Generating ICO for ${option.name}...`);
  const icoSizes = [16, 32, 48, 256];
  const renders = [];
  for (const size of icoSizes) {
    const rPath = path.join(outDir, `temp-${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), tempPng, '--out', rPath]);
    renders.push(rPath);
  }

  // Use png-to-ico
  const icoOutput = path.join(outDir, 'icon.ico');
  const result = execFileSync('npx', ['--yes', 'png-to-ico', ...renders]);
  fs.writeFileSync(icoOutput, result);
  
  // Cleanup temp ICO files
  for (const rPath of renders) {
    fs.unlinkSync(rPath);
  }

  // 3. Generate icon.icns using iconutil
  console.log(`Generating ICNS for ${option.name}...`);
  const iconsetDir = path.join(outDir, 'icon.iconset');
  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
  }

  const icnsSizes = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 }
  ];

  for (const item of icnsSizes) {
    execFileSync('sips', ['-z', String(item.size), String(item.size), tempPng, '--out', path.join(iconsetDir, item.name)]);
  }

  // Run iconutil
  execFileSync('iconutil', ['-c', 'icns', iconsetDir]);
  
  // Cleanup iconset directory & temp files
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.unlinkSync(tempPng);
  fs.unlinkSync(tempPngRaw);

  console.log(`Successfully generated assets for ${option.name}`);
}

console.log('All option assets generated successfully!');
