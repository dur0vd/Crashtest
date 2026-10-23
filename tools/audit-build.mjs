#!/usr/bin/env node
/**
 * Stage 18 build audit: fails when the built app (dist/) contains an external
 * URL whose host is not explicitly allowed with a reason. Allowed hosts are
 * never requested by the app: XML namespaces, legal/scientific sources shown
 * as links the user may open, and comments of bundled libraries. Runtime
 * requests are checked separately in Chromium (tests/browser/*.spec.ts).
 * Usage: node tools/audit-build.mjs [dist]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ALLOWED = {
  // XML namespaces of generated DOCX/SVG/XMP — identifiers, not requests.
  'schemas.microsoft.com': 'namespace', 'schemas.openxmlformats.org': 'namespace', 'purl.org': 'namespace',
  'www.w3.org': 'namespace', 'ns.adobe.com': 'namespace',
  // Sources of norms and studies, displayed as links only.
  'www.consultant.ru': 'source link', 'www.garant.ru': 'source link', 'publication.pravo.gov.ru': 'source link',
  'sudact.ru': 'source link', 'epp.genproc.gov.ru': 'source link', 'cbr.ru': 'source link', 'www.cbr.ru': 'source link',
  '14.mchs.gov.ru': 'source link', 'pmc.ncbi.nlm.nih.gov': 'source link', 'aaafoundation.org': 'source link',
  // Strings inside bundled third-party libraries (comments/error messages).
  'github.com': 'library text', 'stuk.github.io': 'library text', 'rolldown.rs': 'library text', 'answers.microsoft.com': 'library text',
  // Licence/provenance comments of the stdlib fdlibm ports (src/dmath.ts).
  'www.apache.org': 'library licence', 'svnweb.freebsd.org': 'library provenance', 'www.netlib.org': 'library provenance', 'golang.org': 'library provenance',
};

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(js|mjs|html|css|json|webmanifest|svg)$/.test(e.name)) yield p;
  }
}

export async function auditBuild(dist = 'dist') {
  const unknown = new Map(), seen = new Map();
  for await (const file of files(dist)) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)) {
      const host = m[1].toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1') { unknown.set(host, file); continue; }
      seen.set(host, (seen.get(host) ?? 0) + 1);
      if (!(host in ALLOWED)) unknown.set(host, file);
    }
  }
  return { unknown: [...unknown].map(([host, file]) => ({ host, file })), hosts: Object.fromEntries(seen) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await auditBuild(process.argv[2] ?? 'dist');
  if (result.unknown.length) {
    console.error('Неразрешённые внешние адреса в сборке:', JSON.stringify(result.unknown, null, 1));
    process.exitCode = 1;
  } else console.log(`Внешних адресов вне списка нет; хосты: ${JSON.stringify(result.hosts)}`);
}
