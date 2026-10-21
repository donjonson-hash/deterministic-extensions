import {readFile} from 'node:fs/promises';
import {startProjectServer} from '../src/project/server.mjs';

const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!['--project', '--checks', '--proposal'].includes(key) || !value || options[key]) {
    console.error('Usage: node scripts/project-server.mjs --project /path/to/repo [--checks checks.json] [--proposal proposal.json]');
    process.exit(1);
  }
  options[key] = value;
}
if (!options['--project']) {
  console.error('Укажите локальный Git-проект: --project /path/to/repo');
  process.exit(1);
}
try {
  const checks = options['--checks'] ? JSON.parse(await readFile(options['--checks'], 'utf8')) : [];
  const proposal = options['--proposal'] ? JSON.parse(await readFile(options['--proposal'], 'utf8')) : undefined;
  const app = await startProjectServer({projectPath:options['--project'], checks, proposal});
  console.log(`Откройте в браузере:\n${app.url}\nДля остановки нажмите Ctrl+C.`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
} catch (error) { console.error(error.message); process.exitCode = 1; }
