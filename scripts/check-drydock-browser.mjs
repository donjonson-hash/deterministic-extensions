// The local project pilot is a Node-backed browser app, not an MV3 filesystem bridge.
import {chromium} from 'playwright';
import {startProjectServer} from '../src/project/server.mjs';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'project-drydock-browser-'));
let app,browser;
try {
 const project=join(root,'project'),repository=join(root,'scanner'),python=join(root,'fixture-scanner');
 await mkdir(project);await mkdir(repository);
 const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:project,encoding:'utf8'}).trim();
 git('init','-b','main');await writeFile(join(project,'app.js'),'export const x=1;\n');await writeFile(join(project,'package.json'),'{"name":"fixture","version":"1.0.0"}\n');
 git('add','.');git('commit','-m','base');
 const report={engine_version:'browser-fixture',runtime_verified:false,catalog:{sha256:'a'.repeat(64)},snapshot:{sha256:'b'.repeat(64),files:2,bytes:60,excluded:{}},checks_run:['source'],checks_not_run:[],findings:[{applicability:'unknown',title:'Needs review'}],limitations:['fixture_only'],dependency_cve:{status:'partial'}};
 await writeFile(python,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(report))});`,{mode:0o755});
 app=await startProjectServer({projectPath:project,drydock:{python,repository},proposal:{schemaVersion:1,id:'browser-1',title:'Review candidate',baseCommit:git('rev-parse','HEAD'),changes:[{path:'app.js',operation:'write',text:'export const x=2;\n'}]}});
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1360,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(app.url);await page.waitForSelector('body[data-state="prepared"][aria-busy="false"]');
 assert.equal(await page.isDisabled('#publish'),true);
 await page.click('#run-drydock');await page.waitForFunction(()=>document.querySelector('#drydock-status').textContent.includes('Запуск завершён'));
 assert.match(await page.textContent('#drydock-report'),/unknown/);assert.equal(await page.isDisabled('#publish'),true);
 await page.check('#drydock-reviewed');assert.equal(await page.isDisabled('#publish'),false);
 // Rerunning produces a new review boundary even if a deterministic fixture has the same digest.
 await page.click('#run-drydock');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 assert.equal(await page.isChecked('#drydock-reviewed'),false);assert.equal(await page.isDisabled('#publish'),true);
 await page.check('#drydock-reviewed');await page.click('#publish');await page.waitForSelector('body[data-state="published"]');
 assert.equal(await readFile(join(project,'app.js'),'utf8'),'export const x=1;\n');
 await page.click('#undo');await page.waitForSelector('body[data-state="undone"]');await page.click('#redo');await page.waitForSelector('body[data-state="published"]');
 assert.deepEqual(errors,[]);
 if(process.env.DRYDOCK_SCREENSHOT)await page.screenshot({path:process.env.DRYDOCK_SCREENSHOT,fullPage:true});
 console.log('PASS: project Drydock UI requires current evidence review, preserves unknown and source, supports Undo/Redo');
} finally {if(browser)await browser.close();if(app)await app.close();await rm(root,{recursive:true,force:true});}
