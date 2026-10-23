export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function button(
  text: string,
  action: () => void | Promise<void>,
): HTMLButtonElement {
  const b = el('button', text);
  b.type = 'button';
  b.onclick = () => void action();
  return b;
}
export function label(text: string, control: HTMLElement): HTMLLabelElement {
  const l = el('label', text);
  control.setAttribute('aria-label', text);
  l.append(control);
  return l;
}
export function input(value: string, type = 'text'): HTMLInputElement {
  const i = el('input');
  i.type = type;
  i.value = value;
  return i;
}
export function textarea(value: string): HTMLTextAreaElement {
  const i = el('textarea');
  i.value = value;
  return i;
}
export function select(
  options: [string, string][],
  value = options[0]?.[0] ?? '',
): HTMLSelectElement {
  const s = el('select');
  for (const [v, t] of options) {
    const o = el('option', t);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  return s;
}
export function details(title: string, text: string): HTMLDetailsElement {
  const d = el('details');
  d.append(el('summary', title), el('pre', text));
  return d;
}
export function downloadBytes(
  name: string,
  bytes: Uint8Array,
  type: string,
): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type })),
    a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
export const jsonText = (v: unknown): string => JSON.stringify(v, null, 2);
