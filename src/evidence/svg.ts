import { roadWidth } from '../scene';
import type { ProjectEnvelope } from '../parallel/contracts';
import { EVIDENCE_KINDS, pointsOf } from './model';
export const escapeXML=(s:string):string=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
export interface SchemeOptions {scale:number; originX:number;originY:number; widthMm?:number;heightMm?:number}
/** Physical mm dimensions and denominator, independent of screen/print DPI.
 * Export at 100% (no fit-to-page). Coordinates use scene x-right/y-down convention.
 */
export function schemeSVG(p:ProjectEnvelope,o:SchemeOptions):string{
  if(!Number.isFinite(o.scale)||o.scale<=0||![o.originX,o.originY].every(Number.isFinite))throw new Error('Масштаб/начало');
  const w=o.widthMm??420,h=o.heightMm??297,k=1000/o.scale;
  const x=(v:number)=>15+(v-o.originX)*k,y=(v:number)=>25+(v-o.originY)*k;
  const line=(points:{x:number;y:number}[],color:string,width=0.5)=>`<polyline points="${points.map(p=>`${x(p.x)},${y(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
  const roads=p.scene.roads.map(r=>line(r.pts,'#b8bec5',Math.max(0.5,roadWidth(r)*k))).join('');
  const observations=p.evidence.map((e,i)=>{
    const pts=pointsOf(e),start=pts[0];if(!start)return '';
    const dimensions=pts.slice(1).map((b,j)=>{const a=pts[j];return `<text x="${x((a.x+b.x)/2)}" y="${y((a.y+b.y)/2)-1}" font-size="2.8">${Math.hypot(b.x-a.x,b.y-a.y).toFixed(3)} м</text>`;}).join('');
    return line(pts,'#a42317')+`<circle cx="${x(start.x)}" cy="${y(start.y)}" r="1" fill="#a42317"/><text x="${x(start.x)+2}" y="${y(start.y)-2}" font-size="3.5">${i+1}</text>`+dimensions;
  }).join('');
  const actors=p.scene.actors.map((a,i)=>`<g transform="translate(${x(a.x)} ${y(a.y)}) rotate(${a.heading*180/Math.PI})"><rect x="-2" y="-1" width="4" height="2" fill="none" stroke="#174c7c" stroke-width="0.4"/></g><text x="${x(a.x)+3}" y="${y(a.y)}" font-size="3">ТС ${i+1}</text>`).join('');
  const legend=p.evidence.map((e,i)=>`<text x="15" y="${h-52+i*4}" font-size="3">${escapeXML(`${i+1}. ${EVIDENCE_KINDS[e.kind as keyof typeof EVIDENCE_KINDS]??e.kind}; ${e.source??'источник неизвестен'}; ±${e.uncertainty?.metres??'?'} м`)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><title>Схема ДТП — 1:${o.scale}</title><defs><clipPath id="plan"><rect x="10" y="20" width="${w-20}" height="${h-85}"/></clipPath></defs><rect width="${w}" height="${h}" fill="white"/><g font-family="DejaVu Sans, sans-serif" fill="#111"><text x="15" y="12" font-size="5">Схема ДТП. Масштаб 1:${o.scale}. Печать 100%.</text><g clip-path="url(#plan)">${roads}${actors}${observations}</g>${legend}<path d="M15 ${h-18}h${k}" stroke="black" stroke-width="0.6"/><text x="15" y="${h-20}" font-size="3">1 м</text><text x="80" y="${h-12}" font-size="3">Участник __________________    Участник __________________    Составил __________________</text></g></svg>`;
}
