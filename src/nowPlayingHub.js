import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SOUND_PRESETS } from './audioEnhancer.js';
import { cleanText, LOOP_LABELS, renderSyncedProgress, safeHttpUrl } from './playerGui.js';
import { openSessionPayload } from './sessionStore.js';

export const DEFAULT_NOW_PLAYING_PUSH_URL =
 'https://bot-dis-2.botmusicvip.workers.dev/api/now-playing';

const SOURCE_NAMES = {
 youtube: 'YouTube',
 ytsr: 'YouTube',
 soundcloud: 'SoundCloud',
 spotify: 'Spotify',
};

const MAX_SSE_CLIENTS = 20;

function formatSourceLabel(rawSource) {
 const key = String(rawSource ?? '').toLowerCase().trim();
 return SOURCE_NAMES[key] ?? (cleanText(rawSource || 'SoundCloud', 24) || 'SoundCloud');
}

function formatArtwork(rawThumb) {
 const valid = safeHttpUrl(rawThumb);
 if (!valid) return null;
 return valid.includes('sndcdn.com') ? valid.replace('-large.jpg', '-t500x500.jpg') : valid;
}

function serializeMiniTrack(track, position = null) {
 if (!track) return null;
 const rawDur = Number(track.duration ?? 0);
 const durationMs = rawDur > 0 ? (rawDur > 1000 ? rawDur : rawDur * 1000) : 0;
 return {
  ...(position !== null ? { position } : {}),
  title: cleanText(track.title ?? 'Không rõ tên bài', 110),
  author: cleanText(track.metadata?.author ?? 'Nghệ sĩ', 60),
  artworkUrl: formatArtwork(track.thumbnail),
  url: safeHttpUrl(track.url),
  source: String(track.source ?? 'soundcloud').toLowerCase(),
  sourceLabel: formatSourceLabel(track.source),
  durationMs,
 };
}

// Chuẩn hóa địa chỉ đẩy dữ liệu lên Cloudflare Worker (tự tạo khóa băm một chiều từ token bot nếu chưa đặt biến tay).
export function resolvePushEndpoint(env = process.env, botToken = '') {
 const rawFlag = String(env?.NOW_PLAYING_PUSH_URL ?? '').trim().toLowerCase();
 if (rawFlag === 'off' || rawFlag === 'false' || rawFlag === 'none') {
  return { pushUrl: null, pushSecret: '', ownerProof: '' };
 }
 const rawUrl = safeHttpUrl(env?.NOW_PLAYING_PUSH_URL ?? '');
 const explicitSecret = String(env?.NOW_PLAYING_PUSH_SECRET ?? '').trim();
 const cleanBotToken = String(botToken ?? '').trim();
 const derivedSecret = cleanBotToken
  ? createHmac('sha256', 'bot-dis-2-push-v1').update(cleanBotToken).digest('hex')
  : '';
 const ownerProof = cleanBotToken
  ? createHmac('sha256', 'bot-dis-2-owner-proof-v1').update(cleanBotToken).digest('hex')
  : '';
 const secret = explicitSecret || derivedSecret;

 if (rawUrl) {
  try {
   const parsed = new URL(rawUrl);
   const cleanPath = parsed.pathname.replace(/\/+$/, '');
   if (!cleanPath) {
    parsed.pathname = '/api/now-playing';
   }
   return { pushUrl: parsed.toString(), pushSecret: secret, ownerProof };
  } catch {
   return { pushUrl: rawUrl, pushSecret: secret, ownerProof };
  }
 }
 if (secret) {
  return { pushUrl: DEFAULT_NOW_PLAYING_PUSH_URL, pushSecret: secret, ownerProof };
 }
 return { pushUrl: null, pushSecret: '', ownerProof: '' };
}

// Chuyển trạng thái hiện tại của trình phát ZiPlayer sang dữ liệu JSON sạch, an toàn cho Website "Now Playing".
export function serializeNowPlayingState({ player, client, overrides = {} } = {}) {
 const botReady = Boolean(client?.isReady?.());
 const botUser = client?.user ?? null;
 const avatarUrl = typeof botUser?.displayAvatarURL === 'function'
  ? safeHttpUrl(botUser.displayAvatarURL({ extension: 'png', size: 128 }))
  : null;

 const hasTrackOverride = Object.prototype.hasOwnProperty.call(overrides, 'track');
 const rawTrack = hasTrackOverride
  ? overrides.track
  : (player?.queue?.currentTrack ?? player?.currentTrack ?? null);

 const isPaused = overrides.paused ?? Boolean(player?.isPaused);
 const stay247 = overrides.stay247 ?? Boolean(player?.userdata?.stay247);
 const voiceMuted = overrides.voiceMuted ?? Boolean(player?.userdata?.voiceMuted);
 const muteReason = overrides.muteReason ?? player?.userdata?.muteReason ?? null;
 const loopMode = overrides.loopMode ?? (typeof player?.loop === 'function' ? player.loop() : 'off') ?? 'off';
 const autoPlay = overrides.autoPlay ?? (typeof player?.autoPlay === 'function' ? Boolean(player.autoPlay()) : false);
 const volume = overrides.volume ?? player?.volume ?? 100;
 const soundPreset = overrides.soundPreset ?? player?.userdata?.soundPreset ?? 'hd';
 const soundLabel = SOUND_PRESETS[soundPreset]?.label ?? SOUND_PRESETS.hd.label;

 let voiceChannelName = null;
 const vcId = player?.userdata?.voiceChannelId;
 if (vcId && player?.guildId && client?.guilds?.cache) {
  const ch = client.guilds.cache.get(player.guildId)?.channels?.cache?.get(vcId);
  if (ch?.name) voiceChannelName = cleanText(ch.name, 50);
 }

 let status = 'idle';
 let statusLabel = '💤 Chưa phát nhạc';
 if (rawTrack) {
  if (voiceMuted) {
   status = 'muted';
   statusLabel = muteReason === 'stage_suppress'
    ? '🔇 Bị khóa mic Sân khấu'
    : '🔇 Đang bị tắt mic (Server Mute)';
  } else if (isPaused) {
   status = 'paused';
   statusLabel = '⏸️ Đang tạm dừng';
  } else {
   status = 'playing';
   statusLabel = '▶️ Đang phát nhạc';
  }
 } else if (stay247) {
  status = 'idle_247';
  statusLabel = '🌙 Đang treo kênh 24/7';
 }

 let trackPayload = null;
 if (rawTrack) {
  const { currentMs, totalMs } = renderSyncedProgress(player, rawTrack, isPaused || voiceMuted);
  trackPayload = {
   title: cleanText(rawTrack.title ?? 'Không rõ tiêu đề', 120),
   author: cleanText(rawTrack.metadata?.author ?? 'Nghệ sĩ', 65),
   artworkUrl: formatArtwork(rawTrack.thumbnail),
   url: safeHttpUrl(rawTrack.url),
   source: String(rawTrack.source ?? 'soundcloud').toLowerCase(),
   sourceLabel: formatSourceLabel(rawTrack.source),
   positionMs: Math.max(0, Math.round(currentMs ?? 0)),
   durationMs: Math.max(0, Math.round(totalMs ?? 0)),
  };
 }

 const upcomingRaw = Array.isArray(player?.upcomingTracks) ? player.upcomingTracks : [];
 const historyRaw = Array.isArray(player?.queue?.history) ? player.queue.history : [];

 return {
  bot: {
   ready: botReady,
   name: cleanText(botUser?.username ?? 'Discord Music Bot', 45),
   avatarUrl,
  },
  status,
  statusLabel,
  reason: overrides.reason ? cleanText(overrides.reason, 140) : null,
  serverTimeMs: Date.now(),
  voiceChannelName,
  settings: {
   volume,
   loopMode,
   loopLabel: LOOP_LABELS[loopMode] ?? LOOP_LABELS.off,
   autoPlay,
   stay247,
   voiceMuted,
   muteReason,
   soundPreset,
   soundLabel,
  },
  track: trackPayload,
  upcoming: upcomingRaw.slice(0, 10).map((t, i) => serializeMiniTrack(t, i + 1)).filter(Boolean),
  history: historyRaw.slice(-5).reverse().map(t => serializeMiniTrack(t)).filter(Boolean),
 };
}

// Bộ trung tâm phục vụ Website "Now Playing" (Express + SSE thời gian thực + đẩy dữ liệu ra Worker ngoài nếu cấu hình).
export function createNowPlayingHub({
 getPlayer,
 getResumeSeal = null,
 client,
 htmlPath = new URL('../web/index.html', import.meta.url),
 env = process.env,
 botToken = '',
 fetchImpl = fetch,
 logger = console,
} = {}) {
 const htmlContent = readFileSync(htmlPath, 'utf8');
 const sseClients = new Set();
 let lastOverrides = {};
 let pushTimer = null;
 let lastPushOk = false;
 let lastWarnAt = 0;

 const { pushUrl: rawPushUrl, pushSecret, ownerProof } = resolvePushEndpoint(env, botToken);

 const heartbeatTimer = setInterval(() => {
  for (const res of sseClients) {
   try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
 }, 25000);
 heartbeatTimer.unref?.();

 function warnThrottled(msg) {
  const now = Date.now();
  if (now - lastWarnAt < 60000) return;
  lastWarnAt = now;
  logger?.warn?.(msg);
 }

 function getSnapshot(overrides = lastOverrides) {
  const activePlayer = Object.prototype.hasOwnProperty.call(overrides, 'player')
   ? overrides.player
   : getPlayer?.();
  return serializeNowPlayingState({ player: activePlayer, client, overrides });
 }

 async function executeOutboundPush() {
  if (!rawPushUrl) return;
  const snapshot = getSnapshot();
  const outboundBody = typeof getResumeSeal === 'function'
   ? { ...snapshot, resumeSeal: getResumeSeal() }
   : snapshot;
  const headers = { 'Content-Type': 'application/json' };
  if (pushSecret) headers.Authorization = `Bearer ${pushSecret}`;
  if (ownerProof) headers['X-Bot-Proof'] = ownerProof;
  try {
   const res = await fetchImpl(rawPushUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(outboundBody),
    signal: AbortSignal.timeout(5000),
   });
   if (res && res.ok === false) {
    lastPushOk = false;
    if (res.status === 503) {
     warnThrottled('[web-now-playing] ⚠️ Cloudflare Worker báo thiếu NOW_PLAYING_PUSH_SECRET (HTTP 503). Hãy thêm biến Secret này trong Settings -> Variables and Secrets trên Cloudflare.');
    } else if (res.status === 401) {
     warnThrottled('[web-now-playing] ⚠️ Sai mật khẩu NOW_PLAYING_PUSH_SECRET (HTTP 401). Hãy kiểm tra mật khẩu ở botkeep.cloud và Cloudflare khớp nhau.');
    } else {
     warnThrottled(`[web-now-playing] ⚠️ Không thể đẩy dữ liệu lên Website ngoài (HTTP ${res.status}).`);
    }
    return;
   }
   if (!lastPushOk) {
    lastPushOk = true;
    logger?.log?.(`[web-now-playing] ✅ Đã kết nối & đồng bộ trạng thái nhạc lên Website: ${rawPushUrl}`);
   }
  } catch (err) {
   lastPushOk = false;
   warnThrottled(`[web-now-playing] ⚠️ Lỗi mạng khi đẩy dữ liệu lên Website ngoài: ${err?.name ?? 'Error'}`);
  }
 }

 function scheduleOutboundPush() {
  if (!rawPushUrl) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
   pushTimer = null;
   void executeOutboundPush();
  }, 150);
  pushTimer.unref?.();
 }

 // Tự thử đồng bộ lại mỗi 20 giây nếu lần đẩy trước chưa thành công (ví dụ vừa mới thêm Secret trên Cloudflare) hoặc khi đang phát nhạc.
 const resyncTimer = rawPushUrl
  ? setInterval(() => {
     if (!client?.isReady?.()) return;
     const hasActiveTrack = Boolean(getPlayer?.()?.queue?.currentTrack);
     if (!lastPushOk || hasActiveTrack) {
      void executeOutboundPush();
     }
    }, 20000)
  : null;
 resyncTimer?.unref?.();

 function publish(overrides = {}) {
  lastOverrides = overrides;
  if (sseClients.size > 0) {
   const frame = `event: state\ndata: ${JSON.stringify(getSnapshot(overrides))}\n\n`;
   for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
   }
  }
  scheduleOutboundPush();
 }

 function applyCors(_req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
 }

 function mountRoutes(app) {
  if (rawPushUrl) {
   if (!pushSecret) {
    logger?.warn?.('[web-now-playing] ⚠️ Đã có NOW_PLAYING_PUSH_URL nhưng thiếu NOW_PLAYING_PUSH_SECRET trong tab Environment!');
   } else {
    logger?.log?.(`[web-now-playing] Sẵn sàng đồng bộ ra Cloudflare Worker: ${rawPushUrl}`);
   }
  } else {
   logger?.log?.('[web-now-playing] Chưa cấu hình NOW_PLAYING_PUSH_SECRET trong tab Environment (chỉ chạy Web nội bộ tại cổng HTTP của bot).');
  }

  app.options('/api/now-playing', (req, res) => { applyCors(req, res); res.status(204).end(); });
  app.options('/api/now-playing/events', (req, res) => { applyCors(req, res); res.status(204).end(); });

  // Giao diện Website "Now Playing" kiểu Ziji V10.
  app.get('/', (_req, res) => {
   res.setHeader('Content-Type', 'text/html; charset=utf-8');
   res.setHeader('Cache-Control', 'no-cache');
   res.status(200).send(htmlContent);
  });

  // API JSON trả trạng thái bài hát hiện tại cho web tĩnh / Cloudflare / polling.
  app.get('/api/now-playing', (req, res) => {
   applyCors(req, res);
   res.status(200).json(getSnapshot());
  });

  // Luồng SSE đẩy cập nhật tức thì mỗi khi bot bắt đầu bài mới, tạm dừng, tiếp tục, tua hoặc kết thúc.
  app.get('/api/now-playing/events', (req, res) => {
   applyCors(req, res);
   res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
   res.setHeader('Connection', 'keep-alive');
   res.setHeader('X-Accel-Buffering', 'no');
   res.flushHeaders?.();

   if (sseClients.size >= MAX_SSE_CLIENTS) {
    const oldest = sseClients.values().next().value;
    if (oldest) {
     sseClients.delete(oldest);
     try { oldest.end(); } catch {}
    }
   }

   sseClients.add(res);
   res.write(`event: state\ndata: ${JSON.stringify(getSnapshot())}\n\n`);

   req.on('close', () => {
    sseClients.delete(res);
   });
  });
 }

 function close() {
  clearInterval(heartbeatTimer);
  if (resyncTimer) clearInterval(resyncTimer);
  if (pushTimer) {
   clearTimeout(pushTimer);
   pushTimer = null;
  }
  for (const res of sseClients) {
   try { res.end(); } catch {}
  }
  sseClients.clear();
 }

 async function fetchRemoteSessionBackup() {
  if (!rawPushUrl || !botToken) return null;
  try {
   const res = await fetchImpl(rawPushUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
   });
   if (!res?.ok) return null;
   const data = await res.json();
   if (!data?.resumeSeal) return null;
   return openSessionPayload(data.resumeSeal, botToken);
  } catch {
   return null;
  }
 }

 return {
  getSnapshot,
  publish,
  mountRoutes,
  fetchRemoteSessionBackup,
  close,
 };
}
