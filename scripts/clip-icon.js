const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Disable Electron's dock icon so it doesn't bounce in the dock
if (app.dock) app.dock.hide();

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadURL(`data:text/html,<html><body><canvas id="canvas"></canvas></body></html>`);

  win.webContents.on('did-finish-load', async () => {
    const args = process.argv.slice(2);
    // Find arguments that don't start with electron/package flags
    const realArgs = args.filter(a => !a.startsWith('--') && a !== '.');
    
    const srcPath = realArgs[0];
    const destPath = realArgs[1];
    const radiusStr = realArgs[2] || '0.223'; // macOS standard squircle radius is about 22.3% of size
    
    if (!srcPath || !destPath) {
      console.error("Usage: electron scripts/clip-icon.js <src> <dest> [radius]");
      app.exit(1);
      return;
    }

    try {
      const base64Data = fs.readFileSync(srcPath).toString('base64');
      
      const result = await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.getElementById('canvas');
            const size = img.width; // assume square
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            
            // Clear canvas
            ctx.clearRect(0, 0, size, size);
            
            // Draw rounded rect (squircle approximation)
            const r = size * ${radiusStr};
            ctx.beginPath();
            ctx.moveTo(r, 0);
            ctx.lineTo(size - r, 0);
            ctx.quadraticCurveTo(size, 0, size, r);
            ctx.lineTo(size, size - r);
            ctx.quadraticCurveTo(size, size, size - r, size);
            ctx.lineTo(r, size);
            ctx.quadraticCurveTo(0, size, 0, size - r);
            ctx.lineTo(0, r);
            ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.closePath();
            
            ctx.clip();
            ctx.drawImage(img, 0, 0, size, size);
            
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = (err) => reject(new Error('Image failed to load: ' + err));
          img.src = 'data:image/png;base64,' + '${base64Data}';
        })
      `);

      const buffer = Buffer.from(result.split(',')[1], 'base64');
      fs.writeFileSync(destPath, buffer);
      console.log("Successfully clipped and saved transparent PNG to " + destPath);
      app.exit(0);
    } catch (err) {
      console.error("Error clipping icon:", err);
      app.exit(1);
    }
  });
});
