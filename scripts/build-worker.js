import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const htmlPath = new URL('../web/index.html', import.meta.url);
const outDir = new URL('../cloudflare-worker/', import.meta.url);
const outPath = new URL('../cloudflare-worker/worker.js', import.meta.url);

const html = readFileSync(htmlPath, 'utf8');

const workerSource = `// Cloudflare Worker miễn phí phục vụ Website "Now Playing" + API nhận trạng thái từ bot trên botkeep.cloud.
// Cách dùng nhanh:
// 1. Tạo Worker miễn phí tại dash.cloudflare.com -> dán toàn bộ file này -> bấm Deploy.
// 2. Trong phần Settings -> Variables and Secrets của Worker, tạo Secret: NOW_PLAYING_PUSH_SECRET = <mật-khẩu-tự-chọn>.
//    (Tùy chọn) Gắn thêm KV Namespace tên NOW_PLAYING_KV nếu muốn lưu bền vững xuyên suốt mọi cụm máy chủ biên.
// 3. Trên botkeep.cloud, thêm 2 biến môi trường:
//    NOW_PLAYING_PUSH_URL = https://<ten-worker-cua-ban>.workers.dev/api/now-playing
//    NOW_PLAYING_PUSH_SECRET = <mật-khẩu-tự-chọn>

const INDEX_HTML = ${JSON.stringify(html)};
const CACHE_KEY_URL = 'https://now-playing-internal.local/state';
let memoryState = null;

const CORS_HEADERS = {
 'Access-Control-Allow-Origin': '*',
 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
 'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function timingSafeEqualStr(a, b) {
 if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
 let diff = 0;
 for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
 return diff === 0;
}

function computeLivePosition(state) {
 if (!state || typeof state !== 'object') {
  return {
   bot: { ready: false, name: 'Discord Music Bot', avatarUrl: null },
   status: 'idle',
   statusLabel: '💤 Chưa phát nhạc',
   reason: 'Đang chờ tín hiệu đầu tiên từ bot Discord...',
   serverTimeMs: Date.now(),
   voiceChannelName: null,
   settings: { volume: 100, loopMode: 'off', loopLabel: 'Tắt lặp', autoPlay: false, stay247: false, soundLabel: 'Rõ nét HD' },
   track: null,
   upcoming: [],
   history: [],
  };
 }
 if (state.status === 'playing' && state.track && state.serverTimeMs) {
  const elapsed = Math.max(0, Date.now() - Number(state.serverTimeMs));
  const total = Math.max(0, Number(state.track.durationMs) || 0);
  let nextPos = Math.max(0, (Number(state.track.positionMs) || 0) + elapsed);
  if (total > 0 && nextPos > total) nextPos = total;
  return {
   ...state,
   serverTimeMs: Date.now(),
   track: { ...state.track, positionMs: nextPos },
  };
 }
 return { ...state, serverTimeMs: Date.now() };
}

export default {
 async fetch(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
   return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (url.pathname === '/api/now-playing' && request.method === 'POST') {
   const expected = String(env?.NOW_PLAYING_PUSH_SECRET ?? '').trim();
   if (!expected) {
    return Response.json({ error: 'Chưa cấu hình NOW_PLAYING_PUSH_SECRET trên Worker.' }, { status: 503, headers: CORS_HEADERS });
   }
   const auth = request.headers.get('Authorization') ?? '';
   const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
   if (!timingSafeEqualStr(token, expected)) {
    return Response.json({ error: 'Sai khóa xác thực.' }, { status: 401, headers: CORS_HEADERS });
   }
   const body = await request.json().catch(() => null);
   if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Dữ liệu JSON không hợp lệ.' }, { status: 400, headers: CORS_HEADERS });
   }
   memoryState = body;
   const serialized = JSON.stringify(body);
   if (env?.NOW_PLAYING_KV?.put) {
    ctx.waitUntil(env.NOW_PLAYING_KV.put('latest', serialized, { expirationTtl: 86400 }));
   }
   if (typeof caches !== 'undefined' && caches.default) {
    ctx.waitUntil(
     caches.default.put(
      CACHE_KEY_URL,
      new Response(serialized, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' } }),
     ),
    );
   }
   return Response.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
  }

  if (url.pathname === '/api/now-playing' && request.method === 'GET') {
   let state = memoryState;
   if (!state && env?.NOW_PLAYING_KV?.get) {
    state = await env.NOW_PLAYING_KV.get('latest', 'json').catch(() => null);
    if (state) memoryState = state;
   }
   if (!state && typeof caches !== 'undefined' && caches.default) {
    const cached = await caches.default.match(CACHE_KEY_URL).catch(() => null);
    if (cached) {
     state = await cached.json().catch(() => null);
     if (state) memoryState = state;
    }
   }
   return Response.json(computeLivePosition(state), { status: 200, headers: CORS_HEADERS });
  }

  // Với Cloudflare Worker miễn phí, yêu cầu SSE trả 204/404 gọn để trình duyệt tự chuyển sang hỏi JSON định kỳ mỗi 4 giây.
  if (url.pathname === '/api/now-playing/events') {
   return new Response('Polling mode', { status: 404, headers: CORS_HEADERS });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
   return new Response(INDEX_HTML, {
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
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, workerSource, 'utf8');
console.log('Đã tạo cloudflare-worker/worker.js thành công.');
