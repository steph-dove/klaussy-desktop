const { fakeSafeStorage } = require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const azure = require('../../main/util/azure-api');
const { loadConfig, saveConfig, flushSaveConfig, getConfigPath } = require('../../main/util/config');

const PAT = 'pat-secret-value-0001';

function connectionData(id = '11111111-2222-3333-4444-555555555555', email = 'dev@contoso.com') {
  return {
    authenticatedUser: {
      id,
      providerDisplayName: 'Dev Person',
      properties: { Account: { $type: 'System.String', $value: email } },
    },
  };
}

async function withFetch(handler, fn) {
  const initial = loadConfig();
  const realFetch = global.fetch;
  const calls = [];
  const prevEnv = process.env.AZURE_DEVOPS_EXT_PAT;
  delete process.env.AZURE_DEVOPS_EXT_PAT;
  try {
    saveConfig({ ...initial, azureAccounts: [] });
    await flushSaveConfig();
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      const { status = 200, body = '', type = 'application/json' } = handler(String(url), opts) || {};
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return new Response(text, { status, headers: { 'content-type': type } });
    };
    await fn(calls);
  } finally {
    global.fetch = realFetch;
    if (prevEnv !== undefined) process.env.AZURE_DEVOPS_EXT_PAT = prevEnv;
    fakeSafeStorage.available = true;
    saveConfig(initial);
    await flushSaveConfig();
  }
}

test('saveAzureAccount validates the PAT, stores it encrypted and never lists it', async () => {
  await withFetch(() => ({ body: connectionData() }), async (calls) => {
    const saved = await azure.saveAzureAccount({ collection: 'dev.azure.com/Contoso', pat: PAT });
    assert.equal(saved.user, 'dev@contoso.com');
    assert.equal(saved.id, 'azure:dev.azure.com:contoso:dev%40contoso.com');
    assert.equal(calls[0].url, 'https://dev.azure.com/Contoso/_apis/connectionData');
    assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from(':' + PAT).toString('base64'));

    await flushSaveConfig();
    const onDisk = fs.readFileSync(getConfigPath(), 'utf8');
    assert.ok(!onDisk.includes(PAT), 'PAT is not in config in plaintext');

    const listed = azure.listAzureAccounts();
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(PAT));
    assert.equal(listed[0].needsReentry, false);
    assert.equal('patEnc' in listed[0], false);
  });
});

test('saveAzureAccount refuses to save without secure storage', async () => {
  await withFetch(() => ({ body: connectionData() }), async (calls) => {
    fakeSafeStorage.available = false;
    await assert.rejects(azure.saveAzureAccount({ collection: 'contoso', pat: PAT }), (err) => {
      assert.equal(err.kind, 'unavailable');
      assert.match(err.message, /AZURE_DEVOPS_EXT_PAT/);
      return true;
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(loadConfig().azureAccounts, []);
  });
});

test('saveAzureAccount rejects an invalid PAT and writes nothing', async () => {
  await withFetch(() => ({ status: 401, body: '' }), async () => {
    await assert.rejects(azure.saveAzureAccount({ collection: 'contoso', pat: 'bad' }), (err) => err.status === 401);
    assert.deepEqual(loadConfig().azureAccounts, []);
  });
  await withFetch(() => ({ body: connectionData('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') }), async () => {
    await assert.rejects(azure.saveAzureAccount({ collection: 'contoso', pat: 'bad' }), (err) => err.status === 401);
  });
  await withFetch(() => ({ status: 203, body: '<html>sign in</html>', type: 'text/html' }), async () => {
    await assert.rejects(azure.saveAzureAccount({ collection: 'contoso', pat: 'bad' }), (err) => err.status === 203);
  });
});

test('azureJson sends the PAT as Basic auth with the api-version for the host', async () => {
  await withFetch((url) => ({ body: url.includes('connectionData') ? connectionData() : { value: [] } }), async (calls) => {
    await azure.saveAzureAccount({ collection: 'contoso', pat: PAT });
    const ctx = { collectionUrl: 'https://dev.azure.com/contoso', host: 'dev.azure.com', collectionPath: 'contoso' };
    await azure.azureJson(ctx, '/proj/_apis/git/repositories/r/pullrequests/1');
    const last = calls[calls.length - 1];
    assert.equal(last.url, 'https://dev.azure.com/contoso/proj/_apis/git/repositories/r/pullrequests/1?api-version=7.1');
    assert.equal(last.opts.headers.Authorization, azure.basicHeader(PAT));
  });
  assert.equal(azure.apiVersion('tfs.corp.example.com'), '6.0');
});

test('getAzureAuth falls back to AZURE_DEVOPS_EXT_PAT, and says how to connect when nothing is set', async () => {
  await withFetch(() => ({}), async () => {
    assert.throws(() => azure.getAzureAuth({ host: 'dev.azure.com', collectionPath: 'contoso' }), (err) => err.kind === 'missing');
    process.env.AZURE_DEVOPS_EXT_PAT = 'env-pat';
    try {
      assert.equal(azure.getAzureAuth({ host: 'dev.azure.com', collectionPath: 'contoso' }).pat, 'env-pat');
    } finally {
      delete process.env.AZURE_DEVOPS_EXT_PAT;
    }
  });
});

test('a PAT that no longer decrypts asks for re-entry', async () => {
  await withFetch(() => ({ body: connectionData() }), async () => {
    await azure.saveAzureAccount({ collection: 'contoso', pat: PAT });
    const config = loadConfig();
    config.azureAccounts[0].patEnc = Buffer.from('from-another-machine').toString('base64');
    saveConfig(config);
    await flushSaveConfig();
    assert.equal(azure.listAzureAccounts()[0].needsReentry, true);
    assert.throws(() => azure.getAzureAuth({ host: 'dev.azure.com', collectionPath: 'contoso' }), (err) => {
      assert.equal(err.kind, 'reenter');
      assert.match(err.message, /Re-enter the PAT/);
      return true;
    });
  });
});

test('switch and remove keep one active account per collection', async () => {
  let n = 0;
  await withFetch(() => ({ body: connectionData(`1111111${++n}-2222-3333-4444-555555555555`, `user${n}@contoso.com`) }), async () => {
    const a = await azure.saveAzureAccount({ collection: 'contoso', pat: PAT });
    const b = await azure.saveAzureAccount({ collection: 'contoso', pat: PAT });
    let list = azure.listAzureAccounts();
    assert.deepEqual(list.map((x) => x.active), [false, true]);
    assert.equal(await azure.switchAzureAccount(a.id), true);
    list = azure.listAzureAccounts();
    assert.deepEqual(list.map((x) => x.active), [true, false]);
    assert.equal(await azure.removeAzureAccount(a.id), true);
    list = azure.listAzureAccounts();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, b.id);
    assert.equal(list[0].active, true);
    assert.equal(await azure.removeAzureAccount('azure:nope:nope:nope'), false);
  });
});

test('account ids round-trip, including a Server host with a port', () => {
  const a = { host: 'tfs.corp.example.com:8443', collectionPath: 'tfs/defaultcollection', user: 'CORP\\dev' };
  const id = azure.accountId(a);
  assert.equal(id.split(':').length, 4);
  assert.deepEqual(azure.parseAzureAccountId(id), a);
  assert.equal(azure.parseAzureAccountId('gitlab:gitlab.com:me'), null);
});

test('resolveSavedCollection recovers the web host and scheme for an SSH remote to Server', async () => {
  const initial = loadConfig();
  try {
    saveConfig({ ...initial, azureAccounts: [{
      host: 'tfs.corp:8080', collectionPath: 'tfs/defaultcollection', collectionUrl: 'http://tfs.corp:8080/tfs/DefaultCollection', user: 'me', patEnc: '',
    }] });
    await flushSaveConfig();
    const fromSsh = { host: 'tfs.corp', collectionPath: 'tfs/defaultcollection', collectionUrl: 'https://tfs.corp/tfs/DefaultCollection' };
    assert.deepEqual(azure.resolveSavedCollection(fromSsh), {
      host: 'tfs.corp:8080', collectionUrl: 'http://tfs.corp:8080/tfs/DefaultCollection',
    });
    const other = { host: 'other.corp', collectionPath: 'tfs/defaultcollection', collectionUrl: 'https://other.corp/tfs/DefaultCollection' };
    assert.deepEqual(azure.resolveSavedCollection(other), { host: other.host, collectionUrl: other.collectionUrl });
  } finally {
    saveConfig(initial);
    await flushSaveConfig();
  }
});
