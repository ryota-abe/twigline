import type { FileStatusCode } from '../../../shared/protocol';
import { getLang, t } from '../i18n';

export const UNCOMMITTED = 'UNCOMMITTED';

export function shortSha(sha: string, n = 7): string {
  return sha.slice(0, n);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** twigline.history.dateFormat: "relative", "absolute" or a format string (YYYY MM DD HH mm ss) */
export function formatDate(unixSeconds: number, format: string, now = Date.now()): string {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  if (format === 'relative') return relative(unixSeconds * 1000, now);
  const f = format === 'absolute' || !format ? 'YYYY-MM-DD HH:mm' : format;
  return f
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

function relative(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  const lang = getLang();
  const unit = (n: number, ja: string, en: string) => (lang === 'ja' ? `${n} ${ja}前` : `${n} ${en}${n === 1 ? '' : 's'} ago`);
  if (s < 60) return lang === 'ja' ? 'たった今' : 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), '分', 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), '時間', 'hour');
  if (s < 86400 * 30) return unit(Math.floor(s / 86400), '日', 'day');
  if (s < 86400 * 365) return unit(Math.floor(s / (86400 * 30)), 'か月', 'month');
  return unit(Math.floor(s / (86400 * 365)), '年', 'year');
}

export function fullDate(unixSeconds: number): string {
  return formatDate(unixSeconds, 'YYYY-MM-DD HH:mm:ss');
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

export function statusLabel(s: FileStatusCode): string {
  switch (s) {
    case 'A':
      return t('status.added');
    case 'M':
      return t('status.modified');
    case 'D':
      return t('status.deleted');
    case 'R':
      return t('status.renamed');
    case 'C':
      return t('status.copied');
    case 'T':
      return t('status.typeChanged');
    case 'U':
      return t('status.conflicted');
    case '?':
      return t('status.untracked');
  }
}

/** Graph color: hex as is; a theme color ID (such as charts.blue) becomes a CSS variable */
export function laneColor(colors: string[], index: number): string {
  const c = colors[index % colors.length] ?? '#888';
  if (/^[a-zA-Z]+(\.[a-zA-Z0-9]+)+$/.test(c)) return `var(--vscode-${c.replace(/\./g, '-')})`;
  return c;
}

/** Build a class name */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
