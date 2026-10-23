// Собирает index.html: шифрует src/admin.html и добавляет пользователей (логин + пароль).
//
//   node tools/build.mjs            — спросит логины и пароли в терминале
//   BUDGET_USERS="gleb:пароль1,wife:пароль2" node tools/build.mjs
//
// Пароли никуда не сохраняются: в index.html попадает только шифротекст.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 600_000;
const root = new URL('..', import.meta.url);
const b64 = b => Buffer.from(b).toString('base64');
const rand = n => crypto.getRandomValues(new Uint8Array(n));

async function askUsers() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const users = [];
  console.log('Добавьте пользователей. Пустой логин — закончить.');
  while (true) {
    const login = (await rl.question('Логин: ')).trim();
    if (!login) break;
    const password = (await rl.question('Пароль: ')).trim();
    users.push([login, password]);
  }
  rl.close();
  return users;
}

const users = process.env.BUDGET_USERS
  ? process.env.BUDGET_USERS.split(',').map(p => { const i = p.indexOf(':'); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; })
  : await askUsers();
if (!users.length) { console.error('Нужен хотя бы один пользователь'); process.exit(1); }
for (const [l, p] of users) if (!l || p.length < 10) { console.error(`Пароль для «${l}» должен быть не короче 10 символов`); process.exit(1); }

const salt = rand(16);
const contentKey = rand(32);
const ck = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
const iv = rand(12);
const html = await readFile(new URL('src/admin.html', root), 'utf8');
const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, new TextEncoder().encode(html));

const slots = [];
for (const [login, password] of users) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(login.toLowerCase() + '\n' + password), 'PBKDF2', false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const siv = rand(12);
  slots.push({ iv: b64(siv), key: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: siv }, kek, contentKey)) });
}
// порядок слотов перемешан, логины в файл не попадают
slots.sort(() => Math.random() - 0.5);

const vault = { version: b64(rand(6)), iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data), slots };
const template = await readFile(new URL('tools/template.html', root), 'utf8');
const out = template.replace('/*VAULT*/null/*END*/', JSON.stringify(vault));
await writeFile(new URL('index.html', root), out);
console.log(`Готово: index.html, пользователей: ${users.length}`);
