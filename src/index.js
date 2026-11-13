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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, service: 'unilib' });
    }

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
