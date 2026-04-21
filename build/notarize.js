// electron-builder afterSign hook: notarize the signed .app via notarytool.
//
// Inert today. Activates automatically once both:
//   1. mac.identity in package.json points at a Developer ID Application cert
//   2. APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are exported
//      in the build environment.
//
// To finish setup once you have a Developer ID cert:
//   - Enroll in the Apple Developer Program ($99/yr).
//   - Generate a Developer ID Application certificate in your Apple
//     Developer account; install it via Xcode (or download + open the .cer).
//   - Generate an app-specific password at appleid.apple.com → Security.
//   - Find your Team ID in your Apple Developer account.
//   - Export them in your shell or CI:
//       export APPLE_ID="you@example.com"
//       export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
//       export APPLE_TEAM_ID="XXXXXXXXXX"
//   - Flip mac.identity in package.json to your cert's Common Name (or
//     remove the field entirely so electron-builder auto-detects it) and
//     set hardenedRuntime: true.
//   - Then `npm run dist` will sign + notarize the build.

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — skipping notarization.');
    return;
  }

  // Lazy-require so the package isn't a hard dependency until signing is on.
  let notarize;
  try {
    notarize = require('@electron/notarize').notarize;
  } catch (_) {
    console.warn('[notarize] @electron/notarize not installed — run `npm install --save-dev @electron/notarize` to enable.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] submitting ${appName} to Apple notary service…`);
  await notarize({
    tool: 'notarytool',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] done.');
};
