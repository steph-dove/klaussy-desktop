const test = require('node:test');
const assert = require('node:assert/strict');

const { parseForgeUrl, detectForgeFromRemote } = require('../../main/util/forge-url');

const SERVICES_REPO = {
  forge: 'azure',
  host: 'dev.azure.com',
  collectionUrl: 'https://dev.azure.com/Contoso',
  collectionPath: 'contoso',
  project: 'Web App',
  repoName: 'Front-End',
  projectPath: 'contoso/web app/front-end',
  owner: 'contoso/web app',
  repo: 'front-end',
};

test('parseForgeUrl parses a dev.azure.com PR URL and decodes segments', () => {
  const parsed = parseForgeUrl('https://dev.azure.com/Contoso/Web%20App/_git/Front-End/pullrequest/42?_a=files');
  assert.deepEqual(parsed, { ...SERVICES_REPO, number: 42, type: 'pr' });
});

test('every Services spelling of one repo gives the same projectPath', () => {
  const forms = [
    parseForgeUrl('https://dev.azure.com/contoso/Web%20App/_git/front-end/pullrequest/1'),
    parseForgeUrl('https://contoso.visualstudio.com/Web%20App/_git/Front-End/pullrequest/1'),
    parseForgeUrl('https://contoso.visualstudio.com/DefaultCollection/Web%20App/_git/Front-End/pullrequest/1'),
    detectForgeFromRemote('https://contoso@dev.azure.com/contoso/Web%20App/_git/Front-End'),
    detectForgeFromRemote('https://contoso.visualstudio.com/DefaultCollection/Web%20App/_git/Front-End'),
    detectForgeFromRemote('git@ssh.dev.azure.com:v3/contoso/Web%20App/Front-End'),
    detectForgeFromRemote('contoso@vs-ssh.visualstudio.com:v3/Contoso/Web%20App/Front-End'),
  ];
  for (const f of forms) {
    assert.ok(f, 'parsed');
    assert.equal(f.forge, 'azure');
    assert.equal(f.host, 'dev.azure.com');
    assert.equal(f.collectionPath, 'contoso');
    assert.equal(f.projectPath, 'contoso/web app/front-end');
    assert.equal(f.owner, 'contoso/web app');
    assert.equal(f.repo, 'front-end');
    assert.match(f.collectionUrl, /^https:\/\/dev\.azure\.com\/contoso$/i);
  }
});

test('a repo named after its project can drop the project segment', () => {
  const a = parseForgeUrl('https://dev.azure.com/contoso/_git/tools/pullrequest/7');
  assert.equal(a.project, 'tools');
  assert.equal(a.projectPath, 'contoso/tools/tools');
  const b = parseForgeUrl('https://contoso.visualstudio.com/_git/tools/pullrequest/7');
  assert.equal(b.projectPath, 'contoso/tools/tools');
});

test('parseForgeUrl parses an Azure DevOps Server PR URL with a collection path', () => {
  const parsed = parseForgeUrl('https://tfs.corp.example.com:8443/tfs/DefaultCollection/Platform/_git/Core.Api/pullrequest/315');
  assert.deepEqual(parsed, {
    forge: 'azure',
    host: 'tfs.corp.example.com:8443',
    collectionUrl: 'https://tfs.corp.example.com:8443/tfs/DefaultCollection',
    collectionPath: 'tfs/defaultcollection',
    project: 'Platform',
    repoName: 'Core.Api',
    projectPath: 'tfs/defaultcollection/platform/core.api',
    owner: 'tfs/defaultcollection/platform',
    repo: 'core.api',
    number: 315,
    type: 'pr',
  });
});

test('Server remotes over HTTPS and SSH match the PR URL', () => {
  const pr = parseForgeUrl('https://ado.corp.example.com/Coll/Platform/_git/core/pullrequest/2');
  const http = detectForgeFromRemote('https://ado.corp.example.com/Coll/Platform/_git/core');
  const ssh = detectForgeFromRemote('ssh://ado.corp.example.com:22/Coll/Platform/_git/core');
  assert.equal(http.projectPath, pr.projectPath);
  assert.equal(ssh.projectPath, pr.projectPath);
  assert.equal(ssh.collectionUrl, 'https://ado.corp.example.com/Coll');
});

test('remotes on Services never keep a .git suffix', () => {
  const r = detectForgeFromRemote('git@ssh.dev.azure.com:v3/contoso/proj/repo.git');
  assert.equal(r.repo, 'repo');
});

test('non-Azure URLs still parse as before', () => {
  assert.equal(parseForgeUrl('https://github.com/o/r/pull/1').forge, 'github');
  assert.equal(parseForgeUrl('https://gitlab.com/g/p/-/merge_requests/1').forge, 'gitlab');
  assert.equal(parseForgeUrl('https://bitbucket.org/w/r/pull-requests/1').forge, 'bitbucket');
  assert.equal(detectForgeFromRemote('git@github.com:o/r.git').forge, 'github');
  assert.equal(detectForgeFromRemote('https://gitlab.com/g/sub/p.git').forge, 'gitlab');
});

test('a dev.azure.com URL without an org is not treated as Azure', () => {
  assert.equal(parseForgeUrl('https://dev.azure.com/_git/repo/pullrequest/1'), null);
});
