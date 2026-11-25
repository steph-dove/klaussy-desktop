// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Agents Maussian used to drive whose CLIs are gone. Old settings and saved
// sessions that name one move to its replacement (util/config.js v2 -> v3),
// and the name stays for labels on anything still carrying the old id.
//
// No dependencies, so the config migration can require it at the top without
// a cycle (ai-providers requires util/config).

const RETIRED_AGENTS = {
  gemini: { displayName: 'Gemini CLI', shortLabel: 'gm', replacedBy: 'antigravity' },
};

function replacementFor(mode) {
  const r = typeof mode === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_AGENTS, mode)
    ? RETIRED_AGENTS[mode] : null;
  return r ? r.replacedBy : null;
}

// Which agent a saved session resumes under, and which one it counts as
// started by. A session still naming a retired agent (one the migration
// didn't reach) resumes under the replacement but counts as started by the
// retired one, so resume hands off and starts the replacement fresh instead of
// `--continue`-ing whatever conversation that agent ran last.
function resumeModes(mode, originalMode) {
  const resumeMode = replacementFor(mode) || mode || 'claude';
  return { resumeMode, startedBy: originalMode || mode || resumeMode };
}

module.exports = { RETIRED_AGENTS, replacementFor, resumeModes };
