import { describe, expect, it } from 'vitest';
import { emptyScene, type Actor } from '../src/scene';
import { simulate } from '../src/sim';
import { analyze } from '../src/analysis';

function scene() {
  const s = emptyScene();
  s.env.duration = 2;
  s.roads = [{ id: 'r1', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 2, center: 'dashed', oneWay: false, zone: 'city', smooth: false }];
  const actor: Actor = { id: 'parked', kind: 'vehicle', type: 'car', x: 0, y: 6, heading: 0, speed: 0, color: '#fff', delay: 0, path: [], parking: true, flags: { drunk: false, noLicense: false, flees: false } };
  s.actors = [actor];
  return s;
}
const report = (s: ReturnType<typeof scene>) => analyze(s, simulate(s));

describe('геометрия запретов остановки', () => {
  it('противоположная сторона Т-перекрёстка разрешена только при сплошной', () => {
    const s = scene();
    s.roads.push({ ...s.roads[0], id: 'r2', lanes: 1, pts: [{ x: 0, y: -100 }, { x: 0, y: 0 }] });
    expect(report(s).findings.filter((f) => /перекрёстке/.test(f.title))).toHaveLength(1);
    s.roads[0].center = 'solid';
    expect(report(s).findings.filter((f) => /перекрёстке/.test(f.title))).toHaveLength(0);
  });
  it.each(['1.17.1', '1.17.2'])('разметка %s задаёт остановку без указателя', (kind) => {
    const s = scene();
    s.markings = [{ id: 'm1', kind, pts: [{ x: -10, y: 6.6 }, { x: 10, y: 6.6 }], smooth: false }];
    s.actors[0].x = 20;
    const finding = report(s).findings.filter((f) => f.refs.includes('koap:12.19.3.1'));
    expect(finding).toHaveLength(1);
    expect(finding[0].refs).toContain(`marking:${kind}`);
    s.actors[0].x = 30;
    expect(report(s).findings.filter((f) => f.refs.includes('koap:12.19.3.1'))).toHaveLength(0);
  });
  it('при наличии разметки отсчёт ведётся от неё и не переносится на указатель', () => {
    const s = scene();
    s.markings = [{ id: 'm1', kind: '1.17.1', pts: [{ x: -40, y: 6.6 }, { x: -30, y: 6.6 }] }];
    s.signs = [{ id: 'g1', kind: '5.16', x: 0, y: 7.5, angle: 0 }];
    s.actors[0].x = 10;
    expect(report(s).findings.filter((f) => f.refs.includes('koap:12.19.3.1'))).toHaveLength(0);
  });
  it('разметка остановки на другой стороне дороги не запрещает остановку здесь', () => {
    const s = scene();
    s.markings = [{ id: 'm1', kind: '1.17.1', pts: [{ x: -10, y: -6.6 }, { x: 10, y: -6.6 }] }];
    expect(report(s).findings.filter((f) => f.refs.includes('koap:12.19.3.1'))).toHaveLength(0);
  });
});
