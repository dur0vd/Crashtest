import type { Ctx, Info } from './analysis';
import type { Kit } from './restrictions';
import { roadsAt } from './geo';
import type { Actor, Scene } from './scene';
import { DT } from './sim';

/** Упрощённая видимость: атмосфера, освещение дороги и дальность света фар. */
export function visibilityDistance(scene: Scene, actor: Actor, x: number, y: number, lit = false): number {
  const weather = Math.max(1, scene.env.visibility ?? 1000);
  const time = scene.env.timeOfDay ?? 'day';
  if (time === 'day') return weather;
  // Координаты оставлены явными в интерфейсе для будущих локальных условий.
  void x; void y;
  if (lit) return Math.min(weather, 150);
  const light = actor.headlights ?? 'low';
  return Math.min(weather, light === 'high' ? 120 : light === 'low' ? 55 : 5);
}

export function visibilityAt(ctx: Ctx, i: Info, k: number): number {
  const x = i.tr.x[k];
  const y = i.tr.y[k];
  const lit = roadsAt(ctx.geo, { x, y }).some((hit) => hit.rg.road.lit);
  return visibilityDistance(ctx.scene, i.a, x, y, lit);
}

export function checkVisibilityRules(ctx: Ctx, kit: Kit): void {
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || String(i.a.type) === 'train') continue;
    let bad: { k: number; range: number; stop: number } | null = null;
    let lights = -1;
    for (let k = i.k0; k <= i.kEnd; k += 4) {
      if (!i.tr.present[k] || i.tr.v[k] < 0.1) continue;
      const v = i.tr.v[k];
      const range = visibilityAt(ctx, i, k);
      const stop = v * 1.2 + v * v / (2 * i.brake);
      if (stop > range + 0.1 && (!bad || stop - range > bad.stop - bad.range)) bad = { k, range, stop };
      if ((ctx.scene.env.timeOfDay === 'night' || ctx.scene.env.timeOfDay === 'twilight' || (ctx.scene.env.visibility ?? 1000) < 300) && i.a.headlights === 'off') lights = lights < 0 ? k : lights;
    }
    if (bad) kit.add({
      actorId: i.a.id, severity: 'violation', t: bad.k * DT,
      title: 'скорость не обеспечивает остановку в пределах видимости',
      detail: `Видимость ${bad.range.toFixed(0)} м, остановочный путь ${bad.stop.toFixed(0)} м с реакцией и запаздыванием тормозов. Дальность ближнего/дальнего света принята 55/120 м; это учебное допущение.`,
      refs: ['pdd:10.1'],
    });
    if (lights >= 0) kit.add({
      actorId: i.a.id, severity: 'violation', t: lights * DT,
      title: 'движение без фар в тёмное время или при недостаточной видимости',
      detail: 'Включение фар требуется независимо от освещённости дороги. В модели «сумерки» относятся к недостаточной видимости.',
      refs: ['pdd:19.1', 'koap:12.20'],
    });
  }
}
