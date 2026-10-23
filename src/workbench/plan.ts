import { Renderer, worldToScreen, screenToWorld, type Camera } from '../render';
import type { ProjectEnvelope, PhysicsOutput } from '../parallel/contracts';
import {
  pointsOf,
  type Point,
  rasterTransform,
  type RasterCalibration,
} from '../evidence/model';
import type { Attachment } from '../project/model';
export function mountPlan(
  canvas: HTMLCanvasElement,
  getProject: () => ProjectEnvelope,
  getOutput: () => PhysicsOutput | undefined,
  onPoint: (p: Point) => void,
  getAttachments: () => Attachment[],
): { draw: (time?: number) => void; destroy: () => void } {
  const renderer = new Renderer(canvas);
  const cam: Camera = { x: 0, y: 0, s: 5 };
  let time = 0,
    dead = false;
  const first = getProject().scene.actors[0];
  if (first) {
    cam.x = first.x;
    cam.y = first.y;
  }
  let image: ImageBitmap | undefined,
    imageId = '';
  async function background() {
    const raw = getProject().extensions.workspace.raster as unknown as
      RasterCalibration | undefined;
    if (!raw?.attachmentId || raw.attachmentId === imageId) return;
    imageId = raw.attachmentId;
    const a = getAttachments().find((a) => a.id === raw.attachmentId);
    if (a) {
      try {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(a.bytes)]),
        );
        if (dead) {
          bitmap.close();
          return;
        }
        image?.close();
        image = bitmap;
        draw();
      } catch {
        imageId = '';
      }
    }
  }
  function draw(t = time): void {
    if (dead) return;
    time = t;
    renderer.resize();
    const project = getProject(),
      out = getOutput();
    renderer.draw({
      scene: project.scene,
      cam,
      mode: out ? 'play' : 'edit',
      t: time,
      tl: out?.timeline ?? null,
      report: null,
      sel: null,
      selWp: null,
      drawing: null,
      pathActor: null,
      ghost: null,
      grid: true,
      focus: null,
    });
    const ctx = canvas.getContext('2d')!,
      w = renderer.w,
      h = renderer.h;
    ctx.setTransform(renderer.dpr, 0, 0, renderer.dpr, 0, 0);
    const pt = (p: Point) => worldToScreen(cam, w, h, p);
    const raw = project.extensions.workspace.raster as unknown as
      RasterCalibration | undefined;
    if (raw && image) {
      try {
        const tr = rasterTransform(raw);
        ctx.save();
        ctx.translate(w / 2 - cam.x * cam.s, h / 2 - cam.y * cam.s);
        ctx.scale(cam.s, cam.s);
        ctx.transform(tr.a, tr.b, tr.c, tr.d, tr.e, tr.f);
        ctx.globalAlpha = Math.max(0, Math.min(1, raw.opacity));
        ctx.drawImage(image, 0, 0);
        ctx.restore();
      } catch {
        /* invalid calibration is shown by the form */
      }
    }
    for (const e of project.evidence) {
      const pts = pointsOf(e);
      ctx.strokeStyle = '#ffe278';
      ctx.fillStyle = '#ffe278';
      ctx.lineWidth = Math.max(2, Number(e.values.width ?? 0) * cam.s);
      ctx.setLineDash(e.values.absIntermittent === true ? [8, 5] : []);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const q = pt(p);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke();
      if (pts[0]) {
        const q = pt(pts[0]);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '12px sans-serif';
        ctx.fillText(e.kind, q.x + 6, q.y - 5);
      }
    }
    ctx.setLineDash([]);
    const zones = project.extensions.physics.zones;
    if (Array.isArray(zones))
      for (const z of zones) {
        if (
          z &&
          typeof z === 'object' &&
          !Array.isArray(z) &&
          Array.isArray(z.boundary)
        ) {
          ctx.strokeStyle = '#53ecff';
          ctx.beginPath();
          z.boundary.forEach((p, i) => {
            if (
              p &&
              typeof p === 'object' &&
              !Array.isArray(p) &&
              typeof p.x === 'number' &&
              typeof p.y === 'number'
            ) {
              const q = pt({ x: p.x, y: p.y });
              if (i) ctx.lineTo(q.x, q.y);
              else ctx.moveTo(q.x, q.y);
            }
          });
          ctx.closePath();
          ctx.stroke();
        }
      }
    // Optional rendering adapter. Every coordinate/vector comes from the port.
    const samples = out?.renderData?.samples;
    if (Array.isArray(samples))
      for (const s of samples) {
        if (
          !s ||
          typeof s !== 'object' ||
          Array.isArray(s) ||
          typeof s.t !== 'number' ||
          Math.abs(s.t - time) > (out?.timeline.dt ?? 0.025) / 2
        )
          continue;
        if (Array.isArray(s.wheels))
          for (const wheel of s.wheels) {
            if (
              wheel &&
              typeof wheel === 'object' &&
              !Array.isArray(wheel) &&
              typeof wheel.x === 'number' &&
              typeof wheel.y === 'number'
            ) {
              const p = pt({ x: wheel.x, y: wheel.y });
              ctx.fillStyle = '#fff';
              ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
            }
          }
        if (Array.isArray(s.vectors))
          for (const v of s.vectors) {
            if (
              v &&
              typeof v === 'object' &&
              !Array.isArray(v) &&
              [v.x, v.y, v.dx, v.dy].every((n) => typeof n === 'number')
            ) {
              const a = pt({ x: Number(v.x), y: Number(v.y) }),
                b = pt({
                  x: Number(v.x) + Number(v.dx),
                  y: Number(v.y) + Number(v.dy),
                });
              ctx.strokeStyle = '#ff6978';
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
              ctx.fillText(
                `${v.label ?? ''} ${v.value ?? ''} ${v.unit ?? ''}`,
                b.x,
                b.y,
              );
            }
          }
        if (Array.isArray(s.visibility))
          for (const p of s.visibility) {
            if (
              p &&
              typeof p === 'object' &&
              !Array.isArray(p) &&
              typeof p.x === 'number' &&
              typeof p.y === 'number'
            ) {
              const q = pt({ x: p.x, y: p.y });
              ctx.fillStyle = '#51e39d';
              ctx.beginPath();
              ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
      }
    ctx.fillStyle = 'white';
    ctx.font = '12px sans-serif';
    ctx.fillText(
      `1 м = ${cam.s.toFixed(1)} px · ${time.toFixed(3)} с · векторы: масштаб порта`,
      10,
      18,
    );
    void background();
  }
  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    onPoint(
      screenToWorld(cam, r.width, r.height, {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      }),
    );
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      cam.x += e.deltaX / cam.s;
      cam.y += e.deltaY / cam.s;
    } else
      cam.s = Math.max(0.2, Math.min(100, cam.s * Math.exp(-e.deltaY * 0.001)));
    draw();
  };
  const observer = new ResizeObserver(() => draw());
  observer.observe(canvas);
  renderer.onImage = () => draw();
  draw();
  return {
    draw,
    destroy() {
      dead = true;
      observer.disconnect();
      image?.close();
      canvas.onclick = null;
      canvas.onwheel = null;
    },
  };
}
