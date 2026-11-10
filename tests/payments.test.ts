import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { openDb } from '../server/db';
import { createPayments, tbankToken } from '../server/payments';
import { verifyCode } from '../src/license';

const terminal = 'CrashtestDEMO';
const password = 'тестовый-пароль';
const amount = 19_900;
const email = 'buyer@example.org';
const cleanup: (() => Promise<void>)[] = [];

async function setup() {
  const db = openDb(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let clock = Date.parse('2026-11-10T22:30:00Z');
  let bankStatus = 'NEW';
  let orderId = '';
  const notification = (Status = bankStatus, overrides = {}) => ({
    TerminalKey: terminal, OrderId: orderId, PaymentId: '1234', Amount: amount,
    Success: true, ErrorCode: '0', Status, ...overrides,
  });
  const signNotification = (data: ReturnType<typeof notification>) => ({ ...data, Token: tbankToken(data, password) });
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.Token).toBe(tbankToken(body, password));
    if (String(url).endsWith('/Init')) {
      expect(body).toMatchObject({
        Amount: amount, PayType: 'O', DATA: { OperationInitiatorType: '0' },
        Receipt: { Email: email, Items: [{ Amount: amount, Quantity: 1, Price: amount, MeasurementUnit: 'шт' }] },
        NotificationURL: 'https://roadpdd.ru/api/payments/tbank',
      });
      orderId = body.OrderId;
      expect(body.SuccessURL).toBe(`https://roadpdd.ru/?payment=${orderId}`);
      expect(body.FailURL).toBe(body.SuccessURL);
      return Response.json({ ...notification(), PaymentURL: 'https://pay.tbank.ru/test' });
    }
    expect(String(url)).toBe('https://securepay.tinkoff.ru/v2/GetState');
    expect(body.PaymentId).toBe('1234');
    return Response.json(notification());
  });
  const mail = vi.fn<(to: string, subject: string, text: string) => Promise<void>>().mockResolvedValue(undefined);
  const payments = createPayments(db, {
    terminalKey: terminal, password, key: privateKey, siteUrl: new URL('https://roadpdd.ru'),
    receipt: { taxation: 'usn_income', tax: 'none', paymentObject: 'intellectual_activity', ffd12: true },
  }, mail, () => clock, request);
  const app = createApp({ db, payments, mailer: { sendCode: async () => {} } });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => app.close(e => e ? reject(e) : resolve()));
    db.close();
  });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/payments`;
  const post = (path: string, body: unknown) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const start = async () => {
    // Цена из запроса покупателя игнорируется.
    const response = await post('', { email, amount: 1 });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: orderId, url: 'https://pay.tbank.ru/test' });
  };
  return {
    start, payments, mail, request, publicKey,
    status: async () => (await fetch(`${base}/${orderId}`)).json(),
    notify: (status: string, overrides = {}) => post('/tbank', signNotification(notification(status, overrides))),
    post, notification, signNotification,
    setBankStatus: (value: string) => { bankStatus = value; },
    advance: (ms: number) => { clock += ms; },
  };
}

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

describe('оплата Т-Банка', () => {
  it('подписывает уведомление по контрольному примеру банка', () => {
    expect(tbankToken({
      TerminalKey: '1234567890DEMO', OrderId: '000000', Success: true, Status: 'AUTHORIZED',
      PaymentId: '0000000', ErrorCode: '0', Amount: '1111', CardId: '000000', Pan: '200000******0000',
      ExpDate: '1111', RebillId: '000000', Data: { test: 1 }, Receipt: {}, Token: 'старый',
    }, '11111111111')).toBe('1c0964277d0213349243065a0d5b838b8e90d2d25f740d0f2767836e710e80c8');
  });

  it('отклоняет подделку и несовпадение суммы, выдаёт один действующий код после CONFIRMED', async () => {
    const f = await setup();
    expect((await f.post('', { email: 'не почта' })).status).toBe(400);
    await f.start();
    expect((await f.post('/tbank', { ...f.notification('CONFIRMED'), Token: '0'.repeat(64) })).status).toBe(400);
    expect((await f.notify('CONFIRMED', { Amount: 1 })).status).toBe(400);
    expect((await f.notify('CONFIRMED', { PaymentId: '1235' })).status).toBe(400);
    expect((await f.notify('AUTHORIZED')).status).toBe(200);
    await f.payments.deliver();
    expect(f.mail).not.toHaveBeenCalled();

    const responses = await Promise.all([f.notify('CONFIRMED'), f.notify('CONFIRMED')]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('OK');
    }
    await Promise.all([f.payments.deliver(), f.payments.deliver()]);
    expect(f.mail).toHaveBeenCalledTimes(1);
    expect(f.mail.mock.calls[0][0]).toBe(email);
    const code = f.mail.mock.calls[0][2].match(/CT1\.[\w-]+\.[\w-]+/)![0];
    const key = f.publicKey.export({ format: 'jwk' }) as JsonWebKey;
    expect(await verifyCode(code, [key], '2026-11-11')).toMatchObject({ plan: 'personal', until: '2026-12-10' });
    expect(await f.status()).toEqual({ status: 'confirmed', sent: true });
  });

  it('сверяет статус через GetState и повторяет отправку того же кода после сбоя почты', async () => {
    const f = await setup();
    await f.start();
    expect(await f.status()).toEqual({ status: 'pending', sent: false });
    f.setBankStatus('CONFIRMED');
    f.advance(11_000);
    expect(await f.status()).toEqual({ status: 'confirmed', sent: false });
    expect(f.request).toHaveBeenCalledTimes(3);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f.mail.mockRejectedValueOnce(new Error('почта недоступна'));
    await f.payments.deliver();
    await f.payments.deliver();
    expect(f.mail).toHaveBeenCalledTimes(1);
    f.advance(120_000);
    await f.payments.deliver();
    expect(f.mail).toHaveBeenCalledTimes(2);
    expect(f.mail.mock.calls[0]).toEqual(f.mail.mock.calls[1]);
    expect(await f.status()).toEqual({ status: 'confirmed', sent: true });
  });

  it('не выдаёт код после отмены, даже если позже приходит подтверждение', async () => {
    const f = await setup();
    await f.start();
    expect((await f.notify('REFUNDED')).status).toBe(200);
    expect((await f.notify('CONFIRMED')).status).toBe(200);
    await f.payments.deliver();
    expect(f.mail).not.toHaveBeenCalled();
    expect(await f.status()).toEqual({ status: 'cancelled', sent: false });
  });
});
