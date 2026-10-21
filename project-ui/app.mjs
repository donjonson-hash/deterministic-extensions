const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get('token');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

let current = null;
let selectedPath = null;
let busy = false;
let draftDirty = false;

const stateLabels = { ready: 'Готов к работе', prepared: 'Изменения подготовлены', published: 'Ветка создана', undone: 'Создание ветки отменено' };
const kindLabels = { added: 'Добавлен', modified: 'Изменён', deleted: 'Удалён', removed: 'Удалён', changed: 'Изменён' };
const checkLabels = { 'not-run': 'Не запускалась', passed: 'Успешно', failed: 'Не пройдена', error: 'Ошибка запуска', timeout: 'Превышено время' };

function message(text, tone = '') {
  $('status-message').textContent = text;
  $('status-message').dataset.tone = tone;
}

function controls() {
  const available = Boolean(token && current && !busy);
  const prepared = current?.state === 'prepared';
  const editable = current?.state === 'ready' || prepared;
  $('refresh').disabled = !token || busy;
  for (const id of ['proposal-file', 'proposal-json', 'template', 'prepare']) $(id).disabled = !available || !editable;
  $('prepare').disabled ||= Boolean(current?.proposal && !draftDirty);
  $('discard-draft').hidden = !draftDirty || !current?.proposal;
  $('discard-draft').disabled = !available;
  $('run-checks').disabled = !available || !prepared || draftDirty || !current?.checks?.length;
  $('publish').disabled = !available || !prepared || draftDirty || (current?.checks ?? []).some((check) => check.status !== 'passed');
  $('undo').disabled = !available || current?.state !== 'published';
  $('redo').disabled = !available || current?.state !== 'undone';
  $('workflow-hint').textContent = draftDirty ? 'Черновик изменён. Подготовьте его или вернитесь к уже подготовленному набору.'
    : current?.state === 'published' ? 'Ветка создана. Теперь можно отменить её создание.'
    : current?.state === 'undone' ? 'Создание ветки отменено. Теперь можно восстановить тот же результат.'
    : prepared ? `Подготовлено файлов: ${current.proposal.changes.length}. Просмотрите их ниже, затем запустите проверки.`
    : 'Загрузите JSON задачи, чтобы подготовить изменения.';
  for (const button of $('file-list').querySelectorAll('button')) button.disabled = busy;
  document.body.setAttribute('aria-busy', String(busy));
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    credentials: 'omit',
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Сервер вернул нечитаемый ответ (${response.status}).`); }
  if (!response.ok || data.error) throw new Error(data.error || `Ошибка сервера (${response.status}).`);
  return data;
}

async function act(pending, action, success) {
  if (busy) return;
  busy = true;
  controls();
  message(pending);
  try {
    await action();
    message(typeof success === 'function' ? success() : success, 'success');
  } catch (error) {
    message(`Не выполнено: ${error.message} При изменении проекта обновите состояние. Набор изменений автоматически не исправляется.`, 'error');
  } finally {
    busy = false;
    controls();
  }
}

function showFile(path) {
  selectedPath = path;
  const change = current?.proposal?.changes.find((item) => item.path === path);
  for (const button of $('file-list').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.path === path));
  $('selected-path').textContent = change?.path ?? 'Выберите файл';
  $('file-kind').textContent = change ? (kindLabels[change.kind] ?? change.kind) : '';
  $('before').textContent = change?.before ?? '';
  $('after').textContent = change?.after ?? '';
  $('before-note').textContent = change && change.before === null ? '· файла не было' : '';
  $('after-note').textContent = change && change.after === null ? '· файл удалён' : '';
}

function render(next) {
  const firstLoad = !current;
  current = next;
  if (firstLoad) $('proposal-editor').open = !current.proposal;
  if (current.proposal && !draftDirty) restoreProposalText();
  document.body.dataset.state = current.state;
  $('project-path').textContent = current.projectPath;
  $('base-commit').textContent = current.baseCommit;
  $('state').textContent = stateLabels[current.state] ?? current.state;
  const changes = current.proposal?.changes ?? [];
  $('task-title').textContent = current.proposal?.title || 'Просмотрите файлы';
  $('change-count').textContent = current.proposal ? `Файлов в наборе: ${changes.length}. Выберите файл, чтобы проверить его содержимое.` : 'Набор изменений ещё не подготовлен.';
  $('proposal-digest').textContent = current.proposal?.digest ?? '—';
  $('file-list').replaceChildren();
  if (!changes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Здесь появится список файлов.';
    $('file-list').append(empty);
  }
  for (const change of changes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.path = change.path;
    button.append(document.createTextNode(change.path));
    const kind = document.createElement('span');
    kind.textContent = kindLabels[change.kind] ?? change.kind;
    button.append(kind);
    button.addEventListener('click', () => showFile(change.path));
    $('file-list').append(button);
  }
  showFile(changes.some((change) => change.path === selectedPath) ? selectedPath : changes[0]?.path ?? null);
  $('checks').replaceChildren();
  const checks = current.checks ?? [];
  if (!checks.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Автоматические проверки не настроены при запуске сервера.';
    $('checks').append(empty);
  }
  for (const check of checks) {
    const details = document.createElement('details');
    details.className = 'check';
    const summary = document.createElement('summary');
    const name = document.createElement('strong');
    name.textContent = check.name;
    const status = document.createElement('span');
    status.className = 'check-status';
    status.dataset.status = check.status;
    status.textContent = checkLabels[check.status] ?? check.status;
    summary.append(name, status);
    const output = document.createElement('pre');
    output.textContent = check.output || 'Вывод отсутствует.';
    details.append(summary, output);
    $('checks').append(details);
  }
  $('branch-result').hidden = !current.branch;
  $('branch-name').textContent = current.branch ?? '';
  $('branch-note').textContent = current.state === 'undone' ? 'Ветка удалена. Вы можете восстановить её, если проект не изменился.' : `Коммит: ${current.commit ?? '—'}`;
  $('checkout-command').textContent = current.branch ? `git switch -- '${current.branch.replaceAll("'", "'\\''")}'` : '';
  $('checkout-command').hidden = current.state === 'undone';
  controls();
}

function restoreProposalText() {
  const proposal = current.proposal;
  $('proposal-json').value = JSON.stringify({schemaVersion:1, id:proposal.id, title:proposal.title,
    baseCommit:current.baseCommit, changes:proposal.changes.map(change => change.after === null
      ? {path:change.path,operation:'delete'} : {path:change.path,operation:'write',text:change.after})}, null, 2);
}

$('discard-draft').addEventListener('click', () => {
  if (busy || !current?.proposal) return;
  draftDirty = false;
  restoreProposalText();
  $('proposal-editor').open = false;
  controls();
  message('Черновик отброшен. Подготовленный набор сохранён; можно продолжить проверки.', 'success');
});

$('refresh').addEventListener('click', () => act('Обновляем состояние…', async () => render(await api('status')), 'Состояние проекта обновлено.'));
$('template').addEventListener('click', () => {
  if (busy || !current) return;
  $('proposal-json').value = JSON.stringify({ schemaVersion: 1, id: 'task-1', title: 'Название вашей задачи', baseCommit: current.baseCommit, changes: [] }, null, 2);
  draftDirty = true;
  controls();
  message('Шаблон вставлен. Укажите задачу и добавьте реальные изменения в changes.');
  $('proposal-json').focus();
});
$('proposal-json').addEventListener('input', () => {
  draftDirty = true;
  controls();
  if (current?.proposal) message('Текст набора изменён. Подготовьте его заново, чтобы обновить предпросмотр. Для нового набора нужен новый id.');
});
$('proposal-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  act('Читаем JSON-файл…', async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error('JSON-файл больше 2 МиБ.');
    const bytes = await file.arrayBuffer();
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    JSON.parse(source);
    $('proposal-json').value = source;
    draftDirty = true;
    event.target.value = '';
  }, 'JSON загружен. Нажмите «Подготовить и показать изменения».');
});
$('prepare').addEventListener('click', () => act('Проверяем набор и готовим временную копию…', async () => {
  let proposal;
  try { proposal = JSON.parse($('proposal-json').value); } catch { throw new Error('Набор изменений должен быть корректным JSON.'); }
  if (Array.isArray(proposal?.changes) && !proposal.changes.length) {
    throw new Error('В changes нет изменений. Добавьте файлы или нажмите «Вернуться к подготовленному набору».');
  }
  const next = await api('prepare', proposal);
  draftDirty = false;
  render(next);
  $('proposal-editor').open = false;
}, 'Набор подготовлен. Просмотрите каждый изменённый файл перед созданием ветки.'));
$('run-checks').addEventListener('click', () => act('Выполняются локальные проверки. Дождитесь результата…', async () => {
  render(await api('check', { expectedDigest: current.proposal?.digest }));
  if ((current.checks ?? []).some((check) => check.status !== 'passed')) throw new Error('Не все проверки пройдены. Подробности приведены ниже.');
}, 'Выбранные проверки успешно завершены.'));
$('publish').addEventListener('click', () => act('Создаём отдельную ветку…', async () => render(await api('publish', { expectedDigest: current.proposal?.digest })), 'Ветка с изменениями создана. Рабочие файлы исходного проекта не заменены.'));
$('undo').addEventListener('click', () => act('Отменяем создание ветки…', async () => render(await api('undo', { expectedDigest: current.proposal?.digest })), 'Создание ветки отменено.'));
$('redo').addEventListener('click', () => act('Восстанавливаем ветку…', async () => render(await api('redo', { expectedDigest: current.proposal?.digest })), 'Ветка восстановлена.'));

controls();
if (!token) {
  $('project-path').textContent = 'Нет локального доступа';
  $('state').textContent = 'Нужна ссылка запуска';
  message('Откройте полную ссылку из терминала локального сервера. Ключ доступа хранится только в памяти страницы; после перезагрузки откройте исходную ссылку снова.', 'error');
} else {
  await act('Получаем состояние локального проекта…', async () => render(await api('status')), () => current.proposal
    ? `Набор из ${current.proposal.changes.length} файлов уже подготовлен. Просмотрите файлы и запустите проверки на панели действий.`
    : 'Проект подключён. Загрузите JSON с изменениями или заполните шаблон.');
}
