import { utf8 } from '../project/canonical';
const MAGIC=utf8('CRASHENC');
const ITERATIONS=310000;
async function key(password:string,salt:Uint8Array,usage:KeyUsage):Promise<CryptoKey>{
  if(!password)throw new Error('Введите пароль');
  const material=await crypto.subtle.importKey('raw',utf8(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:new Uint8Array(salt),iterations:ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,[usage]);
}
export function isEncrypted(bytes:Uint8Array):boolean{return MAGIC.every((b,i)=>bytes[i]===b);}
export async function encryptProject(bytes:Uint8Array,password:string):Promise<Uint8Array>{
  const header=new Uint8Array(37);header.set(MAGIC);header[8]=1;
  const salt=crypto.getRandomValues(new Uint8Array(16)),nonce=crypto.getRandomValues(new Uint8Array(12));header.set(salt,9);header.set(nonce,25);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:header},await key(password,salt,'encrypt'),new Uint8Array(bytes));
  const out=new Uint8Array(header.length+encrypted.byteLength);out.set(header);out.set(new Uint8Array(encrypted),header.length);return out;
}
export async function decryptProject(bytes:Uint8Array,password:string):Promise<Uint8Array>{
  if(!isEncrypted(bytes)||bytes[8]!==1||bytes.length<53)throw new Error('Формат шифрования');
  try{return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(bytes.slice(25,37)),additionalData:new Uint8Array(bytes.slice(0,37))},await key(password,bytes.slice(9,25),'decrypt'),new Uint8Array(bytes.slice(37))));}
  catch{throw new Error('Неверный пароль или нарушена целостность');}
}
