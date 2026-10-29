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
let memoryPairedSecret = null;
let cachedHtml = null;
let cachedHtmlAt = 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bot-Proof',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isValidSnapshotBody(body) {
  return Boolean(
    body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof body.status === 'string',
  );
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
        ambientMode: 'off',
        ambientLabel: 'T\u1EAFt n\u1EC1n',
      },
      track: null,
      upcoming: [],
      history: [],
    };
  }
  if (state.status === 'playing' && state.track && state.serverTimeMs) {
    const elapsed = Math.max(0, Date.now() - Number(state.serverTimeMs));
    const rate = Number(state.settings?.vibeRate) > 0 ? Number(state.settings.vibeRate) : 1;
    const total = Math.max(0, Number(state.track.durationMs) || 0);
    let pos = Math.max(0, Math.round((Number(state.track.positionMs) || 0) + elapsed * rate));
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
    this.pairedSecret = null;
    this.ownerProof = null;
    if (ctx?.blockConcurrencyWhile && ctx?.storage?.get) {
      ctx.blockConcurrencyWhile(async () => {
        const latest = (await ctx.storage.get('latest').catch(() => null)) || null;
        if (latest && typeof latest === 'object') {
          if (!latest.mixtapesSeal) {
            const m = await ctx.storage.get('mixtapes_seal').catch(() => null);
            if (typeof m === 'string') latest.mixtapesSeal = m;
          }
          if (!latest.statsSeal) {
            const s = await ctx.storage.get('stats_seal').catch(() => null);
            if (typeof s === 'string') latest.statsSeal = s;
          }
        }
        this.state = latest;
        this.pairedSecret =
          (await ctx.storage.get('paired_secret').catch(() => null)) || null;
        this.ownerProof =
          (await ctx.storage.get('owner_proof').catch(() => null)) || null;
      });
    }
  }

  async fetch(request) {
    if (request.method === 'POST') {
      const envSecret = String(this.env?.NOW_PLAYING_PUSH_SECRET || '').trim();
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const proof = String(request.headers.get('X-Bot-Proof') || '').trim();

      if (envSecret) {
        if (!safeEqual(token, envSecret)) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
        }
      } else {
        if (token.length < 4) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
        }
        if (!this.pairedSecret) {
          this.pairedSecret = token;
          if (proof) this.ownerProof = proof;
          if (this.ctx?.storage?.put) {
            await this.ctx.storage.put('paired_secret', token).catch(() => {});
            if (proof) await this.ctx.storage.put('owner_proof', proof).catch(() => {});
          }
        } else {
          const tokenOk = safeEqual(token, this.pairedSecret);
          const proofOk = Boolean(this.ownerProof && proof && safeEqual(proof, this.ownerProof));
          if (!tokenOk && !proofOk) {
            return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
          }
          if (proofOk && !tokenOk) {
            this.pairedSecret = token;
            if (this.ctx?.storage?.put) {
              await this.ctx.storage.put('paired_secret', token).catch(() => {});
            }
          }
          if (!this.ownerProof && proof && tokenOk) {
            this.ownerProof = proof;
            if (this.ctx?.storage?.put) {
              await this.ctx.storage.put('owner_proof', proof).catch(() => {});
            }
          }
        }
      }

      const body = await request.json().catch(() => null);
      if (!isValidSnapshotBody(body)) {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
      }
      if (typeof body.mixtapesSeal === 'string' && body.mixtapesSeal.length > 65536) {
        delete body.mixtapesSeal;
      }
      this.state = body;
      if (this.ctx?.storage?.put) {
        // Tách riêng các két sao lưu lớn nếu tổng bản chụp vượt 90 KB để không bao giờ chạm trần 128 KiB/key của SQLite DO.
        const approxSize = JSON.stringify(body).length;
        if (approxSize > 92160) {
          const slim = { ...body };
          if (slim.mixtapesSeal) {
            await this.ctx.storage.put('mixtapes_seal', slim.mixtapesSeal).catch(() => {});
            delete slim.mixtapesSeal;
          }
          if (slim.statsSeal) {
            await this.ctx.storage.put('stats_seal', slim.statsSeal).catch(() => {});
            delete slim.statsSeal;
          }
          await this.ctx.storage.put('latest', slim).catch(() => {});
        } else {
          await this.ctx.storage.put('latest', body).catch(() => {});
        }
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
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const proof = String(request.headers.get('X-Bot-Proof') || '').trim();

      if (secret) {
        if (!safeEqual(token, secret)) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
        }
      } else if (token.length < 4) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
      }

      const rawText = await request.text().catch(() => '');
      let body = null;
      try {
        body = rawText ? JSON.parse(rawText) : null;
      } catch {
        body = null;
      }
      if (!isValidSnapshotBody(body)) {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
      }

      if (env?.NOW_PLAYING_ROOM?.idFromName) {
        const stub = env.NOW_PLAYING_ROOM.get(env.NOW_PLAYING_ROOM.idFromName('global'));
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        };
        if (proof) headers['X-Bot-Proof'] = proof;
        return stub.fetch('https://now-playing.internal/state', {
          method: 'POST',
          headers,
          body: rawText,
        });
      }

      if (!secret) {
        if (!memoryPairedSecret) memoryPairedSecret = token;
        else if (!safeEqual(token, memoryPairedSecret)) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
        }
      }
      memoryState = body;
      if (env?.NOW_PLAYING_KV?.put) {
        ctx?.waitUntil?.(env.NOW_PLAYING_KV.put('latest', rawText, { expirationTtl: 86400 }));
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
