// Подписка в интерфейсе: пробный режим, окно тарифов и ввод кода активации.
// Логика проверки — в license.ts; здесь хранение на устройстве и окна.

import './billing.css';
import keys from './license-keys.json';
import { FREE_MODELS, type License, type TrialState, canRun, formatDate, markRun, modelKey, todayIso, verifyCode } from './license';
import { BILLING } from './plans';
import type { Scene } from './scene';
import { closeModal, h, openModal } from './ui';

const CODE_KEY = 'crashtest.license';
const TRIAL_KEY = 'crashtest.trial';

let license: License | null = null;
let trial: TrialState = { used: [] };

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно: подписку придётся вводить заново */
  }
};

/** Загружает пробный счётчик и проверяет сохранённый код. */
export async function initBilling(): Promise<void> {
  try {
    const t = JSON.parse(read(TRIAL_KEY) ?? '{}');
    if (Array.isArray(t.used)) trial = { used: t.used.filter((x: unknown) => typeof x === 'string') };
  } catch {
    /* повреждённые данные — начинаем пробный режим заново */
  }
  const code = read(CODE_KEY);
  if (code) {
    const r = await verifyCode(code, keys as JsonWebKey[], todayIso());
    license = typeof r === 'string' ? null : r;
  }
  const url = new URL(location.href);
  const paymentId = url.searchParams.get('payment');
  if (paymentId && /^[a-f0-9-]{36}$/.test(paymentId)) showPaymentStatus(url, paymentId);
}

export function activeLicense(): License | null {
  return license && license.until >= todayIso() ? license : null;
}

/** Короткая строка состояния для меню. */
export function billingStatus(): string {
  const l = activeLicense();
  if (l) return `${l.plan === 'school' ? 'автошкола' : 'подписка'} до ${formatDate(l.until)}`;
  return `Пробный режим: использовано ${Math.min(trial.used.length, FREE_MODELS)} из ${FREE_MODELS} моделей`;
}

/** Проверяет доступ перед запуском модели; без доступа открывает окно подписки. */
export function allowRun(scene: Scene): boolean {
  const key = modelKey(scene);
  if (!canRun(trial, key, activeLicense(), todayIso())) {
    showSubscription('Пробные модели закончились');
    return false;
  }
  if (!activeLicense()) {
    trial = markRun(trial, key);
    write(TRIAL_KEY, JSON.stringify(trial));
  }
  return true;
}

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

function buyLink(plan: 'personal' | 'school', onBack?: () => void): HTMLElement {
  const p = BILLING.plans[plan];
  const subject = encodeURIComponent(`Подписка Crashtest: ${p.title}`);
  const body = encodeURIComponent(plan === 'school'
    ? 'Здравствуйте! Хотим оформить подписку для автошколы на месяц.\nНазвание автошколы:\nИНН (для счёта):\n'
    : 'Здравствуйте! Хочу оформить личную подписку на месяц.\n');
  const mail = h('a', { class: plan === 'school' ? 'btn primary' : 'billing-mail', href: `mailto:${BILLING.contact}?subject=${subject}&body=${body}` }, plan === 'school' ? 'Запросить счёт' : 'Написать по поводу оплаты');
  if (plan === 'school') return mail;

  const card = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => showCheckout(onBack) }, 'Проверяем оплату…');
  const state = h('p', { class: 'billing-availability', role: 'status' });
  const retry = h('button', { type: 'button', class: 'billing-retry', onclick: () => { void check(); }, hidden: true }, 'Проверить ещё раз');
  const controls = h('div', { class: 'billing-payment-controls' }, card, state, retry, mail);
  async function check(): Promise<void> {
    card.disabled = true;
    card.textContent = 'Проверяем оплату…';
    state.textContent = '';
    retry.hidden = true;
    try {
      const config = await paymentApi<{ available: boolean }>('/config');
      if (typeof config.available !== 'boolean') throw new Error('Неверный ответ сервиса');
      if (config.available) {
        card.disabled = false;
        card.textContent = 'Оплатить картой';
        state.textContent = 'Разовый платёж на защищённой странице Т-Банка.';
      } else {
        card.textContent = 'Оплата картой недоступна';
        state.textContent = 'Онлайн-оплата сейчас не подключена. Для оформления напишите нам.';
      }
    } catch {
      card.textContent = 'Оплата картой недоступна';
      state.textContent = 'Не удалось проверить доступность оплаты. Проверьте интернет или напишите нам.';
      retry.hidden = false;
    }
  }
  void check();
  return controls;
}

class PaymentError extends Error {
  constructor(readonly status: number) { super('Сервис оплаты недоступен'); }
}

async function paymentApi<T>(path: string, body?: { email: string }): Promise<T> {
  const response = await fetch(`./api/payments${path}`, {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new PaymentError(response.status);
  return response.json() as Promise<T>;
}

function showCheckout(onBack?: () => void): void {
  const email = h('input', { type: 'email', class: 'code-input billing-email', required: true, maxlength: 64, autocomplete: 'email', spellcheck: 'false', placeholder: 'you@example.ru' });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Перейти к оплате картой');
  const status = h('p', { class: 'billing-form-status', role: 'status', 'aria-live': 'polite' });
  const form = h('form', { onsubmit: async (event: SubmitEvent) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    status.textContent = 'Создаём платёж…';
    try {
      const { url } = await paymentApi<{ url: string }>('', { email: email.value.trim() });
      if (form.closest('#modal:not(.hidden)')) location.assign(url);
    } catch (error) {
      status.textContent = error instanceof PaymentError && error.status === 400
        ? 'Проверьте адрес почты и попробуйте ещё раз.'
        : error instanceof PaymentError && error.status === 429
          ? 'Слишком много запросов. Подождите немного и попробуйте снова.'
          : 'Не удалось перейти к оплате. Проверьте соединение и попробуйте ещё раз или напишите нам.';
    } finally {
      submit.disabled = false;
    }
  } },
    h('label', { class: 'billing-field' }, 'Почта для кода активации и чека', email),
    h('p', { class: 'disclaimer' }, 'Укажите адрес, к которому у вас есть доступ. После подтверждения платежа мы отправим на него код активации.'),
    h('p', { class: 'disclaimer' }, 'Оплачивая подписку, вы принимаете ',
      h('a', { href: 'legal/offer.html', target: '_blank', rel: 'noopener' }, 'оферту'), '. ',
      h('a', { href: 'legal/privacy.html', target: '_blank', rel: 'noopener' }, 'Обработка данных')),
    status,
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn', onclick: () => showSubscription(undefined, onBack) }, 'Назад'), submit));
  openModal(h('div', { class: 'doc subscription billing-checkout' },
    h('span', { class: 'billing-kicker' }, 'ОФОРМЛЕНИЕ ПОДПИСКИ'),
    h('h2', {}, 'Личная подписка'),
    h('div', { class: 'billing-order' }, h('div', {}, h('strong', {}, 'Доступ на 30 дней'), h('span', {}, 'Без автоматического продления')), h('b', {}, rub(BILLING.plans.personal.price))),
    h('p', {}, 'Далее откроется защищённая страница Т-Банка для оплаты картой.'),
    form));
}

function showPaymentStatus(url: URL, id: string): void {
  const status = h('p', { role: 'status' }, 'Проверяем платёж…');
  const retry = h('button', { type: 'button', class: 'btn', onclick: () => { void check(); } }, 'Проверить статус');
  let timer = 0;
  let attempts = 0;
  async function check() {
    window.clearTimeout(timer);
    if (retry.disabled || !status.closest('#modal:not(.hidden)')) return;
    retry.disabled = true;
    try {
      const result = await paymentApi<{ status: 'pending' | 'confirmed' | 'cancelled'; sent: boolean }>(`/${id}`);
      if (result.status === 'cancelled') {
        status.textContent = 'Платёж не завершён или возвращён.';
        retry.hidden = true;
        return;
      }
      if (result.status === 'confirmed' && result.sent) {
        status.textContent = 'Оплата подтверждена. Код активации отправлен на почту, указанную при покупке. Вставьте его в разделе «Код активации».';
        retry.hidden = true;
        return;
      }
      status.textContent = result.status === 'confirmed' ? 'Оплата подтверждена. Готовим письмо с кодом активации. Доставка может занять некоторое время.' : 'Ожидаем подтверждения от банка. Если вы уже оплатили, не создавайте платёж повторно.';
      if (++attempts < 6) timer = window.setTimeout(() => { void check(); }, 5_000);
    } catch (error) {
      status.textContent = error instanceof PaymentError && error.status === 404
        ? `Платёж не найден. Если деньги списаны, напишите на ${BILLING.contact}.`
        : 'Не удалось проверить статус. Проверьте соединение и попробуйте ещё раз. Если деньги списаны, не оплачивайте повторно до проверки.';
    } finally {
      retry.disabled = false;
    }
  }
  openModal(h('div', { class: 'doc subscription' },
    h('h2', {}, 'Оплата подписки'), status,
    h('div', { class: 'row end' }, retry, h('button', { type: 'button', class: 'btn primary', onclick: () => {
      window.clearTimeout(timer);
      url.searchParams.delete('payment');
      history.replaceState(history.state, '', url);
      showSubscription();
    } }, 'К подписке'))));
  void check();
}

/** Окно подписки: состояние, тарифы, ввод кода. */
export function showSubscription(reason?: string, onBack?: () => void): void {
  const l = activeLicense();
  const input = h('textarea', { class: 'code-input', rows: 3, placeholder: 'CT1.…', 'aria-label': 'Код активации', spellcheck: 'false' });
  const msg = h('p', { class: 'code-msg', role: 'status' });
  const activate = async () => {
    const r = await verifyCode(input.value, keys as JsonWebKey[], todayIso());
    if (typeof r === 'string') {
      msg.textContent = r;
      msg.className = 'code-msg bad';
      return;
    }
    license = r;
    write(CODE_KEY, input.value.trim().replace(/\s+/g, ''));
    msg.textContent = `Подписка активна до ${formatDate(r.until)} включительно.`;
    msg.className = 'code-msg ok';
    setTimeout(() => showSubscription(undefined, onBack), 900);
  };
  const plan = (id: 'personal' | 'school') => {
    const p = BILLING.plans[id];
    return h('div', { class: 'plan' },
      h('h3', {}, p.title),
      h('p', { class: 'price' }, `${rub(p.price)} в месяц`),
      h('p', { class: 'disclaimer' }, p.note),
      buyLink(id, onBack),
    );
  };
  openModal(
    h('div', { class: 'doc subscription' },
      h('h2', {}, reason ?? 'Подписка'),
      l
        ? h('p', {}, `Подписка «${l.plan === 'school' ? 'Автошкола' : 'Личная'}»${l.name ? ` — ${l.name}` : ''}, действует по ${formatDate(l.until)} включительно.`)
        : h('p', {}, `Без подписки доступны ${FREE_MODELS} разных моделей: расстановка участников и объектов. Перемещать их, менять скорости и траектории можно сколько угодно. Использовано: ${Math.min(trial.used.length, FREE_MODELS)} из ${FREE_MODELS}. Редактор, примеры и справочник открыты всегда.`),
      h('div', { class: 'plans' }, plan('personal'), plan('school')),
      h('p', { class: 'disclaimer' }, `Подписка действует 30 дней без автоматического продления. Код активации отправляется на почту после подтверждения оплаты. Вопросы — ${BILLING.contact}. Условия — в «Оферте на подписку» (меню → О программе).`),
      h('h3', {}, 'Код активации'),
      input,
      msg,
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn', onclick: onBack ?? closeModal }, onBack ? 'В кабинет' : 'Закрыть'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { void activate(); } }, 'Активировать'),
      ),
    ),
  );
}
