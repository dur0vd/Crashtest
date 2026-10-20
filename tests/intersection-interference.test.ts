import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { emptyScene, type Actor } from '../src/scene';
import { simulate } from '../src/sim';

function situation(brake: boolean) {
  const scene = emptyScene();
  scene.env.duration = 12;
  scene.roads = [
    { id: 'ew', pts: [{x:-60,y:0},{x:60,y:0}], lanes:1, center:'dashed', oneWay:false, zone:'city', smooth:false },
    { id: 'ns', pts: [{x:0,y:-60},{x:0,y:60}], lanes:1, center:'dashed', oneWay:false, zone:'city', smooth:false },
  ];
  const actor = (id:string,x:number,y:number,heading:number): Actor => ({ id,kind:'vehicle',type:'car',x,y,heading,speed:18,delay:0,path:[],color:'#f00',flags:{drunk:false,noLicense:false,flees:false} });
  const priority = actor('priority',-30,1.75,0);
  priority.path = brake ? [{x:-5,y:1.75,v:0,hold:6},{x:50,y:1.75,v:18}] : [{x:50,y:1.75,v:18}];
  const yielding = actor('yielding',-1.75,-22,Math.PI/2);
  yielding.path=[{x:-1.75,y:50,v:18}];
  scene.actors=[priority,yielding];
  scene.signs=[{id:'main',kind:'2.1',x:-15,y:5,angle:0},{id:'yield',kind:'2.4',x:-5,y:-15,angle:Math.PI/2}];
  return scene;
}

describe('помеха без столкновения',()=>{
  it('фактическое торможение перед пересекающим путь ТС сохраняет нарушение обязанности уступить',()=>{
    const scene=situation(true);
    const timeline=simulate(scene);
    expect(timeline.collisions).toHaveLength(0);
    const report=analyze(scene,timeline);
    expect(report.rules.findings.some(f=>f.actorId==='yielding'&&f.severity==='violation'&&f.refs.includes('pdd:13.9')&&f.trace.interferenceFrame!==undefined)).toBe(true);
  });
  it('само наличие ребра приоритета без фактической помехи не устанавливает нарушение',()=>{
    const scene=situation(true);
    scene.actors[1].delay=8;
    const report=analyze(scene,simulate(scene));
    expect(report.rules.findings.some(f=>f.actorId==='yielding'&&f.severity==='violation'&&f.refs.includes('pdd:13.9'))).toBe(false);
  });
});
