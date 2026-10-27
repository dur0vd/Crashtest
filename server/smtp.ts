import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Mailer } from './app';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Адрес отправителя; обычно совпадает с логином. */
  from: string;
  /** Только для тестов: разрешает вход без шифрования. */
  allowPlain?: boolean;
}

const TIMEOUT = 15_000;
const SAFE_ADDRESS = /^[^\s<>@"]{1,64}@[^\s<>@"]{1,255}$/;

/** Читает ответы SMTP построчно: многострочный ответ заканчивается строкой «NNN текст» без дефиса. */
class Session {
  private buf = '';
  private waiting: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void } | null = null;
  private lines: string[] = [];
  private error: Error | null = null;

  constructor(public socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  private handlers: [string, (...a: any[]) => void][] = [];

  private attach(socket: Socket): void {
    socket.setTimeout(TIMEOUT);
    this.handlers = [
      ['timeout', () => this.fail(new Error('SMTP: таймаут'))],
      ['error', (e: Error) => this.fail(e)],
      ['close', () => this.fail(new Error('SMTP: соединение закрыто'))],
      ['data', (d: Buffer) => {
        this.buf += d.toString('utf8');
        let i: number;
        while ((i = this.buf.indexOf('\r\n')) >= 0) {
          this.lines.push(this.buf.slice(0, i));
          this.buf = this.buf.slice(i + 2);
          if (/^\d{3}( |$)/.test(this.lines[this.lines.length - 1])) this.flush();
        }
      }],
    ];
    for (const [ev, fn] of this.handlers) socket.on(ev, fn);
  }

  /** После STARTTLS читаем уже TLS-сокет; свои обработчики снимаем только с исходного, чужие (TLS) не трогаем. */
  swap(socket: TLSSocket): void {
    for (const [ev, fn] of this.handlers) this.socket.off(ev, fn);
    this.socket = socket;
    this.buf = '';
    this.lines = [];
    this.attach(socket);
  }

  private flush(): void {
    const lines = this.lines;
    this.lines = [];
    const code = Number(lines[lines.length - 1].slice(0, 3));
    this.waiting?.resolve({ code, lines });
    this.waiting = null;
  }

  private fail(e: Error): void {
    if (!this.error) this.error = e;
    this.waiting?.reject(this.error);
    this.waiting = null;
    this.socket.destroy();
  }

  read(): Promise<{ code: number; lines: string[] }> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  async cmd(line: string, ok: number, secret = false): Promise<string[]> {
    const reply = this.read();
    this.socket.write(line + '\r\n');
    const r = await reply;
    if (r.code !== ok) throw new Error(`SMTP: на «${secret ? '***' : line.split(' ')[0]}» ответ ${r.lines[r.lines.length - 1]}`);
    return r.lines;
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Письмо в UTF-8: тема в RFC 2047, тело в base64 (так точки и переводы строк не ломают протокол). */
export function buildMessage(from: string, to: string, subject: string, text: string, now = new Date()): string {
  const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

export async function sendSmtp(cfg: SmtpConfig, to: string, subject: string, text: string): Promise<void> {
  if (!SAFE_ADDRESS.test(to) || !SAFE_ADDRESS.test(cfg.from)) throw new Error('SMTP: недопустимый адрес');
  const implicitTls = cfg.port === 465;
  const socket = implicitTls
    ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : netConnect({ host: cfg.host, port: cfg.port });
  const s = new Session(socket);
  try {
    const greeting = await s.read();
    if (greeting.code !== 220) throw new Error(`SMTP: приветствие ${greeting.lines[0]}`);
    let caps = await s.cmd('EHLO crashtest', 250);
    if (!implicitTls) {
      if (caps.some(l => /STARTTLS/i.test(l))) {
        await s.cmd('STARTTLS', 220);
        const secured = tlsConnect({ socket: s.socket, servername: cfg.host });
        await new Promise<void>((resolve, reject) => { secured.once('secureConnect', resolve); secured.once('error', reject); });
        s.swap(secured);
        caps = await s.cmd('EHLO crashtest', 250);
      } else if (!cfg.allowPlain) {
        throw new Error('SMTP: сервер не поддерживает шифрование, вход отменён');
      }
    }
    await s.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, 235, true);
    await s.cmd(`MAIL FROM:<${cfg.from}>`, 250);
    await s.cmd(`RCPT TO:<${to}>`, 250);
    await s.cmd('DATA', 354);
    await s.cmd(`${buildMessage(cfg.from, to, subject, text)}\r\n.`, 250);
    await s.cmd('QUIT', 221).catch(() => {});
  } finally {
    s.socket.destroy();
  }
}

export function smtpMailer(cfg: SmtpConfig): Mailer {
  return {
    sendCode: (email, code) => sendSmtp(cfg, email, 'Код входа в Crashtest', `Ваш код: ${code}. Он действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`),
  };
}
