import { zipSync, unzipSync, strFromU8 } from 'fflate';
import type { ProjectEnvelope } from '../parallel/contracts';
import { normalizeScene } from '../scene';
import { canonical, sha256, utf8 } from './canonical';
import { newProject, type ProjectFile } from './model';
const verifiedArchives=new WeakSet<ProjectFile>();
export const hasVerifiedArchive=(file:ProjectFile):boolean=>verifiedArchives.has(file);
const LIMIT = 256 * 1024 * 1024;
export const ARCHIVE_LIMITS = {bytes:LIMIT, files:512, fileBytes:128*1024*1024};
const safePath = (p:string):boolean => /^[a-zA-Z0-9_./-]+$/.test(p) && !p.startsWith('/') && !p.split('/').some(s=>s==='..'||s==='.'||s==='');
function validateEnvelope(p:ProjectEnvelope):void {
  if(p?.contractVersion!==1) throw new Error('Неподдерживаемая версия контракта');
  if(!p.scene || !Array.isArray(p.scene.actors) || !Array.isArray(p.scene.roads) || !Array.isArray(p.evidence) || !p.extensions?.physics || !p.extensions.rules || !p.extensions.workspace) throw new Error('Повреждённый envelope');
  canonical(p);
}
export async function exportProject(file:ProjectFile):Promise<Uint8Array> {
  validateEnvelope(file.project);
  const payload:Record<string,Uint8Array>={
    'scene.json':utf8(canonical(file.project.scene)),
    'extensions.json':utf8(canonical(file.project.extensions)),
    'evidence.json':utf8(canonical(file.project.evidence)),
    'journal.json':utf8(canonical(file.journal)),
  };
  const attachments=[];
  for(const a of file.attachments){
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(a.id)||payload[`attachments/${a.id}`])throw new Error('ID вложения');
    payload[`attachments/${a.id}`]=a.bytes;
    attachments.push({id:a.id,name:a.name,type:a.type,metadata:a.metadata});
  }
  payload['project.json']=utf8(canonical({format:1,contractVersion:1,versions:file.versions,attachments,...(file.savedResults===undefined?{}:{savedResults:file.savedResults,resultInputHash:file.resultInputHash??null})}));
  const hashes:Record<string,string>={}; let total=0;
  for(const [path,bytes] of Object.entries(payload)){
    total+=bytes.length;if(bytes.length>ARCHIVE_LIMITS.fileBytes||total>LIMIT)throw new Error('Лимит размера проекта');
    hashes[path]=await sha256(bytes);
  }
  if(Object.keys(payload).length+1>ARCHIVE_LIMITS.files)throw new Error('Слишком много файлов');
  payload['manifest.json']=utf8(canonical({format:1,algorithm:'SHA-256',payload:hashes}));
  return zipSync(payload,{level:6});
}
export async function importProject(bytes:Uint8Array):Promise<ProjectFile> {
  if(bytes.length>LIMIT)throw new Error('Лимит архива');
  if(bytes[0]!==0x50||bytes[1]!==0x4b){
    const legacy=JSON.parse(strFromU8(bytes));
    if(legacy.contractVersion){validateEnvelope(legacy);const f=newProject(legacy.scene);f.project=legacy;return f;}
    if(!legacy||typeof legacy!=='object'||!Array.isArray(legacy.actors)||!Array.isArray(legacy.roads))throw new Error('Не сцена');
    if(legacy.version!==undefined&&legacy.version!==1)throw new Error('Неподдерживаемая версия сцены');
    return newProject(normalizeScene(legacy));
  }
  let total=0,count=0; const seen=new Set<string>();
  const entries=unzipSync(bytes,{filter(entry){
    if(!safePath(entry.name)||seen.has(entry.name))throw new Error('Небезопасный или повторный путь ZIP');
    seen.add(entry.name);total+=entry.originalSize;
    if(++count>ARCHIVE_LIMITS.files||entry.originalSize>ARCHIVE_LIMITS.fileBytes||total>LIMIT)throw new Error('Лимит распаковки ZIP');
    return true;
  }});
  const parse=(name:string):any=>{if(!entries[name])throw new Error(`Отсутствует ${name}`);return JSON.parse(strFromU8(entries[name]));};
  const manifest=parse('manifest.json');
  if(manifest.format!==1||manifest.algorithm!=='SHA-256'||!manifest.payload||typeof manifest.payload!=='object')throw new Error('Версия manifest');
  const names=Object.keys(entries).filter(k=>k!=='manifest.json').sort();
  if(canonical(names)!==canonical(Object.keys(manifest.payload).sort()))throw new Error('Состав payload отличается от manifest');
  for(const name of names)if(await sha256(entries[name])!==manifest.payload[name])throw new Error(`SHA-256: ${name}`);
  const meta=parse('project.json'); if(meta.format!==1||meta.contractVersion!==1)throw new Error('Неподдерживаемая версия проекта');
  if(!meta.versions||!['engine','ui','corpus'].every(k=>typeof meta.versions[k]==='string')||!Array.isArray(meta.attachments))throw new Error('Метаданные проекта');
  const project:ProjectEnvelope={contractVersion:1,scene:parse('scene.json'),extensions:parse('extensions.json'),evidence:parse('evidence.json')};
  validateEnvelope(project);
  const attachmentIds=new Set<string>();
  const attachments=meta.attachments.map((a:any)=>{
    if(!a||!/^[a-zA-Z0-9_-]{1,100}$/.test(a.id)||attachmentIds.has(a.id)||!entries[`attachments/${a.id}`])throw new Error('Вложение отсутствует или дублировано');
    attachmentIds.add(a.id);return {...a,bytes:entries[`attachments/${a.id}`]};
  });
  if(names.filter(n=>n.startsWith('attachments/')).length!==attachments.length)throw new Error('Незарегистрированное вложение');
  const journal=parse('journal.json');if(!Array.isArray(journal))throw new Error('Журнал');
  for(const e of journal){validateEnvelope(e.before);validateEnvelope(e.after);if(typeof e.who!=='string'||typeof e.at!=='string'||typeof e.action!=='string')throw new Error('Запись журнала');}
  const file:ProjectFile={project,versions:meta.versions,attachments,journal,...(meta.savedResults===undefined?{}:{savedResults:meta.savedResults,resultInputHash:meta.resultInputHash})};
  verifiedArchives.add(file);return file;
}
