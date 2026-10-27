import { normalizeScene, type Scene } from './scene';

/** Хост клиента: сеть и хранилище подменяются в тестах, DOM не нужен. */
export interface CloudHost {
  fetch: typeof fetch;
  /** Адрес API; пустая строка — тот же origin. */
  baseUrl: string;
  load(): CloudSession | null;
  store(s: CloudSession | null): void;
}

export interface CloudSession { token: string; email: string; sceneId?: string; updatedAt?: number }
export interface CloudItem { id: string; name: string; updatedAt: number }

export class CloudError extends Error {
  constructor(readonly status: number, message: string, readonly remote?: { scene: Scene; updatedAt: number }) { super(message); }
}

export class Cloud {
  constructor(private host: CloudHost) {}

  get session(): CloudSession | null { return this.host.load(); }

  private async call(method: string, path: string, body?: unknown, auth = true): Promise<any> {
    const s = this.host.load();
    if (auth && !s) throw new CloudError(401, 'Нужен вход');
    let res: Response;
    try {
      res = await this.host.fetch(this.host.baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', ...(auth && s ? { authorization: `Bearer ${s.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CloudError(0, 'Нет связи с сервером');
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && auth) this.host.store(null);
    if (!res.ok) {
      throw new CloudError(res.status, json.error ?? 'Ошибка сервера', res.status === 409 ? { scene: normalizeScene(json.scene), updatedAt: json.updatedAt } : undefined);
    }
    return json;
  }

  requestCode(email: string): Promise<void> {
    return this.call('POST', '/api/auth/request', { email }, false);
  }

  async verify(email: string, code: string): Promise<void> {
    const r = await this.call('POST', '/api/auth/verify', { email, code }, false);
    this.host.store({ token: r.token, email: r.email });
  }

  async logout(): Promise<void> {
    try { await this.call('POST', '/api/auth/logout'); } catch { /* выходим локально в любом случае */ }
    this.host.store(null);
  }

  async deleteAccount(): Promise<void> {
    await this.call('DELETE', '/api/account');
    this.host.store(null);
  }

  async list(): Promise<CloudItem[]> {
    return (await this.call('GET', '/api/scenes')).scenes;
  }

  async open(id: string): Promise<Scene> {
    const r = await this.call('GET', `/api/scenes/${id}`);
    this.link(id, r.updatedAt);
    return normalizeScene(r.scene);
  }

  /** Создаёт сцену либо обновляет ту, что открыта из облака; при конфликте бросает CloudError(409). */
  async save(scene: Scene): Promise<void> {
    const s = this.host.load();
    if (s?.sceneId && s.updatedAt !== undefined) {
      try {
        const r = await this.call('PUT', `/api/scenes/${s.sceneId}`, { scene, baseUpdatedAt: s.updatedAt });
        this.link(s.sceneId, r.updatedAt);
        return;
      } catch (e) {
        if (!(e instanceof CloudError) || e.status !== 404) throw e;
        // сцену удалили на другом устройстве — сохраняем заново
      }
    }
    const r = await this.call('POST', '/api/scenes', { scene });
    this.link(r.id, r.updatedAt);
  }

  async remove(id: string): Promise<void> {
    await this.call('DELETE', `/api/scenes/${id}`);
    const s = this.host.load();
    if (s?.sceneId === id) this.host.store({ token: s.token, email: s.email });
  }

  /** После «Новой ситуации» или открытия файла связь с облачной записью разрывается. */
  unlink(): void {
    const s = this.host.load();
    if (s?.sceneId) this.host.store({ token: s.token, email: s.email });
  }

  private link(sceneId: string, updatedAt: number): void {
    const s = this.host.load();
    if (s) this.host.store({ ...s, sceneId, updatedAt });
  }
}
