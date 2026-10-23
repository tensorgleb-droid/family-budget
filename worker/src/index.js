// API семейного бюджета (Cloudflare Worker).
// Проверяет логин и пароль, а данные читает и пишет в приватный репозиторий через GitHub API.
// Токен GitHub хранится только здесь, в секретах Worker, и в браузер не попадает.
//
// Секреты (задаются из GitHub Actions, см. .github/workflows/deploy-worker.yml):
//   DATA_REPO_TOKEN — fine-grained токен, только репо family-budget-data, Contents: read/write
//   BUDGET_USERS    — «логин:пароль,логин:пароль»
// Переменные (wrangler.toml): DATA_REPO, DATA_BRANCH, ALLOWED_ORIGIN

const FILES = { entries: 'data/expenses.json', history: 'data/history.json', settings: 'data/settings.json' };
const CATEGORIES = ['Обязательные платежи', 'Еда и быт', 'Дети', 'Транспорт', 'Кафе и развлечения', 'Одежда и здоровье', 'Отпуск и подарки'];
const SESSION_DAYS = 30;
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/login' && request.method === 'POST') {
        const { login, password } = await request.json();
        const user = await checkPassword(env, String(login || ''), String(password || ''));
        if (!user) {
          await new Promise(r => setTimeout(r, 800)); // притормаживаем подбор
          return json({ error: 'Неверный логин или пароль' }, 401);
        }
        return json({ token: await makeSession(env, user), user });
      }

      const user = await readSession(env, request.headers.get('Authorization'));
      if (!user) return json({ error: 'Нужно войти заново' }, 401);
      const gh = github(env);

      if (url.pathname === '/data' && request.method === 'GET') {
        const [entries, history, settings] = await Promise.all([
          gh.get(FILES.entries, []), gh.get(FILES.history, []), gh.get(FILES.settings, {})
        ]);
        return json({ user, entries: entries.data, history: history.data, settings: settings.data });
      }

      if (url.pathname === '/entries' && request.method === 'POST') {
        const entry = validEntry(await request.json(), user);
        if (!entry) return json({ error: 'Проверьте дату, сумму и категорию' }, 400);
        const entries = await gh.update(FILES.entries, [], list => list.concat([entry]),
          `Сайт (${user}): ${entry.type === 'income' ? 'доход' : 'расход'} ${entry.amount} ${entry.currency}`);
        return json({ entries });
      }

      const del = url.pathname.match(/^\/entries\/(web-[\w-]+)$/);
      if (del && request.method === 'DELETE') {
        const entries = await gh.update(FILES.entries, [], list => list.filter(e => e.id !== del[1]), `Сайт (${user}): удалить запись`);
        return json({ entries });
      }

      if (url.pathname === '/settings' && request.method === 'PUT') {
        const patch = validSettings(await request.json());
        const settings = await gh.update(FILES.settings, {}, s => ({ ...s, ...patch }), `Сайт (${user}): настройки`);
        return json({ settings });
      }

      return json({ error: 'Не найдено' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Ошибка сервера' }, 500);
    }
  }
};

// ---------- вход ----------
function users(env) {
  const map = new Map();
  for (const pair of String(env.BUDGET_USERS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) map.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim());
  }
  return map;
}
async function sha256(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function checkPassword(env, login, password) {
  const name = login.trim().toLowerCase();
  const expected = users(env).get(name);
  // сравниваем хеши за постоянное время, чтобы не подсказывать длину и совпадения
  const a = await sha256(password.trim()), b = await sha256(expected ?? '\u0000' + crypto.randomUUID());
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return expected !== undefined && diff === 0 ? name : null;
}

// Сессия: «логин.срок.подпись». Ключ подписи выводится из секретов, поэтому смена паролей
// или токена автоматически разлогинивает всех.
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', await sha256('session\n' + env.BUDGET_USERS + '\n' + env.DATA_REPO_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
}
async function makeSession(env, user) {
  const body = `${encodeURIComponent(user)}.${Date.now() + SESSION_DAYS * 864e5}`;
  return `${body}.${await sign(env, body)}`;
}
async function readSession(env, header) {
  const token = (header || '').replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  if (await sign(env, body) !== parts[2] || Date.now() > Number(parts[1])) return null;
  const user = decodeURIComponent(parts[0]);
  return users(env).has(user) ? user : null;
}

// ---------- проверка данных ----------
function validEntry(e, user) {
  const amount = Number(e.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '') || !(amount > 0 && amount < 1e9)) return null;
  if (!['income', 'expense'].includes(e.type)) return null;
  if (e.type === 'expense' && !CATEGORIES.includes(e.category)) return null;
  return {
    id: 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: e.date, type: e.type,
    category: e.type === 'expense' ? e.category : '',
    amount: Math.round(amount * 100) / 100, currency: 'RSD',
    note: String(e.note || '').trim().slice(0, 200), who: user, source: 'web'
  };
}
function validSettings(s) {
  const out = {};
  for (const k of ['savings', 'goal', 'income']) {
    if (k in s) { const n = Number(s[k]); if (Number.isFinite(n) && n >= 0) out[k] = n; }
    const c = s[k + 'Cur'];
    if (typeof c === 'string' && /^[A-Z]{3}$/.test(c)) out[k + 'Cur'] = c;
  }
  return out;
}

// ---------- GitHub ----------
function github(env) {
  const base = `https://api.github.com/repos/${env.DATA_REPO}/contents/`;
  const call = (path, opts = {}) => fetch(base + path + (opts.method ? '' : `?ref=${env.DATA_BRANCH}`), {
    ...opts,
    headers: {
      Authorization: `Bearer ${env.DATA_REPO_TOKEN}`,
      'User-Agent': 'family-budget-api',
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: 'application/vnd.github+json',
      ...(opts.headers || {})
    }
  });
  const fromB64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
  const toB64 = s => { const b = enc.encode(s); let r = ''; for (let i = 0; i < b.length; i += 0x8000) r += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(r); };

  async function get(path, fallback) {
    const res = await call(path);
    if (res.status === 404) return { data: fallback, sha: null };
    if (!res.ok) throw new Error(`GitHub ${res.status} (${path})`);
    const meta = await res.json();
    if (meta.content) return { data: JSON.parse(fromB64(meta.content)), sha: meta.sha };
    // файлы больше 1 МБ API отдаёт без содержимого — берём сырой вариант
    const raw = await call(path, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!raw.ok) throw new Error(`GitHub ${raw.status} (${path})`);
    return { data: await raw.json(), sha: meta.sha };
  }
  // читает, меняет, пишет; если бот успел записать раньше (конфликт sha) — повторяет
  async function update(path, fallback, change, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await get(path, fallback);
      const next = change(data);
      const body = { message, branch: env.DATA_BRANCH, content: toB64(JSON.stringify(next, null, 1) + '\n') };
      if (sha) body.sha = sha;
      const res = await call(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      if (res.ok) return next;
      if (res.status !== 409 && res.status !== 422) throw new Error(`GitHub ${res.status} при сохранении`);
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
    throw new Error('Не удалось сохранить: файл одновременно меняет бот, попробуйте ещё раз');
  }
  return { get, update };
}
