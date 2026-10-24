import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startProjectServer} from '../src/project/server.mjs';

const projectPath = await mkdtemp(join(tmpdir(), 'det-project-demo-'));
await mkdir(join(projectPath, 'src'));
const files = {
  'package.json':JSON.stringify({name:'local-theme-demo', private:true, type:'module', scripts:{test:'node --test'}}) + '\n',
  'settings.json':'{"title":"My project","theme":"light"}\n',
  'src/theme.mjs':'export function label(settings) { return settings.title; }\n',
  'theme.test.mjs':"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {label} from './src/theme.mjs';\ntest('title', () => assert.equal(label({title:'Demo'}), 'Demo'));\n",
  'README.md':'# Theme demo\nA disposable project for local review.\n'
};
for (const [name, text] of Object.entries(files)) await writeFile(join(projectPath, name), text);
const git = (...args) => execFileSync('git', args, {cwd:projectPath, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
git('init', '-b', 'main'); git('add', '.');
git('-c','user.name=Demo','-c','user.email=demo@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','-m','Initial demo');
const proposal = {schemaVersion:1,id:'theme-task-1',title:'Добавить название темы в подпись проекта',baseCommit:git('rev-parse','HEAD'),changes:[
  {path:'settings.json',operation:'write',text:'{"title":"My project","theme":"dark"}\n'},
  {path:'src/theme.mjs',operation:'write',text:"export function label(settings) { return settings.theme ? `${settings.title} · ${settings.theme}` : settings.title; }\n"},
  {path:'theme-new.test.mjs',operation:'write',text:"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {label} from './src/theme.mjs';\ntest('theme label', () => assert.equal(label({title:'Demo',theme:'dark'}), 'Demo · dark'));\n"}
]};
const app = await startProjectServer({projectPath, checks:[{name:'Node tests',argv:[process.execPath,'--test']}], proposal});
console.log(`Демо-проект: ${projectPath}\nОткройте: ${app.url}\nНабор из трёх правок уже подготовлен. Запустите проверки, затем создайте ветку.\nCtrl+C остановит сервер. Демо-проект останется в указанной папке.`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
