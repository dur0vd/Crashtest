import { emptyScene, VEHICLES, PEDESTRIANS } from '../scene';
import { newProject, type ProjectFile } from '../project/model';
const numericKeys=new Set(['x','y','heading','width','length','radius','lanes','laneWidth','speed','delay','depth','height','C1','C2','C3','C4','C5','C6','sigma','metres','points','pts','boundary','path','t','hold']);
function geometry(value:unknown):any {
  if(typeof value==='number')return Number.isFinite(value)?value:0;
  if(Array.isArray(value))return value.map(geometry);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>numericKeys.has(k)).map(([k,v])=>[k,geometry(v)]));
  return null;
}
/** Conservative derivative: no original media, free text, extensions, journal, EXIF,
 * timestamps, saved results or unknown schema fields. It cannot be used as the
 * original evidentiary project. Redaction is deliberate data loss, never in-place.
 */
export function redactProject(file:ProjectFile):ProjectFile {
  const scene=emptyScene();scene.name='Обезличенная схема';scene.env.accidentDate='';
  for(const collection of ['roads','sidewalks','tracks','crosswalks','obstacles'] as const){
    (scene[collection] as unknown[]) = file.project.scene[collection].map((item,i)=>({...geometry(item),id:`${collection}-${i+1}`}));
  }
  scene.actors=file.project.scene.actors.map((a,i)=>({
    id:`participant-${i+1}`,kind:a.kind==='vehicle'?'vehicle':'pedestrian',
    type:a.kind==='vehicle'&&a.type in VEHICLES?a.type:a.type in PEDESTRIANS?a.type:'car',
    x:a.x,y:a.y,heading:a.heading,color:'#2166ac',speed:a.speed,delay:a.delay,
    path:a.path.map(p=>geometry(p)),flags:{}
  })) as typeof scene.actors;
  const out=newProject(scene);out.versions={...file.versions};
  out.project.evidence=file.project.evidence.map((e,i)=>({id:`observation-${i+1}`,kind:['braking','skid','lateral','debris','fluid','gouge','impact','final-vehicle','final-body','crush','sign','signal'].includes(e.kind)?e.kind:'observation',geometry:geometry(e.geometry),values:geometry(e.values),source:'Обезличенная производная'}));
  out.project.extensions.workspace={redacted:true,warning:'Исходные материалы, ПДн и история исключены. Не оригинал.'};
  return out;
}
/** URL sharing is disabled for workbench projects, including derivatives. */
export function canShareByURL(_file:ProjectFile):boolean { return false; }
