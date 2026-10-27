import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Публичные страницы документов: те же тексты, что в приложении, — по прямой ссылке для автошкол и платёжных сервисов. */
const PAGES: [string, string][] = [
  ['terms', 'docs/legal/terms.md'],
  ['offer', 'docs/legal/subscription-offer.md'],
  ['privacy', 'docs/legal/privacy.md'],
  ['pilot', 'docs/legal/pilot-agreement.md'],
  ['sources', 'docs/legal/third-party.md'],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');

/** Тот же упрощённый markdown, что и в src/legal.ts: заголовки, цитаты, списки, таблицы, абзацы. */
export function markdownToHtml(src: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list = false;
  let table = false;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const end = () => {
    flush();
    if (list) out.push('</ul>');
    if (table) out.push('</table>');
    list = table = false;
  };
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t) end();
    else if (t.startsWith('|')) {
      if (/^\|[-| :]+\|$/.test(t)) continue;
      const cells = t.slice(1, -1).split('|').map((c) => inline(c.trim()));
      if (!table) {
        end();
        table = true;
        out.push(`<table><tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr>`);
      } else out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
    } else if (t.startsWith('- ')) {
      flush();
      if (!list) {
        list = true;
        out.push('<ul>');
      }
      out.push(`<li>${inline(t.slice(2))}</li>`);
    } else if (t.startsWith('## ')) {
      end();
      out.push(`<h2>${inline(t.slice(3))}</h2>`);
    } else if (t.startsWith('# ')) {
      end();
      out.push(`<h1>${inline(t.slice(2))}</h1>`);
    } else if (t.startsWith('> ')) {
      end();
      out.push(`<p class="note">${inline(t.slice(2))}</p>`);
    } else para.push(t);
  }
  end();
  return out.join('\n');
}

export function legalPagesPlugin(): Plugin {
  let root = '';
  return {
    name: 'юридические-страницы',
    apply: 'build',
    configResolved(c) { root = c.root; },
    generateBundle() {
      const nav = PAGES.map(([name, file]) => `<a href="${name}.html">${esc(readFileSync(join(root, file), 'utf8').match(/^# (.+)$/m)?.[1] ?? name)}</a>`).join(' · ');
      for (const [name, file] of PAGES) {
        const md = readFileSync(join(root, file), 'utf8');
        const title = md.match(/^# (.+)$/m)?.[1] ?? 'Документ';
        this.emitFile({
          type: 'asset',
          fileName: `legal/${name}.html`,
          source: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Crashtest</title>`
            + '<style>body{font:16px/1.6 system-ui,sans-serif;color:#17202a;max-width:820px;margin:0 auto;padding:24px 16px 48px}h1{line-height:1.25}h2{margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #c9d1dc;padding:6px 8px;text-align:left}.note{color:#46515d;border-left:3px solid #aebccc;padding-left:10px}nav{font-size:14px;margin-bottom:20px}a{color:#175b9e}</style></head><body>'
            + `<nav><a href="../about.html">Crashtest</a> · ${nav}</nav>${markdownToHtml(md)}</body></html>`,
        });
      }
    },
  };
}
