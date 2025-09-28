// Basic utilities shared across modules
export const now = () => Date.now();

export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

export const shortHex = (s, a = 6, b = 6) =>
  s ? s.slice(0, a) + '…' + s.slice(-b) : '—';

export const fmtAgo = (ms) => {
  if (ms < 1500) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  return d + 'd';
};

export const isHex64 = (s) => /^[0-9a-f]{64}$/i.test((s || '').trim());

export const isMobile = /Mobi|Android/i.test(navigator.userAgent);
