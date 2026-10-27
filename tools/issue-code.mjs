#!/usr/bin/env node
// Выпуск кодов активации подписки Crashtest.
//
//   node tools/issue-code.mjs init                       — создать пару ключей (один раз)
//   node tools/issue-code.mjs personal "Иван" [дней=30]  — личная подписка
//   node tools/issue-code.mjs school "Автошкола Старт" [дней=30]
//
// Закрытый ключ хранится ВНЕ репозитория: ~/.crashtest/license-private.pem
// (или путь из переменной CRASHTEST_KEY). Никому его не передавайте и не коммитьте:
// с ним любой может выпускать коды. Открытый ключ дописывается в src/license-keys.json —
// приложение принимает коды, подписанные любым ключом из этого списка (так ключ можно сменить).
// Выданные коды записываются в ~/.crashtest/issued.csv для учёта.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = join(ROOT, 'src', 'license-keys.json');
const KEY = process.env.CRASHTEST_KEY || join(homedir(), '.crashtest', 'license-private.pem');
const LOG = join(dirname(KEY), 'issued.csv');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const day = (d) => d.toISOString().slice(0, 10);

const [cmd, name, daysArg] = process.argv.slice(2);

if (cmd === 'init') {
  if (existsSync(KEY)) {
    console.error(`Ключ уже есть: ${KEY}. Удалите его вручную, если действительно нужен новый.`);
    process.exit(1);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  mkdirSync(dirname(KEY), { recursive: true });
  writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const keys = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : [];
  keys.push(publicKey.export({ format: 'jwk' }));
  writeFileSync(KEYS, JSON.stringify(keys, null, 2) + '\n');
  console.log(`Закрытый ключ: ${KEY} (храните в секрете и сделайте резервную копию).`);
  console.log(`Открытый ключ добавлен в ${KEYS} — закоммитьте его и выпустите новую версию приложения.`);
} else if (cmd === 'personal' || cmd === 'school') {
  if (!name) {
    console.error('Укажите имя или название автошколы в кавычках.');
    process.exit(1);
  }
  const days = Number(daysArg ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 400) {
    console.error('Срок — целое число дней от 1 до 400.');
    process.exit(1);
  }
  const key = createPrivateKey(readFileSync(KEY));
  const until = new Date();
  until.setDate(until.getDate() + days - 1);
  const data = { plan: cmd, name, until: day(until), id: b64url(randomBytes(6)) };
  const payload = b64url(JSON.stringify(data));
  const signature = sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' });
  const code = `CT1.${payload}.${b64url(signature)}`;
  appendFileSync(LOG, `${day(new Date())};${data.id};${cmd};"${name.replace(/"/g, '""')}";${data.until}\n`);
  console.log(`Тариф: ${cmd === 'school' ? 'автошкола' : 'личная подписка'}, «${name}», действует по ${data.until} включительно.\n`);
  console.log(code);
  // Проверка: открытый ключ этого закрытого должен быть в списке приложения.
  const pub = createPublicKey(key).export({ format: 'jwk' });
  const keys = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : [];
  if (!keys.some((k) => k.x === pub.x && k.y === pub.y)) console.error('\nВнимание: открытого ключа нет в src/license-keys.json — приложение не примет этот код.');
} else {
  console.log('Использование:\n  node tools/issue-code.mjs init\n  node tools/issue-code.mjs personal "Имя" [дней]\n  node tools/issue-code.mjs school "Автошкола" [дней]');
}
