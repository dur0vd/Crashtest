import { openDb, purgeInactive } from './db';
import { createApp, type Mailer } from './app';
import { sendSmtp, type SmtpConfig } from './smtp';
import { createPayments, paymentConfig, type Payments } from './payments';

const port = Number(process.env.PORT ?? 8787);
const db = openDb(process.env.DB_PATH ?? 'crashtest.sqlite');

const smtp: SmtpConfig | undefined = process.env.SMTP_HOST ? {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 465),
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASS ?? '',
  from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
} : undefined;
const hook = process.env.MAIL_WEBHOOK_URL;

/** Приоритет: SMTP, затем HTTP-шлюз; вывод в журнал используется для входа при разработке. */
async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (smtp) return sendSmtp(smtp, to, subject, text);
  if (hook) {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Почтовый шлюз ответил ${r.status}`);
  } else {
    throw new Error('Отправка почты не настроена');
  }
}

const mailer: Mailer = {
  async sendCode(email, code) {
    if (!smtp && !hook) { console.log(`[mail] ${email}: код ${code}`); return; }
    const text = `Ваш код: ${code}. Он действует 10 минут.`;
    await sendMail(email, 'Код входа в Crashtest', smtp ? `${text} Если вы не запрашивали вход, просто проигнорируйте письмо.` : text);
  },
};

let payments: Payments | undefined;
if (process.env.TBANK_ENABLED === 'true') {
  try {
    if (smtp ? !smtp.user || !smtp.pass || !smtp.from : !hook) throw new Error('Отправка почты не настроена');
    payments = createPayments(db, paymentConfig(process.env), sendMail);
  } catch (error) {
    console.error('Оплата Т-Банка отключена. Проверьте настройки терминала, ключа активации, кассы и почты.', error instanceof Error ? error.name : '');
  }
}
const deliver = () => { void payments?.deliver().catch(() => console.error('Не удалось обработать очередь писем с кодами активации')); };
deliver();
if (payments) setInterval(deliver, 5_000).unref();

// Раз в сутки (и при запуске) удаляем аккаунты, неактивные дольше срока хранения.
const purge = () => {
  payments?.purge();
  const n = purgeInactive(db, Date.now());
  if (n) console.log(`Удалено неактивных аккаунтов: ${n}`);
};
purge();
setInterval(purge, 24 * 3600_000).unref();

createApp({ db, mailer, payments, allowOrigin: process.env.ALLOW_ORIGIN }).listen(port, '127.0.0.1', () => {
  console.log(`Crashtest API: http://127.0.0.1:${port}`);
});
