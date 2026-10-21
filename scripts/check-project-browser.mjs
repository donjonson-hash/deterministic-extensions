import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readFile, rm, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packed = await mkdtemp(join(tmpdir(),'project-packaged-browser-'));
const {version} = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
execFileSync('python3',['-m','zipfile','-e',join(root,`dist/project-pilot-${version}.zip`),packed]);
const demo = spawn(process.execPath, ['scripts/project-demo.mjs'], {cwd:packed,stdio:['ignore','pipe','pipe']});
let browser, projectPath;
try {
  const url = await new Promise((resolve,reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Demo startup timed out')),30_000);
    demo.once('exit', code => {clearTimeout(timer);reject(new Error(`Demo exited ${code}: ${output}`));});
    demo.stderr.on('data', data => {output += data;});
    demo.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/);
      if (match) {clearTimeout(timer);projectPath=output.match(/Демо-проект: (.+)/)[1];resolve(match[0]);}
    });
  });
  browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE || undefined, args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1360,height:1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector('body[data-state="prepared"][aria-busy="false"]');
  assert.equal(new URL(page.url()).hash,'');
  const launch = new URL(url);
  const status = await (await fetch(`${launch.origin}/api/status`, {headers:{Authorization:`Bearer ${new URLSearchParams(launch.hash.slice(1)).get('token')}`}})).json();
  const input = {schemaVersion:1, id:'browser-review-2', title:status.proposal.title, baseCommit:status.baseCommit,
    changes:status.proposal.changes.map(item => ({path:item.path,operation:'write',text:item.after}))};
  await page.locator('#proposal-file').setInputFiles({name:'proposal.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(input))});
  await page.waitForFunction(() => document.getElementById('proposal-json').value.includes('browser-review-2'));
  assert.equal(await page.locator('#run-checks').isDisabled(),true);
  await page.locator('#prepare').click();
  await page.waitForFunction(() => !document.getElementById('run-checks').disabled);
  assert.equal(await page.locator('#file-list button').count(),3);
  await page.locator('#file-list button').filter({hasText:'src/theme.mjs'}).click();
  assert.match(await page.locator('#after').textContent(),/settings.theme/);
  assert.equal(await page.locator('#publish').isDisabled(),true);
  await page.locator('#run-checks').click();
  await page.waitForFunction(() => !document.getElementById('publish').disabled);
  await page.locator('#publish').click();
  await page.waitForSelector('body[data-state="published"][aria-busy="false"]');
  const branch = await page.locator('#branch-name').textContent();
  const git = (...args) => execFileSync('git',args,{cwd:projectPath,encoding:'utf8'}).trim();
  const commit = git('rev-parse',branch);
  assert.equal(git('branch','--show-current'),'main');
  assert.match(await readFile(`${projectPath}/settings.json`,'utf8'),/light/);
  assert.match(git('show',`${branch}:settings.json`),/dark/);
  await page.locator('#undo').click();
  await page.waitForSelector('body[data-state="undone"][aria-busy="false"]');
  assert.equal(git('branch','--list',branch),'');
  await page.locator('#redo').click();
  await page.waitForSelector('body[data-state="published"][aria-busy="false"]');
  assert.equal(git('rev-parse',branch),commit);
  assert.equal(git('status','--porcelain'),'');
  assert.deepEqual(errors,[]);
  if (process.env.PROJECT_SCREENSHOT) await page.screenshot({path:process.env.PROJECT_SCREENSHOT,fullPage:true});
  console.log('PASS: project browser — three-file preview, checks, branch publication, Undo/Redo, original files intact');
} finally {
  if (browser) await browser.close();
  if (demo.exitCode === null) {const ended=once(demo,'exit');demo.kill('SIGTERM');await ended;}
  if (projectPath) await rm(projectPath,{recursive:true,force:true});
  await rm(packed,{recursive:true,force:true});
}
