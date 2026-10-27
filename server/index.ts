import { openDb } from './db';
import { createApp, type Mailer } from './app';

const port = Number(process.env.PORT ?? 8787);
const db = openDb(process.env.DB_PATH ?? 'crashtest.sqlite');

/** Без MAIL_WEBHOOK_URL код печатается в журнал — только для разработки. */
const mailer: Mailer = {
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

createApp({ db, mailer, allowOrigin: process.env.ALLOW_ORIGIN }).listen(port, '127.0.0.1', () => {
  console.log(`Crashtest API: http://127.0.0.1:${port}`);
});
