import { describe, expect, it } from 'vitest';
import { analyze, type Report } from '../src/analysis';
import { simulate } from '../src/sim';
import { analyzeTechnical } from '../src/analysis/technical';
import { analyzeRules } from '../src/analysis/traffic-rules';
import { graphPriority } from '../src/analysis/intersections';
import { emptyScene, type Actor, type Road, type Scene, type TrafficLight } from '../src/scene';
import { PRESETS } from '../src/presets';
import pdd from '../src/data/pdd.json';

const preset = (id: string) => PRESETS.find(p => p.id === id)!.build();
const run = (scene: Scene) => analyze(scene, simulate(scene));
const violations = (report: Report, id?: string) => report.rules.findings.filter(f => f.severity === 'violation' && (!id || f.actorId === id));
const hasViolation = (report: Report, ref: string, id?: string) => violations(report, id).some(f => f.refs.includes(ref));
const edges = (report: Report) => report.rules.priorityGraphs.flatMap(g => g.edges);
const edge = (report: Report, from: string, to: string, ref: string) => edges(report).find(e => e.from === from && e.to === to && e.refs.includes(ref));

function road(id: string, pts: [number, number][]): Road {
  return { id, pts: pts.map(([x,y]) => ({x,y})), lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false, surfacePriority: 'hard' };
}
function car(id: string, x: number, y: number, heading: number, path: [number, number, number][], options: Partial<Actor> = {}): Actor {
  return { id, kind: 'vehicle', type: 'car', x,y,heading, speed: 18, color: '#2288dd', delay: 0,
    flags: {drunk:false,noLicense:false,flees:false}, path: path.map(([px,py,v]) => ({x:px,y:py,v})), ...options };
}
function cross(): Scene {
  const scene = emptyScene();
  scene.env.accidentDate = '2026-10-20T12:00';
  scene.env.duration = 16;
  scene.roads = [road('ew',[[-60,0],[60,0]]),road('ns',[[0,-60],[0,60]])];
  scene.actors = [car('a',-35,1.75,0,[[50,1.75,18]]),car('b',-1.75,-35,Math.PI/2,[[-1.75,50,18]])];
  return scene;
}
function green(id: string,x: number,y: number,angle: number, extra: Partial<TrafficLight> = {}): TrafficLight {
  return {id,x,y,angle,lineLength:3.5,green:60,yellow:0,red:0,offset:0,...extra};
}
function oppositeTurn(maneuver: 'left'|'uturn', regulated: boolean): Scene {
  const scene = cross();
  scene.actors[0].path = maneuver === 'left'
    ? [{x:-6,y:1.75,v:18},{x:1.75,y:-6,v:18},{x:1.75,y:-50,v:18}]
    : [{x:-6,y:1.75,v:18},{x:0,y:0,v:18},{x:-6,y:-1.75,v:18},{x:-50,y:-1.75,v:18}];
  scene.actors[1] = car('b',35,-1.75,Math.PI,[[-50,-1.75,18]]);
  if (regulated) scene.lights = [green('west',-10,3.5,0),green('east',10,-3.5,Math.PI)];
  return scene;
}
function delayed(scene: Scene, id = 'a'): Scene {
  const cloned = structuredClone(scene);
  cloned.actors.find(a => a.id === id)!.delay = 9;
  cloned.env.duration = 25;
  return cloned;
}

describe('раздел 13: нормы берутся из корпуса', () => {
  it.each(['13.1','13.2','13.3','13.4','13.5','13.6','13.7','13.8','13.9','13.10','13.11','13.11(1)','13.12','13.13'])('пункт %s присутствует в проверяемом источнике', id => {
    expect(pdd.sections.flatMap(s => s.points).find(p => p.id === id)?.text.length).toBeGreaterThan(30);
  });
});

describe('13.3, 13.9, 13.11: регулирование и приоритет', () => {
  it('13.11: граф объясняет уступку справа; контакт является нарушением', () => {
    const scene = preset('right-hand');
    const report = run(scene);
    const [priority,yielder] = scene.actors;
    expect(edge(report,yielder.id,priority.id,'pdd:13.11')).toBeDefined();
    expect(hasViolation(report,'pdd:13.11',yielder.id)).toBe(true);
  });
  it('13.11: разнесённый по времени проезд не создаёт нарушения', () => {
    const scene = preset('right-hand');
    scene.actors[1].delay=8;
    scene.env.duration=20;
    const report=run(scene);
    expect(report.collisions).toHaveLength(0);
    expect(hasViolation(report,'pdd:13.11')).toBe(false);
  });
  it('13.9: знак 2.4 уступает главной независимо от дальнейшего направления', () => {
    const scene=preset('giveway');
    const report=run(scene);
    expect(edge(report,scene.actors[0].id,scene.actors[1].id,'pdd:13.9')).toBeDefined();
    expect(hasViolation(report,'pdd:13.9',scene.actors[0].id)).toBe(true);
  });
  it('13.9: своевременная уступка не превращается в нарушение', () => {
    const scene=preset('giveway');
    scene.actors[0].delay=8;
    scene.env.duration=20;
    expect(hasViolation(run(scene),'pdd:13.9',scene.actors[0].id)).toBe(false);
  });
  it.each(['flashing-yellow','off'] as const)('13.3: %s возвращает действие знаков приоритета', mode => {
    const scene=preset('giveway');
    scene.lights=[green('west',-10,3.5,0,{mode}),green('north',-3.5,-10,Math.PI/2,{mode})];
    const report=run(scene);
    expect(edge(report,scene.actors[0].id,scene.actors[1].id,'pdd:13.9')).toBeDefined();
    expect(hasViolation(report,'pdd:6.2')).toBe(false);
  });
  it('13.3: разрешающий сигнал отменяет приоритет знаков', () => {
    const scene=preset('giveway');
    scene.lights=[green('west',-10,3.5,0),green('north',-3.5,-10,Math.PI/2)];
    const report=run(scene);
    expect(hasViolation(report,'pdd:13.9')).toBe(false);
    expect(edges(report).some(e=>e.refs.includes('pdd:13.11'))).toBe(false);
  });
  it('13.11: цикл четырёх одновременно подъехавших участников требует договориться', () => {
    const scene=cross();
    scene.actors.push(car('c',35,-1.75,Math.PI,[[-50,-1.75,18]]),car('d',1.75,35,-Math.PI/2,[[1.75,-50,18]]));
    const report=run(scene);
    const cyclic=report.rules.priorityGraphs.find(g=>g.agreementRequired);
    expect(cyclic).toBeDefined();
    expect(cyclic!.cycles.flat()).toEqual(expect.arrayContaining(['a','b','c','d']));
    expect(hasViolation(report,'pdd:13.11')).toBe(false);
    expect(report.rules.findings.some(f=>f.detail.includes('договариваются'))).toBe(true);
  });
});

describe('13.4, 13.12: левый поворот и разворот', () => {
  it.each(['left','uturn'] as const)('13.4: %s на зелёный уступает встречному прямо', maneuver => {
    const scene=oppositeTurn(maneuver,true);
    const report=run(scene);
    expect(edge(report,'a','b','pdd:13.4')).toBeDefined();
    expect(hasViolation(report,'pdd:13.4','a')).toBe(true);
  });
  it.each(['left','uturn'] as const)('13.12: %s на равнозначной дороге уступает встречному', maneuver => {
    const scene=oppositeTurn(maneuver,false);
    const report=run(scene);
    expect(edge(report,'a','b','pdd:13.12')).toBeDefined();
    expect(hasViolation(report,'pdd:13.12','a')).toBe(true);
  });
  it.each([true,false])('разнесённый по времени поворот не нарушает приоритет (регулируемый=%s)', regulated => {
    const scene=delayed(oppositeTurn('left',regulated));
    expect(hasViolation(run(scene),regulated?'pdd:13.4':'pdd:13.12','a')).toBe(false);
  });
  it('13.10: при изменении главной равные по статусу уступают справа', () => {
    const scene=cross();
    scene.signs=[{id:'west-main',kind:'2.1',x:-12,y:5,angle:0,plates:['8.13'],mainDirections:[0,Math.PI/2]}];
    const report=run(scene);
    const priority=edge(report,'b','a','pdd:13.10');
    expect(priority).toBeDefined();
    expect(priority!.refs).toContain('pdd:13.11');
    expect(hasViolation(report,'pdd:13.10','b')).toBe(true);
    expect(edges(report).some(e=>e.refs.includes('pdd:13.9'))).toBe(false);
  });
  it('13.10: уступивший справа на изменяющей направление главной не нарушает очерёдность', () => {
    const scene=cross();
    scene.signs=[{id:'west-main',kind:'2.1',x:-12,y:5,angle:0,plates:['8.13'],mainDirections:[0,Math.PI/2]}];
    expect(hasViolation(run(delayed(scene,'b')),'pdd:13.10','b')).toBe(false);
  });
  it('13.10: движение по разным по статусу ветвям сохраняет обязанность второстепенной', () => {
    const scene=cross();
    scene.signs=[{id:'west-main',kind:'2.1',x:-12,y:5,angle:0,plates:['8.13'],mainDirections:[0,Math.PI]}];
    expect(edge(run(scene),'b','a','pdd:13.9')).toBeDefined();
  });
});

describe('13.5–13.6: дополнительная секция и трамвай', () => {
  it('13.5: включённая стрелка с красным уступает другому направлению', () => {
    const scene=cross();
    scene.lights=[green('west',-10,3.5,0,{green:0,red:60,extraSection:{directions:['straight'],on:true}}),green('north',-3.5,-10,Math.PI/2)];
    const report=run(scene);
    expect(edge(report,'a','b','pdd:13.5')).toBeDefined();
    expect(hasViolation(report,'pdd:13.5','a')).toBe(true);
    expect(hasViolation(report,'pdd:6.2','a')).toBe(false);
  });
  it('13.5: уступка по дополнительной стрелке исключает нарушение', () => {
    const scene=cross();
    scene.lights=[green('west',-10,3.5,0,{green:0,red:60,extraSection:{directions:['straight'],on:true}}),green('north',-3.5,-10,Math.PI/2)];
    expect(hasViolation(run(delayed(scene)),'pdd:13.5','a')).toBe(false);
  });
  it('13.6: одновременно разрешённое движение даёт трамваю преимущество', () => {
    const scene=preset('tram');
    scene.lights=[green('west',-12,3.5,0),green('north',-3.5,-12,Math.PI/2)];
    const report=run(scene);
    expect(edge(report,scene.actors[1].id,scene.actors[0].id,'pdd:13.6')).toBeDefined();
    expect(hasViolation(report,'pdd:13.6',scene.actors[1].id)).toBe(true);
  });
  it('13.6: трамвай по дополнительной стрелке с красным сам уступает', () => {
    const scene=preset('tram');
    scene.lights=[green('west',-12,3.5,0,{green:0,red:60,extraSection:{directions:['straight'],on:true}}),green('north',-3.5,-12,Math.PI/2)];
    const report=run(scene);
    expect(edge(report,scene.actors[0].id,scene.actors[1].id,'pdd:13.6')).toBeDefined();
    expect(hasViolation(report,'pdd:13.6',scene.actors[0].id)).toBe(true);
  });
  it('13.9: трамвай со второстепенной не получает преимущество перед главной', () => {
    const scene=preset('tram');
    scene.signs=[{id:'yield',kind:'2.4',x:-15,y:5,angle:0},{id:'main',kind:'2.1',x:-5,y:-15,angle:Math.PI/2}];
    const report=run(scene);
    expect(edge(report,scene.actors[0].id,scene.actors[1].id,'pdd:13.9')).toBeDefined();
    expect(hasViolation(report,'pdd:13.9',scene.actors[0].id)).toBe(true);
  });
});

describe('13.7–13.8: завершение проезда', () => {
  function exitScene(stopLine: boolean): Scene {
    const scene=cross();
    scene.actors=scene.actors.slice(0,1);
    scene.lights=[green('entry',-10,3.5,0),green('exit',3,3.5,0,{green:0,red:60,stopLine})];
    return scene;
  }
  it('13.7: разрешённый въезд позволяет закончить движение на выходной красный без стоп-линии', () => {
    const report=run(exitScene(false));
    expect(hasViolation(report,'pdd:6.2','a')).toBe(false);
    expect(report.rules.findings.some(f=>f.actorId==='a'&&f.refs.includes('pdd:13.7')&&f.compliance==='выполнено')).toBe(true);
  });
  it('13.7: внутренняя стоп-линия требует соблюдать выходной светофор', () => {
    const report=run(exitScene(true));
    expect(hasViolation(report,'pdd:6.2','a')).toBe(true);
  });
  it('13.8: начинающий на зелёный уступает завершающему пересечение', () => {
    const scene=cross();
    scene.lights=[green('west',-10,3.5,0,{green:6,yellow:0,red:54}),green('north',-3.5,-10,Math.PI/2,{green:54,yellow:0,red:6,offset:54})];
    scene.actors[1].delay=1.5;
    const report=run(scene);
    expect(edge(report,'b','a','pdd:13.8')).toBeDefined();
  });
  it('13.8: разрешающий сигнал не отменяет приоритет не закончившего переход пешехода', () => {
    const scene=cross();
    scene.actors=[scene.actors[0],car('ped',0,-4,Math.PI/2,[[0,5,3.6]],{kind:'pedestrian',type:'adult',speed:3.6,delay:3})];
    scene.actors[0].delay=1.6;
    scene.lights=[green('west',-10,3.5,0,{green:54,yellow:0,red:6,offset:54})];
    scene.crosswalks=[{id:'crossing',x:0,y:0,angle:Math.PI/2,length:8,width:4,lightId:'west'}];
    const report=run(scene);
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(hasViolation(report,'pdd:13.8','a')).toBe(true);
  });
  it('13.8: при свободном перекрёстке начало движения на зелёный не является нарушением', () => {
    const scene=cross();
    scene.actors=scene.actors.slice(0,1);
    scene.lights=[green('west',-10,3.5,0)];
    expect(hasViolation(run(scene),'pdd:13.8','a')).toBe(false);
  });
});

describe('13.2: затор на выходе', () => {
  function queueScene(): Scene {
    const scene=cross();
    scene.env.duration=25;
    scene.actors[0].path=[{x:0,y:1.75,v:0,hold:8},{x:40,y:1.75,v:18}];
    scene.actors[1].delay=15;
    scene.actors.push(car('queue',8,1.75,0,[],{speed:0}));
    scene.markings=[{id:'waffle',kind:'1.26',pts:[{x:-4,y:-4},{x:4,y:-4},{x:4,y:4},{x:-4,y:4}]}];
    return scene;
  }
  it('очередь, существовавшая до въезда, и остановка поперёк пути нарушают 13.2', () => {
    const report=run(queueScene());
    expect(hasViolation(report,'pdd:13.2','a')).toBe(true);
    expect(violations(report,'a').find(f=>f.refs.includes('pdd:13.2'))!.trace).toHaveProperty('queueActorId','queue');
  });
  it('сама остановка в перекрёстке без существовавшей очереди не доказывает 13.2', () => {
    const scene=queueScene();
    scene.actors=scene.actors.filter(a=>a.id!=='queue');
    expect(hasViolation(run(scene),'pdd:13.2','a')).toBe(false);
  });
  it('ожидание левого поворота не считается въездом в затор', () => {
    const scene=queueScene();
    scene.actors[0].path=[{x:0,y:1.75,v:0,hold:8},{x:1.75,y:-8,v:18},{x:1.75,y:-40,v:18}];
    expect(hasViolation(run(scene),'pdd:13.2','a')).toBe(false);
  });
});

describe('13.13: неизвестное покрытие', () => {
  it('при отсутствии знаков водитель считает свою дорогу второстепенной', () => {
    const scene=cross();
    scene.actors[0].coveringUnknown=true;
    const report=run(scene);
    expect(edge(report,'a','b','pdd:13.13')).toBeDefined();
    expect(hasViolation(report,'pdd:13.13','a')).toBe(true);
  });
  it('13.13: уступка при неизвестном покрытии соблюдает требование', () => {
    const scene=cross();
    scene.actors[0].coveringUnknown=true;
    expect(hasViolation(run(delayed(scene)),'pdd:13.13','a')).toBe(false);
  });
  it('известное покрытие не создаёт искусственного преимущества', () => {
    const scene=cross();
    expect(edges(run(scene)).some(e=>e.refs.includes('pdd:13.13'))).toBe(false);
  });
  it('знак главной дороги отменяет предположение о второстепенной', () => {
    const scene=cross();
    scene.actors[0].coveringUnknown=true;
    scene.signs=[{id:'main',kind:'2.1',x:-12,y:5,angle:0}];
    const report=run(scene);
    expect(edges(report).some(e=>e.from==='a'&&e.refs.includes('pdd:13.13'))).toBe(false);
    expect(edge(report,'b','a','pdd:13.9')).toBeDefined();
  });
});

describe('13.1: поворот уступает пересекающим дорогу на выходе', () => {
  function turnScene(type:'adult'|'bicycle'):Scene {
    const scene=cross();
    scene.actors=scene.actors.slice(0,1);
    scene.actors[0].path=[{x:-3,y:1.75,v:18},{x:-1.75,y:6,v:18},{x:-1.75,y:40,v:18}];
    scene.actors.push(type==='adult'
      ? car('vulnerable',-4,5,0,[[4,5,5]],{kind:'pedestrian',type:'adult',speed:5,delay:5.2})
      : car('vulnerable',-20,5,0,[[30,5,18]],{type:'bicycle',delay:3.2}));
    return scene;
  }
  it.each(['adult','bicycle'] as const)('13.1: контакт с %s на пересекаемой дороге нарушает обязанность уступить', type=>{
    const scene=turnScene(type);
    const report=run(scene);
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(hasViolation(report,'pdd:13.1','a')).toBe(true);
  });
  it.each(['adult','bicycle'] as const)('13.1: поворот после освобождения дороги %s не нарушает приоритет', type=>{
    const scene=delayed(turnScene(type));
    expect(hasViolation(run(scene),'pdd:13.1','a')).toBe(false);
  });
});

describe('13.11(1): кольцо и исключение для въезда с главной', () => {
  function circleScene(mainEntry:boolean):Scene {
    const scene=cross();
    // Проверяется правило на въезде в кольцевую дорогу; геометрия
    // отдельного кольца и группировка примыканий проверены в geo tests.
    scene.roads[0].role='roundabout';
    scene.roads[0].oneWay=true;
    scene.signs=[{id:'circle',kind:'4.3',x:-5,y:-12,angle:Math.PI/2}];
    if(mainEntry) scene.signs.push({id:'main-entry',kind:'2.1',x:-5,y:-15,angle:Math.PI/2});
    return scene;
  }
  it('въезжающий по неглавной обязан уступить движущемуся по кругу',()=>{
    const report=run(circleScene(false));
    expect(edge(report,'b','a','pdd:13.11(1)')).toBeDefined();
    expect(hasViolation(report,'pdd:13.11(1)','b')).toBe(true);
  });
  it('въезжающий по главной не получает обязанность уступить только из факта круга',()=>{
    const report=run(circleScene(true));
    expect(edges(report).some(e=>e.from==='b'&&e.refs.includes('pdd:13.11(1)'))).toBe(false);
    expect(edge(report,'a','b','pdd:13.9')).toBeDefined();
  });
  it('уступивший до въезда на круг не нарушает 13.11(1)',()=>{
    const report=run(delayed(circleScene(false),'b'));
    expect(hasViolation(report,'pdd:13.11(1)','b')).toBe(false);
  });
});


describe('регрессии области действия приоритета и регулировщика', () => {
  it('13.13: неизвестное покрытие обоих подходов не доказывает равнозначность', () => {
    const scene=cross();
    scene.actors.forEach(a=>a.coveringUnknown=true);
    const report=run(scene);
    expect(edges(report).some(e=>e.refs.includes('pdd:13.11'))).toBe(false);
    expect(hasViolation(report,'pdd:13.11')).toBe(false);
    expect(report.rules.actors.every(a=>a.status==='insufficient-data')).toBe(true);
  });
  it('6.10: физический поворот регулировщика управляет боковым подходом без его стоп-линии', () => {
    const scene=cross();
    scene.lights=[green('controller',0,0,0,{kind:'controller',controllerGesture:'arms-out'})];
    const report=run(scene);
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(hasViolation(report,'pdd:6.10','a')).toBe(true);
    expect(hasViolation(report,'pdd:6.10','b')).toBe(false);
    const relation=edges(report).find(e=>e.from==='a'&&e.to==='b');
    expect(relation).toBeDefined();
    expect(report.rules.findings.some(f=>f.actorId==='a'&&f.causal&&f.trace.ruleCodes instanceof Array&&f.trace.ruleCodes.includes('rule:signal'))).toBe(true);
  });
  it('6.11: адресованное требование остановки не запрещает движение другому подходу', () => {
    const scene=cross();
    scene.lights=[green('controller',0,0,Math.PI/2,{kind:'controller',controllerGesture:'stop',controllerTargetHeading:0}),green('north',-3.5,-10,Math.PI/2)];
    const report=run(scene);
    expect(hasViolation(report,'pdd:6.11','a')).toBe(true);
    expect(hasViolation(report,'pdd:6.11','b')).toBe(false);
    const participants=report.rules.priorityGraphs.flatMap(g=>g.participants);
    expect(participants.find(p=>p.actorId==='a')!.lightId).toBe('controller');
    expect(participants.find(p=>p.actorId==='b')!.lightId).toBe('north');
  });
  it('граф перекрёстка не назначает приоритет для контакта на удалённом участке дороги', () => {
    const scene=cross();
    const {ctx}=analyzeRules(analyzeTechnical(scene,simulate(scene)));
    expect(ctx.priorityGraphs.flatMap(g=>g.edges).length).toBeGreaterThan(0);
    expect(graphPriority(ctx,'a','b',{x:50,y:1.75},ctx.tl.n-1)).toMatchObject({edge:null,cycle:false});
  });
  it('разные по времени встречи четырёх направлений не образуют одновременный цикл', () => {
    const scene=cross();
    scene.env.duration=30;
    scene.actors.push(car('c',35,-1.75,Math.PI,[[-50,-1.75,18]]),car('d',1.75,35,-Math.PI/2,[[1.75,-50,18]],{delay:15}));
    expect(run(scene).rules.priorityGraphs.some(g=>g.agreementRequired)).toBe(false);
  });
});

describe('6.15: распоряжения регулировщика и другие требования знаков', () => {
  function directedTurn(withController:boolean):Scene {
    const scene=cross();
    scene.actors=scene.actors.slice(0,1);
    scene.actors[0].path=[{x:-25,y:1.75,v:18},{x:-18,y:1.75,v:18},{x:-8,y:1.75,v:18},{x:-3,y:1.75,v:18},{x:-1.75,y:6,v:18},{x:-1.75,y:40,v:18}];
    scene.signs=[{id:'no-right',kind:'3.18.1',x:-25,y:5,angle:0}];
    if(withController) scene.lights=[green('controller',0,0,-Math.PI/2,{kind:'controller',controllerGesture:'right-arm-forward'})];
    return scene;
  }
  it('разрешённый жест отменяет противоречащий ему запрет поворота', () => {
    expect(hasViolation(run(directedTurn(false)),'sign:3.18.1','a')).toBe(true);
    const report=run(directedTurn(true));
    expect(hasViolation(report,'pdd:6.10','a')).toBe(false);
    expect(hasViolation(report,'sign:3.18.1','a')).toBe(false);
  });
  it.each(['3.11','3.13'])('жест не отменяет ограничение массы/высоты %s', kind => {
    const scene=directedTurn(true);
    scene.signs.push({id:'dimensions',kind,x:-24,y:5,angle:0,value:1});
    expect(hasViolation(run(scene),`sign:${kind}`,'a')).toBe(true);
  });
});
