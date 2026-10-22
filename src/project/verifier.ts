import { hasVerifiedArchive } from './archive';
import type { WorkbenchPorts, JsonValue } from '../parallel/contracts';
import { canonical, resultJSON } from './canonical';
import { inputHash, type ProjectFile, type Versions } from './model';
export interface Verification { integrity:'verified'|'not-checked'; calculation:'unavailable'|'mismatch'|'match'|'no-baseline'|'error'; inputHash:string; versions:Versions; versionDiff:string[]; diff:string[]; results?:JsonValue; issues?:unknown }
export function diffJSON(a:unknown,b:unknown,path=''):string[]{
  if(canonical(a)===canonical(b))return [];
  if(a&&b&&typeof a==='object'&&typeof b==='object')return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>{
    const av=(a as any)[k],bv=(b as any)[k],p=path+'/'+k.replace(/~/g,'~0').replace(/\//g,'~1');
    return av===undefined||bv===undefined?[p]:diffJSON(av,bv,p);
  });
  return [path||'/'];
}
/** Caller must first importProject: integrity is a ZIP check, calculation is separate. */
export async function verifyProject(file:ProjectFile,ports:WorkbenchPorts,currentVersions=file.versions):Promise<Verification>{
  const hash=await inputHash(file.project);
  const result:Verification={integrity:hasVerifiedArchive(file)?'verified':'not-checked',calculation:'unavailable',inputHash:hash,versions:file.versions,versionDiff:(Object.keys(currentVersions) as (keyof Versions)[]).filter(k=>file.versions[k]!==currentVersions[k]),diff:[]};
  if(!ports.physics)return result;
  const physical=await ports.physics.simulate(file.project);
  if(physical.status!=='ok')return {...result,calculation:physical.status==='unsupported'?'unavailable':'error',issues:physical.issues};
  let rules:unknown=null;
  if(ports.rules){const r=await ports.rules.evaluate(file.project,physical.value.timeline,physical.value);if(r.status!=='ok')return {...result,calculation:'error',issues:r.issues};rules=r.value;}
  const computed=resultJSON({physics:physical.value,rules}) as JsonValue;
  if(file.savedResults===undefined)return {...result,calculation:'no-baseline',results:computed};
  const diff=diffJSON(file.savedResults,computed);
  if(file.resultInputHash!==hash)diff.unshift('/resultInputHash');
  return {...result,calculation:diff.length?'mismatch':'match',diff,results:computed};
}
