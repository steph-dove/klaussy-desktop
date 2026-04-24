// Build-time feature flags that change between internal and retail builds.
//
// `licenseRequired`:
//   false — license gate is a no-op; the activation modal never shows, and
//           isActivated() always returns true. Use for internal dogfood
//           builds distributed to friends / beta testers.
//   true  — normal license enforcement. Unactivated packaged builds see the
//           modal on launch and get a dismissable activation prompt.
//
// Flip this to `true` before the first commercial release, rebuild, ship.
// Dev builds (`electron .`) always bypass regardless of this value.

module.exports = {
  licenseRequired: false,
};
