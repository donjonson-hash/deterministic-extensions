// Exercise the packaged reference extension. CI must use REQUIRE_EXTENSION=1.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {chromium} from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = join(root, 'dist/extension');
await readFile(join(extension, 'manifest.json'));
const temporary = await mkdtemp(join(tmpdir(), 'deterministic-extension-'));
const output = process.env.TEST_OUTPUT || join(root, 'test-output');
await mkdir(output, {recursive:true});
const types = {'.html':'text/html', '.css':'text/css', '.mjs':'text/javascript', '.js':'text/javascript', '.svg':'image/svg+xml'};
const server = createServer(async (request, response) => {
  try {
    const path = resolve(extension, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(extension + '/')) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [], externalRequests = [], checks = [];
let context;

try {
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {channel:'chromium'}),
    headless:true, acceptDownloads:true, viewport:{width:1440,height:1000},
    args:['--no-sandbox', '--disable-gpu', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.setDefaultTimeout(20000);
  const watch = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
  };
  context.pages().forEach(watch);
  context.on('page', watch);
  context.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  let worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension:'));
  if (!worker) worker = await context.waitForEvent('serviceworker', {timeout:process.env.REQUIRE_EXTENSION ? 15000 : 2500}).catch(error => {
    if (process.env.REQUIRE_EXTENSION) throw error;
    return null;
  });
  const base = worker ? new URL('.', worker.url()).href : `${origin}/`;
  const welcomeUrl = new URL('welcome.html', base).href;
  const appUrl = new URL('app.html', base).href;
  const navigate = async callback => {
    if (!worker) await context.setOffline(false);
    try { return await callback(); }
    finally { await context.setOffline(true); }
  };
  const ready = page => page.waitForFunction(() => {
    const status = document.getElementById('worker-status');
    return status?.dataset.state === 'ready' && status.dataset.revision === document.body.dataset.revision;
  });
  const download = async page => {
    await page.bringToFront();
    const pending = page.waitForEvent('download');
    await page.locator('#download-b').click();
    const result = await pending;
    return readFile(await result.path());
  };
  let page;
  if (worker) {
    const deadline = Date.now() + 15000;
    while (!page && Date.now() < deadline) {
      page = context.pages().find(tab => tab.url() === welcomeUrl);
      if (!page) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, 'first install opens its local welcome page');
    await context.setOffline(true);
    checks.push('first-install-welcome');
  } else {
    page = await context.newPage();
    await navigate(() => page.goto(welcomeUrl));
  }
  await page.locator('#open-editor').waitFor();
  await navigate(async () => { await page.locator('#open-editor').click(); await ready(page); });
  assert.equal(page.url(), appUrl);
  checks.push('welcome-opens-workspace');

  const a = Buffer.concat([Buffer.from([239,187,191]), Buffer.from('item\r\nprice 25\r\nПривет 🥭\r\n')]);
  const b = Buffer.from('item\nprice 30\r\nПривет 🥭');
  await page.locator('#file-a').setInputFiles({name:'reference.txt', mimeType:'text/plain', buffer:a});
  await page.waitForFunction(() => document.getElementById('text-a').value.includes('price 25'));
  await page.locator('#file-b').setInputFiles({name:'revision.txt', mimeType:'text/plain', buffer:b});
  await page.waitForFunction(() => document.getElementById('text-b').value.includes('price 30'));
  await ready(page);
  assert.deepEqual(await download(page), b, 'untouched B download preserves mixed endings and final-newline absence');
  assert.ok(await page.locator('#change-list .change-row').count() > 0);
  checks.push('import-and-original-byte-export');

  const displayedUseA = await page.locator('#use-a').elementHandle();
  await displayedUseA.click();
  await ready(page);
  assert.deepEqual(await download(page), a, 'Use A copies the exact document including BOM and CRLF');
  await displayedUseA.evaluate(button => button.click());
  assert.match(await page.locator('#status').textContent(), /already applied/i);
  assert.deepEqual(await download(page), a, 'replayed displayed action cannot create a second edit');
  await page.locator('#undo').click();
  await ready(page);
  assert.deepEqual(await download(page), b, 'one Undo restores original B bytes');
  await displayedUseA.evaluate(button => button.click());
  assert.match(await page.locator('#status').textContent(), /already applied/i);
  assert.deepEqual(await download(page), b, 'old action remains consumed after Undo');
  await page.locator('#redo').click();
  await ready(page);
  assert.deepEqual(await download(page), a, 'Redo restores copied B bytes');
  checks.push('use-a-replay-undo-redo-byte-export');

  const popup = context.waitForEvent('page');
  let help;
  await navigate(async () => {
    await page.locator('#getting-started').click();
    help = await popup; await help.waitForURL(welcomeUrl); await help.locator('#open-editor').waitFor();
  });
  assert.equal(page.url(), appUrl);
  assert.deepEqual(await download(page), a);
  await page.locator('#undo').click(); await ready(page);
  assert.deepEqual(await download(page), b, 'separate help tab preserves edit history');
  checks.push('help-preserves-editor-and-history');

  await page.setViewportSize({width:375,height:812});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'workspace fits a narrow viewport');
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:join(output, 'workspace.png'), fullPage:true});
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  assert.deepEqual(externalRequests, [], 'no external HTTP requests');
  console.log(JSON.stringify({passed:true, mode:worker ? 'extension':'local-page', browser:context.browser()?.version(), offline:true, checks}, null, 2));
} catch (error) {
  console.error({errors, externalRequests});
  if (context) for (const [index, page] of context.pages().entries()) if (!page.isClosed()) {
    await page.screenshot({path:join(output, `failure-${index}.png`), fullPage:true}).catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive:true, force:true});
}
