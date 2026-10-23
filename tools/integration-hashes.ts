/** Node (no DOM) reference hashes for the Node ↔ Chromium determinism check.
 * Usage: node --import tsx tools/integration-hashes.ts '<json {titles, mc}>' */
import { PRESETS } from '../src/presets';
import { createPorts, runProject } from '../src/integration/ports';
import { newProject } from '../src/project/model';
import { canonical, resultJSON, sha256, utf8 } from '../src/project/canonical';

const { titles, mc } = JSON.parse(process.argv[2]) as { titles: string[]; mc: Record<string, unknown> };
const ports = createPorts();
const out: Record<string, string> = {};
for (const title of titles) {
  const p = newProject(PRESETS.find(x => x.title === title)!.build()).project;
  p.extensions.rules = { mode: 'educational' };
  const run = await runProject(p, ports);
  if (run.physics.status !== 'ok' || run.rules?.status !== 'ok') throw new Error(title);
  out[title] = await sha256(utf8(canonical(resultJSON({ physics: run.physics.value, rules: run.rules.value }))));
}
const r = await ports.physics.calculate('reconstruction.monte-carlo', newProject(PRESETS[0].build()).project, mc as never);
if (r.status !== 'ok') throw new Error('mc');
out['monte-carlo'] = await sha256(utf8(canonical(resultJSON(r.value))));
process.stdout.write(JSON.stringify(out));
