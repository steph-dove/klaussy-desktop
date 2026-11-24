// electron-builder afterSign hook: notarize the signed .app via notarytool.
//
// Inert until mac.identity in package.json points at a Developer ID Application cert and the
// build environment has notary credentials, either:
//   - APPLE_KEYCHAIN_PROFILE: the name given to `xcrun notarytool store-credentials <name>`, which
//     keeps the app-specific password in the keychain. It wins over the three variables below.
//   - APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, all three.
// Setting only some of the three is an error, so a half-configured release build can't ship
// unnotarized by accident.
//
// To finish setup once you have a Developer ID cert:
//   - Enroll in the Apple Developer Program ($99/yr).
//   - Generate a Developer ID Application certificate in your Apple
//     Developer account; install it via Xcode (or download + open the .cer).
//   - Generate an app-specific password at appleid.apple.com → Security.
//   - Find your Team ID in your Apple Developer account.
//   - Either store them once in a keychain profile:
//       xcrun notarytool store-credentials maussian-notary --apple-id you@example.com --team-id XXXXXXXXXX
//       export APPLE_KEYCHAIN_PROFILE=maussian-notary
//     or export them in your shell or CI:
//       export APPLE_ID="you@example.com"
//       export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
//       export APPLE_TEAM_ID="XXXXXXXXXX"
//   - Flip mac.identity in package.json to your cert's Common Name (or
//     remove the field entirely so electron-builder auto-detects it) and
//     set hardenedRuntime: true.
//   - Then `npm run dist` will sign + notarize the build.

const APPLE_VARS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

// Picks the notary credentials from the environment. Returns null when none are set, and throws
// when only some of the three APPLE_* variables are.
function notaryCredentials(env, log = console.log) {
  const set = APPLE_VARS.filter((name) => env[name]);
  if (env.APPLE_KEYCHAIN_PROFILE) {
    log(`[notarize] using keychain profile ${env.APPLE_KEYCHAIN_PROFILE}`);
    if (set.length) log(`[notarize] ignoring ${set.join(', ')} because APPLE_KEYCHAIN_PROFILE is set`);
    return { keychainProfile: env.APPLE_KEYCHAIN_PROFILE };
  }
  if (set.length === APPLE_VARS.length) {
    log('[notarize] using APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID');
    return { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
  }
  if (set.length) {
    const missing = APPLE_VARS.filter((name) => !env[name]);
    throw new Error(`[notarize] ${set.join(', ')} set but ${missing.join(', ')} missing. Set all three or APPLE_KEYCHAIN_PROFILE.`);
  }
  return null;
}

async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const credentials = notaryCredentials(process.env);
  if (!credentials) {
    console.log('[notarize] neither APPLE_KEYCHAIN_PROFILE nor APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID set — skipping notarization.');
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
    ...credentials,
  });
  console.log('[notarize] done.');
}

exports.default = notarizing;
exports.notaryCredentials = notaryCredentials;
