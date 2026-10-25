import type { Scene } from './scene';
import { encodeShare } from './share';

interface WorkerChanges {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

interface UpdateHost {
  workers: WorkerChanges;
  scene(): Scene;
  save(serialized: string): void;
  replaceHash(hash: string): void;
  reload(): void;
}

/** После обновления открытая вкладка должна использовать чанки установленной версии. */
export function reloadOnWorkerUpdate(host: UpdateHost): void {
  let controlled = !!host.workers.controller;
  let reloading = false;
  host.workers.addEventListener('controllerchange', () => {
    if (!host.workers.controller || reloading) return;
    if (!controlled) {
      // Первая установка не прерывает работу и не вызывает лишнюю загрузку.
      controlled = true;
      return;
    }
    try {
      const scene = host.scene();
      const serialized = JSON.stringify(scene);
      const hash = `#s=${encodeShare(scene)}`;
      try { host.save(serialized); } catch { /* Сцена останется в обновлённой ссылке. */ }
      // Старый #s= при запуске имеет приоритет над localStorage: заменяем его
      // актуальной сценой до перезагрузки, включая последние правки редактора.
      host.replaceHash(hash);
    } catch {
      // Если сохранить ссылку не удалось, не рискуем потерять правки вкладки.
      return;
    }
    reloading = true;
    host.reload();
  });
}
