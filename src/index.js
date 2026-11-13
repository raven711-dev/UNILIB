// UNILIB — نقطة الدخول: يستقبل Webhook من Telegram بعد التحقق من الرمز السري
import { handleUpdate } from './bot.js';
import { claimUpdate } from './db.js';
import { safeEqual, redact } from './util.js';

const MAX_BODY = 200_000; // بايت

async function processUpdate(env, update) {
  try {
    if (!Number.isSafeInteger(update?.update_id)) return;
    if (!(await claimUpdate(env.DB, update.update_id))) return; // تحديث مكرر
    await handleUpdate(env, update);
  } catch (e) {
    console.error('update failed:', redact(e?.message, env));
  }
}

// خطوة إعداد لمرة واحدة: تسجّل الـ Webhook لدى Telegram. تعمل فقط إذا وُجد السر SETUP_KEY،
// ويُحذف هذا السر بعد النجاح فتتعطل الخطوة تمامًا.
async function setup(url, env) {
  if (!env.SETUP_KEY) return new Response('Not found', { status: 404 });
  if (!safeEqual(url.searchParams.get('key') ?? '', env.SETUP_KEY)) return new Response('Forbidden', { status: 403 });
  const out = (obj, status = 200) =>
    Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!env.TELEGRAM_BOT_TOKEN) return out({ ok: false, error: 'TELEGRAM_BOT_TOKEN غير مضبوط' }, 400);
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? '')) {
    return out({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET غير مضبوط أو غير صالح (16 حرفًا فأكثر: حروف إنجليزية وأرقام و _ و -)' }, 400);
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${url.origin}/webhook`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      max_connections: 20,
    }),
  });
  const data = await res.json().catch(() => null);
  return out({ ok: !!data?.ok, description: redact(data?.description ?? 'لا رد من Telegram', env) }, data?.ok ? 200 : 502);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, service: 'unilib' });
    }

    if (url.pathname === '/setup' && request.method === 'GET') return setup(url, env);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret ?? '', env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response('Forbidden', { status: 403 });
      }
      const len = Number(request.headers.get('content-length') ?? 0);
      if (len > MAX_BODY) return new Response('Payload too large', { status: 413 });
      let update;
      try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      ctx.waitUntil(processUpdate(env, update)); // الرد السريع على Telegram ثم المعالجة
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  },
};
