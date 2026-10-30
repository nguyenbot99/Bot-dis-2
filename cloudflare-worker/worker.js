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
let memoryRemoteAuth = null;
let memoryPendingCommands = [];
const memoryPinFailures = new Map();
let cachedHtml = null;
let cachedHtmlAt = 0;

const ALLOWED_ACTIONS = new Set([
  'verify',
  'toggle_pause',
  'skip',
  'previous',
  'replay',
  'shuffle',
  'loop',
  'autoplay',
  'volume',
  'preset',
  'vibe',
  'ambient',
  'play',
]);

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

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function isValidSnapshotBody(body) {
  return Boolean(
    body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof body.status === 'string',
  );
}

function sanitizeRemoteCommand(body) {
  if (!body || typeof body !== 'object') return null;
  const action = String(body.action || '').trim();
  if (!ALLOWED_ACTIONS.has(action)) return null;
  let value = body.value ?? null;
  if (action === 'volume') {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num) || num < 0 || num > 200) return null;
    value = num;
  } else if (action === 'play') {
    const q = String(value || '').trim().slice(0, 300);
    if (q.length < 2) return null;
    value = q;
  } else if (typeof value === 'string') {
    value = value.trim().slice(0, 40);
  }
  return {
    action,
    value,
    playNext: Boolean(body.playNext),
  };
}

async function verifyRemotePin(remoteAuth, rawPin, clientKey, failureMap) {
  const now = Date.now();
  const bucket = failureMap.get(clientKey);
  if (bucket && now < bucket.resetAt && bucket.count >= 5) {
    return {
      ok: false,
      status: 429,
      error: 'Nhập sai mã PIN quá 5 lần — vui lòng chờ 60 giây rồi thử lại.',
    };
  }
  const cleanPin = String(rawPin || '').trim();
  if (!/^\d{6}$/.test(cleanPin)) {
    return {
      ok: false,
      status: 401,
      error: 'Mã PIN gồm đúng 6 chữ số (gõ /webkey trong Discord để lấy mã).',
    };
  }
  const salt = String(remoteAuth?.salt || '');
  const entries = Array.isArray(remoteAuth?.entries) ? remoteAuth.entries : [];
  if (!salt || entries.length === 0) {
    return {
      ok: false,
      status: 401,
      error: 'Hiện chưa có mã PIN nào được mở — hãy gõ /webkey trong Discord trước.',
    };
  }
  const candHash = await sha256Hex(`bot-dis-2-webpin-v1:${salt}:${cleanPin}`);
  for (const entry of entries) {
    if (!entry || typeof entry.hash !== 'string') continue;
    if (Number(entry.expiresAt) > 0 && now >= Number(entry.expiresAt)) continue;
    if (safeEqual(candHash, entry.hash)) {
      failureMap.delete(clientKey);
      return {
        ok: true,
        role: entry.role || 'dj',
        userId: entry.userId || '',
        expiresAt: Number(entry.expiresAt) || 0,
      };
    }
  }
  if (failureMap.size >= 80) failureMap.clear();
  const nextCount = (bucket && now < bucket.resetAt ? bucket.count : 0) + 1;
  failureMap.set(clientKey, { count: nextCount, resetAt: now + 60000 });
  return {
    ok: false,
    status: 401,
    error: 'Mã PIN không đúng hoặc đã hết hạn — gõ /webkey trong Discord để lấy mã mới.',
  };
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
      remoteControl: { enabled: false },
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
  const cleanState = { ...state };
  delete cleanState.remoteAuth;
  if (cleanState.status === 'playing' && cleanState.track && cleanState.serverTimeMs) {
    const elapsed = Math.max(0, Date.now() - Number(cleanState.serverTimeMs));
    const rate = Number(cleanState.settings?.vibeRate) > 0 ? Number(cleanState.settings.vibeRate) : 1;
    const total = Math.max(0, Number(cleanState.track.durationMs) || 0);
    let pos = Math.max(0, Math.round((Number(cleanState.track.positionMs) || 0) + elapsed * rate));
    if (total > 0 && pos > total) pos = total;
    return {
      ...cleanState,
      serverTimeMs: Date.now(),
      track: { ...cleanState.track, positionMs: pos },
    };
  }
  return { ...cleanState, serverTimeMs: Date.now() };
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
    this.remoteAuth = null;
    this.pendingCommands = [];
    this.pinFailures = new Map();
    if (ctx?.blockConcurrencyWhile && ctx?.storage?.get) {
      ctx.blockConcurrencyWhile(async () => {
        const latest = (await ctx.storage.get('latest').catch(() => null)) || null;
        if (latest && typeof latest === 'object') {
          delete latest.remoteAuth;
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
        this.remoteAuth =
          (await ctx.storage.get('remote_auth').catch(() => null)) || null;
      });
    }
  }

  async verifyBotAuth(request) {
    const envSecret = String(this.env?.NOW_PLAYING_PUSH_SECRET || '').trim();
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const proof = String(request.headers.get('X-Bot-Proof') || '').trim();

    if (envSecret) {
      return safeEqual(token, envSecret);
    }
    if (token.length < 4) return false;
    if (!this.pairedSecret) {
      this.pairedSecret = token;
      if (proof) this.ownerProof = proof;
      if (this.ctx?.storage?.put) {
        await this.ctx.storage.put('paired_secret', token).catch(() => {});
        if (proof) await this.ctx.storage.put('owner_proof', proof).catch(() => {});
      }
      return true;
    }
    const tokenOk = safeEqual(token, this.pairedSecret);
    const proofOk = Boolean(this.ownerProof && proof && safeEqual(proof, this.ownerProof));
    if (!tokenOk && !proofOk) return false;
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
    return true;
  }

  async fetch(input, init) {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const reqUrl = new URL(request.url || 'https://now-playing.internal/state');

    // 1. Nút nhận lệnh điều khiển 2 chiều từ trình duyệt Website (xác thực PIN 6 số SHA-256).
    if (reqUrl.pathname === '/remote-command' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const clientIp = String(request.headers.get('X-Client-IP') || 'web');
      const verified = await verifyRemotePin(this.remoteAuth, body?.pin, clientIp, this.pinFailures);
      if (!verified.ok) {
        return Response.json({ ok: false, error: verified.error }, { status: verified.status, headers: CORS });
      }
      const cmd = sanitizeRemoteCommand(body);
      if (!cmd) {
        return Response.json(
          { ok: false, error: 'Thao tác điều khiển không hợp lệ.' },
          { status: 400, headers: CORS },
        );
      }
      if (cmd.action === 'verify') {
        return Response.json(
          { ok: true, role: verified.role, expiresAt: verified.expiresAt },
          { status: 200, headers: CORS },
        );
      }
      if (this.pendingCommands.length >= 15) {
        this.pendingCommands.shift();
      }
      this.pendingCommands.push({
        id: crypto.randomUUID(),
        ...cmd,
        role: verified.role,
        userId: verified.userId,
        createdAt: Date.now(),
      });
      return Response.json(
        { ok: true, queued: true, role: verified.role },
        { status: 200, headers: CORS },
      );
    }

    // 2. Nút cho bot Discord rút nhanh hàng đợi lệnh điều khiển (xác thực chữ ký của bot).
    if (reqUrl.pathname === '/remote-drain' && request.method === 'POST') {
      if (!(await this.verifyBotAuth(request))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const now = Date.now();
      const commands = this.pendingCommands
        .splice(0, 20)
        .filter(c => now - (c.createdAt || 0) < 30000);
      return Response.json({ ok: true, commands }, { status: 200, headers: CORS });
    }

    // 3. Bot đẩy trạng thái bài hát + bảng băm PIN mới nhất.
    if (request.method === 'POST') {
      if (!(await this.verifyBotAuth(request))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
      }

      const body = await request.json().catch(() => null);
      if (!isValidSnapshotBody(body)) {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
      }
      if (Object.prototype.hasOwnProperty.call(body, 'remoteAuth')) {
        this.remoteAuth = body.remoteAuth;
        delete body.remoteAuth;
        if (this.ctx?.storage?.put) {
          await this.ctx.storage.put('remote_auth', this.remoteAuth).catch(() => {});
        }
      }
      if (typeof body.mixtapesSeal === 'string' && body.mixtapesSeal.length > 65536) {
        delete body.mixtapesSeal;
      }
      this.state = body;
      if (this.ctx?.storage?.put) {
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
      const now = Date.now();
      const commands = this.pendingCommands
        .splice(0, 20)
        .filter(c => now - (c.createdAt || 0) < 30000);
      return Response.json({ ok: true, commands }, { status: 200, headers: CORS });
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

    if (url.pathname === '/api/remote-command' && request.method === 'POST') {
      const clientIp = request.headers.get('CF-Connecting-IP') || 'web';
      if (env?.NOW_PLAYING_ROOM?.idFromName) {
        const stub = env.NOW_PLAYING_ROOM.get(env.NOW_PLAYING_ROOM.idFromName('global'));
        return stub.fetch('https://now-playing.internal/remote-command', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-IP': clientIp,
          },
          body: await request.text().catch(() => ''),
        });
      }
      const body = await request.json().catch(() => null);
      const verified = await verifyRemotePin(memoryRemoteAuth, body?.pin, clientIp, memoryPinFailures);
      if (!verified.ok) {
        return Response.json({ ok: false, error: verified.error }, { status: verified.status, headers: CORS });
      }
      const cmd = sanitizeRemoteCommand(body);
      if (!cmd) {
        return Response.json({ ok: false, error: 'Thao tác điều khiển không hợp lệ.' }, { status: 400, headers: CORS });
      }
      if (cmd.action === 'verify') {
        return Response.json({ ok: true, role: verified.role, expiresAt: verified.expiresAt }, { status: 200, headers: CORS });
      }
      if (memoryPendingCommands.length >= 15) memoryPendingCommands.shift();
      memoryPendingCommands.push({
        id: crypto.randomUUID(),
        ...cmd,
        role: verified.role,
        userId: verified.userId,
        createdAt: Date.now(),
      });
      return Response.json({ ok: true, queued: true, role: verified.role }, { status: 200, headers: CORS });
    }

    if (url.pathname === '/api/remote-drain' && request.method === 'POST') {
      const secret = String(env?.NOW_PLAYING_PUSH_SECRET || '').trim();
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const proof = String(request.headers.get('X-Bot-Proof') || '').trim();

      if (secret && !safeEqual(token, secret)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      if (!secret && token.length < 4) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
      }

      if (env?.NOW_PLAYING_ROOM?.idFromName) {
        const stub = env.NOW_PLAYING_ROOM.get(env.NOW_PLAYING_ROOM.idFromName('global'));
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        };
        if (proof) headers['X-Bot-Proof'] = proof;
        return stub.fetch('https://now-playing.internal/remote-drain', {
          method: 'POST',
          headers,
          body: '{}',
        });
      }

      if (!secret && memoryPairedSecret && !safeEqual(token, memoryPairedSecret)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const commands = memoryPendingCommands.splice(0, 20);
      return Response.json({ ok: true, commands }, { status: 200, headers: CORS });
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
      if (Object.prototype.hasOwnProperty.call(body, 'remoteAuth')) {
        memoryRemoteAuth = body.remoteAuth;
        delete body.remoteAuth;
      }
      memoryState = body;
      if (env?.NOW_PLAYING_KV?.put) {
        ctx?.waitUntil?.(env.NOW_PLAYING_KV.put('latest', JSON.stringify(body), { expirationTtl: 86400 }));
      }
      const commands = memoryPendingCommands.splice(0, 20);
      return Response.json({ ok: true, commands }, { status: 200, headers: CORS });
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
