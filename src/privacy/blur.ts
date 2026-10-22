/** Local manual derivative. Original stays unchanged and is excluded by redacted ZIP.
 * Solid pixelation is applied directly to pixels; no server, EXIF or original bytes
 * are included in the PNG. It is not an automatic face/number detector.
 */
export async function blurRegions(blob:Blob,regions:{x:number;y:number;width:number;height:number}[]):Promise<Blob>{
  const bitmap=await createImageBitmap(blob);const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
  const ctx=canvas.getContext('2d')!;ctx.drawImage(bitmap,0,0);bitmap.close();
  for(const r of regions){
    if(![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>canvas.width||r.y+r.height>canvas.height)throw new Error('Область вне изображения');
    // Opaque masking avoids recoverable weak blur, while remaining manually reviewable.
    ctx.fillStyle='#555';ctx.fillRect(r.x,r.y,r.width,r.height);
  }
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG export')),'image/png'));
}
