import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AMBIENT_MODES, SOUND_PRESETS, VIBE_MODES } from './audioEnhancer.js';
import { openFavoritesPayload } from './favoritesStore.js';
import { openMixtapesPayload } from './mixtapeStore.js';
import { cleanText, LOOP_LABELS, renderSyncedProgress, safeHttpUrl } from './playerGui.js';
import { openSessionPayload } from './sessionStore.js';
import { openStatsPayload } from './statsStore.js';
import { sanitizeWebAudioDescriptor } from './webAudio.js';
import { normalizeRemoteCommandInput } from './webRemote.js';

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

function sanitizeWebLyricsDescriptor(rawLyrics) {
 if (!rawLyrics || typeof rawLyrics !== 'object') return null;
 const source = cleanText(rawLyrics.source ?? 'LRCLIB', 24) || 'LRCLIB';
 if (Array.isArray(rawLyrics.synced) && rawLyrics.synced.length > 0) {
  const synced = [];
  for (const item of rawLyrics.synced) {
   if (!item || typeof item !== 'object') continue;
   const t = Math.max(0, Math.round(Number(item.t) || 0));
   const text = String(item.text ?? '').trim().slice(0, 140);
   if (!text) continue;
   synced.push({ t, text });
   if (synced.length >= 180) break;
  }
  if (synced.length > 0) {
   return { source, synced, plain: null };
  }
 }
 const plain = typeof rawLyrics.plain === 'string'
  ? rawLyrics.plain.trim().slice(0, 3200)
  : '';
 if (plain) {
  return { source, synced: null, plain };
 }
 return null;
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
 const vibeMode = overrides.vibeMode ?? player?.userdata?.vibeMode ?? 'normal';
 const vibeInfo = VIBE_MODES[vibeMode] ?? VIBE_MODES.normal;
 const ambientMode = overrides.ambientMode ?? player?.userdata?.ambientMode ?? 'off';
 const ambientInfo = AMBIENT_MODES[ambientMode] ?? AMBIENT_MODES.off;

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
  const webAudio = sanitizeWebAudioDescriptor(
   overrides.webAudio ?? rawTrack.metadata?.webAudio ?? rawTrack.webAudio ?? null,
  );
  const webLyrics = sanitizeWebLyricsDescriptor(
   overrides.webLyrics ?? rawTrack.metadata?.webLyrics ?? rawTrack.webLyrics ?? null,
  );
  const rawDed = rawTrack.metadata?.dedication;
  const dedication = rawDed && typeof rawDed === 'object'
   ? {
      fromName: cleanText(rawDed.fromName ?? 'Một người bạn', 35),
      toName: cleanText(rawDed.toName ?? 'Bạn', 35),
      message: cleanText(rawDed.message ?? '', 160),
     }
   : null;
  trackPayload = {
   title: cleanText(rawTrack.title ?? 'Không rõ tiêu đề', 120),
   author: cleanText(rawTrack.metadata?.author ?? 'Nghệ sĩ', 65),
   artworkUrl: formatArtwork(rawTrack.thumbnail),
   url: safeHttpUrl(rawTrack.url),
   source: String(rawTrack.source ?? 'soundcloud').toLowerCase(),
   sourceLabel: formatSourceLabel(rawTrack.source),
   positionMs: Math.max(0, Math.round(currentMs ?? 0)),
   durationMs: Math.max(0, Math.round(totalMs ?? 0)),
   ...(dedication ? { dedication } : {}),
   ...(webAudio ? { webAudio } : {}),
   ...(webLyrics ? { lyrics: webLyrics } : {}),
  };
 }

 const sleepTimerLabel = cleanText(
  overrides.sleepTimerLabel ?? player?.userdata?.sleepTimerLabel ?? '',
  45,
 ) || null;

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
   vibeMode,
   vibeLabel: vibeInfo.label,
   vibeRate: vibeInfo.rate ?? 1.0,
   ambientMode,
   ambientLabel: ambientInfo.label,
   sleepTimerLabel,
  },
  remoteControl: {
   enabled: Boolean(overrides.remoteControlEnabled),
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
 getFavoritesSeal = null,
 onRemoteFavorites = null,
 getStatsSeal = null,
 onRemoteStats = null,
 getMixtapesSeal = null,
 onRemoteMixtapes = null,
 webRemote = null,
 onRemoteCommand = null,
 client,
 htmlPath = new URL('../web/index.html', import.meta.url),
 env = process.env,
 botToken = '',
 deferInitialPush = false,
 fetchImpl = fetch,
 logger = console,
} = {}) {
 const htmlContent = readFileSync(htmlPath, 'utf8');
 const sseClients = new Set();
 let lastOverrides = {};
 let pushTimer = null;
 let lastPushOk = false;
 let lastWarnAt = 0;
 let outboundPushPaused = Boolean(deferInitialPush);
 let remoteBackupCheckFailed = false;
 let explicitSealClear = false;
 let remoteDrainBusy = false;
 let remoteDrainUnsupportedUntil = 0;

 const { pushUrl: rawPushUrl, pushSecret, ownerProof } = resolvePushEndpoint(env, botToken);
 const remoteDrainUrl = rawPushUrl
  ? rawPushUrl.replace(/\/api\/now-playing\/?$/, '/api/remote-drain')
  : null;

 async function dispatchRemoteCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0 || typeof onRemoteCommand !== 'function') return;
  for (const rawCmd of commands) {
   if (!rawCmd || typeof rawCmd !== 'object') continue;
   if (webRemote?.markCommandExecuted && !webRemote.markCommandExecuted(rawCmd.id)) continue;
   try {
    await onRemoteCommand(rawCmd);
   } catch (err) {
    logger?.warn?.(`[web-remote] Bỏ qua lệnh từ xa lỗi: ${err?.message ?? err}`);
   }
  }
 }

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
  const mergedOverrides = {
   ...overrides,
   remoteControlEnabled: Boolean(webRemote?.hasActivePins?.()),
  };
  return serializeNowPlayingState({ player: activePlayer, client, overrides: mergedOverrides });
 }

 async function executeOutboundPush() {
  if (!rawPushUrl || outboundPushPaused) return false;
  const snapshot = getSnapshot();
  const seal = typeof getResumeSeal === 'function' ? getResumeSeal() : undefined;
  const favSeal = typeof getFavoritesSeal === 'function' ? getFavoritesSeal() : undefined;
  const statsSeal = typeof getStatsSeal === 'function' ? getStatsSeal() : undefined;
  const mixtapesSeal = typeof getMixtapesSeal === 'function' ? getMixtapesSeal() : undefined;
  if (seal) {
   remoteBackupCheckFailed = false;
   explicitSealClear = false;
  } else if (remoteBackupCheckFailed && !explicitSealClear) {
   // Nếu lúc khởi động mạng lạnh chưa đọc được backup từ Cloudflare và cũng chưa có phiên mới hay lệnh /leave, không ghi đè mất backup cũ.
   return false;
  }
  const outboundBody = {
   ...snapshot,
   ...(typeof getResumeSeal === 'function' ? { resumeSeal: seal ?? null } : {}),
   ...(typeof getFavoritesSeal === 'function' ? { favoritesSeal: favSeal ?? null } : {}),
   ...(typeof getStatsSeal === 'function' ? { statsSeal: statsSeal ?? null } : {}),
   ...(typeof getMixtapesSeal === 'function' ? { mixtapesSeal: mixtapesSeal ?? null } : {}),
   ...(webRemote?.exportWorkerAuth ? { remoteAuth: webRemote.exportWorkerAuth() } : {}),
  };
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
    return false;
   }
   if (!lastPushOk) {
    lastPushOk = true;
    logger?.log?.(`[web-now-playing] ✅ Đã kết nối & đồng bộ trạng thái nhạc lên Website: ${rawPushUrl}`);
   }
   const respJson = await res.json?.().catch(() => null);
   if (Array.isArray(respJson?.commands) && respJson.commands.length > 0) {
    void dispatchRemoteCommands(respJson.commands);
   }
   return true;
  } catch (err) {
   lastPushOk = false;
   warnThrottled(`[web-now-playing] ⚠️ Lỗi mạng khi đẩy dữ liệu lên Website ngoài: ${err?.name ?? 'Error'}`);
   return false;
  }
 }

 function scheduleOutboundPush(immediate = false) {
  if (!rawPushUrl || outboundPushPaused) return;
  if (pushTimer) {
   clearTimeout(pushTimer);
   pushTimer = null;
  }
  if (immediate) {
   void executeOutboundPush();
   return;
  }
  pushTimer = setTimeout(() => {
   pushTimer = null;
   void executeOutboundPush();
  }, 150);
  pushTimer.unref?.();
 }

 // Tự thử đồng bộ lại mỗi 20 giây nếu lần đẩy trước chưa thành công hoặc khi đang ở trong phòng thoại / phát nhạc.
 const resyncTimer = rawPushUrl
  ? setInterval(() => {
     if (!client?.isReady?.() || outboundPushPaused) return;
     const activePl = getPlayer?.();
     const hasActiveSession = Boolean(activePl && !activePl.destroyed);
     if (!lastPushOk || hasActiveSession) {
      void executeOutboundPush();
     }
    }, 20000)
  : null;
 resyncTimer?.unref?.();

 // Kéo nhanh lệnh điều khiển 2 chiều từ Cloudflare Worker (~1.8s/lần CHỈ KHI có mã PIN /webkey đang hoạt động; bình thường tốn 0 băng thông!).
 const remoteDrainTimer = remoteDrainUrl
  ? setInterval(async () => {
     if (outboundPushPaused || remoteDrainBusy) return;
     if (!webRemote?.hasActivePins?.() || typeof onRemoteCommand !== 'function') return;
     if (Date.now() < remoteDrainUnsupportedUntil) return;
     remoteDrainBusy = true;
     try {
      const headers = { 'Content-Type': 'application/json' };
      if (pushSecret) headers.Authorization = `Bearer ${pushSecret}`;
      if (ownerProof) headers['X-Bot-Proof'] = ownerProof;
      const res = await fetchImpl(remoteDrainUrl, {
       method: 'POST',
       headers,
       body: '{}',
       signal: AbortSignal.timeout(3500),
      });
      if (res?.status === 404) {
       remoteDrainUnsupportedUntil = Date.now() + 180_000;
       return;
      }
      if (!res?.ok) return;
      const data = await res.json().catch(() => null);
      if (Array.isArray(data?.commands) && data.commands.length > 0) {
       await dispatchRemoteCommands(data.commands);
      }
     } catch {
     } finally {
      remoteDrainBusy = false;
     }
    }, 1800)
  : null;
 remoteDrainTimer?.unref?.();

 function publish(overrides = {}, { immediatePush = false, clearRemoteSession = false } = {}) {
  lastOverrides = overrides;
  if (clearRemoteSession) explicitSealClear = true;
  if (sseClients.size > 0) {
   const frame = `event: state\ndata: ${JSON.stringify(getSnapshot(overrides))}\n\n`;
   for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
   }
  }
  scheduleOutboundPush(immediatePush);
 }

 function setOutboundPushPaused(paused) {
  outboundPushPaused = Boolean(paused);
 }

 async function flushOutboundPush() {
  if (pushTimer) {
   clearTimeout(pushTimer);
   pushTimer = null;
  }
  outboundPushPaused = false;
  return executeOutboundPush();
 }

 function applyCors(_req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  app.options('/api/remote-command', (req, res) => { applyCors(req, res); res.status(204).end(); });

  // API điều khiển nhạc 2 chiều trực tiếp trên Express (bảo vệ bằng mã PIN 6 số /webkey + giới hạn chống dò mã).
  app.post('/api/remote-command', (req, res) => {
   applyCors(req, res);
   if (!webRemote || typeof onRemoteCommand !== 'function') {
    res.status(503).json({ ok: false, error: 'Chế độ điều khiển từ xa chưa sẵn sàng.' });
    return;
   }
   let rawBody = '';
   let aborted = false;
   req.on('data', chunk => {
    if (aborted) return;
    rawBody += chunk.toString('utf8');
    if (rawBody.length > 4096) {
     aborted = true;
     res.status(413).json({ ok: false, error: 'Dữ liệu gửi lên quá lớn.' });
    }
   });
   req.on('end', async () => {
    if (aborted) return;
    let body = null;
    try {
     body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
     res.status(400).json({ ok: false, error: 'Định dạng JSON không hợp lệ.' });
     return;
    }
    const clientIp = String(req.headers?.['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'local').split(',')[0].trim();
    const verified = webRemote.verifyPin(body?.pin, clientIp);
    if (!verified.ok) {
     res.status(verified.locked ? 429 : 401).json({ ok: false, error: verified.error });
     return;
    }
    let cmd;
    try {
     cmd = normalizeRemoteCommandInput(body);
    } catch (err) {
     res.status(400).json({ ok: false, error: err?.message ?? 'Lệnh không hợp lệ.' });
     return;
    }
    if (cmd.action === 'verify') {
     res.status(200).json({ ok: true, role: verified.role, expiresAt: verified.expiresAt });
     return;
    }
    try {
     const result = await onRemoteCommand({
      id: randomUUID(),
      ...cmd,
      role: verified.role,
      userId: verified.userId,
     });
     res.status(200).json({ ok: true, executed: true, role: verified.role, ...(result ?? {}) });
    } catch (err) {
     res.status(403).json({ ok: false, error: err?.message ?? 'Không thể thực thi thao tác này.' });
    }
   });
  });

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
  if (remoteDrainTimer) clearInterval(remoteDrainTimer);
  if (pushTimer) {
   clearTimeout(pushTimer);
   pushTimer = null;
  }
  for (const res of sseClients) {
   try { res.end(); } catch {}
  }
  sseClients.clear();
 }

 // Đọc bản sao lưu phiên phòng thoại từ Cloudflare Durable Object (thử lại tối đa 3 lần nếu mạng container mới khởi động còn lạnh).
 async function fetchRemoteSessionBackup({ retries = 3 } = {}) {
  if (!rawPushUrl || !botToken) return null;
  for (let attempt = 0; attempt < retries; attempt++) {
   if (attempt > 0) {
    await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 2200));
   }
   try {
    const res = await fetchImpl(rawPushUrl, {
     method: 'GET',
     headers: { Accept: 'application/json' },
     signal: AbortSignal.timeout(4500),
    });
    if (!res?.ok) continue;
    const data = await res.json();
    remoteBackupCheckFailed = false;
    if (data?.favoritesSeal && typeof onRemoteFavorites === 'function') {
     try {
      const openedFavs = openFavoritesPayload(data.favoritesSeal, botToken);
      if (openedFavs) onRemoteFavorites(openedFavs);
     } catch {}
    }
    if (data?.statsSeal && typeof onRemoteStats === 'function') {
     try {
      const openedStats = openStatsPayload(data.statsSeal, botToken);
      if (openedStats) onRemoteStats(openedStats);
     } catch {}
    }
    if (data?.mixtapesSeal && typeof onRemoteMixtapes === 'function') {
     try {
      const openedMixtapes = openMixtapesPayload(data.mixtapesSeal, botToken);
      if (openedMixtapes) onRemoteMixtapes(openedMixtapes);
     } catch {}
    }
    if (!data?.resumeSeal) return null;
    return openSessionPayload(data.resumeSeal, botToken);
   } catch {}
  }
  remoteBackupCheckFailed = true;
  return null;
 }

 return {
  getSnapshot,
  publish,
  setOutboundPushPaused,
  flushOutboundPush,
  mountRoutes,
  fetchRemoteSessionBackup,
  close,
 };
}
