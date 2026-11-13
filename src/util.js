// أدوات مساعدة: مقارنة آمنة، تهريب HTML، تنسيق الحجم، إخفاء الأسرار من السجلات

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} بايت`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} ك.ب`;
  return `${(b / 1024 / 1024).toFixed(1)} م.ب`;
}

export function redact(text, env) {
  let t = String(text ?? '');
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'SESSION_SIGNING_KEY']) {
    if (env && env[k]) t = t.split(env[k]).join('[مخفي]');
  }
  return t;
}

export function parseId(v) {
  return typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null;
}
