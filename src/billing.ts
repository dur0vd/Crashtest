// Подписка в интерфейсе: пробный режим, окно тарифов и ввод кода активации.
// Логика проверки — в license.ts; здесь хранение на устройстве и окна.

import keys from './license-keys.json';
import { FREE_MODELS, type License, type TrialState, canRun, formatDate, markRun, modelKey, todayIso, verifyCode } from './license';
import type { Scene } from './scene';
import { closeModal, h, openModal } from './ui';

/** Цены и способы оплаты. Ссылку на оплату вставьте сюда, когда подключите платёжный сервис. */
export const BILLING = {
  contact: 'mr.cartest@mail.ru',
  plans: {
    personal: { title: 'Личная подписка', price: 199, note: 'для одного ученика на его устройствах' },
    school: { title: 'Автошкола', price: 3990, note: 'для преподавателей и всех учеников школы' },
  },
  /** Ссылки на оплату по тарифам; пустая строка — оплата по запросу на почту. */
  payUrl: { personal: '', school: '' },
} as const;

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
}

export function activeLicense(): License | null {
  return license && license.until >= todayIso() ? license : null;
}

/** Короткая строка состояния для меню. */
export function billingStatus(): string {
  const l = activeLicense();
  if (l) return `${l.plan === 'school' ? 'автошкола' : 'подписка'} до ${formatDate(l.until)}`;
  return `пробный режим: ${Math.min(trial.used.length, FREE_MODELS)} из ${FREE_MODELS} моделей`;
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

function buyLink(plan: 'personal' | 'school'): HTMLElement {
  const p = BILLING.plans[plan];
  const url = BILLING.payUrl[plan];
  if (url) return h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, 'Оплатить');
  const subject = encodeURIComponent(`Подписка Crashtest: ${p.title}`);
  const body = encodeURIComponent(plan === 'school'
    ? 'Здравствуйте! Хотим оформить подписку для автошколы на месяц.\nНазвание автошколы:\nИНН (для счёта):\n'
    : 'Здравствуйте! Хочу оформить личную подписку на месяц.\nИмя (будет указано в коде):\n');
  return h('a', { class: 'btn primary', href: `mailto:${BILLING.contact}?subject=${subject}&body=${body}` }, 'Запросить оплату');
}

/** Окно подписки: состояние, тарифы, ввод кода. */
export function showSubscription(reason?: string): void {
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
    setTimeout(() => showSubscription(), 900);
  };
  const plan = (id: 'personal' | 'school') => {
    const p = BILLING.plans[id];
    return h('div', { class: 'plan' },
      h('h3', {}, p.title),
      h('p', { class: 'price' }, `${rub(p.price)} в месяц`),
      h('p', { class: 'disclaimer' }, p.note),
      buyLink(id),
    );
  };
  openModal(
    h('div', { class: 'doc subscription' },
      h('h2', {}, reason ?? 'Подписка'),
      l
        ? h('p', {}, `Подписка «${l.plan === 'school' ? 'Автошкола' : 'Личная'}»${l.name ? ` — ${l.name}` : ''}, действует по ${formatDate(l.until)} включительно.`)
        : h('p', {}, `Без подписки доступны ${FREE_MODELS} разных моделей: расстановка участников и объектов. Перемещать их, менять скорости и траектории можно сколько угодно. Использовано: ${Math.min(trial.used.length, FREE_MODELS)} из ${FREE_MODELS}. Редактор, примеры и справочник открыты всегда.`),
      h('div', { class: 'plans' }, plan('personal'), plan('school')),
      h('p', { class: 'disclaimer' }, `Подписка на 30 дней без автоматического продления. После оплаты вы получите код активации на почту. Вопросы — ${BILLING.contact}. Условия — в «Оферте на подписку» (меню → О программе).`),
      h('h3', {}, 'Код активации'),
      input,
      msg,
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn', onclick: closeModal }, 'Закрыть'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { void activate(); } }, 'Активировать'),
      ),
    ),
  );
}
