import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { buildGeo, classifyIntersectionMovement, intersectionAt, roadsAt } from '../src/geo';
import { emptyScene, type Actor, type Road } from '../src/scene';
import { simulate } from '../src/sim';

const road = (id: string, pts: Road['pts']): Road => ({
  id, pts, lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false,
});

function outerTurn(corner: number, type: 'adult' | 'bicycle') {
  const scene = emptyScene();
  scene.env.accidentDate = '2026-10-20T12:00';
  scene.env.duration = 16;
  scene.roads = [road('h', [{ x: -80, y: 0 }, { x: 80, y: 0 }]),
    road('v', [{ x: 0, y: -80 }, { x: 0, y: 80 }])];
  const vehicle: Actor = { id: 'turning', kind: 'vehicle', type: 'car', x: -30, y: 1.75,
    heading: 0, speed: 18, delay: 0, color: '#2288dd', flags: { drunk: false, noLicense: false, flees: false },
    path: [{ x: -corner, y: 1.75, v: 18 }, { x: -1.75, y: corner, v: 18 }, { x: -1.75, y: 40, v: 18 }] };
  scene.actors = [vehicle, { id: 'crossing', kind: type === 'adult' ? 'pedestrian' : 'vehicle', type,
    x: type === 'adult' ? -4 : -20, y: 10, heading: 0, speed: type === 'adult' ? 5 : 18,
    delay: type === 'adult' ? 5.2 : 3.2, color: '#dd8822', flags: { drunk: false, noLicense: false, flees: false },
    path: [{ x: 30, y: 10, v: type === 'adult' ? 5 : 18 }] }];
  return scene;
}

describe('13.1 при наружном повороте за оценочным контуром', () => {
  it.each([[6, 'adult'], [6, 'bicycle'], [8, 'adult'], [8, 'bicycle']] as const)(
    'поворот с угловой точкой %s м уступает %s на выездной дороге', (corner, type) => {
      const scene = outerTurn(corner, type);
      const geo = buildGeo(scene);
      const movement = classifyIntersectionMovement(geo, scene.actors[0], geo.intersections[0]);
      expect(movement).toMatchObject({ maneuver: 'right', entryRoadId: 'h', exitRoadId: 'v' });
      if (corner === 8) expect(movement.routeSource).toBe('nearby-road-transition');
      const timeline = simulate(scene);
      expect(timeline.collisions).toHaveLength(1);
      const contact = timeline.collisions[0];
      expect(intersectionAt(geo, contact.point)).toBeUndefined();
      expect(roadsAt(geo, contact.point).some(hit => hit.rg.road.id === 'v')).toBe(true);
      const report = analyze(scene, timeline);
      expect(report.rules.findings.some(f => f.actorId === 'turning' && f.severity === 'violation'
        && f.causal && f.refs.includes('pdd:13.1'))).toBe(true);
    },
  );
});
