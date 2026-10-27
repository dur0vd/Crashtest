import { openDb, purgeInactive } from './db';
import { createApp, type Mailer } from './app';
import { smtpMailer } from './smtp';

const port = Number(process.env.PORT ?? 8787);
const db = openDb(process.env.DB_PATH ?? 'crashtest.sqlite');

/** Приоритет: SMTP, затем HTTP-шлюз; без них код печатается в журнал — только для разработки. */
const webhookMailer: Mailer = {
  async sendCode(email, code) {
    const hook = process.env.MAIL_WEBHOOK_URL;
    if (!hook) { console.log(`[mail] ${email}: код ${code}`); return; }
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: email, subject: 'Код входа в Crashtest', text: `Ваш код: ${code}. Он действует 10 минут.` }),
    });
    if (!r.ok) throw new Error(`Почтовый шлюз ответил ${r.status}`);
  },
};

// Раз в сутки (и при запуске) удаляем аккаунты, неактивные дольше срока хранения.
const purge = () => { const n = purgeInactive(db, Date.now()); if (n) console.log(`Удалено неактивных аккаунтов: ${n}`); };
purge();
setInterval(purge, 24 * 3600_000).unref();

const mailer: Mailer = process.env.SMTP_HOST
  ? smtpMailer({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 465),
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
    })
  : webhookMailer;

createApp({ db, mailer, allowOrigin: process.env.ALLOW_ORIGIN }).listen(port, '127.0.0.1', () => {
  console.log(`Crashtest API: http://127.0.0.1:${port}`);
});
