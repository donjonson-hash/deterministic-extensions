import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createProjectSession} from './engine.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const MAX_BODY = 2 * 1024 * 1024;

export async function startProjectServer({projectPath, checks = [], proposal, port = 0}) {
  const session = await createProjectSession({projectPath, checks});
  if (proposal) {
    try { await session.prepare(proposal); }
    catch (error) { await session.close(); throw error; }
  }
  const token = randomBytes(32).toString('hex');
  const auth = Buffer.from(`Bearer ${token}`);
  let origin;
  let queue = Promise.resolve();
  const serial = (task) => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const json = (status, value) => {
      response.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(origin).host
          || (request.headers.origin && request.headers.origin !== origin)) {
        return json(403, {error:'Недопустимый адрес или источник запроса.'});
      }
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const supplied = Buffer.from(request.headers.authorization || '');
        if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) {
          return json(401, {error:'Откройте ссылку с ключом сессии из терминала.'});
        }
        if (request.method === 'GET' && url.pathname === '/api/status') return json(200, await session.status());
        const actions = {'/api/prepare':'prepare', '/api/check':'runChecks', '/api/publish':'publish', '/api/undo':'undo', '/api/redo':'redo'};
        const action = actions[url.pathname];
        if (request.method !== 'POST' || !action) return json(404, {error:'Неизвестная операция.'});
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, {error:'Ожидается application/json.'});
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY) { request.resume(); return json(413, {error:'Набор изменений превышает 2 MiB.'}); }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks))); }
        catch { return json(400, {error:'Некорректный JSON или UTF-8.'}); }
        if (action !== 'prepare' && (!body || Array.isArray(body) || typeof body.expectedDigest !== 'string' || Object.keys(body).some(key => key !== 'expectedDigest'))) {
          return json(400, {error:'Укажите expectedDigest просмотренного набора.'});
        }
        const result = await serial(async () => {
          if (action !== 'prepare' && (await session.status()).proposal?.digest !== body.expectedDigest) {
            throw new Error('Набор изменился в другой вкладке. Обновите состояние и просмотрите его заново.');
          }
          return session[action](...(action === 'prepare' ? [body] : []));
        });
        return json(200, result);
      }
      const asset = assets.get(url.pathname);
      if (request.method !== 'GET' || !asset) return json(404, {error:'Страница не найдена.'});
      response.writeHead(200, {'Content-Type':asset[1]});
      response.end(await readFile(new URL(`../../project-ui/${asset[0]}`, import.meta.url)));
    } catch (error) {
      if (!response.headersSent) json(409, {error:error.message});
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { await session.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url:`${origin}/#token=${token}`,
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections();
      await closed;
      await session.close();
    }
  };
}
