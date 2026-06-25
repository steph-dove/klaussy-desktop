const fs = require('fs');
const path = require('path');

const option = process.argv[2];
const validOptions = ['option-a-loom', 'option-b-prism', 'option-c-sentinel'];

if (!option || !validOptions.includes(option)) {
  console.error(`Please specify a valid option: ${validOptions.join(', ')}`);
  console.error(`Usage: node scripts/apply-icon-option.js <option-name>`);
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'icon-options', option);
const filesToCopy = [
  'icon.png',
  'icon-1024.png',
  'icon-2048.png',
  'icon-square-1024.png',
  'icon-square-2048.png',
  'icon.ico',
  'icon.icns'
];

for (const file of filesToCopy) {
  const src = path.join(srcDir, file);
  const dest = path.join(repoRoot, file);
  
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to root.`);
  } else {
    console.warn(`Source file not found: ${src}`);
  }
}

console.log(`\nSuccessfully applied "${option}" as the active app icon!`);
console.log(`You can now rebuild the app or run it using:`);
console.log(`  npm start`);
