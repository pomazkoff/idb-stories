/**
 * Построение DOM без HTML-строк (T3, раздел 10.6): только createElement и textContent.
 * Стили — классы из styles.css; динамические значения — только через CSSOM (element.style.x),
 * что разрешено строгим CSP без 'unsafe-inline'.
 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function button(className: string, label: string, text?: string): HTMLButtonElement {
  const b = h('button', className, text);
  b.type = 'button';
  if (text === undefined) b.setAttribute('aria-label', label);
  return b;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  close: ['M6 6l12 12', 'M18 6L6 18'],
  pause: ['M9 5v14', 'M15 5v14'],
  play: ['M7 5l12 7-12 7z'],
  sound: ['M4 9h4l5-4v14l-5-4H4z', 'M16.5 8.5a5 5 0 010 7', 'M19 6a8.5 8.5 0 010 12'],
  muted: ['M4 9h4l5-4v14l-5-4H4z', 'M16 9l6 6', 'M22 9l-6 6'],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `idbs-icon idbs-icon--${name}`);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function setIcon(target: HTMLElement, name: IconName): void {
  target.replaceChildren(icon(name));
}

const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [contenteditable]';

export function isInteractive(target: EventTarget | null, within: Element): boolean {
  if (!(target instanceof Element)) return false;
  const hit = target.closest(INTERACTIVE);
  return hit !== null && within.contains(hit);
}

export function focusable(root: Element): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hidden && el.closest('[hidden]') === null);
}
