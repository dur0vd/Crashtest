import {
  Input,
  BlobSource,
  MP4,
  QTFF,
  WEBM,
  MATROSKA,
  OGG,
  MPEG_TS,
  EncodedPacketSink,
  VideoSampleSink,
  type InputVideoTrack,
} from 'mediabunny';
import type {
  PhysicsPort,
  ProjectEnvelope,
  JsonObject,
  FeatureResult,
  CalculationRecord,
  RunControl,
} from '../parallel/contracts';
export interface FrameStamp {
  index: number;
  pts: number;
  duration: number;
  key: boolean;
}
export interface VideoIndex {
  frames: FrameStamp[];
  vfr: boolean;
  width: number;
  height: number;
  codec: string | null;
}
export class LocalVideo {
  private input: Input;
  private track: InputVideoTrack | null = null;
  private decoder: VideoSampleSink | null = null;
  constructor(blob: Blob) {
    this.input = new Input({
      source: new BlobSource(blob),
      formats: [MP4, QTFF, WEBM, MATROSKA, OGG, MPEG_TS],
    });
  }
  async index(control: RunControl = {}): Promise<VideoIndex> {
    this.track = await this.input.getPrimaryVideoTrack();
    if (!this.track)
      throw new Error('Нет видеодорожки / неподдерживаемый контейнер');
    const frames: FrameStamp[] = [];
    const sink = new EncodedPacketSink(this.track);
    for await (const packet of sink.packets(undefined, undefined, {
      metadataOnly: true,
    })) {
      if (control.isCancelled?.()) throw new Error('Отменено');
      if (frames.length >= 200000)
        throw new Error('Лимит индекса 200000 кадров; оригинал сохранён');
      frames.push({
        index: frames.length,
        pts: packet.timestamp,
        duration: packet.duration,
        key: packet.type === 'key',
      });
      if (frames.length % 500 === 0) control.onProgress?.(frames.length, 0);
    }
    frames.sort((a, b) => a.pts - b.pts);
    frames.forEach((f, i) => (f.index = i));
    if (!frames.length) throw new Error('Нет меток кадров');
    const intervals = frames.slice(1).map((f, i) => f.pts - frames[i].pts),
      reference = intervals[0] ?? 0;
    return {
      frames,
      vfr: intervals.some(
        (d) => Math.abs(d - reference) > Math.max(1e-6, reference * 0.001),
      ),
      width: await this.track.getDisplayWidth(),
      height: await this.track.getDisplayHeight(),
      codec: await this.track.getCodec(),
    };
  }
  async draw(stamp: FrameStamp, canvas: HTMLCanvasElement): Promise<number> {
    if (!this.track) throw new Error('Сначала индексируйте видео');
    if (!(await this.track.canDecode()))
      throw new Error(
        'Этот кодек не декодируется браузером; PTS и оригинал сохранены',
      );
    this.decoder ??= new VideoSampleSink(this.track);
    const sample = await this.decoder.getSample(stamp.pts + 1e-8);
    if (!sample) throw new Error('Кадр недоступен');
    try {
      if (Math.abs(sample.timestamp - stamp.pts) > 1e-5)
        throw new Error('Декодированный PTS не совпал; разметка заблокирована');
      canvas.width = sample.displayWidth;
      canvas.height = sample.displayHeight;
      sample.draw(canvas.getContext('2d')!, 0, 0);
      return sample.timestamp;
    } finally {
      sample.close();
    }
  }
  destroy(): void {
    this.input.dispose();
    this.decoder = null;
    this.track = null;
  }
}
export interface VideoAnnotation {
  attachmentId: string;
  pts: number;
  frameIndex: number;
  pixel: { x: number; y: number };
  sigmaPx: number;
  kind: 'wheel-ground' | 'calibration';
  world?: { x: number; y: number };
  sigmaM?: number;
  actorId?: string;
}
export function videoCalculation(
  port: PhysicsPort | undefined,
  method: 'video.homography' | 'video.trajectory',
  project: ProjectEnvelope,
  parameters: JsonObject,
  control?: RunControl,
): Promise<FeatureResult<CalculationRecord[]>> {
  if (!port)
    return Promise.resolve({
      status: 'unsupported',
      issues: [
        { code: 'no-physics-port', message: 'Расчёт недоступен в этой сборке' },
      ],
    });
  return port.calculate(method, project, parameters, control);
}
/** Explicit observed synchronization, no derivation from nominal FPS/seek. */
export function timelineTime(
  pts: number,
  observedVideoPTS: number,
  observedTimelineSeconds: number,
): number {
  return pts - observedVideoPTS + observedTimelineSeconds;
}
