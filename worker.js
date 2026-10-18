import * as lead from './functions/api/lead.js';
import * as tg from './functions/api/tg.js';

const routes = { '/api/lead': lead, '/api/tg': tg };

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    const mod = routes[path];

    if (!mod) {
      const res = await env.ASSETS.fetch(request);
      const ct = res.headers.get('content-type') || '';
      if (env.TURNSTILE_SITEKEY && ct.includes('text/html')) {
        const tag = `<script>window.TURNSTILE_SITEKEY=${JSON.stringify(String(env.TURNSTILE_SITEKEY))};</script>`;
        return new HTMLRewriter()
          .on('body', { element(e) { e.append(tag, { html: true }); } })
          .transform(res);
      }
      return res;
    }

    const m = request.method.toUpperCase();
    const handler = mod['onRequest' + m[0] + m.slice(1).toLowerCase()] || mod.onRequest;
    if (!handler) return new Response('Method Not Allowed', { status: 405 });
    return handler({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
  },
};
