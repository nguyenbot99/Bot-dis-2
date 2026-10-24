const BaseDO = await import('cloudflare:workers')
  .then(m => m.DurableObject)
  .catch(
    () =>
      class {
        constructor(ctx, env) {
          this.ctx = ctx;
          this.env = env;
        }
      },
  );

const UI_URL =
  'https://raw.githubusercontent.com/nguyenbot99/Bot-dis-2/main/web/index.html';

let memoryState = null;
let cachedHtml = null;
let cachedHtmlAt = 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function withLivePosition(state) {
  if (!state || typeof state !== 'object') {
    return {
      bot: { ready: false, name: 'Discord Music Bot', avatarUrl: null },
      status: 'idle',
      statusLabel: '\uD83D\uDCA4 Ch\u01B0a ph\u00E1t nh\u1EA1c',
      reason: '\u0110ang ch\u1EDD t\u00EDn hi\u1EC7u \u0111\u1EA7u ti\u00EAn t\u1EEB bot Discord...',
      serverTimeMs: Date.now(),
      voiceChannelName: null,
      settings: {
        volume: 100,
        loopMode: 'off',
        loopLabel: 'T\u1EAFt l\u1EB7p',
        autoPlay: false,
        stay247: false,
        soundLabel: 'R\u00F5 n\u00E9t HD',
      },
      track: null,
      upcoming: [],
      history: [],
    };
  }
  if (state.status === 'playing' && state.track && state.serverTimeMs) {
    const elapsed = Math.max(0, Date.now() - Number(state.serverTimeMs));
    const total = Math.max(0, Number(state.track.durationMs) || 0);
    let pos = Math.max(0, (Number(state.track.positionMs) || 0) + elapsed);
    if (total > 0 && pos > total) pos = total;
    return {
      ...state,
      serverTimeMs: Date.now(),
      track: { ...state.track, positionMs: pos },
    };
  }
  return { ...state, serverTimeMs: Date.now() };
}

async function loadHtml() {
  const now = Date.now();
  if (cachedHtml && now - cachedHtmlAt < 300000) return cachedHtml;
  try {
    const res = await fetch(UI_URL, { cf: { cacheTtl: 300 } });
    if (res.ok) {
      cachedHtml = await res.text();
      cachedHtmlAt = now;
      return cachedHtml;
    }
  } catch {}
  return cachedHtml || '<!doctype html><meta charset="utf-8"><title>Now Playing</title>';
}

export class NowPlayingRoom extends BaseDO {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    if (ctx?.blockConcurrencyWhile && ctx?.storage?.get) {
      ctx.blockConcurrencyWhile(async () => {
        this.state = (await ctx.storage.get('latest').catch(() => null)) || null;
      });
    }
  }

  async fetch(request) {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
      }
      this.state = body;
      if (this.ctx?.storage?.put) {
        await this.ctx.storage.put('latest', body).catch(() => {});
      }
      return Response.json({ ok: true }, { status: 200, headers: CORS });
    }
    return Response.json(withLivePosition(this.state), { status: 200, headers: CORS });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/now-playing' && request.method === 'POST') {
      const secret = String(env?.NOW_PLAYING_PUSH_SECRET || '').trim();
      if (!secret) {
        return Response.json(
          { error: 'Missing NOW_PLAYING_PUSH_SECRET' },
          { status: 503, headers: CORS },
        );
      }
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!safeEqual(token, secret)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
      }
      memoryState = body;
      const raw = JSON.stringify(body);
      if (env?.NOW_PLAYING_ROOM?.idFromName) {
        const stub = env.NOW_PLAYING_ROOM.get(env.NOW_PLAYING_ROOM.idFromName('global'));
        await stub.fetch('https://now-playing.internal/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: raw,
        });
      }
      if (env?.NOW_PLAYING_KV?.put) {
        ctx?.waitUntil?.(env.NOW_PLAYING_KV.put('latest', raw, { expirationTtl: 86400 }));
      }
      return Response.json({ ok: true }, { status: 200, headers: CORS });
    }

    if (url.pathname === '/api/now-playing' && request.method === 'GET') {
      if (env?.NOW_PLAYING_ROOM?.idFromName) {
        const stub = env.NOW_PLAYING_ROOM.get(env.NOW_PLAYING_ROOM.idFromName('global'));
        return stub.fetch('https://now-playing.internal/state');
      }
      let state = memoryState;
      if (!state && env?.NOW_PLAYING_KV?.get) {
        state = await env.NOW_PLAYING_KV.get('latest', 'json').catch(() => null);
        if (state) memoryState = state;
      }
      return Response.json(withLivePosition(state), { status: 200, headers: CORS });
    }

    if (url.pathname === '/api/now-playing/events') {
      return new Response('Polling', { status: 404, headers: CORS });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await loadHtml();
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
