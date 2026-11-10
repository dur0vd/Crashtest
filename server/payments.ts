import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import keys from '../src/license-keys.json';
import type { License } from '../src/license';
import { BILLING } from '../src/plans';

type Fields = Record<string, unknown>;
type Status = 'pending' | 'confirmed' | 'cancelled';
interface Order {
  id: string;
  terminal_key: string;
  payment_id: string | null;
  amount: number;
  status: Status;
  sent_at: number | null;
}

export interface PaymentConfig {
  terminalKey: string;
  password: string;
  siteUrl: URL;
  key: KeyObject;
  receipt: { taxation: string; tax: string; paymentObject: string; ffd12: boolean };
}

type SendMail = (to: string, subject: string, text: string) => Promise<void>;
const API = 'https://securepay.tinkoff.ru/v2';
const DESCRIPTION = 'Личная подписка Crashtest на 30 дней';
const CANCELLED = new Set(['CANCELED', 'DEADLINE_EXPIRED', 'REJECTED', 'REVERSED', 'REFUNDED']);
const DAY = 86_400_000;

export function paymentConfig(env: NodeJS.ProcessEnv): PaymentConfig {
  const {
    TBANK_TERMINAL_KEY: terminalKey, TBANK_PASSWORD: password, CRASHTEST_KEY: keyPath,
    TBANK_RECEIPT_TAXATION: taxation, TBANK_RECEIPT_TAX: tax,
    TBANK_RECEIPT_PAYMENT_OBJECT: paymentObject, TBANK_RECEIPT_FFD: ffd,
  } = env;
  if (!terminalKey || !password || !keyPath || !taxation || !tax || !paymentObject || (ffd !== '1.05' && ffd !== '1.2')) {
    throw new Error('Не заданы настройки терминала, кассы или ключа активации');
  }
  const siteUrl = new URL(env.TBANK_SITE_URL ?? 'https://roadpdd.ru');
  if (siteUrl.protocol !== 'https:' || siteUrl.username || siteUrl.password) throw new Error('Для оплаты нужен адрес HTTPS');
  const key = createPrivateKey(readFileSync(keyPath));
  const pub = createPublicKey(key).export({ format: 'jwk' });
  if (!keys.some(k => k.kty === pub.kty && k.crv === pub.crv && k.x === pub.x && k.y === pub.y)) {
    throw new Error('Ключ активации не соответствует открытому ключу приложения');
  }
  return { terminalKey, password, siteUrl, key, receipt: { taxation, tax, paymentObject, ffd12: ffd === '1.2' } };
}

/** В подпись входят только скалярные поля верхнего уровня и пароль терминала. */
export function tbankToken(fields: Fields, password: string): string {
  const scalars = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    key !== 'Token' && ['string', 'number', 'boolean'].includes(typeof value),
  ));
  scalars.Password = password;
  return createHash('sha256').update(Object.keys(scalars).sort().map(k => String(scalars[k])).join('')).digest('hex');
}

function paymentId(value: unknown): string | null {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  const id = String(value);
  return /^\d{1,20}$/.test(id) ? id : null;
}

function issueLicense(order: Order, key: KeyObject, now: number): string {
  // Срок в днях по Москве, включая день выдачи. Формат совпадает с tools/issue-code.mjs.
  const until = new Date(now + 3 * 3600_000 + 29 * DAY).toISOString().slice(0, 10);
  const data: License = { plan: 'personal', name: '', until, id: order.id };
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' });
  return `CT1.${payload}.${signature.toString('base64url')}`;
}

export type Payments = ReturnType<typeof createPayments>;

export function createPayments(db: DatabaseSync, config: PaymentConfig, sendMail: SendMail, now = Date.now, request = fetch) {
  const { terminalKey, password, receipt } = config;
  const find = db.prepare('SELECT id, terminal_key, payment_id, amount, status, sent_at FROM payment_orders WHERE id = ?');
  const findOrder = (id: string) => find.get(id) as Order | undefined;

  async function bank(method: 'Init' | 'GetState', data: Fields): Promise<Fields> {
    const fields = { TerminalKey: terminalKey, ...data };
    const response = await request(`${API}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, Token: tbankToken(fields, password) }),
      redirect: 'error', signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`Т-Банк ${method}: HTTP ${response.status}`);
    const result = await response.json() as Fields;
    if (result?.Success !== true || String(result.ErrorCode) !== '0') {
      const code = /^\d+$/.test(String(result?.ErrorCode)) ? String(result.ErrorCode) : 'неизвестен';
      throw new Error(`Т-Банк ${method}: код ошибки ${code}`);
    }
    return result;
  }

  async function start(email: string) {
    const id = randomUUID();
    const amount = BILLING.plans.personal.price * 100;
    const time = now();
    const returnUrl = new URL('/', config.siteUrl);
    returnUrl.searchParams.set('payment', id);
    db.prepare('INSERT INTO payment_orders (id, terminal_key, amount, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, terminalKey, amount, email, time);
    try {
      const result = await bank('Init', {
        Amount: amount, OrderId: id, Description: DESCRIPTION, PayType: 'O',
        NotificationURL: new URL('/api/payments/tbank', config.siteUrl).href,
        SuccessURL: returnUrl.href, FailURL: returnUrl.href,
        RedirectDueDate: new Date(time + 3600_000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        DATA: { OperationInitiatorType: '0' },
        Receipt: {
          Email: email, Taxation: receipt.taxation,
          Items: [{
            Name: DESCRIPTION, Price: amount, Quantity: 1, Amount: amount, Tax: receipt.tax,
            PaymentMethod: 'full_payment', PaymentObject: receipt.paymentObject,
            ...(receipt.ffd12 ? { MeasurementUnit: 'шт' } : {}),
          }],
        },
      });
      const bankId = paymentId(result.PaymentId);
      const url = new URL(typeof result.PaymentURL === 'string' ? result.PaymentURL : '');
      if (!bankId || result.OrderId !== id || result.TerminalKey !== terminalKey || String(result.Amount) !== String(amount)
        || url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Т-Банк не вернул корректную ссылку для оплаты');
      }
      db.prepare('UPDATE payment_orders SET payment_id = ? WHERE id = ?').run(bankId, id);
      return { id, url: url.href };
    } catch (error) {
      db.prepare('DELETE FROM payment_orders WHERE id = ? AND payment_id IS NULL').run(id);
      throw error;
    }
  }

  function applyState(data: Fields): boolean {
    if (typeof data.OrderId !== 'string' || data.TerminalKey !== terminalKey) return false;
    const order = findOrder(data.OrderId);
    if (!order || order.terminal_key !== terminalKey || !order.payment_id || order.payment_id !== paymentId(data.PaymentId)) return false;
    if (CANCELLED.has(String(data.Status))) {
      db.prepare("UPDATE payment_orders SET status = 'cancelled', email = NULL, license_code = NULL WHERE id = ?")
        .run(order.id);
    } else if (data.Status === 'CONFIRMED') {
      if (String(data.Amount) !== String(order.amount) || data.Success !== true || String(data.ErrorCode) !== '0') return false;
      if (order.status === 'pending') {
        db.prepare("UPDATE payment_orders SET status = 'confirmed', license_code = ? WHERE id = ? AND status = 'pending'")
          .run(issueLicense(order, config.key, now()), order.id);
      }
    }
    return true;
  }

  function notify(data: Fields): boolean {
    if (typeof data.Token !== 'string' || !/^[a-f0-9]{64}$/i.test(data.Token)) return false;
    if (!timingSafeEqual(Buffer.from(data.Token, 'hex'), Buffer.from(tbankToken(data, password), 'hex'))) return false;
    return applyState(data);
  }

  async function status(id: string) {
    const order = findOrder(id);
    if (!order?.payment_id || order.terminal_key !== terminalKey) return null;
    if (order.status === 'pending' && db.prepare(
      "UPDATE payment_orders SET checked_at = ? WHERE id = ? AND status = 'pending' AND checked_at <= ?",
    ).run(now(), id, now() - 10_000).changes) {
      try {
        const state = await bank('GetState', { PaymentId: order.payment_id });
        if (state.OrderId === id) applyState(state);
      }
      catch { /* Уведомление банка или следующая проверка обновят статус. */ }
    }
    const current = findOrder(id)!;
    return { status: current.status, sent: current.sent_at !== null };
  }

  async function deliver() {
    const time = now();
    // Атомарно забираем одну запись. После сбоя будет повтор с тем же кодом.
    const row = db.prepare(`
      UPDATE payment_orders SET next_delivery_at = ?
      WHERE id = (SELECT id FROM payment_orders WHERE status = 'confirmed'
        AND license_code IS NOT NULL AND next_delivery_at <= ? ORDER BY next_delivery_at, created_at LIMIT 1)
      RETURNING id, email, license_code
    `).get(time + 120_000, time) as { id: string; email: string; license_code: string } | undefined;
    if (!row) return;
    try {
      await sendMail(row.email, 'Код активации Crashtest', `Ваш код активации личной подписки на 30 дней:\n\n${row.license_code}\n\nОткройте меню «Подписка» на roadpdd.ru и вставьте код в поле «Код активации».`);
      db.prepare("UPDATE payment_orders SET email = NULL, license_code = NULL, sent_at = ? WHERE id = ? AND status = 'confirmed'")
        .run(now(), row.id);
    } catch {
      console.error(`Не удалось отправить код активации для заказа ${row.id}. Отправка будет повторена.`);
    }
  }

  function purge() {
    db.prepare("UPDATE payment_orders SET email = NULL, status = 'cancelled' WHERE status = 'pending' AND created_at < ?")
      .run(now() - 7 * DAY);
  }

  return { start, notify, status, deliver, purge };
}
