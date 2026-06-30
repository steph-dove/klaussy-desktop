require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMcpList } = require('../../main/ipc/mcp');

// Real `claude mcp list` output (captured from a live run), covering each state.
const SAMPLE = [
  'Checking MCP server health…',
  '',
  'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected',
  'unity-mcp: /Users/me/.unity/relay/relay --mcp - ! Connected · tools fetch failed',
  'notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication',
  'broken: npx -y broken-server - ✗ Failed to connect',
].join('\n');

test('parseMcpList maps each health state', () => {
  const byName = parseMcpList(SAMPLE);
  assert.equal(byName['claude.ai Google Drive'].status, 'connected');
  assert.equal(byName['unity-mcp'].status, 'partial', 'connected-but-tools-failed → partial');
  assert.equal(byName.notion.status, 'auth');
  assert.equal(byName.broken.status, 'failed');
  // Keeps the raw text for the tooltip.
  assert.match(byName.notion.text, /Needs authentication/);
});

test('parseMcpList ignores the header and blank lines', () => {
  const byName = parseMcpList(SAMPLE);
  assert.ok(!('Checking MCP server health…' in byName));
  assert.equal(Object.keys(byName).length, 4);
});

test('parseMcpList tolerates empty / garbage input', () => {
  assert.deepEqual(parseMcpList(''), {});
  assert.deepEqual(parseMcpList(null), {});
  assert.deepEqual(parseMcpList('no recognizable lines here'), {});
});
