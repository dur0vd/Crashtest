import exifr from 'exifr';
import { sha256 } from '../project/canonical';
import type { Attachment } from '../project/model';
import type { JsonValue } from '../parallel/contracts';
export async function readAttachment(file: File): Promise<Attachment> {
  if (file.size > 128 * 1024 * 1024) throw new Error('Лимит вложения 128 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let exif: JsonValue = null,
    exifStatus = 'not-applicable';
  if (file.type.startsWith('image/')) {
    try {
      const data = await exifr.parse(bytes, {
        gps: true,
        tiff: true,
        exif: true,
      });
      exif = data ? JSON.parse(JSON.stringify(data)) : null;
      exifStatus = data ? 'parsed' : 'not-found';
    } catch {
      exifStatus = 'unsupported-or-invalid';
    }
  }
  return {
    id: crypto.randomUUID(),
    name: file.name,
    type: file.type,
    bytes,
    metadata: {
      sha256: await sha256(bytes),
      exif,
      exifStatus,
      importedAt: new Date().toISOString(),
      lastModified: file.lastModified,
    },
  };
}
