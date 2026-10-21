import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { simulate } from '../src/sim';
import { emptyScene, type Actor, type Road, type Scene } from '../src/scene';
const road = (id:string, pts:Road['pts']):Road => ({ id, pts, lanes:2, center:'dashed', oneWay:false, zone:'city', smooth:false });
function turning(right = false, lateral = 1.75, exitLateral = 1.75): Scene {
  const scene = emptyScene();
  scene.env.duration = 18;
  scene.roads = [road('h',[{x:-100,y:0},{x:100,y:0}]),road('v',[{x:0,y:-100},{x:0,y:100}])];
  const x = right ? -exitLateral : exitLateral;
  scene.actors = [{id:'a',kind:'vehicle',type:'car',x:-40,y:lateral,heading:0,speed:18,delay:0,color:'#48a',
    flags:{drunk:false,noLicense:false,flees:false}, path:[{x:-6,y:lateral,v:18},{x,y:right?8:-8,v:18},{x,y:right?50:-50,v:18}]
      .map(p=>({...p,signal:right?'right' as const:'left' as const,signalAt:0}))}];
  return scene;
}
const findings = (s:Scene) => analyze(s,simulate(s)).rules.findings;
const violations = (s:Scene, ref:string) => findings(s).filter(f=>f.actorId==='a'&&f.severity==='violation'&&f.refs.includes(ref));

describe('8.5: попутные трамвайные пути и иной порядок полос', () => {
  const withTrack = (lateral=1.75) => {
    const scene=turning(false,lateral);
    scene.tracks=[{id:'tram',pts:[{x:-100,y:0},{x:100,y:0}],separated:false,smooth:false}];
    return scene;
  };
  it('левый поворот начинается с попутных путей на одном уровне',()=>{
    const s=withTrack();
    expect(violations(s,'pdd:8.5').some(f=>f.trace.tramTrackId==='tram')).toBe(true);
  });
  it('начало поворота с путей соответствует этому требованию',()=>{
    const s=withTrack(0); s.actors[0].path.unshift({x:-16,y:0,v:18,signal:'left',signalAt:0},{x:-10,y:0,v:18,signal:'left',signalAt:0}); const fs=violations(s,'pdd:8.5'); expect(fs,JSON.stringify(fs.map(f=>({title:f.title,m:f.trace.maneuver,lat:f.trace.lateral,tram:f.trace.tramTrackId,on:f.trace.onTramTrack})))).toHaveLength(0);
  });
  it.each(['separated','opposing','lane-order'] as const)('%s не создаёт обязанности повернуть с этих путей',kind=>{
    const s=withTrack();
    if(kind==='separated') s.tracks[0].separated=true;
    if(kind==='opposing') s.tracks[0].pts.reverse();
    if(kind==='lane-order') s.signs=[{id:'order',kind:'5.15.1',x:-12,y:6,angle:0}];
    expect(violations(s,'pdd:8.5')).toHaveLength(0);
  });
});

describe('8.6: правая сторона и возможность держаться правее',()=>{
  it('явно возможный правый поворот во внутреннюю полосу нарушает положение',()=>{
    const s=turning(true,5.25,1.75);
    s.actors[0].maneuverContext={cannotKeepExtreme:false};
    expect(violations(s,'pdd:8.6').some(f=>f.title.includes('правого края'))).toBe(true);
  });
  it('правый поворот в крайнюю правую полосу соответствует наблюдаемому требованию',()=>{
    const s=turning(true,5.25,5.25);
    s.actors[0].maneuverContext={cannotKeepExtreme:false};
    expect(violations(s,'pdd:8.6')).toHaveLength(0);
  });
  it('неизвестная возможность занять правый край не приравнивается к подтверждённому нарушению',()=>{
    const s=turning(true,5.25,2.8);
    const fs=violations(s,'pdd:8.6'); expect(fs,JSON.stringify(fs.map(f=>({title:f.title,m:f.trace.maneuver,lat:f.trace.lateral,body:f.trace.bodyMinimumLateral})))).toHaveLength(0);
    expect(findings(s).some(f=>f.refs.includes('pdd:8.6')&&f.compliance==='не определить')).toBe(true);
  });
});

it('остановленный в задней передаче автомобиль не продолжает совершать задний ход во время позднего наезда',()=>{
  const s=emptyScene();s.env.duration=16;s.roads=[road('h',[{x:-100,y:0},{x:100,y:0}])];
  const a:Actor={id:'a',kind:'vehicle',type:'car',x:0,y:1.75,heading:0,speed:-5,delay:0,color:'#48a',
    flags:{drunk:false,noLicense:false,flees:false},path:[{x:-5,y:1.75,v:0,hold:20}]};
  s.actors=[a,{...a,id:'b',x:-50,speed:18,path:[{x:50,y:1.75,v:18}]}];
  const timeline=simulate(s);expect(timeline.collisions.length).toBeGreaterThan(0);
  const contact=timeline.collisions[0];expect(timeline.tracks.get('a')!.v[contact.frame-1]).toBe(0);
  const report=analyze(s,timeline);
  expect(report.rules.findings.some(f=>f.actorId==='a'&&f.causal&&f.refs.includes('pdd:8.12'))).toBe(false);
});
