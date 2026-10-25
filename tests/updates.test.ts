import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { encodeShare, sceneFromHash } from '../src/share';
import { normalizeScene } from '../src/scene';
import { reloadOnWorkerUpdate } from '../src/updates';

function workers(initial: object | null) {
  let listener = () => {};
  return {
    controller: initial,
    addEventListener(_type: 'controllerchange', fn: () => void) { listener = fn; },
    change(controller: object | null) { this.controller = controller; listener(); },
  };
}

describe('обновление открытой вкладки', () => {
  it('пропускает первый controller и сохраняет последующие правки перед единственной перезагрузкой', () => {
    const service = workers(null);
    const scene = PRESETS[0].build();
    const order: string[] = [];
    let hash = `#s=${encodeShare(PRESETS[0].build())}`;
    let saved = '';
    reloadOnWorkerUpdate({
      workers: service, scene: () => scene,
      save: value => { saved = value; order.push('save'); },
      replaceHash: value => { hash = value; order.push('hash'); },
      reload: () => { order.push('reload'); },
    });
    service.change({});
    expect(order).toEqual([]);
    scene.name = 'Последние правки до срабатывания таймера автосохранения';
    scene.actors[0].speed += 7;
    service.change({});
    expect(order).toEqual(['save', 'hash', 'reload']);
    expect(JSON.parse(saved)).toEqual(scene);
    expect(sceneFromHash(hash)).toEqual(normalizeScene(scene));
    service.change({});
    expect(order).toEqual(['save', 'hash', 'reload']);
  });

  it('обновляет уже контролируемую вкладку и сохраняет сцену в ссылке при недоступном хранилище', () => {
    const service = workers({});
    const scene = PRESETS[0].build();
    let hash = '';
    let reloads = 0;
    reloadOnWorkerUpdate({
      workers: service, scene: () => scene,
      save: () => { throw new Error('Хранилище недоступно'); },
      replaceHash: value => { hash = value; },
      reload: () => { reloads++; },
    });
    service.change(null);
    expect(reloads).toBe(0);
    service.change({});
    expect(reloads).toBe(1);
    expect(sceneFromHash(hash)).toEqual(normalizeScene(scene));
  });

  it('не перезагружает вкладку, если старая ссылка не заменена актуальной сценой', () => {
    const service = workers({});
    let reloads = 0;
    reloadOnWorkerUpdate({
      workers: service, scene: () => PRESETS[0].build(),
      save: () => {},
      replaceHash: () => { throw new Error('Не удалось изменить адрес'); },
      reload: () => { reloads++; },
    });
    service.change({});
    expect(reloads).toBe(0);
  });
});
