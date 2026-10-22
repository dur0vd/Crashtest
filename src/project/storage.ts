import type { ProjectFile } from './model';
const DB='crashtest-projects-v1';
function openDB():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore('projects');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function transaction<T>(mode:IDBTransactionMode,fn:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await openDB();try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction('projects',mode);const r=fn(tx.objectStore('projects'));tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
export const saveLocal=(id:string,file:ProjectFile):Promise<IDBValidKey>=>transaction('readwrite',s=>s.put(file,id));
export const loadLocal=(id:string):Promise<ProjectFile|undefined>=>transaction('readonly',s=>s.get(id));
export const deleteLocal=(id:string):Promise<undefined>=>transaction('readwrite',s=>s.delete(id));
