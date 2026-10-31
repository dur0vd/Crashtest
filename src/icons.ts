const PATHS = {
  select: 'M5 3.5 19 13l-6.5 1.2L9 20.5 5 3.5Z M12.5 14.2l4.2 5.3',
  pan: 'M8 12V6.5a1.5 1.5 0 0 1 3 0V11 M11 10V4.5a1.5 1.5 0 0 1 3 0V11 M14 10V6.5a1.5 1.5 0 0 1 3 0V12 M17 10.5a1.5 1.5 0 0 1 3 0V15c0 3.3-2.5 6-5.5 6H12a5 5 0 0 1-4-2L4.4 14a1.6 1.6 0 0 1 2.4-2.1L9 14',
  road: 'M7 3 3 21 M17 3l4 18 M12 3v3 M12 10v4 M12 18v3',
  sidewalk: 'M4 4h16v16H4Z M9 4v16 M9 9h11 M9 15h11 M14 4v5 M16 9v6 M13 15v5',
  track: 'M6 3v18 M18 3v18 M4 7h16 M4 12h16 M4 17h16',
  railway: 'M3 5h18 M3 10h18 M7 3v9 M12 3v9 M17 3v9 M3 17h18 M5 14l3 6 M11 14l3 6 M17 14l3 6',
  crosswalk: 'M3 5v14 M21 5v14 M7 6v12 M12 6v12 M17 6v12 M6 6h2v12H6Z M11 6h2v12h-2Z M16 6h2v12h-2Z',
  light: 'M9 3h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M12 19v3 M12 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z M12 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z M12 13.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  sign: 'M10.4 4.1a1.8 1.8 0 0 1 3.2 0l7 12.4a1.7 1.7 0 0 1-1.5 2.5H4.9a1.7 1.7 0 0 1-1.5-2.5l7-12.4Z M12 8v4 M12 15.2v.1 M12 19v3',
  marking: 'M3 6h18 M3 18h18 M4 11h4 M11 11h4 M18 11h3 M4 14h4 M11 14h4 M18 14h3',
  obstacle: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16 M16 10h3a1 1 0 0 1 1 1v10 M2 21h20 M8 7h1 M12 7h1 M8 11h1 M12 11h1 M8 15h1 M12 15h1 M9 21v-3h3v3',
  vehicle: 'M5 10l1.3-4.1A2 2 0 0 1 8.2 4.5h7.6a2 2 0 0 1 1.9 1.4L19 10 M5 10h14a2 2 0 0 1 2 2v5H3v-5a2 2 0 0 1 2-2Z M3 17v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2 M18 17v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2 M6.5 13.5H8 M16 13.5h1.5 M2 9h2 M20 9h2',
  ped: 'M13.5 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M9 21l2-6 M16 21l-3-6v-5 M6 13l3-4 4-1 3 4 3 1 M10 9l-1 5 4 2',
  path: 'M4 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M6 7h10a4 4 0 0 1 0 8h-5a2 2 0 0 0 0 4h6 M14 16l3 3-3 3',
  undo: 'M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 6 6v3',
  redo: 'M15 5l5 5-5 5 M20 10H10a6 6 0 0 0-6 6v3',
  examples: 'M5 3h10l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M14 3v5h5 M8 12h7 M8 16h5',
  menu: 'M5 11.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z M12 11.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z M19 11.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  fit: 'M9 4H4v5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5 M9 9h6v6H9Z',
  follow: 'M9 5 7.5 7H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-3.5L15 5H9Z M12 9.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
  play: 'm9 5 11 7-11 7V5Z',
  pause: 'M8 5v14 M16 5v14',
  restart: 'M5 5v14 M19 5 8 12l11 7V5Z',
  edit: 'm15 5 4 4 M4 20l4.5-1L20 7.5a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z',
  panel: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M14 4v16 M17 8h.1 M17 12h.1 M17 16h.1',
  close: 'M6 6l12 12 M18 6 6 18',
  chevron: 'm8 5 7 7-7 7',
  book: 'M12 6c-3-2-6-2.5-10-1v15c4-1.5 7-1 10 1 3-2 6-2.5 10-1V5c-4-1.5-7-1-10 1Z M12 6v15 M5 9c1.5-.2 3 .1 4 .7 M15 9.7c1-.6 2.5-.9 4-.7',
  layers: 'm12 3 10 5-10 5L2 8l10-5Z M2 12l10 5 10-5 M2 16l10 5 10-5',
  check: 'm5 12 4 4L19 6',
  save: 'M5 3h12l4 4v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2Z M7 3v6h9V3 M7 21v-8h10v8 M13 3v3',
  sparkles: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z M20 2v4 M18 4h4 M4 19v3 M2.5 20.5h3',
} as const;

export type IconName = keyof typeof PATHS;

/** Декоративная иконка: доступное название задаётся на родительской кнопке. */
export function icon(name: IconName): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('class', 'ui-icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}
