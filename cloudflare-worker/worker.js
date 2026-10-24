const UI_URL =
  'https://raw.githubusercontent.com/nguyenbot99/Bot-dis-2/main/web/index.html';
const CACHE_URL = 'https://now-playing-cache.local/state';

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
      statusLabel: 'Chua phat nhac',
      reason: 'Dang cho tin hieu dau tien tu bot Discord...',
      serverTimeMs: Date.now(),
      voiceChannelName: null,
      settings: {
        volume: 100,
        loopMode: 'off',
        loopLabel: 'Tat lap',
        autoPlay: false,
        stay247: false,
        soundLabel: 'Ro net HD',
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
      if (env?.NOW_PLAYING_KV?.put) {
        ctx.waitUntil(env.NOW_PLAYING_KV.put('latest', raw, { expirationTtl: 86400 }));
      }
      if (typeof caches !== 'undefined' && caches.default) {
        const resp = new Response(raw, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
        });
        ctx.waitUntil(caches.default.put(CACHE_URL, resp));
      }
      return Response.json({ ok: true }, { status: 200, headers: CORS });
    }

    if (url.pathname === '/api/now-playing' && request.method === 'GET') {
      let state = memoryState;
      if (!state && env?.NOW_PLAYING_KV?.get) {
        state = await env.NOW_PLAYING_KV.get('latest', 'json').catch(() => null);
        if (state) memoryState = state;
      }
      if (!state && typeof caches !== 'undefined' && caches.default) {
        const hit = await caches.default.match(CACHE_URL).catch(() => null);
        if (hit) {
          state = await hit.json().catch(() => null);
          if (state) memoryState = state;
        }
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
