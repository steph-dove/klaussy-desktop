// Automated OpenCode provider configuration helper for local Ollama models.
// Ensures ~/.config/opencode/opencode.jsonc includes the provider.ollama mapping
// (pointing to http://127.0.0.1:11434/v1) and model entry whenever an ollama model
// is selected in Klaussy.

const path = require('path');
const os = require('os');
const fs = require('fs');

// Approximate: a `//` inside a string that isn't preceded by `:` or `\` is
// stripped too, which can turn valid JSON invalid. Callers must treat a parse
// failure as "leave the file alone", never as "start from scratch".
function stripJsonComments(str) {
  return str.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
}

// Parsed contents, `{}` when the file is absent or empty, or `null` when it
// exists but can't be parsed.
function readJsonConfig(filePath, stripComments) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const text = (stripComments ? stripJsonComments(raw) : raw).trim();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    console.warn('[opencode-config] leaving ' + filePath + ' untouched, could not parse it:', err && err.message);
    return null;
  }
}

// opencode honors XDG on every platform; the POSIX fallbacks alone would write
// where Windows opencode never reads. `platform` is injectable so CI on
// macOS/Linux covers the Windows branches, as shQuote() does in ai-providers.js.
function configHome(platform = process.platform) {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return xdg.trim();
  if (platform === 'win32' && process.env.APPDATA) return process.env.APPDATA;
  return path.join(os.homedir(), '.config');
}

function dataHome(platform = process.platform) {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return xdg.trim();
  if (platform === 'win32') {
    return process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), '.local', 'share');
  }
  return path.join(os.homedir(), '.local', 'share');
}

function globalConfigDir(platform = process.platform) {
  return path.join(configHome(platform), 'opencode');
}

function authFilePath(platform = process.platform) {
  return path.join(dataHome(platform), 'opencode', 'auth.json');
}

// opencode accepts either extension; we write .jsonc but must read both.
const CONFIG_NAMES = ['opencode.jsonc', 'opencode.json'];

// The model opencode would actually pick, as its top-level `"model":
// "provider/model-id"` field. Project config wins over global, matching
// opencode's own merge order.
function resolveOpenCodeModel(worktreePath) {
  const candidates = [];
  if (worktreePath && typeof worktreePath === 'string') {
    for (const name of CONFIG_NAMES) candidates.push(path.join(worktreePath, name));
  }
  for (const name of CONFIG_NAMES) candidates.push(path.join(globalConfigDir(), name));

  for (const file of candidates) {
    const parsed = readJsonConfig(file, true);
    if (parsed && typeof parsed.model === 'string' && parsed.model.trim()) return parsed.model.trim();
  }
  return '';
}

// True only inside the running app. `require('electron')` outside it resolves
// to a path string, so `app` is undefined rather than throwing.
function inElectronApp() {
  try {
    const { app } = require('electron');
    return !!(app && typeof app.getPath === 'function');
  } catch {
    return false;
  }
}

function updateJsonFileWithOllamaProvider(filePath, rawModelName) {
  try {
    const parsed = readJsonConfig(filePath, true);
    // Rewriting a config we couldn't read would destroy a hand-written file
    // over a typo, so a parse failure skips the update entirely.
    if (parsed === null) return;
    if (!parsed.$schema) parsed.$schema = 'https://opencode.ai/config.json';

    if (!parsed.provider) parsed.provider = {};
    if (!parsed.provider.ollama) {
      parsed.provider.ollama = {
        npm: '@ai-sdk/openai',
        name: 'ollama',
        options: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' },
        models: {},
      };
    }

    if (!parsed.provider.ollama.options) {
      parsed.provider.ollama.options = { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' };
    } else {
      if (!parsed.provider.ollama.options.baseURL) parsed.provider.ollama.options.baseURL = 'http://127.0.0.1:11434/v1';
      if (!parsed.provider.ollama.options.apiKey) parsed.provider.ollama.options.apiKey = 'ollama';
    }

    if (!parsed.provider.ollama.models) parsed.provider.ollama.models = {};
    parsed.provider.ollama.models[rawModelName] = { name: rawModelName };

    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[opencode-config] could not write ' + filePath + ':', err && err.message);
  }
}

function ensureOpenCodeOllamaConfig(modelSlug, worktreePath) {
  if (!modelSlug || typeof modelSlug !== 'string' || !modelSlug.startsWith('ollama/')) return;
  const rawModelName = modelSlug.replace(/^ollama\//, '');
  if (!rawModelName) return;

  // Fire-and-forget so a slow /api/create never blocks a spawn. Gated on a live
  // Electron app so `npm test` can't rewrite a developer's real Ollama models.
  if (inElectronApp()) {
    try {
      require('./ollama').ensureContextLength({ model: rawModelName })
        .then((r) => { if (r && r.error) console.warn('[opencode-config] context floor:', r.error); })
        .catch((e) => console.warn('[opencode-config] context floor failed:', e && e.message));
    } catch (e) { console.warn('[opencode-config] context floor unavailable:', e && e.message); }
  }

  const configDir = globalConfigDir();
  const globalConfigFile = path.join(configDir, 'opencode.jsonc');

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    updateJsonFileWithOllamaProvider(globalConfigFile, rawModelName);
  } catch (err) {
    console.warn('[opencode-config] error checking global config:', err && err.message);
  }

  // Also patch project-level opencode.json if present in worktreePath
  if (worktreePath && typeof worktreePath === 'string') {
    const projectConfigFile = path.join(worktreePath, 'opencode.json');
    if (fs.existsSync(projectConfigFile)) {
      updateJsonFileWithOllamaProvider(projectConfigFile, rawModelName);
    }
  }

  // Ensure opencode's auth store has the ollama provider credential entry
  try {
    const authFile = authFilePath();
    const authDir = path.dirname(authFile);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    // Strict JSON, not JSONC: stripping comments here could mangle a key that
    // happens to contain `//`. An unreadable file is left alone — it holds the
    // other providers' credentials.
    const authParsed = readJsonConfig(authFile, false);
    if (authParsed === null) return;
    if (!authParsed.ollama) {
      authParsed.ollama = { type: 'api', key: 'ollama' };
      fs.writeFileSync(authFile, JSON.stringify(authParsed, null, 2) + '\n', 'utf-8');
    }
  } catch (err) {
    console.warn('[opencode-config] could not write opencode auth.json:', err && err.message);
  }
}

// Reads the model opencode itself would use, so it covers someone who never
// opens Klaussy's picker. Resolves rather than throws: runs on every launch.
async function ensureStartupContextFloor({ worktreePath } = {}) {
  let cfg = {};
  try { cfg = require('../util/config').loadConfig() || {}; } catch { /* first run */ }

  const configured = cfg.opencodePath && String(cfg.opencodePath).trim();
  const bin = configured || 'opencode';
  // A configured path is used as given; a bare command must resolve on PATH
  // (whichBinSync handles where.exe vs which).
  const installed = /[\\/]/.test(bin)
    ? fs.existsSync(bin)
    : !!require('../util/platform').whichBinSync(bin);
  if (!installed) return { skipped: 'opencode-not-installed' };

  const slug = (cfg.agentModel && cfg.agentModel.opencode)
    || cfg.opencodeModel
    || resolveOpenCodeModel(worktreePath);
  if (!slug || !slug.startsWith('ollama/')) return { skipped: 'not-an-ollama-model' };

  const model = slug.replace(/^ollama\//, '');
  if (!model) return { skipped: 'not-an-ollama-model' };

  // Reaching Ollama is itself the "is it running" check; a dead server just
  // returns an error we swallow at the call site.
  return require('./ollama').ensureContextLength({ model });
}

module.exports = {
  ensureOpenCodeOllamaConfig,
  ensureStartupContextFloor,
  resolveOpenCodeModel,
  globalConfigDir,
  authFilePath,
};
