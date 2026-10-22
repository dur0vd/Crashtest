import { it,expect } from 'vitest';
import { newProject } from '../src/project/model';
import { emptyScene } from '../src/scene';
import { newEvidence,rasterTransform,evidenceIssues } from '../src/evidence/model';
import { schemeSVG } from '../src/evidence/svg';
import { timelineTime,videoCalculation,LocalVideo } from '../src/media/video';
import { readFile } from 'node:fs/promises';
it('survey transform maps both real reference points, no perspective claim',()=>{
  const t=rasterTransform({attachmentId:'a',pixelA:{x:10,y:20},pixelB:{x:110,y:20},worldA:{x:3,y:4},worldB:{x:3,y:14},opacity:0.5});
  expect(t.a*10+t.c*20+t.e).toBeCloseTo(3);expect(t.b*110+t.d*20+t.f).toBeCloseTo(14);
});
it('observations remain immutable when inconsistent with computed observations',()=>{
  const p=newProject(emptyScene()).project;p.evidence=[newEvidence('impact',[{x:1,y:2}],{establishedBy:'Осмотр',confidence:0.8},'Протокол',0.1)];const before=JSON.stringify(p.evidence);
  expect(evidenceIssues(p,[{...p.evidence[0],geometry:{points:[{x:5,y:2}]}}]).join()).toContain('расходится');expect(JSON.stringify(p.evidence)).toBe(before);
});
it('scale SVG uses physical mm, metric dimensions, empty signatures and escapes evidence',()=>{
  const p=newProject(emptyScene()).project;p.evidence=[newEvidence('braking',[{x:0,y:0},{x:3,y:4}],{},'<script>',0.01)];
  const svg=schemeSVG(p,{scale:100,originX:0,originY:0});expect(svg).toContain('420mm');expect(svg).toContain('15,25 45,65');expect(svg).toContain('5.000 м');expect(svg).toContain('&lt;script&gt;');expect(svg).toContain('__________________');
});
it('sync maps measured PTS offsets and unavailable port is explicit',async()=>{
  expect(timelineTime(12.7,10,3)).toBeCloseTo(5.7);expect((await videoCalculation(undefined,'video.homography',newProject(emptyScene()).project,{})).status).toBe('unsupported');
});
it('real VFR container index matches independently generated ffmpeg timestamps',async()=>{
  const bytes=await readFile(new URL('./fixtures/graphics/vfr.webm',import.meta.url));const video=new LocalVideo(new Blob([bytes]));
  try{const index=await video.index();expect(index.vfr).toBe(true);expect(index.frames.map(f=>f.pts)).toEqual([0,0.04,0.12,0.16,0.28]);expect(index.width).toBe(160);}finally{video.destroy();}
});
