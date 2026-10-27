import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMessage, sendSmtp } from '../server/smtp';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** Минимальный SMTP-сервер без шифрования; запоминает команды и письмо. */
async function fakeSmtp(opts: { starttls?: boolean; authOk?: boolean } = {}) {
  const log: string[] = [];
  let data = '';
  const server = createServer(sock => {
    let inData = false;
    let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', d => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else data += line + '\r\n';
          continue;
        }
        log.push(line.startsWith('AUTH') ? 'AUTH ***' : line);
        if (line.startsWith('EHLO')) sock.write(opts.starttls ? '250-fake\r\n250 STARTTLS\r\n' : '250 fake\r\n');
        else if (line.startsWith('AUTH')) sock.write(opts.authOk === false ? '535 bad credentials\r\n' : '235 ok\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) sock.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 ?\r\n');
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { port, log, data: () => data };
}

const cfg = (port: number) => ({ host: '127.0.0.1', port, user: 'u@x.ru', pass: 'secret', from: 'u@x.ru', allowPlain: true });

describe('SMTP-клиент', () => {
  it('отправляет письмо с кодом: команды по порядку, тема и тело в UTF-8', async () => {
    const f = await fakeSmtp();
    await sendSmtp(cfg(f.port), 'a@b.ru', 'Код входа', 'Ваш код: 123456.\r\n.точка в начале строки');
    expect(f.log).toEqual(['EHLO crashtest', 'AUTH ***', 'MAIL FROM:<u@x.ru>', 'RCPT TO:<a@b.ru>', 'DATA', 'QUIT']);
    const data = f.data();
    expect(data).toContain('Subject: =?UTF-8?B?');
    const body = data.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toContain('Ваш код: 123456.');
  });

  it('ошибка входа не раскрывает пароль', async () => {
    const f = await fakeSmtp({ authOk: false });
    const err = await sendSmtp(cfg(f.port), 'a@b.ru', 't', 'x').then(() => new Error("не упало"), (e: Error) => e);
    expect(err.message).toContain('535');
    expect(err.message).not.toContain('secret');
  });

  it('без шифрования вход отменяется, если это не разрешено явно', async () => {
    const f = await fakeSmtp();
    const err = await sendSmtp({ ...cfg(f.port), allowPlain: false }, 'a@b.ru', 't', 'x').then(() => new Error("не упало"), (e: Error) => e);
    expect(err.message).toContain('шифрован');
    expect(f.log.some(l => l.startsWith('AUTH'))).toBe(false);
  });

  it('адрес с переводом строки или скобками отклоняется до соединения', async () => {
    const f = await fakeSmtp();
    for (const bad of ['a@b.ru\r\nRCPT TO:<x@y.ru>', 'a>@b.ru', 'нет-собаки']) {
      await expect(sendSmtp(cfg(f.port), bad, 't', 'x')).rejects.toThrow('адрес');
    }
    expect(f.log).toEqual([]);
  });

  it('buildMessage: тема и тело кодируются, дата и Message-ID заданы', () => {
    const m = buildMessage('u@x.ru', 'a@b.ru', 'Тест', 'Привет', new Date('2026-01-01T00:00:00Z'));
    expect(m).toContain('From: u@x.ru');
    expect(m).toContain('Date: Thu, 01 Jan 2026 00:00:00 GMT');
    expect(m).toMatch(/Message-ID: <[\w-]+@x\.ru>/);
  });
});
