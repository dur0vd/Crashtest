import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { PRESETS } from '../src/presets';
import { hasEmergencySignals, normalizeScene } from '../src/scene';
import { simulate } from '../src/sim';

const scene = () => PRESETS.find((p) => p.id === 'ambulance-red')!.build();
describe('спецтранспорт с синим маячком и сиреной', () => {
  it('на зелёный всё равно уступают скорой, а её отступление требует безопасности', () => {
    const s = scene();
    const report = analyze(s, simulate(s));
    expect(report.collisions.length).toBeGreaterThan(0);
    const other = report.findings.filter((f) => f.actorId === s.actors[1].id && f.severity === 'violation');
    expect(other.flatMap((f) => f.refs)).toContain('koap:12.17.2');
    const ambulance = report.findings.filter((f) => f.actorId === s.actors[0].id && f.severity === 'violation');
    expect(ambulance.flatMap((f) => f.refs)).not.toContain('koap:12.12.1');
    expect(ambulance.some((f) => f.refs.includes('pdd:3.1') && f.causal)).toBe(true);
  });
  it('вне перекрёстка не называет пересечение траекторий перекрёстком', () => {
    const s = scene();
    s.roads = [];
    const report = analyze(s, simulate(s));
    expect(report.collisions[0].title).toBe('Столкновение со спецтранспортом');
    expect(report.findings.some((f) => f.actorId === s.actors[1].id && f.refs.includes('koap:12.17.2'))).toBe(true);
  });
  it('без конфликтующего транспорта проезд на красный не становится нарушением', () => {
    const s = scene();
    s.actors.splice(1);
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.refs.includes('pdd:3.1') && f.severity === 'info')).toBe(true);
    expect(report.findings.filter((f) => f.severity === 'violation')).toHaveLength(0);
  });
  it('выключенные спецсигналы возвращают обычные требования светофора', () => {
    const s = scene();
    s.actors[0].emergency = false;
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.actorId === s.actors[0].id && f.refs.includes('koap:12.12.1'))).toBe(true);
    expect(report.findings.some((f) => f.refs.includes('koap:12.17.2'))).toBe(false);
  });
  it('флаг не даёт преимуществ пешеходу или произвольному типу ТС', () => {
    const s = scene();
    s.actors[0].type = 'bicycle';
    expect(hasEmergencySignals(s.actors[0])).toBe(false);
    expect(normalizeScene(s).actors[0].emergency).toBe(false);
  });
  it('у старых сцен спецсигналы по умолчанию выключены', () => {
    const s = scene();
    delete s.actors[0].emergency;
    expect(normalizeScene(s).actors[0].emergency).toBe(false);
  });
});


describe('пешеход перед спецтранспортом', () => {
  const crossing = () => {
    const s = PRESETS.find((p) => p.id === 'crosswalk')!.build();
    s.actors[0].emergency = true;
    return s;
  };
  it('пешеход обязан воздержаться от перехода, а скорая — обеспечить безопасность', () => {
    const s = crossing();
    const report = analyze(s, simulate(s));
    const pedestrian = report.findings.filter((f) => f.actorId === s.actors[1].id);
    const driver = report.findings.filter((f) => f.actorId === s.actors[0].id);
    expect(pedestrian.filter((f) => f.refs.includes('pdd:4.7') && f.severity === 'violation' && f.causal)).toHaveLength(1);
    expect(driver.some((f) => f.refs.includes('pdd:14.1'))).toBe(false);
    expect(driver.some((f) => f.refs.includes('koap:12.18'))).toBe(false);
    expect(driver.some((f) => f.refs.includes('pdd:3.1') && f.severity === 'violation' && f.causal)).toBe(true);
  });
  it('переход, начатый до появления скорой, не становится нарушением автоматически', () => {
    const s = crossing();
    s.actors[0].delay = 1;
    s.actors[0].x = -40;
    const report = analyze(s, simulate(s));
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.actorId === s.actors[1].id && f.refs.includes('pdd:4.7') && f.severity === 'violation')).toBe(false);
    expect(report.findings.some((f) => f.actorId === s.actors[1].id && f.refs.includes('pdd:4.7') && f.severity === 'info')).toBe(true);
  });
  it('при выключенных спецсигналах действует обычное преимущество пешехода', () => {
    const s = crossing();
    s.actors[0].emergency = false;
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.refs.includes('pdd:4.7'))).toBe(false);
    expect(report.findings.some((f) => f.actorId === s.actors[0].id && f.refs.includes('pdd:14.1'))).toBe(true);
  });
});
