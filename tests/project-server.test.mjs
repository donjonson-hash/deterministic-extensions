import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startProjectServer} from '../src/project/server.mjs';

test('local API rejects unauthorized/cross-origin requests and stale tab publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-api-test-'));
  const git = (...args) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args], {cwd:root,encoding:'utf8'}).trim();
  let server;
  try {
    git('init','-b','main');
    await writeFile(join(root,'file.txt'),'original\n');
    git('add','.'); git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base');
    server = await startProjectServer({projectPath:root});
    const url = new URL(server.url);
    const headers = {Authorization:`Bearer ${new URLSearchParams(url.hash.slice(1)).get('token')}`, 'Content-Type':'application/json'};
    const post = (action, body) => fetch(`${url.origin}/api/${action}`, {method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await fetch(`${url.origin}/api/status`)).status,401);
    assert.equal((await fetch(`${url.origin}/api/status`,{headers:{...headers,Origin:'https://example.com'}})).status,403);
    const page = await fetch(url.origin);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const status = await (await fetch(`${url.origin}/api/status`,{headers})).json();
    const proposal = id => ({schemaVersion:1,id,title:id,baseCommit:status.baseCommit,changes:[{path:'file.txt',operation:'write',text:`${id}\n`}]});
    const a = await (await post('prepare',proposal('a'))).json();
    assert.ok(a.proposal.digest);
    const b = await (await post('prepare',proposal('b'))).json();
    assert.equal((await post('publish',{})).status,400);
    const stale = await post('publish',{expectedDigest:a.proposal.digest});
    assert.equal(stale.status,409);
    assert.match((await stale.json()).error,/другой вкладке/);
    const published = await (await post('publish',{expectedDigest:b.proposal.digest})).json();
    assert.equal(published.state,'published');
    assert.equal(git('show',`${published.branch}:file.txt`),'b');
    assert.equal(git('branch','--show-current'),'main');
  } finally {
    if (server) await server.close();
    await rm(root,{recursive:true,force:true});
  }
});
