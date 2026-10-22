import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import type { ReportDocument } from './model';
import type { ProjectEnvelope } from '../parallel/contracts';
import { EVIDENCE_KINDS, pointsOf } from '../evidence/model';
import type { SchemeOptions } from '../evidence/svg';
async function embedFont(pdf:PDFDocument,bytes:Uint8Array):Promise<PDFFont>{pdf.registerFontkit(fontkit);return pdf.embedFont(bytes,{subset:true});}
function wrap(text:string,font:PDFFont,size:number,width:number):string[]{
  const chars=new Set(font.getCharacterSet());const filtered=[...text].map(c=>chars.has(c.codePointAt(0)!)?c:'?').join('');
  const out:string[]=[];let line='';for(const c of filtered){if(c==='\n'||font.widthOfTextAtSize(line+c,size)>width){out.push(line);line=c==='\n'?'':c;}else line+=c;}if(line)out.push(line);return out;
}
export async function exportPDF(doc:ReportDocument,fontBytes:Uint8Array):Promise<Uint8Array>{
  const pdf=await PDFDocument.create();pdf.setTitle(doc.title);pdf.setSubject(`SHA-256 ${doc.inputHash}`);const font=await embedFont(pdf,fontBytes);
  let page=pdf.addPage([595.28,841.89]),y=795;let pageNo=1;
  const next=()=>{page.drawText(String(pageNo++),{x:550,y:20,size:9,font});page=pdf.addPage([595.28,841.89]);y=795;};
  const write=(text:string,size=10)=>{for(const line of wrap(text,font,size,505)){if(y<45)next();page.drawText(line,{x:45,y,size,font,color:rgb(0.08,0.12,0.17)});y-=size*1.45;}y-=6;};
  write(doc.title,18);for(const section of doc.sections){if(y<100)next();write(section.title,13);for(const line of section.lines)write(line);}
  page.drawText(String(pageNo),{x:550,y:20,size:9,font});return pdf.save();
}
export async function exportDOCX(doc:ReportDocument):Promise<Uint8Array>{
  const document=new Document({creator:'Crashtest',title:doc.title,description:`SHA-256 ${doc.inputHash}`,styles:{default:{document:{run:{font:'DejaVu Sans',size:22}}}},sections:[{children:[new Paragraph({text:doc.title,heading:HeadingLevel.TITLE}),...doc.sections.flatMap(s=>[new Paragraph({text:s.title,heading:HeadingLevel.HEADING_1}),...s.lines.map(line=>new Paragraph({children:[new TextRun(line)],spacing:{after:100}}))])]}]});
  return new Uint8Array(await Packer.toBuffer(document));
}
/** Vector PDF scheme with a physical denominator, not a screenshot. */
export async function schemePDF(project:ProjectEnvelope,options:SchemeOptions,fontBytes:Uint8Array):Promise<Uint8Array>{
  const pdf=await PDFDocument.create(),mm=72/25.4,w=options.widthMm??420,h=options.heightMm??297;
  if(!Number.isFinite(options.scale)||options.scale<=0)throw new Error('Масштаб');
  const page=pdf.addPage([w*mm,h*mm]),font=await embedFont(pdf,fontBytes),k=1000/options.scale;
  const point=(p:{x:number;y:number})=>({x:(15+(p.x-options.originX)*k)*mm,y:(h-25-(p.y-options.originY)*k)*mm});
  const text=(s:string,x:number,y:number,size=9)=>page.drawText(s,{x:x*mm,y:(h-y)*mm,size,font});
  text(`Схема ДТП — 1:${options.scale}; печать 100%`,15,12,14);
  for(const [i,e] of project.evidence.entries()){
    const pts=pointsOf(e);for(let j=1;j<pts.length;j++){
      page.drawLine({start:point(pts[j-1]),end:point(pts[j]),thickness:0.8,color:rgb(0.6,0.1,0.1)});
      const mid=point({x:(pts[j-1].x+pts[j].x)/2,y:(pts[j-1].y+pts[j].y)/2});page.drawText(`${Math.hypot(pts[j].x-pts[j-1].x,pts[j].y-pts[j-1].y).toFixed(3)} м`,{...mid,font,size:8});
    }
    if(pts[0])page.drawText(String(i+1),{...point(pts[0]),font,size:10});
    text(`${i+1}. ${EVIDENCE_KINDS[e.kind as keyof typeof EVIDENCE_KINDS]??e.kind}; ±${e.uncertainty?.metres??'?'} м; ${e.source??'нет источника'}`,15,h-55+i*4,8);
  }
  text('Участник ______________  Участник ______________  Составил ______________',60,h-12);
  return pdf.save();
}
