import './account.css';
import { Cloud, CloudError, type CloudItem } from './cloud';
import { closeModal, h, openModal } from './ui';
import type { Scene } from './scene';

/** Действия редактора, которые кабинет не должен выполнять самостоятельно. */
export interface AccountActions {
  login: () => void;
  save: () => Promise<string>;
  open: (scene: Scene) => void;
  subscription: () => void;
  billingStatus: () => string;
  sessionChanged: () => void;
}

const errorText = (error: unknown): string => error instanceof CloudError ? error.message : 'Не удалось выполнить действие';
const plural = (n: number): string => n % 10 === 1 && n % 100 !== 11 ? 'ситуация' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'ситуации' : 'ситуаций';
const button = (label: string, action: () => void, extra = ''): HTMLButtonElement => h('button', { type: 'button', class: `btn ${extra}`, onclick: action }, label);

/** Кабинет показывает только сведения, реально доступные на устройстве и в облаке. */
export function showAccount(cloud: Cloud, actions: AccountActions, notice = ''): void {
  const session = cloud.session;
  const status = h('p', { class: 'account-status', role: 'status', 'aria-live': 'polite' });
  status.textContent = notice;
  const list = h('div', { class: 'account-scenes' });
  const count = h('span', { class: 'account-count' });
  let busy = false;
  const section = h('section', { class: 'account-section' },
    h('div', { class: 'account-section-head' }, h('div', {}, h('h3', {}, 'Ситуации в облаке'), h('p', {}, 'Открывайте свои работы на разных устройствах.')), count),
    list);
  const identity = session
    ? h('div', { class: 'account-identity' }, h('div', { class: 'account-avatar', 'aria-hidden': 'true' }, session.email.charAt(0).toUpperCase()), h('div', {}, h('span', { class: 'account-overline' }, 'ВЫ ВОШЛИ КАК'), h('strong', {}, session.email), h('p', {}, 'Сохраняйте ситуации в облако, чтобы открывать их на других устройствах.')))
    : h('div', { class: 'account-identity' }, h('div', { class: 'account-avatar', 'aria-hidden': 'true' }, '↗'), h('div', {}, h('span', { class: 'account-overline' }, 'АККАУНТ'), h('strong', {}, 'Вход не выполнен'), h('p', {}, 'Текущая ситуация сохраняется на устройстве. Войдите, чтобы сохранять работы в облако.')));
  const account = h('div', { class: 'account doc' },
    h('div', { class: 'account-header' }, h('span', { class: 'account-overline' }, 'CRASHTEST'), h('h2', {}, 'Личный кабинет'), h('p', {}, 'Ваши ситуации и подписка в одном месте.')),
    identity,
    !session ? h('div', { class: 'account-login' }, button('Войти по почте', actions.login, 'primary'), h('span', {}, 'Редактор работает и без входа.')) : null,
    h('div', { class: 'account-billing' }, h('div', {}, h('h3', {}, 'Подписка и доступ'), h('strong', {}, actions.billingStatus()), h('p', {}, 'Код подписки и пробный доступ хранятся на этом устройстве.')), button('Тарифы и активация', actions.subscription)),
    session ? section : null,
    status,
    session ? h('div', { class: 'account-footer' }, button('Выйти', () => { void logout(); }), button('Удалить аккаунт', () => { void deleteAccount(); }, 'account-delete')) : null);
  openModal(account);
  if (session) void refresh();

  async function refresh(): Promise<void> {
    list.replaceChildren(h('p', { class: 'account-list-message' }, 'Загружаем ситуации…'));
    status.textContent = '';
    try {
      const items = await cloud.list();
      if (!account.isConnected) return;
      count.textContent = `${items.length} ${plural(items.length)}`;
      if (!items.length) {
        list.replaceChildren(h('div', { class: 'account-empty' }, h('strong', {}, 'Пока здесь пусто'), h('p', {}, 'Сохраните текущую ситуацию, чтобы она появилась в кабинете.'), button('Сохранить текущую ситуацию', () => { void save(); }, 'primary')));
      } else {
        list.replaceChildren(...items.map(sceneRow), h('div', { class: 'account-list-actions' }, button('Сохранить текущую ситуацию', () => { void save(); })));
      }
    } catch (error) {
      if (!account.isConnected) return;
      if (!cloud.session) {
        actions.sessionChanged();
        showAccount(cloud, actions, 'Сессия завершилась. Войдите снова.');
        return;
      }
      count.textContent = '';
      list.replaceChildren(h('div', { class: 'account-empty' }, h('p', {}, errorText(error)), button('Попробовать ещё раз', () => { void refresh(); })));
    }
  }
  function sceneRow(item: CloudItem): HTMLElement {
    const date = new Date(item.updatedAt);
    const dateText = Number.isNaN(date.getTime()) ? '' : `Изменена ${date.toLocaleDateString('ru-RU')}`;
    const open = button('Открыть', () => { void openScene(); }, 'primary');
    const remove = button('Удалить', () => { void removeScene(); }, 'account-row-delete');
    async function openScene(): Promise<void> {
      if (busy) return;
      busy = true;
      open.disabled = true;
      status.textContent = '';
      try { const scene = await cloud.openIf(item.id, () => account.isConnected); if (scene) { actions.open(scene); closeModal(); } }
      catch (error) { status.textContent = errorText(error); if (!cloud.session) actions.sessionChanged(); }
      finally { busy = false; open.disabled = false; }
    }
    async function removeScene(): Promise<void> {
      if (!window.confirm(`Удалить из облака ситуацию «${item.name || 'Без названия'}»?`)) return;
      remove.disabled = true;
      try { await cloud.remove(item.id); await refresh(); }
      catch (error) { status.textContent = errorText(error); if (!cloud.session) actions.sessionChanged(); }
      finally { remove.disabled = false; }
    }
    return h('div', { class: 'account-scene' }, h('div', { class: 'account-scene-mark', 'aria-hidden': 'true' }, '↗'), h('div', { class: 'account-scene-title' }, h('strong', {}, item.name || 'Без названия'), h('span', {}, dateText)), h('div', { class: 'account-scene-actions' }, open, remove));
  }
  async function save(): Promise<void> {
    if (busy) return;
    busy = true;
    status.textContent = 'Сохраняем…';
    try {
      const message = await actions.save();
      if (account.isConnected) { await refresh(); status.textContent = message; }
    } finally { busy = false; }
  }
  async function logout(): Promise<void> {
    await cloud.logout();
    actions.sessionChanged();
    showAccount(cloud, actions);
  }
  async function deleteAccount(): Promise<void> {
    if (!window.confirm('Удалить аккаунт и все ситуации на сервере? Это действие необратимо.')) return;
    try { await cloud.deleteAccount(); actions.sessionChanged(); showAccount(cloud, actions); }
    catch (error) { status.textContent = errorText(error); if (!cloud.session) actions.sessionChanged(); }
  }
}
