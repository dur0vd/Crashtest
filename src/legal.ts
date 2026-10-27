// Юридические тексты в приложении: вступительное окно, «О программе» и документы из docs/legal.
// Тексты встроены при сборке (?raw), поэтому открываются офлайн. Всё выводится через text-узлы, без innerHTML.

import pkg from '../package.json';
import privacy from '../docs/legal/privacy.md?raw';
import terms from '../docs/legal/terms.md?raw';
import pilot from '../docs/legal/pilot-agreement.md?raw';
import offer from '../docs/legal/subscription-offer.md?raw';
import thirdParty from '../docs/legal/third-party.md?raw';
import licenseText from '../LICENSE?raw';
import { DISCLAIMER, LAW_CHECKED } from './law';
import { closeModal, h, openModal } from './ui';

/** Версия вступительного текста. Поднимайте её при изменении текста, чтобы окно показалось снова. */
export const INTRO_VERSION = '2';
const INTRO_KEY = 'crashtest.intro';

const DOCS: { title: string; text: string }[] = [
  { title: 'Пользовательское соглашение', text: terms },
  { title: 'Оферта на подписку', text: offer },
  { title: 'Политика конфиденциальности', text: privacy },
  { title: 'Соглашение о пилотном тестировании (шаблон для автошкол)', text: pilot },
  { title: 'Источники и лицензии', text: thirdParty },
  { title: 'Лицензия на программное обеспечение', text: licenseText },
];

const introAccepted = (): boolean => {
  try {
    return localStorage.getItem(INTRO_KEY) === INTRO_VERSION;
  } catch {
    return false;
  }
};

/** Минимальный разбор markdown для документов: заголовки, цитаты, списки, таблицы, абзацы и **полужирный**. */
export function renderMarkdown(src: string): HTMLElement {
  const root = h('div', { class: 'md' });
  let para: string[] = [];
  let list: HTMLElement | null = null;
  let table: HTMLElement | null = null;

  const flush = () => {
    if (para.length) root.append(h('p', {}, ...inline(para.join(' '))));
    para = [];
  };
  const endBlock = () => {
    flush();
    list = null;
    table = null;
  };

  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t) {
      endBlock();
    } else if (t.startsWith('|')) {
      if (/^\|[-| :]+\|$/.test(t)) continue;
      const cells = t.slice(1, -1).split('|').map((c) => c.trim());
      if (!table) {
        endBlock();
        table = h('table', { class: 'md-table' }, h('tr', {}, ...cells.map((c) => h('th', {}, ...inline(c)))));
        root.append(table);
      } else {
        table.append(h('tr', {}, ...cells.map((c) => h('td', {}, ...inline(c)))));
      }
    } else if (t.startsWith('- ')) {
      flush();
      table = null;
      if (!list) {
        list = h('ul', {});
        root.append(list);
      }
      list.append(h('li', {}, ...inline(t.slice(2))));
    } else if (t.startsWith('## ')) {
      endBlock();
      root.append(h('h3', {}, ...inline(t.slice(3))));
    } else if (t.startsWith('# ')) {
      endBlock();
      root.append(h('h2', {}, ...inline(t.slice(2))));
    } else if (t.startsWith('> ')) {
      endBlock();
      root.append(h('p', { class: 'disclaimer' }, ...inline(t.slice(2))));
    } else {
      list = null;
      table = null;
      para.push(t);
    }
  }
  endBlock();
  return root;
}

function inline(text: string): (string | HTMLElement)[] {
  return text.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? h('b', {}, part) : part)).filter((p) => p !== '');
}

function showDoc(title: string, text: string): void {
  openModal(
    h('div', { class: 'doc' },
      h('button', { type: 'button', class: 'btn', onclick: showAbout }, '← О программе'),
      h('h2', {}, title),
      renderMarkdown(text.replace(/^# .*\n/, '')),
    ),
  );
}

/** Первый запуск: учебный характер и ограничения. Согласие сохраняется с версией текста. */
export function showIntroIfNeeded(): void {
  if (introAccepted()) return;
  const accept = () => {
    try {
      localStorage.setItem(INTRO_KEY, INTRO_VERSION);
    } catch {
      /* хранилище недоступно: окно появится снова при следующем запуске */
    }
    closeModal();
  };
  openModal(
    h('div', { class: 'doc intro' },
      h('h2', {}, 'Crashtest — учебная модель'),
      h('p', {}, 'Наглядное пособие к разделам ПДД о дорожно-транспортных происшествиях и ответственности.'),
      h('p', {}, 'Приложение не является экспертизой, решением ГИБДД или суда и не заменяет юридическую консультацию. Оно не определяет виновника ДТП и не предназначено для подготовки к экзамену.'),
      h('p', {}, 'Разбор строится на упрощённой физике и правилах, поэтому результат может отличаться от экспертной оценки.'),
      h('p', { class: 'disclaimer' }, `Нормы права сверены: ${LAW_CHECKED}. Проверяйте действующую редакцию на официальном портале pravo.gov.ru.`),
      h('p', { class: 'disclaimer' }, 'Персональные данные приложение не собирает: ситуации хранятся только на вашем устройстве.'),
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn', onclick: showAbout }, 'Подробнее'),
        h('button', { type: 'button', class: 'btn primary', onclick: accept }, 'Понятно'),
      ),
    ),
  );
}

/** «О программе»: версия, учебный характер, документы и источники. */
export function showAbout(): void {
  openModal(
    h('div', { class: 'doc about' },
      h('h2', {}, 'О программе'),
      h('p', {}, `Crashtest, версия ${pkg.version}. Учебная модель, не экспертиза.`),
      h('p', { class: 'disclaimer' }, DISCLAIMER),
      h('p', { class: 'disclaimer' }, `Нормы права сверены: ${LAW_CHECKED}.`),
      h('h3', {}, 'Документы'),
      h('ul', { class: 'docs' },
        ...DOCS.map((d) => h('li', {}, h('button', { type: 'button', class: 'linkbtn', onclick: () => showDoc(d.title, d.text) }, d.title))),
      ),
    ),
  );
}
