require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const ollama = require('../../main/state/ollama');
const { loadConfig, saveConfig } = require('../../main/util/config');

// Stand in for the local server: /api/tags is what is installed, /api/ps what
// is currently resident.
function withServer({ installed = [], loaded = [] }, run) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const names = String(url).endsWith('/api/ps') ? loaded : installed;
    return { ok: true, json: async () => ({ models: names.map((name) => ({ name })) }) };
  };
  return Promise.resolve().then(run).finally(() => { global.fetch = realFetch; });
}

async function withConfig(patch, run) {
  const cfg = loadConfig();
  await saveConfig({ ...cfg, ...patch });
  try {
    return await run();
  } finally {
    // saveConfig merges, so a key cannot be unset by omission — blank it out.
    const cleared = {};
    for (const key of Object.keys(patch)) cleared[key] = cfg[key] === undefined ? '' : cfg[key];
    await saveConfig({ ...cfg, ...cleared });
  }
}

test('an explicit pin wins over everything', async () => {
  await withConfig({ ollamaSummaryModel: 'pinned:latest' }, () =>
    withServer({ installed: ['other:7b'], loaded: ['other:7b'] }, async () => {
      assert.equal(await ollama.pickChatModel(), 'pinned:latest');
    }));
});

// The model the agent is running is the one to summarize with — it is already
// warm, and it is what the user chose.
test('the model the agent is using is preferred', async () => {
  await withServer({ installed: ['qwen3-coder:30b', 'llama3.2:latest'], loaded: ['llama3.2:latest'] }, async () => {
    assert.equal(await ollama.pickChatModel({ prefer: 'qwen3-coder:30b' }), 'qwen3-coder:30b');
  });
});

test('a provider-prefixed model name still resolves', async () => {
  await withServer({ installed: ['qwen3-coder:30b'], loaded: [] }, async () => {
    assert.equal(await ollama.pickChatModel({ prefer: 'ollama/qwen3-coder:30b' }), 'qwen3-coder:30b');
  });
});

// A cold model costs a full load, so a resident one is both "in use" and much
// cheaper to ask.
test('a resident model is used when the agent has none configured', async () => {
  await withServer({ installed: ['qwen3-coder:30b', 'llama3.2:latest'], loaded: ['llama3.2:latest'] }, async () => {
    assert.equal(await ollama.pickChatModel(), 'llama3.2:latest');
  });
});

// The likeliest resident model is the FIM autocomplete one, which continues
// text instead of obeying it — using it would produce exactly the rambling
// notes this feature exists to avoid.
test('the loaded autocomplete model is never chosen to summarize', async () => {
  await withServer({
    installed: ['qwen2.5-coder:1.5b-base', 'qwen3-coder:30b'],
    loaded: ['qwen2.5-coder:1.5b-base'],
  }, async () => {
    assert.equal(await ollama.pickChatModel(), 'qwen3-coder:30b');
  });
});

test('a preferred model that is not installed is ignored', async () => {
  await withServer({ installed: ['qwen3-coder:30b'], loaded: [] }, async () => {
    assert.equal(await ollama.pickChatModel({ prefer: 'not-pulled:70b' }), 'qwen3-coder:30b');
  });
});

// No summary beats a hallucinated one.
test('only base models installed means no local summary', async () => {
  await withServer({ installed: ['qwen2.5-coder:1.5b-base'], loaded: [] }, async () => {
    assert.equal(await ollama.pickChatModel(), null);
    assert.equal(await ollama.generateText('anything'), '');
  });
});
