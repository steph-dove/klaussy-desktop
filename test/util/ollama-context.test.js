const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseNumCtx,
  architectureContextLimit,
  AGENT_MIN_NUM_CTX,
  recommendedAgentContext,
  resolveAgentContext,
  MIN_VIABLE_AGENT_CTX,
} = require('../../main/state/ollama');

const GB = 1024 * 1024 * 1024;

// The shape /api/show actually returns: one "key<spaces>value" per line.
const SHOWN_PARAMS = [
  'temperature                    0.7',
  'top_k                          20',
  'stop                           "<|im_start|>"',
].join('\n');

test('parseNumCtx reads num_ctx out of the /api/show parameters block', () => {
  assert.equal(parseNumCtx(SHOWN_PARAMS + '\nnum_ctx                        65536'), 65536);
});

test('parseNumCtx returns 0 when the model ships no num_ctx', () => {
  assert.equal(parseNumCtx(SHOWN_PARAMS), 0, 'an unset num_ctx means Ollama falls back to its 4096 default');
  assert.equal(parseNumCtx(''), 0);
  assert.equal(parseNumCtx(undefined), 0);
});

test('parseNumCtx does not match a parameter that merely ends in num_ctx', () => {
  assert.equal(parseNumCtx('other_num_ctx                  1024'), 0);
});

test('architectureContextLimit finds the per-architecture context ceiling', () => {
  assert.equal(architectureContextLimit({
    'general.architecture': 'qwen3moe',
    'qwen3moe.context_length': 262144,
    'qwen3moe.embedding_length': 2048,
  }), 262144);
});

test('architectureContextLimit returns 0 when the ceiling is absent or malformed', () => {
  assert.equal(architectureContextLimit({ 'general.architecture': 'qwen3moe' }), 0);
  assert.equal(architectureContextLimit({ 'qwen3moe.context_length': 'lots' }), 0);
  assert.equal(architectureContextLimit(null), 0);
  assert.equal(architectureContextLimit('nope'), 0);
});

test('the baked floor is clamped to what the architecture can serve', () => {
  // Mirrors ensureContextLength's target calculation.
  const target = (minCtx, limit) => (limit ? Math.min(minCtx, limit) : minCtx);

  assert.equal(target(AGENT_MIN_NUM_CTX, 262144), AGENT_MIN_NUM_CTX, 'a roomy model keeps the floor');
  assert.equal(target(AGENT_MIN_NUM_CTX, 8192), 8192, 'a small model is never asked for more than it has');
  assert.equal(target(AGENT_MIN_NUM_CTX, 0), AGENT_MIN_NUM_CTX, 'an unknown ceiling falls back to the floor');
});

test('the agent floor clears Ollama default, which is what breaks opencode', () => {
  assert.ok(AGENT_MIN_NUM_CTX > 4096, 'the whole point is to escape the 4096 default');
});

test('recommendedAgentContext scales the window to installed RAM', () => {
  assert.equal(recommendedAgentContext(128 * GB), 131072);
  assert.equal(recommendedAgentContext(64 * GB), 131072);
  assert.equal(recommendedAgentContext(32 * GB), 65536);
  assert.equal(recommendedAgentContext(16 * GB), 32768);
  assert.equal(recommendedAgentContext(8 * GB), MIN_VIABLE_AGENT_CTX);
});

test('a machine reporting slightly under its advertised RAM still gets its tier', () => {
  // 16GB hardware commonly reports ~15.7GiB once firmware reserves its slice.
  assert.equal(recommendedAgentContext(15.7 * GB), 32768);
  assert.equal(recommendedAgentContext(63.6 * GB), 131072);
});

test('every RAM tier clears the ~12k floor opencode needs for its tools', () => {
  for (const bytes of [8, 16, 32, 64, 128]) {
    assert.ok(recommendedAgentContext(bytes * GB) > 12288,
      bytes + 'GB tier must still fit the system prompt and tool schemas');
  }
});

// Mirrors ensureContextLength's decision: a pinned preference matches exactly so
// lowering it reclaims memory, while auto only ever raises.
const satisfied = (pinned, current, target) => (pinned ? current === target : current >= target);

test('a pinned preference re-bakes when lowering the window, not just raising it', () => {
  assert.equal(satisfied(true, 131072, 32768), false, 'lowering 128K to 32K must actually re-bake');
  assert.equal(satisfied(true, 32768, 32768), true);
  assert.equal(satisfied(true, 16384, 32768), false);
});

test('auto never shrinks a window the user already has', () => {
  assert.equal(satisfied(false, 131072, 65536), true, 'a roomier window is left alone on auto');
  assert.equal(satisfied(false, 4096, 65536), false, 'but the broken default is still raised');
});

test('resolveAgentContext pins an explicit preference', () => {
  assert.equal(resolveAgentContext({ agentContextLength: 131072 }), 131072);
  assert.equal(resolveAgentContext({ agentContextLength: '65536' }), 65536, 'a stringified pref still counts');
});

test('resolveAgentContext treats 0, absent, and junk as auto', () => {
  const auto = recommendedAgentContext();
  assert.equal(resolveAgentContext({ agentContextLength: 0 }), auto);
  assert.equal(resolveAgentContext({}), auto);
  assert.equal(resolveAgentContext(null), auto);
  assert.equal(resolveAgentContext({ agentContextLength: 'auto' }), auto);
  assert.equal(resolveAgentContext({ agentContextLength: -1 }), auto, 'a negative window is never honoured');
});
