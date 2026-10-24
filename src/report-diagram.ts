import { Renderer } from './render';
import type { Scene } from './scene';
import { DT, type Timeline } from './sim';

/** Отдельный холст не меняет камеру, выбранный объект и позицию плеера. */
export async function reportDiagram(scene: Scene, timeline: Timeline): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 800;
  const renderer = new Renderer(canvas);
  renderer.w = canvas.width;
  renderer.h = canvas.height;
  const time = timeline.collisions[0]?.t ?? timeline.duration;
  const frame = Math.min(timeline.n - 1, Math.round(time / DT));
  const points = scene.actors.flatMap((actor) => {
    const track = timeline.tracks.get(actor.id);
    return [{ x: actor.x, y: actor.y }, ...actor.path, ...(track?.present[frame] ? [{ x: track.x[frame], y: track.y[frame] }] : [])];
  });
  if (!points.length) points.push({ x: 0, y: 0 });
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs) - 10, x1 = Math.max(...xs) + 10;
  const y0 = Math.min(...ys) - 10, y1 = Math.max(...ys) + 10;
  const cam = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, s: Math.min(1200 / (x1 - x0), 800 / (y1 - y0)) };
  const view = { scene, cam, mode: 'play' as const, t: time, tl: timeline, report: null, sel: null, selWp: null, drawing: null, pathActor: null, ghost: null, grid: false, focus: null };
  renderer.draw(view);
  await renderer.imagesReady();
  renderer.draw(view);
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.translate(600, 400);
  ctx.scale(cam.s, cam.s);
  ctx.translate(-cam.x, -cam.y);
  ctx.setLineDash([0.8, 0.7]);
  ctx.lineWidth = 1.5 / cam.s;
  for (const actor of scene.actors) {
    ctx.beginPath();
    ctx.moveTo(actor.x, actor.y);
    for (const waypoint of actor.path) ctx.lineTo(waypoint.x, waypoint.y);
    ctx.strokeStyle = actor.color;
    ctx.stroke();
  }
  ctx.restore();
  return canvas.toDataURL('image/png');
}
