import { type Report, HARM_LABEL } from './analysis';
import { type Corpus, resolveRef } from './corpus';
import { DISCLAIMER, LAW, LAW_CHECKED, refLabel } from './law';
import { type Scene, actorLabels, actorTitle } from './scene';

/** Данные сцены и выводы никогда не вставляются как HTML. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Самодостаточный файл: схема и тексты норм доступны без сети. */
export function reportHtml(scene: Scene, report: Report, image: string, corpus?: Corpus): string {
  const e = escapeHtml;
  const labels = actorLabels(scene);
  const title = (id: string) => {
    const actor = scene.actors.find((a) => a.id === id);
    return actor ? actorTitle(actor, labels) : id;
  };
  const used = [...new Set([
    ...report.findings.flatMap((f) => f.refs),
    ...report.verdicts.flatMap((v) => v.legal.flatMap((l) => l.refs)),
    ...report.duties.flatMap((l) => l.refs),
  ])];
  const anchor = (id: string) => `law-${used.indexOf(id)}`;
  const refs = (ids: string[]) => ids.map((id) => `<a href="#${anchor(id)}">${e(refLabel(id))}</a>`).join(' · ');
  const paras = (texts: string[]) => texts.map((s) => `<p>${e(s)}</p>`).join('');
  const people = report.verdicts.map((v) => `<section><h3>${e(title(v.actorId))}</h3><p>${e(v.text)}</p>${report.findings.filter((f) => f.actorId === v.actorId).map((f) => `<article><h4>${e(f.title)}${f.causal ? ' · причинная связь с ДТП' : ''}</h4><p>${e(f.detail)}</p><p>${f.t === undefined ? '' : `${f.t.toFixed(1)} с · `}${refs(f.refs)}</p></article>`).join('')}${v.legal.length ? '<h4>Возможная ответственность</h4>' : ''}${v.legal.map((l) => `<p>${e(l.text)}<br>${refs(l.refs)}</p>`).join('')}</section>`).join('');
  const collisions = report.collisions.map((c) => `<section><h3>${e(c.title)} · ${c.collision.t.toFixed(2)} с</h3><p>${e(c.description)}</p><ul>${c.harm.map((h) => `<li>${e(title(h.actorId))}: ${e(HARM_LABEL[h.level])}</li>`).join('')}</ul>${paras(c.notes)}${c.tech.map((tech) => `<article><h4>${e(title(tech.actorId))}: техническая возможность</h4><p>Опасность возникла на ${tech.tHazard.toFixed(2)} с. Скорость ${tech.speedKmh.toFixed(1)} км/ч; расстояние до столкновения ${tech.available.toFixed(1)} м; остановочный путь ${tech.stopDist.toFixed(1)} м.</p><p>${tech.avoidable ? 'Техническая возможность остановиться имелась.' : 'Технической возможности остановиться с заданной скоростью не имелось.'} Безопасная расчётная скорость: ${tech.safeKmh.toFixed(1)} км/ч.${tech.limitKmh === undefined ? '' : ` Ограничение: ${tech.limitKmh.toFixed(0)} км/ч; возможность остановиться на разрешённой скорости: ${tech.avoidableAtLimit ? 'имелась' : 'отсутствовала'}.`}</p></article>`).join('')}</section>`).join('');
  const laws = used.map((id) => {
    const full = corpus ? resolveRef(corpus, id) : null;
    const short = LAW[id];
    return `<article id="${anchor(id)}"><h3>${e(full?.cite ?? refLabel(id))}</h3><p>${e(full?.title ?? short?.title ?? '')}</p><p class="law-text">${e(full?.text ?? short?.text ?? 'Текст нормы отсутствует в локальном корпусе. Проверьте действующую редакцию в официальном источнике.')}</p>${(full?.sanction ?? short?.sanction) ? `<p>${e(full?.sanction ?? short?.sanction)}</p>` : ''}</article>`;
  }).join('');
  // Принимается только собственный PNG холста; произвольные URL в файл не переносятся.
  const diagram = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) ? `<figure><img src="${image}" alt="Схема ситуации в момент первого удара и траектории участников"><figcaption>${report.collisions.length ? `Первое столкновение: ${report.collisions[0].collision.t.toFixed(2)} с.` : 'Ситуация в конце расчёта.'} Сплошные линии — пройденный путь, пунктир — заданная траектория.</figcaption></figure>` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${e(scene.name)} — разбор Crashtest</title><style>body{font:15px/1.5 system-ui,sans-serif;color:#17202a;max-width:960px;margin:24px auto;padding:0 20px}h1,h2,h3,h4{line-height:1.25}h2{margin-top:30px;border-bottom:1px solid #aaa}section,article{margin:16px 0}article{border-left:3px solid #aebccc;padding-left:12px}a{color:#175b9e}figure{margin:20px 0}img{width:100%;height:auto}figcaption,.disclaimer{font-size:13px;color:#46515d}.law-text{white-space:pre-wrap}.actions button{font:inherit;padding:8px 14px}@media print{@page{size:A4;margin:16mm}body{margin:0;padding:0;max-width:none;font-size:10pt}.actions{display:none}h2,h3,h4{break-after:avoid}img,article{break-inside:avoid}a{color:inherit}figure{break-inside:avoid}}</style></head><body><div class="actions"><button type="button" onclick="window.print()">Печать / сохранить PDF</button></div><h1>${e(scene.name)}</h1><p>Учебный разбор дорожной ситуации · Crashtest</p><h2>Классификация и вывод</h2>${paras(report.summary)}${diagram}<h2>Участники и нарушения</h2>${people}<h2>Столкновения и техническая возможность</h2>${collisions || '<p>Столкновений в расчёте нет.</p>'}<h2>Хронология</h2><ol>${report.events.map((event) => `<li>${event.t.toFixed(2)} с — ${e(event.text)}</li>`).join('')}</ol><h2>Обязанности после ДТП</h2>${report.duties.map((d) => `<p>${e(d.text)}<br>${refs(d.refs)}</p>`).join('') || '<p>ДТП не зафиксировано.</p>'}<h2>Допущения расчёта</h2><ul>${report.assumptions.map((s) => `<li>${e(s)}</li>`).join('')}</ul><p class="disclaimer">${e(DISCLAIMER)} Нормы и санкции сверены: ${e(LAW_CHECKED)}. Полные тексты выгружены: ${e(corpus?.pdd.fetched ?? 'дата недоступна')}; дата выгрузки не подтверждает действующую редакцию.</p><h2>Нормы, использованные в разборе</h2>${laws}</body></html>`;
}
