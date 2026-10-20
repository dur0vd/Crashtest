import { describe, expect, it } from 'vitest';
import { addRoundaboutTemplate } from '../src/editor';
import { emptyScene, normalizeScene } from '../src/scene';
import { buildGeo } from '../src/geo';

describe('шаблон кольца из редактора', () => {
  it('создаёт замкнутую одностороннюю дорогу, четыре въезда и знаки 4.3', () => {
    const scene = emptyScene();
    const ringId = addRoundaboutTemplate(scene, { x: 100, y: -80 });
    const ring = scene.roads.find(r => r.id === ringId)!;
    expect(ring.role).toBe('roundabout');
    expect(ring.oneWay).toBe(true);
    expect(ring.pts.at(-1)!.x).toBeCloseTo(ring.pts[0].x, 8);
    expect(ring.pts.at(-1)!.y).toBeCloseTo(ring.pts[0].y, 8);
    expect(scene.roads.filter(r => r.id !== ringId)).toHaveLength(4);
    expect(scene.signs.map(s => s.kind)).toEqual(['4.3', '4.3', '4.3', '4.3']);
    expect(buildGeo(normalizeScene(JSON.parse(JSON.stringify(scene)))) .intersections.some(i => i.roundabout)).toBe(true);
  });

  it('повторное добавление не дублирует идентификаторы объектов', () => {
    const scene = emptyScene();
    addRoundaboutTemplate(scene, { x: 0, y: 0 });
    addRoundaboutTemplate(scene, { x: 200, y: 0 });
    expect(new Set(scene.roads.map(r => r.id)).size).toBe(10);
    expect(new Set(scene.signs.map(s => s.id)).size).toBe(8);
  });
});
