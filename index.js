import 'dotenv/config';
import express from 'express';
import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, Options, PermissionFlagsBits, Routes } from 'discord.js';
import { PlayerManager } from 'ziplayer';
import ffmpeg from 'ffmpeg-static';
import { parseSeekTime, pickBestMatchingTrack, resolveConfig, resolveMusicRequest } from './src/policy.js';
import {
 clampVolumePercent,
 configurePlayerAudio,
 getNextSoundPreset,
 installAudioEnhancer,
 MAX_VOLUME_PERCENT,
 MIN_VOLUME_PERCENT,
 parseCustomVolumeInput,
 setAudioEnhancement,
 SOUND_PRESETS,
} from './src/audioEnhancer.js';
import { assertMusicAccess, isBotOwner, resolveHumanRequester } from './src/access.js';
import { fetchTrackLyrics, sanitizeLyricsTitle } from './src/lyrics.js';
import { createNowPlayingHub } from './src/nowPlayingHub.js';
import { deleteDiscordMessage, extractMessageRef, sweepChannelStaleNotices } from './src/messageCleaner.js';
import { captureGatewayFallbackSessions, createRuntimeSessionStore, sealSessionPayload } from './src/sessionStore.js';
import { createVoiceRoomStatusSync } from './src/voiceStatus.js';
import { buildVoiceGuardEmbed, evaluateBotVoiceTransition } from './src/voiceGuard.js';
import { buildHelpEmbed, commands } from './src/commands.js';
import {
 buildAddSongModal,
 buildEndedPayload,
 buildHistoryEmbed,
 buildIdle247Payload,
 buildLyricsEmbed,
 buildNowPlayingEmbed,
 buildPlayerPayload,
 buildQueueEmbed,
 buildVolumeModal,
 cleanText,
 formatDuration,
 IDLE_PANEL_AUTO_DELETE_MS,
 LOOP_LABELS,
 renderSyncedProgress,
 resolveNowPlayingWebUrl,
} from './src/playerGui.js';

// Kiểm tra phiên bản Node tối thiểu do thư viện voice yêu cầu Node >= 22.12.0.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw new Error('Cần Node >=22.12.0');
const { token: DISCORD_TOKEN, guildId: GUILD_ID, autoRegister } = resolveConfig(process.env);
installAudioEnhancer(ffmpeg);

// Chỉ nạp trực tiếp SoundCloudPlugin siêu nhẹ (~80–140MB RAM, không nạp YouTubePlugin/jsdom vốn ngốn >300MB & bị chặn LOGIN_REQUIRED trên VPS).
// Mọi link YouTube & Spotify đều được giải mã metadata qua HTTP/oEmbed gọn nhẹ ở src/policy.js rồi phát luồng âm thanh chuẩn từ SoundCloud.
const pluginRoot = new URL('./node_modules/@ziplayer/plugin/dist/', import.meta.url);
const { SoundCloudPlugin } = await import(new URL('SoundCloudPlugin.js', pluginRoot));

// Khởi tạo Discord client với bộ nhớ đệm tối thiểu để giảm mức tiêu thụ RAM.
const client = new Client({
 intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
 allowedMentions: { parse: [] },
 makeCache: Options.cacheWithLimits({
  ...Options.DefaultMakeCacheSettings,
  MessageManager: 0,
  PresenceManager: 0,
  ReactionManager: 0,
  UserManager: 0,
  GuildMemberManager: { maxSize: 1, keepOverLimit: m => m.id === m.client.user?.id },
 }),
});

// Kiểm tra bản nhạc SoundCloud có luồng phát trọn bài không bị khóa DRM (cbc/ctr-encrypted-hls), không bị nhá hàng 30s Go+ (SNIP) hay chặn vùng (BLOCK).
function isPlayableSoundCloudRaw(item) {
 if (!item) return false;
 if (item.policy === 'SNIP' || item.policy === 'BLOCK') return false;
 if (item.duration === 30000 && Number(item.full_duration) > 45000) return false;
 const transcodings = item.media?.transcodings;
 if (!Array.isArray(transcodings) || !transcodings.length) return true;
 return transcodings.some(
  t => !t?.snipped && (t?.format?.protocol === 'progressive' || t?.format?.protocol === 'hls')
 );
}

function mapSoundCloudRawTrack(item, requestedBy) {
 const artwork = typeof item.artwork_url === 'string'
  ? item.artwork_url.replace('-large.', '-t500x500.')
  : undefined;
 return {
  id: String(item.id),
  title: item.title,
  url: item.permalink_url,
  duration: item.duration,
  thumbnail: artwork,
  requestedBy,
  source: 'soundcloud',
  metadata: {
   author: item.user?.username,
   plays: item.playback_count,
  },
 };
}

// Khởi tạo SoundCloudPlugin đã tối ưu: lọc bỏ bản 30s Go+ SNIP khi tìm kiếm & AutoPlay để luôn phát trọn bài ổn định trên VPS.
const soundCloudPlugin = new SoundCloudPlugin();
soundCloudPlugin.priority = 20;
soundCloudPlugin.ready = soundCloudPlugin.ready.catch(() => {});
// Gỡ giới hạn timeout 12 giây của Axios đối với luồng tải âm thanh trực tiếp để khi tạm dừng nhạc không bị tự ngắt socket.
if (soundCloudPlugin.client?.http?.interceptors?.request) {
 soundCloudPlugin.client.http.interceptors.request.use(cfg => {
  if (cfg?.responseType === 'stream') cfg.timeout = 0;
  return cfg;
 });
}
const rawSoundCloudSearch = soundCloudPlugin.search.bind(soundCloudPlugin);

soundCloudPlugin.search = async function patchedSoundCloudSearch(query, requestedBy) {
 await this.client.ensureReady();
 const trimmed = String(query ?? '').trim();
 if (/^https?:\/\//i.test(trimmed)) {
  const direct = await rawSoundCloudSearch(trimmed, requestedBy);
  if (Array.isArray(direct?.tracks)) {
   direct.tracks.forEach(t => {
    if (typeof t?.thumbnail === 'string') t.thumbnail = t.thumbnail.replace('-large.', '-t500x500.');
   });
  }
  return direct;
 }
 const cleanQ = trimmed.replace(/^(?:sc|soundcloud):\s*/i, '').trim();
 if (!cleanQ) return { tracks: [] };
 const results = await this.client.search({ query: cleanQ, limit: 25 });
 const playable = (Array.isArray(results) ? results : []).filter(isPlayableSoundCloudRaw);
 const chosen = (playable.length ? playable : results ?? []).slice(0, 15);
 return { tracks: chosen.map(item => mapSoundCloudRawTrack(item, requestedBy)) };
};

soundCloudPlugin.getRelatedTracks = async function patchedRelatedTracks(track, opts = {}) {
 await this.client.ensureReady();
 try {
  const wantLimit = opts?.limit || 1;
  const trackURL = track?.url ?? track;
  const trackTitle = track?.title ?? track;
  let rawItems = this.validate(trackURL)
   ? await this.client.getRelatedTracks(trackURL, { limit: 30 }).catch(() => [])
   : [];
  if (!rawItems?.length && trackTitle) {
   const searched = await this.search(String(trackTitle), 'SoundCloud_Related').catch(() => null);
   if (searched?.tracks?.[0]?.url) {
    rawItems = await this.client.getRelatedTracks(searched.tracks[0].url, { limit: 30 }).catch(() => []);
   }
  }
  const historyUrls = new Set((opts?.history ?? []).map(h => h?.url).filter(Boolean));
  return (Array.isArray(rawItems) ? rawItems : [])
   .filter(item => isPlayableSoundCloudRaw(item) && item.duration > 35000 && item.duration <= 10800000 && !historyUrls.has(item.permalink_url))
   .slice(opts?.offset || 0, (opts?.offset || 0) + wantLimit)
   .map(item => mapSoundCloudRawTrack(item, 'auto'));
 } catch {
  return [];
 }
};

// Khi một link SoundCloud trực tiếp bị khóa luồng hoặc chỉ cho nghe thử Go+, tự tìm bản đầy đủ tương ứng và đồng bộ lại thời lượng.
function installSmartFallback(plugin, notifySynced) {
 plugin.getFallback = async function patchedFallback(track) {
  const rawQuery = [track?.title, track?.metadata?.author].filter(Boolean).join(' ').trim() || track?.title;
  let res = await this.search(rawQuery, track?.requestedBy || 'fallback').catch(() => null);
  let candidates = (res?.tracks ?? []).filter(c => c && !c.isLive && !(c.duration > 10800000) && c.url !== track?.url);

  if (!candidates.length && track?.title) {
   const cleaned = sanitizeLyricsTitle(track.title, track?.metadata?.author);
   const cleanQuery = [cleaned.title, cleaned.artist].filter(Boolean).join(' ').trim();
   if (cleanQuery && cleanQuery !== rawQuery) {
    res = await this.search(cleanQuery, track?.requestedBy || 'fallback').catch(() => null);
    candidates = (res?.tracks ?? []).filter(c => c && !c.isLive && !(c.duration > 10800000) && c.url !== track?.url);
   }
  }
  if (!candidates.length) throw new Error(`Không tìm thấy luồng dự phòng từ ${this.name}`);

  const best = pickBestMatchingTrack(candidates, {
   title: track?.title,
   artist: track?.metadata?.author,
   durationMs: track?.duration > 35000 ? track?.duration : 0,
  });
  const ordered = [best, ...candidates.filter(c => c !== best)].filter(Boolean).slice(0, 3);

  let lastErr;
  for (const cand of ordered) {
   try {
    const streamInfo = await this.getStream(cand);
    if (streamInfo?.stream) {
     if (cand.duration > 0) track.duration = cand.duration;
     if (cand.url) track.url = cand.url;
     if (cand.id) track.id = cand.id;
     if (!track.thumbnail && cand.thumbnail) track.thumbnail = cand.thumbnail;
     track.source = this.name;
     track.metadata = { ...track.metadata, ...cand.metadata };
     notifySynced?.(track);
     return streamInfo;
    }
   } catch (err) {
    lastErr = err;
   }
  }
  throw lastErr ?? new Error(`Không thể tải luồng dự phòng từ ${this.name}`);
 };
}

// Khởi tạo trình quản lý phát nhạc ZiPlayer ở cấu hình nhẹ, tắt bộ đệm tìm kiếm và thống kê.
const manager = new PlayerManager({
 plugins: [soundCloudPlugin],
 enableSearchCache: false,
 enableStatsCollection: false,
 autoCleanup: true,
 cleanupInterval: 60000,
 extractorTimeout: 15000,
});

installSmartFallback(soundCloudPlugin, syncedTrack => {
 for (const p of manager.getAll()) {
  if (p?.queue?.currentTrack === syncedTrack) schedulePanelUpdate(p, { track: syncedTrack });
 }
});

// Bộ lưu trạng thái phòng thoại & danh sách nhạc tự động khôi phục khi bot bị reset hoặc cập nhật tính năng.
const sessionStore = createRuntimeSessionStore();

// Bộ tự động đặt trạng thái Kênh Thoại (Voice Channel Status) theo tên bài hát đang phát & dọn sạch khi dừng nhạc/rời phòng.
const voiceRoomStatus = createVoiceRoomStatusSync({ rest: client.rest, client });

// Trung tâm Website "Now Playing" (giao diện kiểu Ziji V10 + SSE thời gian thực + tự động đồng bộ ra Cloudflare Worker).
const nowPlayingHub = createNowPlayingHub({
 getPlayer: () => manager.getAll()[0] ?? null,
 getResumeSeal: () => {
  const exported = sessionStore.exportSessionsObject();
  return Object.keys(exported).length > 0 ? sealSessionPayload(exported, DISCORD_TOKEN) : null;
 },
 client,
 botToken: DISCORD_TOKEN,
 deferInitialPush: true,
});

// Máy chủ HTTP nhẹ phục vụ Website "Now Playing" (/) + API thời gian thực (/api/now-playing) + kiểm tra sức khỏe (/healthz).
const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.status(client.isReady() ? 200 : 503).json({ ready: client.isReady(), uptime: Math.floor(process.uptime()) }));
nowPlayingHub.mountRoutes(app);
const explicitPort = process.env.PORT || process.env.SERVER_PORT;
let server = app.listen(Number(explicitPort || 3000), '0.0.0.0');
server.on('error', e => {
 if (!explicitPort && e?.code === 'EADDRINUSE') {
  console.warn('[http] Cổng 3000 đang bận, tự chuyển sang cổng trống.');
  server = app.listen(0, '0.0.0.0');
  server.on('error', e2 => console.warn('[http]', e2?.code ?? e2?.name ?? 'Lỗi'));
  return;
 }
 fatal(e);
});

let busy = false, closing = false;
const cooldown = new Map();
const refreshCooldown = new Map();
const guildKickAlerts = new Map();
const guildLastKickAlertAt = new Map();
const guildLastRejoinAt = new Map();
const guildKickSnapshots = new Map();
const pendingAutoDeletes = new Map();
const channelLastSweepAt = new Map();
const KICK_SNAPSHOT_TTL_MS = 30 * 60 * 1000; // Giữ trạng thái bài đang phát & hàng đợi trong 30 phút sau khi bị kick để khôi phục khi /join.
const PROGRESS_TICK_MS = 5000; // Chu kỳ cập nhật thanh tiến trình (5 giây/lần: chuẩn mượt, không bao giờ chạm giới hạn rate-limit Discord).
const CHANNEL_SWEEP_COOLDOWN_MS = 180000; // Quét dọn tin nhắn mồ côi tối đa 3 phút/lần mỗi kênh.
const KNOWN_ERROR_RE = /^(Hãy|Bạn|Bot|Chờ|Chỉ|Hàng|Không|Chưa|Tên|URL|Lệnh|Bản|Link|Thời|Số|Định|Vị|Mức|Âm)/;

function clearPanelTimer(player) {
 if (player?.userdata?.panelTimer) {
  clearTimeout(player.userdata.panelTimer);
  player.userdata.panelTimer = null;
 }
}

function stopProgressTicker(player) {
 if (player?.userdata?.progressTicker) {
  clearInterval(player.userdata.progressTicker);
  player.userdata.progressTicker = null;
 }
}

function clearAutoDeleteTimer(player) {
 const ud = player?.userdata;
 if (!ud) return;
 if (ud.autoDeleteTimer) {
  clearTimeout(ud.autoDeleteTimer);
  ud.autoDeleteTimer = null;
 }
 if (ud.autoDeleteKey) {
  const entry = pendingAutoDeletes.get(ud.autoDeleteKey);
  if (entry?.timer) clearTimeout(entry.timer);
  pendingAutoDeletes.delete(ud.autoDeleteKey);
  ud.autoDeleteKey = null;
 }
}

// Tự động thu dọn khung chờ 24/7, khung kết thúc & thông báo kick sau 4 phút 30 giây qua Discord REST API (không phụ thuộc MessageManager cache).
function schedulePanelAutoDelete(msg, player = null, delayMs = IDLE_PANEL_AUTO_DELETE_MS, fallbackChannelId = null) {
 const resolvedChannelId = fallbackChannelId ?? player?.userdata?.textChannel?.id ?? null;
 const ref = extractMessageRef(msg, resolvedChannelId);
 if (!ref && typeof msg?.delete !== 'function') return;
 if (!(delayMs > 0)) return;
 clearAutoDeleteTimer(player);

 const key = ref ? `${ref.channelId}:${ref.messageId}` : null;
 if (key && pendingAutoDeletes.has(key)) {
  clearTimeout(pendingAutoDeletes.get(key).timer);
  pendingAutoDeletes.delete(key);
 }

 const ud = player?.userdata ?? null;
 const timer = setTimeout(() => {
  if (key) pendingAutoDeletes.delete(key);
  if (ud?.autoDeleteTimer === timer) {
   ud.autoDeleteTimer = null;
   ud.autoDeleteKey = null;
  }
  if (ud?.panelMessage?.id && ud.panelMessage.id === (ref?.messageId ?? msg?.id)) {
   ud.panelMessage = null;
  }
  void deleteDiscordMessage(client.rest, msg, ref?.channelId ?? resolvedChannelId);
 }, delayMs);
 timer.unref?.();

 if (key) {
  if (pendingAutoDeletes.size >= 80) {
   const oldestKey = pendingAutoDeletes.keys().next().value;
   clearTimeout(pendingAutoDeletes.get(oldestKey)?.timer);
   pendingAutoDeletes.delete(oldestKey);
  }
  pendingAutoDeletes.set(key, { channelId: ref.channelId, messageId: ref.messageId, msg, timer });
 }
 if (ud) {
  ud.autoDeleteTimer = timer;
  ud.autoDeleteKey = key;
 }
}

function collectActiveMessageIds() {
 const ids = new Set();
 for (const pl of manager.getAll()) {
  if (pl?.userdata?.panelMessage?.id) ids.add(String(pl.userdata.panelMessage.id));
  if (pl?.userdata?.voiceAlertMessage?.id) ids.add(String(pl.userdata.voiceAlertMessage.id));
 }
 return ids;
}

// Tự động quét nhẹ và xóa các khung "Phiên phát nhạc đã kết thúc" / "Phát hiện bot bị kick" cũ bị mồ côi (ví dụ sau khi restart bot).
function triggerChannelSweep(channelId, { clearAllKickAlerts = false, force = false } = {}) {
 if (!channelId || !client.user?.id) return;
 const key = String(channelId);
 const now = Date.now();
 if (!force && now - (channelLastSweepAt.get(key) ?? 0) < CHANNEL_SWEEP_COOLDOWN_MS) return;
 if (channelLastSweepAt.size >= 80) channelLastSweepAt.clear();
 channelLastSweepAt.set(key, now);
 void sweepChannelStaleNotices({
  rest: client.rest,
  channelId: key,
  botId: client.user.id,
  activeMessageIds: collectActiveMessageIds(),
  pendingKeys: new Set(pendingAutoDeletes.keys()),
  clearAllKickAlerts,
 }).catch(() => {});
}

function persistActiveSession(player, { immediate = false } = {}) {
 if (closing || !player || player.destroyed) return;
 sessionStore.savePlayer(player, { immediate });
}

function clearPersistedSession(guildId) {
 if (closing || !guildId) return;
 sessionStore.removeGuild(guildId, { immediate: true });
}

function markPanelTouched(player, overrides = {}) {
 const ud = player?.userdata;
 if (ud) {
  ud.lastPanelEditAt = Date.now();
  ud.lastProgressText = renderSyncedProgress(player).barText;
 }
 if (player && !player.destroyed) {
  persistActiveSession(player);
  nowPlayingHub.publish({ player, ...overrides });
 }
}

// Kiểm tra trong kênh thoại có ít nhất 1 người nghe thật qua voiceStates (chính xác tuyệt đối ngay cả khi GuildMemberManager giới hạn bộ đệm).
function hasHumanListener(player) {
 const guild = client.guilds.cache.get(player?.guildId);
 const channelId = player?.userdata?.voiceChannelId ?? guild?.members?.me?.voice?.channelId;
 if (!guild || !channelId) return true;
 if (!guild.voiceStates?.cache) return true;
 return guild.voiceStates.cache.some(vs => vs.channelId === channelId && vs.id !== client.user?.id && !vs.member?.user?.bot);
}

function clearEmptyTimer(player) {
 if (player?.userdata?.emptyTimer) {
  clearTimeout(player.userdata.emptyTimer);
  player.userdata.emptyTimer = null;
 }
 if (player?.userdata?.restoreReconnectTimer) {
  clearTimeout(player.userdata.restoreReconnectTimer);
  player.userdata.restoreReconnectTimer = null;
 }
}

// Áp dụng trạng thái 24/7 trực tiếp lên cả Player options lẫn LifecycleController bên trong ZiPlayer.
function apply247State(player, enabled) {
 if (!player?.userdata) return;
 player.userdata.stay247 = enabled;
 player.options.leaveOnEnd = !enabled;
 player.options.leaveOnEmpty = !enabled;
 if (player.runtimeGraph?.lifecycleController) {
  player.runtimeGraph.lifecycleController.leaveOnEnd = !enabled;
  player.runtimeGraph.lifecycleController.leaveOnEmpty = !enabled;
 }
 if (enabled) {
  if (!player.queue?.currentTrack && (player.upcomingTracks?.length ?? 0) === 0) {
   player.userdata.idleOpen = true;
  }
  player.clearLeaveTimeout?.();
  clearEmptyTimer(player);
 } else {
  player.userdata.idleOpen = false;
  if (!player.queue?.currentTrack && (player.upcomingTracks?.length ?? 0) === 0) {
   player.scheduleLeave?.();
  }
 }
}

// Cập nhật tin nhắn khung điều khiển an toàn (chống chồng lấn request và tự dọn nếu tin nhắn bị xóa).
async function editPanelSafely(player, overrides = {}) {
 const ud = player?.userdata;
 if (!ud || player.destroyed || ud.ending || ud.manualDisconnect || !ud.panelMessage) return;
 if (ud.panelEditInFlight) return;
 ud.panelEditInFlight = true;
 try {
  const msg = ud.panelMessage;
  const payload = buildPlayerPayload(player, overrides);
  markPanelTouched(player);
  await msg.edit(payload);
 } catch (err) {
  const code = err?.code;
  if (code === 10008 || code === 50001 || code === 50013) {
   ud.panelMessage = null;
   stopProgressTicker(player);
  }
 } finally {
  ud.panelEditInFlight = false;
 }
}

// Bộ nhịp tự động đẩy thanh tiến trình 0:00 🔘▬▬▬ chạy đúng theo luồng âm thanh thực tế mỗi 5 giây.
function startProgressTicker(player) {
 const ud = player?.userdata;
 if (!ud || player.destroyed || ud.ending || ud.manualDisconnect) return;
 stopProgressTicker(player);
 ud.progressTicker = setInterval(() => {
  if (!player || player.destroyed || !ud.panelMessage || ud.ending || ud.manualDisconnect || !player.queue?.currentTrack) {
   stopProgressTicker(player);
   return;
  }
  if (player.isPaused || !player.isPlaying || ud.panelEditInFlight || ud.panelTimer) return;
  if (Date.now() - (ud.lastSessionPersistAt ?? 0) >= 10000) {
   ud.lastSessionPersistAt = Date.now();
   persistActiveSession(player);
  }
  if (Date.now() - (ud.lastPanelEditAt ?? 0) < 4000) return;
  if (!hasHumanListener(player)) return;
  const nextBar = renderSyncedProgress(player).barText;
  if (!nextBar || nextBar === ud.lastProgressText) return;
  void editPanelSafely(player);
 }, PROGRESS_TICK_MS);
 ud.progressTicker.unref?.();
}

// Gửi khung điều khiển nhạc mới tinh xuống cuối kênh chat mỗi khi bắt đầu bài mới (xóa khung cũ để tránh rác kênh).
async function postFreshPanel(player, track) {
 const ud = player?.userdata;
 if (!ud || player.destroyed || ud.manualDisconnect) return;
 ud.ending = false;
 ud.idleOpen = false;
 clearPanelTimer(player);
 stopProgressTicker(player);
 clearAutoDeleteTimer(player);
 const oldMsg = ud.panelMessage;
 ud.panelMessage = null;
 if (oldMsg) void deleteDiscordMessage(client.rest, oldMsg, ud.textChannel?.id);
 if (!ud.textChannel?.send) return;
 try {
  const sent = await ud.textChannel.send(buildPlayerPayload(player, { track }));
  if (player.destroyed || ud.ending || ud.manualDisconnect) {
   sent.edit(buildEndedPayload()).catch(() => {});
   schedulePanelAutoDelete(sent, null, IDLE_PANEL_AUTO_DELETE_MS, ud.textChannel?.id);
   return;
  }
  ud.panelMessage = sent;
  markPanelTouched(player);
  if (ud.pendingKickRestoreSync) {
   ud.pendingKickRestoreSync = false;
   schedulePanelUpdate(player);
  }
  if (!player.isPaused) startProgressTicker(player);
 } catch (e) {
  console.warn('[khung-nhạc] Không thể gửi khung điều khiển vào kênh chat (kiểm tra quyền Gửi tin nhắn):', e?.code ?? e?.name ?? 'Lỗi');
 }
}

// Gom các thay đổi liên tiếp (âm lượng, lặp, 24/7, hàng đợi, tạm dừng, tua nhạc) để cập nhật khung điều khiển & Website mượt mà.
function schedulePanelUpdate(player, overrides = {}) {
 if (player && !player.destroyed) {
  persistActiveSession(player);
  nowPlayingHub.publish({ player, ...overrides });
  voiceRoomStatus.syncPlayer(player, overrides);
 }
 const ud = player?.userdata;
 if (!ud || player.destroyed || ud.ending || !ud.panelMessage) return;
 clearPanelTimer(player);
 ud.panelTimer = setTimeout(() => {
  ud.panelTimer = null;
  void editPanelSafely(player, overrides);
 }, 250);
 ud.panelTimer.unref?.();
}

// Đóng khung điều khiển của bài hiện tại (hoặc chuyển sang khung chờ 24/7 nếu đang bật 24/7) và hẹn giờ tự xóa sau 4.5 phút.
async function closeCurrentPanel(player, reason, { keepIdle247 = false } = {}) {
 const ud = player?.userdata;
 if (!ud) return;
 ud.ending = true;
 clearPanelTimer(player);
 stopProgressTicker(player);
 clearAutoDeleteTimer(player);
 const shouldKeepIdle = keepIdle247 && ud.stay247 && !ud.manualDisconnect;
 if (shouldKeepIdle) persistActiveSession(player, { immediate: true });
 nowPlayingHub.publish(
  {
   player: shouldKeepIdle ? player : null,
   track: null,
   reason,
  },
  { immediatePush: Boolean(shouldKeepIdle) },
 );
 updateBotPresence(null);
 voiceRoomStatus.syncPlayer(player, { track: null });
 const payload = shouldKeepIdle
  ? buildIdle247Payload(player, reason)
  : buildEndedPayload(reason);
 const msg = ud.panelMessage;
 if (shouldKeepIdle) {
  if (msg) {
   const edited = await msg.edit(payload).catch(() => null);
   if (edited) {
    schedulePanelAutoDelete(msg, player);
    return;
   }
   ud.panelMessage = null;
  }
  if (ud.textChannel?.send && reason) {
   const sent = await ud.textChannel.send(payload).catch(() => null);
   ud.panelMessage = sent;
   if (sent) schedulePanelAutoDelete(sent, player);
  }
  return;
 }
 ud.panelMessage = null;
 if (msg) {
  await msg.edit(payload).catch(() => {});
  schedulePanelAutoDelete(msg, null, IDLE_PANEL_AUTO_DELETE_MS, ud.textChannel?.id);
 }
}

// Sao lưu gọn nhẹ bài hát đang phát, mốc thời gian và hàng đợi trước khi phiên bị hủy do bot bị kick khỏi phòng.
function cloneSavedTrack(t) {
 if (!t || typeof t !== 'object') return null;
 return {
  id: t.id,
  title: t.title,
  url: t.url,
  duration: t.duration,
  thumbnail: t.thumbnail,
  requestedBy: t.requestedBy,
  source: t.source,
  isLive: t.isLive,
  metadata: t.metadata ? { ...t.metadata } : undefined,
 };
}

function captureKickSnapshot(player) {
 if (!player || player.destroyed) return null;
 const cur = player.queue?.currentTrack ?? player.currentTrack ?? null;
 const upcoming = (Array.isArray(player.upcomingTracks) ? player.upcomingTracks : [])
  .slice(0, 20)
  .map(cloneSavedTrack)
  .filter(Boolean);
 const clonedCur = cloneSavedTrack(cur);
 if (!clonedCur && !upcoming.length) return null;

 let positionMs = 0;
 if (cur) {
  const { currentMs, totalMs } = renderSyncedProgress(player, cur, Boolean(player.isPaused));
  if (currentMs >= 5000 && (!totalMs || currentMs < totalMs - 5000)) {
   positionMs = Math.round(currentMs);
  }
 }

 const snap = {
  savedAt: Date.now(),
  currentTrack: clonedCur,
  positionMs,
  upcomingTracks: upcoming,
  wasPaused: Boolean(player.isPaused && !player.userdata?.autoPausedByMute),
  volume: player.volume ?? 100,
  loopMode: (typeof player.loop === 'function' ? player.loop() : 'off') ?? 'off',
  autoPlay: typeof player.autoPlay === 'function' ? Boolean(player.autoPlay()) : false,
  soundPreset: player.userdata?.soundPreset ?? 'hd',
  ownerId: player.userdata?.ownerId ?? null,
 };
 if (guildKickSnapshots.size >= 50) guildKickSnapshots.clear();
 guildKickSnapshots.set(player.guildId, snap);
 return snap;
}

// Khôi phục lại đúng bài hát, mốc thời gian tua và hàng đợi trước khi bị kick khi người dùng gọi /join hoặc /247.
async function restoreKickSnapshotIfAny(player, voiceChannel, fallbackUserId) {
 const guildId = player?.guildId;
 if (!guildId) return null;
 const snap = guildKickSnapshots.get(guildId);
 if (!snap) return null;
 guildKickSnapshots.delete(guildId);
 if (Date.now() - snap.savedAt > KICK_SNAPSHOT_TTL_MS) return null;

 const allTracks = [snap.currentTrack, ...(snap.upcomingTracks ?? [])].filter(Boolean);
 if (!allTracks.length) return null;
 const [firstTrack, ...restTracks] = allTracks;

 const origOwner = resolveHumanRequester(firstTrack.requestedBy) || snap.ownerId;
 const guildObj = voiceChannel?.guild ?? client.guilds.cache.get(guildId);
 const ownerStillInRoom = Boolean(
  origOwner && (
   guildObj?.voiceStates?.cache?.get(origOwner)?.channelId === voiceChannel?.id ||
   voiceChannel?.members?.has?.(origOwner)
  ),
 );
 const effectiveOwner = ownerStillInRoom ? origOwner : fallbackUserId;
 if (!ownerStillInRoom) firstTrack.requestedBy = fallbackUserId;

 if (player.userdata) {
  player.userdata.soundPreset = snap.soundPreset ?? 'hd';
  player.userdata.ownerId = effectiveOwner;
  player.userdata.idleOpen = false;
 }
 setAudioEnhancement({
  preset: snap.soundPreset ?? 'hd',
  channelBitrate: voiceChannel?.bitrate,
 });

 configurePlayerAudio(player);
 if (typeof snap.volume === 'number' && snap.volume !== 100) player.setVolume(snap.volume);
 if (snap.autoPlay) player.autoPlay(true);

 const played = await player.play(firstTrack, firstTrack.requestedBy || fallbackUserId).catch(() => false);
 if (!played) return null;

 if (restTracks.length > 0) {
  if (typeof player.queue?.addMultiple === 'function') {
   player.queue.addMultiple(restTracks);
  } else {
   for (const t of restTracks) player.queue?.insert?.(t, player.queue.size);
  }
 }
 if (snap.loopMode && snap.loopMode !== 'off') player.loop(snap.loopMode);

 let resumedAtMs = 0;
 if (snap.currentTrack && snap.positionMs >= 5000) {
  const seekOk = await player.seek(snap.positionMs).catch(() => false);
  if (seekOk) resumedAtMs = snap.positionMs;
 }
 if (snap.wasPaused && !player.isPaused) {
  await player.pause().catch(() => {});
 }
 if (player.userdata && !player.userdata.panelMessage) {
  player.userdata.pendingKickRestoreSync = true;
 }
 schedulePanelUpdate(player);
 return {
  track: firstTrack,
  resumedAtMs,
  queuedCount: restTracks.length,
 };
}

// Tự động xóa thông báo bị kick khỏi phòng ngay khi bot được gọi vào lại kênh thoại (kể cả thông báo cũ trước lúc bot restart).
function clearKickAlertsOnRejoin(guildId, textChannelId = null) {
 if (!guildId) return;
 guildLastRejoinAt.set(guildId, Date.now());
 const msgs = guildKickAlerts.get(guildId);
 if (msgs?.length) {
  guildKickAlerts.delete(guildId);
  for (const m of msgs) {
   void deleteDiscordMessage(client.rest, m, textChannelId);
  }
 }
 if (textChannelId) {
  triggerChannelSweep(textChannelId, { clearAllKickAlerts: true, force: true });
 }
}

// Gửi hoặc cập nhật thông báo trạng thái mic / kick khỏi phòng gọn gàng (chống gửi trùng 2 lần và tự thu dọn sau 4.5 phút).
async function sendVoiceGuardAlert(textChannel, userdata, event, guildId = textChannel?.guildId) {
 const embed = buildVoiceGuardEmbed(event, { autoDeleteMs: IDLE_PANEL_AUTO_DELETE_MS });
 if (!embed || !textChannel?.send) return;
 const payload = { embeds: [embed], allowedMentions: { parse: [] } };

 // Khi mở lại mic, ưu tiên sửa đè ngay lên khung báo tắt mic trước đó để kênh chat luôn sạch sẽ.
 if (event.action === 'unmuted' && userdata?.voiceAlertMessage) {
  const edited = await userdata.voiceAlertMessage.edit(payload).catch(() => null);
  if (edited) {
   schedulePanelAutoDelete(edited, null, 60000, textChannel.id);
   return;
  }
 }

 const isKickEvent = String(event.action).startsWith('kicked_');
 const startedAt = Date.now();
 if (!isKickEvent && userdata && startedAt - (userdata.lastVoiceAlertAt ?? 0) < 3000) return;
 if (isKickEvent && guildId) {
  // Khóa chống gửi đúp khi Discord bắn 2 sự kiện VoiceStateUpdate liên tiếp lúc bị kick.
  if (startedAt - (guildLastKickAlertAt.get(guildId) ?? 0) < 4000) return;
  guildLastKickAlertAt.set(guildId, startedAt);
  const prevKickMsgs = guildKickAlerts.get(guildId);
  if (prevKickMsgs?.length) {
   guildKickAlerts.delete(guildId);
   for (const m of prevKickMsgs) void deleteDiscordMessage(client.rest, m, textChannel.id);
  }
 }
 if (userdata) {
  userdata.lastVoiceAlertAt = startedAt;
  if (userdata.voiceAlertMessage) {
   void deleteDiscordMessage(client.rest, userdata.voiceAlertMessage, textChannel.id);
   userdata.voiceAlertMessage = null;
  }
 }
 const sent = await textChannel.send(payload).catch(() => null);
 if (!sent) return;
 if (isKickEvent && guildId) {
  if ((guildLastRejoinAt.get(guildId) ?? 0) >= startedAt) {
   void deleteDiscordMessage(client.rest, sent, textChannel.id);
   return;
  }
  const list = guildKickAlerts.get(guildId) ?? [];
  list.push(sent);
  if (guildKickAlerts.size >= 50) guildKickAlerts.clear();
  guildKickAlerts.set(guildId, list);
  schedulePanelAutoDelete(sent, null, IDLE_PANEL_AUTO_DELETE_MS, textChannel.id);
  return;
 }
 if (userdata && !isKickEvent) userdata.voiceAlertMessage = sent;
}

// Cập nhật dòng trạng thái dưới tên bot trong Discord để mọi thành viên thấy tên bài đang phát & địa chỉ Website Now Playing.
function updateBotPresence(track = null) {
 if (!client.user) return;
 let hostLabel = '';
 try {
  const webUrl = resolveNowPlayingWebUrl();
  if (webUrl) hostLabel = new URL(webUrl).host;
 } catch {}
 const statusText = track?.title
  ? `${cleanText(track.title, 58)}${hostLabel ? ` • ${hostLabel}` : ''}`
  : `/play${hostLabel ? ` • ${hostLabel}` : ''}`;
 try {
  client.user.setActivity(statusText, { type: ActivityType.Listening });
 } catch {}
}

// Đóng toàn bộ phiên phát, xóa mọi bộ hẹn giờ/tham chiếu và cho bot rời khỏi kênh thoại.
async function destroyPlayerSession(guildId, reason) {
 clearPersistedSession(guildId);
 const p = manager.get(guildId);
 if (!p) {
  nowPlayingHub.publish({ player: null, track: null, reason }, { immediatePush: true, clearRemoteSession: true });
  updateBotPresence(null);
  return;
 }
 const ud = p.userdata;
 if (ud) {
  ud.manualDisconnect = true;
  ud.stay247 = false;
  ud.restoringUntil = 0;
  if (ud.voiceAlertMessage) {
   void deleteDiscordMessage(client.rest, ud.voiceAlertMessage, ud.textChannel?.id);
   ud.voiceAlertMessage = null;
  }
  stopProgressTicker(p);
  clearEmptyTimer(p);
  if (ud.voiceChannelId) {
   await voiceRoomStatus.clearChannelNow(ud.voiceChannelId, guildId);
  }
  await closeCurrentPanel(p, reason);
  ud.textChannel = null;
 }
 manager.delete(guildId);
 nowPlayingHub.publish({ player: null, track: null, reason }, { immediatePush: true, clearRemoteSession: true });
 updateBotPresence(null);
}

// Gắn sự kiện vòng đời từ ZiPlayer để tự động đồng bộ khung điều khiển nhạc trên kênh chat & Website Now Playing.
manager.on('trackStart', (player, track) => {
 const humanOwner = resolveHumanRequester(track?.requestedBy);
 if (humanOwner && player?.userdata) player.userdata.ownerId = humanOwner;
 if (Array.isArray(player?.queue?.history) && player.queue.history.length > 25) {
  player.queue.history.splice(0, player.queue.history.length - 25);
 }
 // Nếu bot đã bị tắt mic sẵn từ trước khi bắt đầu bài, tự tạm dừng ngay để không trôi mất bài hát trong im lặng.
 const botVs = client.guilds.cache.get(player.guildId)?.voiceStates?.cache?.get(client.user?.id);
 if ((botVs?.serverMute || botVs?.suppress) && player?.userdata) {
  player.userdata.voiceMuted = true;
  player.userdata.muteReason = botVs.serverMute ? 'server_mute' : 'stage_suppress';
  player.userdata.autoPausedByMute = true;
  const pauseTimer = setTimeout(() => {
   if (!player.destroyed && player.userdata?.voiceMuted && !player.isPaused) player.pause();
  }, 250);
  pauseTimer.unref?.();
 }
 persistActiveSession(player, { immediate: true });
 nowPlayingHub.publish({ player, track, paused: Boolean(player?.isPaused) }, { immediatePush: true });
 updateBotPresence(track);
 voiceRoomStatus.syncPlayer(player, { track, paused: Boolean(player?.isPaused) });
 void postFreshPanel(player, track);
});
manager.on('playerPause', player => {
 stopProgressTicker(player);
 schedulePanelUpdate(player, { paused: true });
});
manager.on('playerResume', player => {
 startProgressTicker(player);
 schedulePanelUpdate(player, { paused: false });
});
manager.on('seek', player => schedulePanelUpdate(player));
manager.on('volumeChange', player => schedulePanelUpdate(player));
manager.on('queueAdd', player => schedulePanelUpdate(player));
manager.on('queueRemove', player => schedulePanelUpdate(player));
manager.on('queueEnd', player => {
 if (player.userdata?.stay247) {
  player.userdata.idleOpen = true;
  player.clearLeaveTimeout?.();
  void closeCurrentPanel(player, 'Đã phát hết hàng đợi — Bot vẫn đang treo trong kênh thoại 24/7.', { keepIdle247: true });
  return;
 }
 void closeCurrentPanel(player, 'Đã phát hết toàn bộ danh sách nhạc.');
});
manager.on('playerStop', player => {
 if (player.userdata?.skipNextStopEvent) {
  player.userdata.skipNextStopEvent = false;
  return;
 }
 if (player.userdata?.stay247) {
  player.userdata.idleOpen = true;
  player.clearLeaveTimeout?.();
  void closeCurrentPanel(player, 'Đã dừng phát nhạc — Bot vẫn đang giữ kết nối kênh thoại 24/7.', { keepIdle247: true });
  return;
 }
 void closeCurrentPanel(player, 'Đã dừng phát nhạc.');
});
manager.on('playerDestroy', player => {
 clearPersistedSession(player?.guildId);
 clearEmptyTimer(player);
 void closeCurrentPanel(player, 'Phiên phát nhạc đã kết thúc, bot đã rời kênh thoại.');
 if (player.userdata) player.userdata.textChannel = null;
});
manager.on('playerError', (player, error) => {
 console.error('[lỗi-phát-nhạc]', error?.name ?? 'Error');
 if (player.userdata?.stay247) {
  player.userdata.idleOpen = true;
  player.userdata.skipNextStopEvent = true;
  player.stop();
  player.clearLeaveTimeout?.();
  void closeCurrentPanel(player, 'Nguồn bài hát gặp sự cố — Bot vẫn giữ kết nối kênh thoại 24/7.', { keepIdle247: true });
  return;
 }
 void destroyPlayerSession(player.guildId, 'Nguồn nhạc gặp sự cố nên phiên phát đã tự đóng để bảo vệ tài nguyên.');
});
manager.on('error', () => console.error('[quản-lý-nhạc] lỗi'));

// Kiểm tra người dùng đang ở kênh thoại thường và cùng kênh thoại với bot (chủ bot được phép điều khiển từ xa khi bot đang ở trong phòng).
async function requireSameVoiceChannel(guild, userId) {
 const cachedChannel = guild.voiceStates.cache.get(userId)?.channel;
 const channel = cachedChannel ?? (await guild.members.fetch(userId).catch(() => null))?.voice?.channel ?? null;
 const botChannelId = guild.members.me?.voice.channelId
  ?? guild.voiceStates.cache.get(client.user?.id)?.channelId
  ?? manager.get(guild.id)?.userdata?.voiceChannelId
  ?? null;

 if (isBotOwner(userId)) {
  if (botChannelId) {
   const activeBotChannel = guild.channels.cache.get(botChannelId);
   if (activeBotChannel?.type === 2) return activeBotChannel;
  }
  if (!channel || channel.type !== 2) throw new Error('Hãy vào một kênh thoại thường trước để bot biết phòng cần vào.');
  return channel;
 }

 if (!channel || channel.type !== 2) throw new Error('Hãy vào một kênh thoại thường trước.');
 if (botChannelId && botChannelId !== channel.id) throw new Error('Bạn phải ở cùng kênh thoại với bot.');
 return channel;
}

// Tạo mới hoặc lấy phiên kết nối kênh thoại hiện tại của máy chủ.
async function ensureVoiceSession({ guild, voiceChannel, textChannel, userId, initial247 = false }) {
 const me = guild.members.me ?? await guild.members.fetchMe();
 const perms = voiceChannel.permissionsFor(me);
 if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
  throw new Error('Bot thiếu quyền Xem kênh, Kết nối hoặc Nói trong kênh thoại này.');
 }

 let p = manager.get(guild.id);
 let created = false;
 if (!p) {
  if (manager.getAll().length) throw new Error('Chỉ cho phép một phiên phát đồng thời.');
  p = await manager.create(guild.id, {
   leaveOnEnd: !initial247,
   leaveOnEmpty: !initial247,
   leaveTimeout: 30000,
   userdata: {
    ownerId: userId,
    textChannel,
    voiceChannelId: voiceChannel.id,
    stay247: initial247,
    soundPreset: 'hd',
    idleOpen: Boolean(initial247),
    panelMessage: null,
    panelTimer: null,
    autoDeleteTimer: null,
    emptyTimer: null,
    ending: false,
    manualDisconnect: false,
    lastReconnectAt: 0,
    voiceMuted: false,
    muteReason: null,
    autoPausedByMute: false,
    kickTimestamps: [],
    voiceAlertMessage: null,
    lastVoiceAlertAt: 0,
   },
   selfDeaf: true,
   volume: 100,
   quality: 'high',
   ffmpegPath: ffmpeg,
   lowPerformance: true,
   preload: { enabled: false },
   crossfade: { enabled: false, autoEnable: false },
   smartTransition: { enabled: false },
   loudnessNormalization: { enabled: false },
   maxStreamStore: 1,
   extractorTimeout: 15000,
   antiStuck: {
    enabled: true,
    maxRetries: 2,
    retryDelayMs: 1500,
    reusePreloadFirst: false,
    reduceQualityOnRetry: false,
    controlledSkipThreshold: 2,
   },
  });
  created = true;
 } else if (p.userdata) {
  if (textChannel) p.userdata.textChannel = textChannel;
  p.userdata.voiceChannelId = voiceChannel.id;
 }

 try {
  configurePlayerAudio(p);
  setAudioEnhancement({
   preset: p.userdata?.soundPreset ?? 'hd',
   channelBitrate: voiceChannel.bitrate,
  });
  if (!p.connection) await p.connect(voiceChannel);
  clearKickAlertsOnRejoin(guild.id, textChannel?.id ?? p.userdata?.textChannel?.id ?? null);
  persistActiveSession(p, { immediate: true });
  return { player: p, created };
 } catch (e) {
  if (created) manager.delete(guild.id);
  throw e;
 }
}

// Dùng chung logic kiểm tra, tìm kiếm và thêm bài hát cho cả lệnh /play lẫn hộp thoại "Thêm bài hát mới".
async function enqueueAndPlay({ guild, voiceChannel, textChannel, rawQuery, userId, playNext = false }) {
 const now = Date.now();
 if (now - (cooldown.get(userId) ?? 0) < 3000) throw new Error('Chờ 3 giây giữa hai lần thêm nhạc.');
 const { query: q, spotifyMeta } = await resolveMusicRequest(rawQuery);
 if (cooldown.size >= 100) cooldown.clear();
 cooldown.set(userId, Date.now());

 const { player: p, created } = await ensureVoiceSession({ guild, voiceChannel, textChannel, userId });
 guildKickSnapshots.delete(guild.id);
 try {
  if (p.queue.size >= 20) throw new Error('Hàng đợi đã đủ 20 bài.');
  let result = await p.search(q, userId).catch(() => null);
  const isDirectScUrl = q.startsWith('https://soundcloud.com/');
  // Dự phòng cho link SoundCloud nếu API /resolve bị kén định dạng slug của bài hát.
  if (!result?.tracks?.length && isDirectScUrl) {
   const parts = new URL(q).pathname.split('/').filter(Boolean);
   if (parts.length >= 2) {
    const slugQuery = `sc:${parts[0].replace(/[-_]+/g, ' ')} ${parts[1].replace(/[-_]+/g, ' ')}`;
    const fallback = await p.search(slugQuery, userId).catch(() => null);
    const matched = fallback?.tracks?.find(t => t.url?.toLowerCase() === q.toLowerCase()) ?? fallback?.tracks?.[0];
    if (matched) result = { tracks: [matched] };
   }
  }
  const track = isDirectScUrl
   ? result?.tracks?.[0]
   : pickBestMatchingTrack(result?.tracks ?? [], spotifyMeta ?? { title: q });
  if (!track) throw new Error('Không tìm thấy bài hát phù hợp (link bị ẩn, giới hạn vùng/Go+ hoặc không tồn tại).');
  if (spotifyMeta?.thumbnail && !track.thumbnail) track.thumbnail = spotifyMeta.thumbnail;
  if (track.isLive || track.duration > 10800000) {
   throw new Error('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
  }
  const hadCurrent = Boolean(p.queue.currentTrack);
  if (!hadCurrent && p.userdata) {
   p.userdata.ownerId = userId;
   p.userdata.idleOpen = false;
  }
  if (hadCurrent && playNext) {
   p.queue.insert(track, 0);
   schedulePanelUpdate(p);
   return { track, queued: true, insertedNext: true };
  }
  if (!(await p.play(track, userId))) throw new Error('Không thể phát bài hát này.');
  if (hadCurrent) schedulePanelUpdate(p);
  return { track, queued: hadCurrent, insertedNext: false };
 } catch (e) {
  cooldown.delete(userId);
  if (created && !p.userdata?.stay247) manager.delete(guild.id);
  throw e;
 }
}

// Theo dõi biến động kênh thoại: phát hiện bị tắt mic (Server Mute / Stage), bị kick khỏi phòng, chuyển kênh AFK, hoặc kênh trống.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
 if (closing) return;
 const guild = newState.guild ?? oldState.guild;
 if ((newState.id ?? oldState.id) === client.user?.id && !oldState.channelId && newState.channelId) {
  clearKickAlertsOnRejoin(guild.id);
 }
 const p = manager.get(guild.id);
 if (!p || p.destroyed || !p.userdata) return;

 // Trường hợp trạng thái thoại của chính bot thay đổi (vào phòng, bị tắt/mở mic, bị kéo phòng hoặc bị kick).
 if ((newState.id ?? oldState.id) === client.user?.id) {
  // Trong 15 giây đầu vừa khôi phục sau restart, nếu Discord dọn trễ phiên voice cũ gây rớt thoáng qua thì tự nối lại êm ái thay vì báo nhầm bị kick.
  if (p.userdata.restoringUntil && Date.now() < p.userdata.restoringUntil && !p.userdata.manualDisconnect) {
   if (newState.channelId) {
    p.userdata.kickHandled = false;
    p.userdata.voiceChannelId = newState.channelId;
    if (newState.channel?.bitrate) setAudioEnhancement({ channelBitrate: newState.channel.bitrate });
   } else if (oldState.channelId) {
    const target = guild.channels.cache.get(p.userdata.voiceChannelId);
    if (target && !p.userdata.restoreReconnectTimer) {
     p.userdata.restoreReconnectTimer = setTimeout(() => {
      p.userdata.restoreReconnectTimer = null;
      if (!p.destroyed && !p.userdata?.manualDisconnect) {
       p.connect(target).catch(() => {});
      }
     }, 1500);
     p.userdata.restoreReconnectTimer.unref?.();
    }
    return;
   }
  }

  const ev = evaluateBotVoiceTransition(oldState, newState, p.userdata, {
   afkChannelId: guild.afkChannelId,
   isPlaying: Boolean(p.isPlaying || p.queue?.currentTrack),
   isPaused: Boolean(p.isPaused),
  });

  if (ev.action === 'manual_leave') return;

  if (ev.action === 'kicked_stop') {
   if (p.userdata.kickHandled) return;
   p.userdata.kickHandled = true;
   const alertChannel = p.userdata.textChannel;
   const saved = captureKickSnapshot(p);
   ev.hasSavedMusic = Boolean(saved);
   void destroyPlayerSession(guild.id, `👢 Bot đã bị kick (ngắt kết nối) khỏi kênh thoại <#${ev.oldChannelId}>.`);
   void sendVoiceGuardAlert(alertChannel, null, ev, guild.id);
   return;
  }

  if (ev.action === 'kicked_abort_247') {
   if (p.userdata.kickHandled) return;
   p.userdata.kickHandled = true;
   const alertChannel = p.userdata.textChannel;
   const saved = captureKickSnapshot(p);
   ev.hasSavedMusic = Boolean(saved);
   void destroyPlayerSession(
    guild.id,
    `👢 Phát hiện bot bị kick khỏi kênh <#${ev.oldChannelId}> liên tiếp — đã tự tắt 24/7 và rời phòng.`,
   );
   void sendVoiceGuardAlert(alertChannel, null, ev, guild.id);
   return;
  }

  if (ev.action === 'kicked_reconnect_247') {
   void sendVoiceGuardAlert(p.userdata.textChannel, p.userdata, ev, guild.id);
   if (Date.now() - p.userdata.lastReconnectAt > 4000) {
    p.userdata.lastReconnectAt = Date.now();
    const target = guild.channels.cache.get(p.userdata.voiceChannelId);
    const timer = setTimeout(() => {
     if (!p.destroyed && p.userdata?.stay247 && !p.userdata.manualDisconnect && target) {
      p.connect(target).catch(() => {
       const ch = p.userdata?.textChannel;
       void destroyPlayerSession(guild.id, `🚫 Bot không còn quyền vào lại kênh thoại <#${ev.oldChannelId}>.`);
       ch?.send?.({ content: `🚫 Bot không còn quyền kết nối lại vào kênh <#${ev.oldChannelId}> — đã dừng chế độ 24/7.` }).catch(() => {});
      });
     }
    }, 3000);
    timer.unref?.();
   }
   return;
  }

  if (newState.channelId) {
   p.userdata.kickHandled = false;
   if (!oldState.channelId) clearKickAlertsOnRejoin(guild.id, p.userdata.textChannel?.id ?? null);
   const changedRoom = oldState.channelId !== newState.channelId;
   p.userdata.voiceChannelId = newState.channelId;
   if (newState.channel?.bitrate) setAudioEnhancement({ channelBitrate: newState.channel.bitrate });
   persistActiveSession(p, { immediate: changedRoom });
   if (changedRoom) {
    nowPlayingHub.publish({ player: p }, { immediatePush: true });
    voiceRoomStatus.handleRoomMove(oldState.channelId, newState.channelId, p);
   }
  }

  if (ev.action === 'muted' || ev.action === 'joined_muted') {
   if (ev.muteReason === 'stage_suppress') {
    newState.setSuppressed?.(false).catch(() => newState.requestToSpeak?.().catch(() => {}));
   }
   if (ev.shouldPause && !p.isPaused) p.pause();
   if (p.userdata.idleOpen && !p.queue?.currentTrack) {
    if (p.userdata.panelMessage) {
     void closeCurrentPanel(p, undefined, { keepIdle247: true });
    } else {
     nowPlayingHub.publish({ player: p, track: null });
    }
   } else {
    schedulePanelUpdate(p, { paused: Boolean(p.isPaused), voiceMuted: true, muteReason: ev.muteReason });
   }
   void sendVoiceGuardAlert(p.userdata.textChannel, p.userdata, ev);
   return;
  }

  if (ev.action === 'unmuted') {
   if (ev.shouldResume && p.isPaused) p.resume();
   if (p.userdata.idleOpen && !p.queue?.currentTrack) {
    if (p.userdata.panelMessage) {
     void closeCurrentPanel(p, undefined, { keepIdle247: true });
    } else {
     nowPlayingHub.publish({ player: p, track: null });
    }
   } else {
    schedulePanelUpdate(p, { paused: Boolean(p.isPaused), voiceMuted: false, muteReason: null });
   }
   void sendVoiceGuardAlert(p.userdata.textChannel, p.userdata, ev);
   return;
  }

  if (ev.action === 'moved_afk') {
   if (ev.shouldPause && !p.isPaused) p.pause();
   schedulePanelUpdate(p, { paused: Boolean(p.isPaused) });
   void sendVoiceGuardAlert(p.userdata.textChannel, p.userdata, ev);
   return;
  }

  schedulePanelUpdate(p);
  return;
 }

 // Trường hợp người nghe vào/ra kênh thoại của bot.
 const vcId = p.userdata.voiceChannelId;
 if (!vcId || (oldState.channelId !== vcId && newState.channelId !== vcId)) return;
 if (p.userdata.stay247) {
  clearEmptyTimer(p);
  return;
 }
 const listeners = guild.voiceStates.cache.filter(vs => vs.channelId === vcId && vs.id !== client.user?.id).size;
 if (listeners === 0 && !p.userdata.emptyTimer) {
  p.userdata.emptyTimer = setTimeout(() => {
   p.userdata.emptyTimer = null;
   const remain = guild.voiceStates.cache.filter(vs => vs.channelId === vcId && vs.id !== client.user?.id).size;
   if (!p.destroyed && !p.userdata?.stay247 && remain === 0) {
    void destroyPlayerSession(guild.id, 'Kênh thoại không còn người nghe nên bot đã tự rời kênh.');
   }
  }, 30000);
  p.userdata.emptyTimer.unref?.();
 } else if (listeners > 0) {
  clearEmptyTimer(p);
 }
});

// Đồng bộ danh sách lệnh (tên lệnh giữ chuẩn quốc tế, chú thích bằng tiếng Việt) cho một máy chủ cụ thể.
async function syncGuildCommands(appId, targetGuildId) {
 await client.rest.put(Routes.applicationGuildCommands(appId, targetGuildId), { body: commands });
}

// Lúc bot vừa khởi động lên, quét nhẹ các kênh văn bản hoạt động để tự dọn sạch những khung kết thúc / thông báo kick cũ bị sót lại từ trước khi restart.
async function sweepStartupOrphanedNotices(readyClient) {
 const botId = readyClient.user?.id;
 if (!botId) return;
 const guilds = [...readyClient.guilds.cache.values()].slice(0, 5);
 const candidateChannels = [];
 for (const guild of guilds) {
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  for (const ch of guild.channels.cache.values()) {
   if (ch?.type !== 0 || !ch.lastMessageId) continue;
   if (me && !ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    continue;
   }
   const priority = /(bot|nhac|nhạc|music|nghich|nghịch|lenh|lệnh|chat)/i.test(ch.name ?? '') ? 1 : 0;
   candidateChannels.push({ id: ch.id, priority, lastId: ch.lastMessageId });
  }
 }
 candidateChannels.sort((a, b) => (b.priority - a.priority) || (b.lastId > a.lastId ? 1 : -1));
 for (const item of candidateChannels.slice(0, 12)) {
  channelLastSweepAt.set(item.id, Date.now());
  await sweepChannelStaleNotices({
   rest: readyClient.rest,
   channelId: item.id,
   botId,
   activeMessageIds: collectActiveMessageIds(),
   pendingKeys: new Set(pendingAutoDeletes.keys()),
   limit: 25,
  }).catch(() => {});
 }
}

// Tự động vào lại phòng thoại cũ và khôi phục chế độ 24/7 / bài đang phát / hàng đợi sau khi bot vừa reset hoặc cập nhật tính năng.
async function restorePersistedSessionsOnStartup(readyClient, gatewayFallback = {}) {
 let restoredOk = false;
 try {
  let sourceLabel = sessionStore.hasAny() ? 'ổ đĩa cục bộ' : null;
  if (!sourceLabel) {
   const remoteBackup = await nowPlayingHub.fetchRemoteSessionBackup();
   if (remoteBackup && sessionStore.importFallbackSessions(remoteBackup) > 0) {
    sourceLabel = 'bản sao lưu đám mây';
   }
  }
  if (!sourceLabel && gatewayFallback && Object.keys(gatewayFallback).length > 0) {
   if (sessionStore.importFallbackSessions(gatewayFallback) > 0) {
    sourceLabel = 'trạng thái phòng Discord trực tiếp';
   }
  }

  const restorable = sessionStore.getRestorableSessions();
  if (!restorable.length) {
   nowPlayingHub.setOutboundPushPaused(false);
   nowPlayingHub.publish();
   void sweepStartupOrphanedNotices(readyClient);
   return;
  }

  console.log(`[khôi-phục] Tìm thấy phiên phòng thoại trước khi restart (${sourceLabel ?? 'đã lưu'}), đang chờ 1.5s để nối lại...`);
  await new Promise(r => setTimeout(r, 1500));

  for (const snap of restorable) {
   if (manager.getAll().length > 0) break;
   if (GUILD_ID && snap.guildId !== GUILD_ID) {
    sessionStore.removeGuild(snap.guildId);
    continue;
   }
   const guild = readyClient.guilds.cache.get(snap.guildId)
    ?? await readyClient.guilds.fetch(snap.guildId).catch(() => null);
   if (!guild) continue;

   const voiceChannel = guild.channels.cache.get(snap.voiceChannelId)
    ?? await guild.channels.fetch(snap.voiceChannelId).catch(() => null);
   const isVoiceRoom = Boolean(voiceChannel && (voiceChannel.type === 2 || voiceChannel.type === 13 || voiceChannel.isVoiceBased?.()));
   if (!isVoiceRoom) {
    sessionStore.removeGuild(snap.guildId);
    continue;
   }

   const textChannel = snap.textChannelId
    ? (guild.channels.cache.get(snap.textChannelId) ?? await guild.channels.fetch(snap.textChannelId).catch(() => null))
    : null;
   if (textChannel?.id) {
    await sweepChannelStaleNotices({
     rest: readyClient.rest,
     channelId: textChannel.id,
     botId: readyClient.user.id,
     activeMessageIds: collectActiveMessageIds(),
     pendingKeys: new Set(pendingAutoDeletes.keys()),
     limit: 25,
    }).catch(() => {});
   }

   const fallbackOwner = snap.ownerId || readyClient.user.id;
   let connectedPlayer = null;
   let lastConnectErr = null;
   for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
     await new Promise(r => setTimeout(r, attempt === 2 ? 2500 : 4500));
    }
    try {
     const { player } = await ensureVoiceSession({
      guild,
      voiceChannel,
      textChannel,
      userId: fallbackOwner,
      initial247: Boolean(snap.stay247),
     });
     connectedPlayer = player;
     break;
    } catch (err) {
     lastConnectErr = err;
     console.warn(`[khôi-phục] Lần thử ${attempt}/3 nối lại phòng "${voiceChannel.name}" chưa thành công:`, err?.message ?? 'Lỗi');
    }
   }
   if (!connectedPlayer) throw lastConnectErr ?? new Error('Không thể kết nối lại kênh thoại sau 3 lần thử.');

   const p = connectedPlayer;
   if (p.userdata) {
    p.userdata.restoringUntil = Date.now() + 15000;
    p.userdata.soundPreset = snap.soundPreset ?? 'hd';
    p.userdata.ownerId = snap.ownerId ?? p.userdata.ownerId;
   }
   setAudioEnhancement({
    preset: snap.soundPreset ?? 'hd',
    channelBitrate: voiceChannel.bitrate,
   });
   if (typeof snap.volume === 'number' && snap.volume !== 100) p.setVolume(snap.volume);
   if (snap.autoPlay) p.autoPlay(true);

   nowPlayingHub.setOutboundPushPaused(false);
   const allTracks = [snap.currentTrack, ...(snap.upcomingTracks ?? [])].filter(Boolean);
   if (allTracks.length > 0) {
    const [firstTrack, ...restTracks] = allTracks;
    if (p.userdata) p.userdata.idleOpen = false;
    const played = await p.play(firstTrack, firstTrack.requestedBy || fallbackOwner).catch(() => false);
    if (played) {
     if (restTracks.length > 0) {
      if (typeof p.queue?.addMultiple === 'function') p.queue.addMultiple(restTracks);
      else for (const t of restTracks) p.queue?.insert?.(t, p.queue.size);
     }
     if (snap.loopMode && snap.loopMode !== 'off') p.loop(snap.loopMode);
     if (snap.currentTrack && snap.positionMs >= 5000) {
      await p.seek(snap.positionMs).catch(() => {});
     }
     if (snap.wasPaused && !p.isPaused) {
      await p.pause().catch(() => {});
     }
     if (p.userdata && !p.userdata.panelMessage) {
      p.userdata.pendingKickRestoreSync = true;
     }
     persistActiveSession(p, { immediate: true });
     schedulePanelUpdate(p);
     nowPlayingHub.publish({ player: p }, { immediatePush: true });
     restoredOk = true;
     console.log(`[khôi-phục] ✅ Đã tự động vào lại phòng "${voiceChannel.name}" và phát tiếp nhạc sau khi restart.`);
     break;
    }
   }

   // Trường hợp trước khi reset bot chỉ đang treo trong phòng thoại (24/7 hoặc vừa /join chưa mở bài).
   persistActiveSession(p, { immediate: true });
   nowPlayingHub.publish({ player: p, track: null }, { immediatePush: true });
   if (snap.stay247 && textChannel?.send) {
    await closeCurrentPanel(
     p,
     `🔄 Bot vừa khởi động lại / cập nhật xong và đã **tự động vào lại phòng thoại <#${voiceChannel.id}>** (chế độ 24/7).`,
     { keepIdle247: true },
    );
   } else if (!snap.stay247) {
    if (textChannel?.send) {
     const notice = await textChannel.send({
      content: `🔄 Bot vừa khởi động lại / cập nhật xong và đã **tự động vào lại phòng thoại <#${voiceChannel.id}>**.`,
      allowedMentions: { parse: [] },
     }).catch(() => null);
     if (notice) schedulePanelAutoDelete(notice, null, 90000, textChannel.id);
    }
    const listeners = guild.voiceStates.cache.filter(vs => vs.channelId === voiceChannel.id && vs.id !== readyClient.user?.id).size;
    if (listeners === 0 && p.userdata && !p.userdata.emptyTimer) {
     p.userdata.emptyTimer = setTimeout(() => {
      p.userdata.emptyTimer = null;
      const remain = guild.voiceStates.cache.filter(vs => vs.channelId === voiceChannel.id && vs.id !== readyClient.user?.id).size;
      if (!p.destroyed && !p.userdata?.stay247 && remain === 0) {
       void destroyPlayerSession(guild.id, 'Kênh thoại không còn người nghe nên bot đã tự rời kênh.');
      }
     }, 60000);
     p.userdata.emptyTimer.unref?.();
    }
   }
   restoredOk = true;
   console.log(`[khôi-phục] ✅ Đã tự động kết nối lại phòng thoại "${voiceChannel.name}" sau khi restart.`);
   break;
  }
 } catch (e) {
  console.warn('[khôi-phục] Không thể khôi phục phiên phòng thoại cũ:', e?.message ?? e?.name ?? 'Lỗi');
 } finally {
  nowPlayingHub.setOutboundPushPaused(false);
  if (!restoredOk) nowPlayingHub.publish();
  void sweepStartupOrphanedNotices(readyClient);
 }
}

client.once(Events.ClientReady, async c => {
 console.log(`[khởi-động] Đã đăng nhập: ${c.user.tag}`);
 const gatewayFallback = captureGatewayFallbackSessions(c);
 updateBotPresence(null);
 void restorePersistedSessionsOnStartup(c, gatewayFallback);
 const appInfo = await c.application.fetch().catch(() => null);
 if (appInfo?.interactionsEndpointURL) {
  console.warn(`[cảnh-báo] Phát hiện Interactions Endpoint URL cũ (${appInfo.interactionsEndpointURL}), đang tự động gỡ bỏ...`);
  await client.rest.patch(Routes.currentApplication(), { body: { interactions_endpoint_url: null } })
   .then(() => console.log('[khởi-động] Đã tự động xóa Interactions Endpoint URL cũ thành công.'))
   .catch(() => console.error('[CẢNH BÁO] Không thể tự xóa Interactions Endpoint URL. Hãy vào Discord Developer Portal -> General Information xóa trắng ô Interactions Endpoint URL rồi bấm Save Changes.'));
 }
 if (!autoRegister) return;
 try {
  // Xóa các lệnh global tiếng Anh cũ còn sót lại (ví dụ từ BMH) để tránh bị trùng lệnh trên Discord.
  await client.rest.put(Routes.applicationCommands(c.application.id), { body: [] });
  const targets = GUILD_ID ? [GUILD_ID] : [...c.guilds.cache.keys()].slice(0, 5);
  await Promise.all(targets.map(gid => syncGuildCommands(c.application.id, gid)));
  console.log(`[đồng-bộ] Đã cập nhật ${commands.length} lệnh (chú thích tiếng Việt) cho ${targets.length} máy chủ.`);
 } catch (e) {
  console.error('[đồng-bộ-lỗi]', e?.name ?? 'Error', e?.message ?? '');
 }
});

client.on(Events.GuildCreate, guild => {
 if (!autoRegister || !client.application?.id) return;
 if (GUILD_ID ? guild.id !== GUILD_ID : client.guilds.cache.size > 5) return;
 syncGuildCommands(client.application.id, guild.id)
  .then(() => console.log(`[đồng-bộ] Đã đăng ký ${commands.length} lệnh cho máy chủ mới ${guild.id}.`))
  .catch(e => console.error('[đồng-bộ-lỗi]', e?.name ?? 'Error'));
});

client.on(Events.Error, e => console.error('[discord]', e.name));

// Gửi thông báo lỗi tiếng Việt gọn gàng cho mọi loại tương tác (Slash, Nút bấm, Menu, Modal).
async function replyInteractionError(i, e) {
 if (e?.code === 40060) {
  console.error('[CẢNH BÁO] Lệnh đã bị một nơi khác (ví dụ BMH) phản hồi trước! Token bot đang bị dùng trùng — hãy vào Discord Developer Portal bấm Reset Token rồi cập nhật lại trên Botkeep.');
  return;
 }
 console.error('[lỗi-tương-tác]', i.commandName ?? i.customId, e?.name ?? 'Error', '-', String(e?.message ?? '').slice(0, 160));
 const content = KNOWN_ERROR_RE.test(e?.message ?? '') ? e.message : 'Nguồn nhạc hoặc kết nối gặp lỗi. Vui lòng thử lại sau.';
 if (i.deferred || i.replied) {
  await i.editReply({ content, allowedMentions: { parse: [] } }).catch(() => {});
 } else {
  await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
 }
}

// Xử lý tương tác trên khung Music Player (Nút bấm, Menu thả xuống và Hộp thoại thêm nhạc).
async function handlePlayerComponent(i) {
 const p = manager.get(i.guildId);

 // Trường hợp mở hộp thoại thêm bài hát mới: phải gọi showModal trước khi defer (hoạt động cả khi bot vừa restart).
 if (
  (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'add_song')
  || (i.isButton() && i.customId === 'player_open_add')
 ) {
  await requireSameVoiceChannel(i.guild, i.user.id);
  if (p) assertMusicAccess('play', i.user.id, p);
  await i.showModal(buildAddSongModal());
  if (p?.queue.currentTrack) schedulePanelUpdate(p);
  return;
 }

 // Trường hợp mở hộp thoại tùy chỉnh âm lượng (0% – 200%): phải gọi showModal trước khi defer.
 if (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'custom_volume') {
  if (!p) {
   await i.update(buildEndedPayload());
   schedulePanelAutoDelete(i.message, null, IDLE_PANEL_AUTO_DELETE_MS, i.channelId);
   return;
  }
  await requireSameVoiceChannel(i.guild, i.user.id);
  assertMusicAccess('volume', i.user.id, p);
  if (p.userdata) p.userdata.panelMessage = i.message;
  await i.showModal(buildVolumeModal(p.volume ?? 100));
  if (p.queue?.currentTrack) schedulePanelUpdate(p);
  return;
 }

 // Trường hợp xem hàng đợi từ menu (ai trong máy chủ cũng bấm xem được, hiển thị riêng tư).
 if (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'view_queue') {
  if (!p) throw new Error('Chưa có phiên phát nhạc nào.');
  await i.reply({ embeds: [buildQueueEmbed(p, client.user)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  schedulePanelUpdate(p);
  return;
 }

 // Trường hợp xem lời bài hát trực tiếp từ menu (ai trong máy chủ cũng xem được).
 if (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'view_lyrics') {
  const cur = p?.queue?.currentTrack;
  if (!cur) throw new Error('Hiện chưa phát bài hát nào để tìm lời.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  schedulePanelUpdate(p);
  const lyricsData = await fetchTrackLyrics({
   title: cur.title,
   artist: cur.metadata?.author,
   durationMs: cur.duration,
  });
  await i.editReply({ embeds: [buildLyricsEmbed(lyricsData, client.user)], allowedMentions: { parse: [] } });
  return;
 }

 // Trường hợp làm mới thanh tiến trình (chỉ cập nhật hiển thị thời gian, có giới hạn chống bấm liên tục).
 if (i.isButton() && i.customId === 'player_refresh') {
  if (!p || !p.queue.currentTrack) {
   await i.update(buildEndedPayload());
   schedulePanelAutoDelete(i.message, null, IDLE_PANEL_AUTO_DELETE_MS, i.channelId);
   return;
  }
  const now = Date.now();
  if (now - (refreshCooldown.get(i.guildId) ?? 0) < 2500) {
   return void await i.reply({ content: 'Thanh tiến trình đang tự động chạy theo nhạc mỗi 5 giây.', flags: MessageFlags.Ephemeral });
  }
  refreshCooldown.set(i.guildId, now);
  if (p.userdata) p.userdata.panelMessage = i.message;
  markPanelTouched(p);
  await i.update(buildPlayerPayload(p));
  return;
 }

 // Trường hợp gửi hộp thoại thêm bài hát (Modal Submit).
 if (i.isModalSubmit() && i.customId === 'player_add_modal') {
  let ownsLock = false;
  try {
   await i.deferReply({ flags: MessageFlags.Ephemeral });
   if (busy) return void await i.editReply({ content: 'Đang xử lý thao tác khác, vui lòng thử lại.' });
   busy = true; ownsLock = true;
   const channel = await requireSameVoiceChannel(i.guild, i.user.id);
   assertMusicAccess('play', i.user.id, manager.get(i.guildId));
   const { track, queued } = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    rawQuery: i.fields.getTextInputValue('query'),
    userId: i.user.id,
   });
   await i.editReply({
    content: queued ? `✅ Đã thêm vào hàng đợi: **${cleanText(track.title, 90)}**` : `▶️ Đang phát: **${cleanText(track.title, 90)}**`,
    allowedMentions: { parse: [] },
   });
  } finally {
   if (ownsLock) busy = false;
  }
  return;
 }

 // Trường hợp gửi hộp thoại tùy chỉnh âm lượng bất kỳ từ 0% đến 200% (Modal Submit).
 if (i.isModalSubmit() && i.customId === 'player_volume_modal') {
  let ownsLock = false;
  try {
   await i.deferReply({ flags: MessageFlags.Ephemeral });
   if (!p) throw new Error('Chưa có phiên phát nhạc nào.');
   if (busy) return void await i.editReply({ content: 'Đang xử lý thao tác khác, vui lòng thử lại.' });
   busy = true; ownsLock = true;
   await requireSameVoiceChannel(i.guild, i.user.id);
   assertMusicAccess('volume', i.user.id, p);
   configurePlayerAudio(p);
   const target = parseCustomVolumeInput(i.fields.getTextInputValue('volume'));
   if (!p.setVolume(target)) throw new Error('Không thể chỉnh âm lượng lúc này.');
   nowPlayingHub.publish({ player: p, volume: target });
   schedulePanelUpdate(p, { volume: target });
   await i.editReply({
    content: `🎚️ Đã tùy chỉnh âm lượng thành **${target}%** (áp dụng trực tiếp ngay trên bài đang phát).`,
    allowedMentions: { parse: [] },
   });
  } finally {
   if (ownsLock) busy = false;
  }
  return;
 }

 // Tất cả các nút & mục menu thay đổi nhạc còn lại: bắt buộc cùng kênh thoại và là chủ bài đang phát.
 if (!p) {
  if (i.isButton() || i.isStringSelectMenu()) {
   await i.update(buildEndedPayload());
   schedulePanelAutoDelete(i.message, null, IDLE_PANEL_AUTO_DELETE_MS, i.channelId);
   return;
  }
  throw new Error('Chưa có phiên phát nhạc nào.');
 }

 let ownsLock = false;
 try {
  if (busy) {
   return void await i.reply({ content: 'Đang xử lý thao tác khác, vui lòng thử lại.', flags: MessageFlags.Ephemeral });
  }
  busy = true; ownsLock = true;
  await requireSameVoiceChannel(i.guild, i.user.id);
  assertMusicAccess('control', i.user.id, p);
  if (p.userdata) p.userdata.panelMessage = i.message;

  if (i.isButton()) {
   switch (i.customId) {
    case 'player_pause': {
     const nextPaused = !p.isPaused;
     if (p.userdata) p.userdata.autoPausedByMute = false;
     if (nextPaused) {
      p.pause();
      stopProgressTicker(p);
     } else {
      p.resume();
      startProgressTicker(p);
     }
     clearPanelTimer(p);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p, { paused: nextPaused }));
     return;
    }
    case 'player_prev': {
     if (!p.previousTrack) throw new Error('Không có bài hát trước đó để quay lại.');
     await i.deferUpdate();
     if (!(await p.previous())) throw new Error('Không thể quay lại bài trước.');
     return;
    }
    case 'player_skip': {
     await i.deferUpdate();
     p.skip();
     return;
    }
    case 'player_leave': {
     guildKickSnapshots.delete(i.guildId);
     clearPersistedSession(i.guildId);
     const leavingVcId = p.userdata?.voiceChannelId;
     if (p.userdata) {
      p.userdata.manualDisconnect = true;
      p.userdata.stay247 = false;
      p.userdata.ending = true;
      clearPanelTimer(p);
      stopProgressTicker(p);
      clearAutoDeleteTimer(p);
      clearEmptyTimer(p);
      p.userdata.panelMessage = null;
      p.userdata.textChannel = null;
     }
     const reason = 'Đã tắt chế độ 24/7 và rời khỏi kênh thoại.';
     nowPlayingHub.publish({ player: null, track: null, reason }, { immediatePush: true, clearRemoteSession: true });
     updateBotPresence(null);
     if (leavingVcId) await voiceRoomStatus.clearChannelNow(leavingVcId, i.guildId);
     await i.update(buildEndedPayload(reason));
     schedulePanelAutoDelete(i.message, null, IDLE_PANEL_AUTO_DELETE_MS, i.channelId);
     manager.delete(i.guildId);
     return;
    }
    case 'player_stop': {
     guildKickSnapshots.delete(i.guildId);
     if (p.userdata?.stay247) {
      p.userdata.ending = true;
      p.userdata.idleOpen = true;
      p.userdata.skipNextStopEvent = true;
      clearPanelTimer(p);
      stopProgressTicker(p);
      clearAutoDeleteTimer(p);
      p.queue.reset();
      p.stop();
      p.clearLeaveTimeout?.();
      const reason = 'Đã dừng phát nhạc và xóa hàng đợi — Bot vẫn đang giữ kết nối 24/7.';
      persistActiveSession(p, { immediate: true });
      nowPlayingHub.publish({ player: p, track: null, reason }, { immediatePush: true });
      updateBotPresence(null);
      voiceRoomStatus.syncPlayer(p, { track: null });
      await i.update(buildIdle247Payload(p, reason));
      schedulePanelAutoDelete(i.message, p, IDLE_PANEL_AUTO_DELETE_MS, i.channelId);
      return;
     }
     clearPersistedSession(i.guildId);
     const stoppingVcId = p.userdata?.voiceChannelId;
     if (p.userdata) {
      p.userdata.manualDisconnect = true;
      p.userdata.ending = true;
      clearPanelTimer(p);
      stopProgressTicker(p);
      clearAutoDeleteTimer(p);
      clearEmptyTimer(p);
      p.userdata.panelMessage = null;
      p.userdata.textChannel = null;
     }
     const reason = 'Đã dừng phát nhạc, xóa hàng đợi và rời kênh thoại.';
     nowPlayingHub.publish({ player: null, track: null, reason }, { immediatePush: true, clearRemoteSession: true });
     updateBotPresence(null);
     if (stoppingVcId) await voiceRoomStatus.clearChannelNow(stoppingVcId, i.guildId);
     await i.update(buildEndedPayload(reason));
     schedulePanelAutoDelete(i.message, null, IDLE_PANEL_AUTO_DELETE_MS, i.channelId);
     manager.delete(i.guildId);
     return;
    }
   }
  }

  if (i.isStringSelectMenu() && i.customId === 'player_menu') {
   switch (i.values[0]) {
    case 'toggle_autoplay': {
     const nextAuto = !p.autoPlay();
     p.autoPlay(nextAuto);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p, { autoPlay: nextAuto }));
     return;
    }
    case 'cycle_sound':
    case 'preset_hd':
    case 'preset_vocal':
    case 'preset_bass':
    case 'preset_flat': {
     const nextPreset = i.values[0] === 'cycle_sound'
      ? getNextSoundPreset(p.userdata?.soundPreset ?? 'hd')
      : i.values[0].slice('preset_'.length);
     if (!SOUND_PRESETS[nextPreset]) throw new Error('Chưa hỗ trợ chế độ chất âm này.');
     if (p.userdata) p.userdata.soundPreset = nextPreset;
     setAudioEnhancement({ preset: nextPreset });
     clearPanelTimer(p);
     markPanelTouched(p);
     nowPlayingHub.publish({ player: p, soundPreset: nextPreset });
     await i.update(buildPlayerPayload(p, { soundPreset: nextPreset }));
     const presetInfo = SOUND_PRESETS[nextPreset];
     await i.followUp({
      content: `🎧 Đã chuyển ngay chất âm sang **${presetInfo.label}** (*${presetInfo.description}*) — áp dụng trực tiếp trên bài đang phát!`,
      flags: MessageFlags.Ephemeral,
     }).catch(() => {});
     return;
    }
    case 'cycle_loop': {
     const order = ['off', 'track', 'queue'];
     const nextMode = order[(order.indexOf(p.loop()) + 1) % order.length];
     p.loop(nextMode);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p, { loopMode: nextMode }));
     return;
    }
    case 'toggle_247': {
     const next247 = !p.userdata?.stay247;
     apply247State(p, next247);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p, { stay247: next247 }));
     return;
    }
    case 'shuffle_queue': {
     if (p.upcomingTracks.length < 2) throw new Error('Hàng đợi cần ít nhất 2 bài để trộn.');
     p.shuffle();
     clearPanelTimer(p);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p));
     return;
    }
    case 'clear_queue': {
     if (p.upcomingTracks.length === 0) throw new Error('Hàng đợi chờ hiện đang trống.');
     p.clearQueue();
     clearPanelTimer(p);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p));
     return;
    }
    case 'vol_down':
    case 'vol_up':
    case 'vol_100': {
     configurePlayerAudio(p);
     const currentVol = p.volume ?? 100;
     const target = i.values[0] === 'vol_100'
      ? 100
      : clampVolumePercent(currentVol + (i.values[0] === 'vol_up' ? 20 : -20));
     if (!p.setVolume(target)) throw new Error('Không thể chỉnh âm lượng lúc này.');
     clearPanelTimer(p);
     markPanelTouched(p);
     nowPlayingHub.publish({ player: p, volume: target });
     await i.update(buildPlayerPayload(p, { volume: target }));
     return;
    }
   }
  }
 } finally {
  if (ownsLock) busy = false;
 }
}

// Xử lý toàn bộ tương tác từ Discord (Lệnh slash + Nút bấm + Menu + Modal trên khung Music Player).
client.on(Events.InteractionCreate, async i => {
 if (!i.guild) return;
 if (GUILD_ID && i.guildId !== GUILD_ID) {
  return void i.reply({ content: 'Bot chỉ phục vụ máy chủ đã cấu hình.', flags: MessageFlags.Ephemeral }).catch(() => {});
 }
 if (i.channelId) triggerChannelSweep(i.channelId);

 if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) {
  try { await handlePlayerComponent(i); } catch (e) { await replyInteractionError(i, e); }
  return;
 }

 if (!i.isChatInputCommand()) return;
 const reply = content => i.editReply({ content, allowedMentions: { parse: [] } });
 let ownsLock = false;
 try {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (i.commandName === 'help') return await i.editReply({ embeds: [buildHelpEmbed(client.user)], allowedMentions: { parse: [] } });
  if (i.commandName === 'ping') return await reply(`Độ trễ: ${client.ws.ping} ms • Bộ nhớ Node: ${Math.round(process.memoryUsage().rss / 1048576)} MiB (chưa tính tiến trình FFmpeg).`);
  if (busy) return await reply('Đang xử lý lệnh khác, vui lòng thử lại.');
  busy = true; ownsLock = true;

  const p = manager.get(i.guildId);
  if (i.commandName === 'queue') {
   if (!p) return await reply('Chưa có phiên phát nhạc nào.');
   return await i.editReply({ embeds: [buildQueueEmbed(p, client.user)], allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'history') {
   if (!p) return await reply('Chưa có phiên phát nhạc nào.');
   return await i.editReply({ embeds: [buildHistoryEmbed(p, client.user)], allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'nowplaying') {
   if (!p || !p.queue.currentTrack) return await reply('Hiện chưa phát bài hát nào.');
   return await i.editReply({ embeds: [buildNowPlayingEmbed(p, client.user)], allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'lyrics') {
   const customQuery = i.options.getString('query')?.trim();
   const cur = p?.queue?.currentTrack;
   if (!customQuery && !cur) return await reply('Hiện chưa phát bài nào — hãy nhập tên bài vào tham số `query` (ví dụ `/lyrics query: Nơi này có anh`).');
   const lyricsData = await fetchTrackLyrics(
    customQuery
     ? { title: customQuery }
     : { title: cur.title, artist: cur.metadata?.author, durationMs: cur.duration },
   );
   return await i.editReply({ embeds: [buildLyricsEmbed(lyricsData, client.user)], allowedMentions: { parse: [] } });
  }

  const channel = await requireSameVoiceChannel(i.guild, i.user.id);
  // Kiểm tra quyền điều khiển: chỉ người yêu cầu bài đang phát mới được tác động vào nhạc.
  assertMusicAccess(i.commandName, i.user.id, p);

  if (i.commandName === 'join') {
   const alreadyConnected = Boolean(p?.connection);
   const { player: joinedPlayer } = await ensureVoiceSession({ guild: i.guild, voiceChannel: channel, textChannel: i.channel, userId: i.user.id });
   if (!alreadyConnected && !joinedPlayer.queue?.currentTrack) {
    const restored = await restoreKickSnapshotIfAny(joinedPlayer, channel, i.user.id);
    if (restored) {
     const posNote = restored.resumedAtMs > 0 ? ` từ mốc **${formatDuration(restored.resumedAtMs)}**` : '';
     const queueNote = restored.queuedCount > 0 ? ` *(kèm ${restored.queuedCount} bài trong hàng đợi)*` : '';
     return await reply(`▶️ Đã vào lại <#${channel.id}> và **phát tiếp nhạc lúc trước khi bị kick**: **${cleanText(restored.track.title, 85)}**${posNote}${queueNote}!`);
    }
   }
   nowPlayingHub.publish({ player: joinedPlayer }, { immediatePush: true });
   return await reply(alreadyConnected ? `✅ Bot đang ở sẵn trong kênh thoại <#${channel.id}>.` : `✅ Đã tham gia kênh thoại <#${channel.id}>. Dùng \`/play\` để phát nhạc hoặc \`/247\` để giữ bot ở lại 24/7.`);
  }

  if (i.commandName === '247') {
   const chosen = i.options.getString('mode');
   if (!p) {
    if (chosen === 'off') return await reply('Chế độ 24/7 hiện đang tắt (bot chưa ở trong kênh thoại).');
    const { player: createdPlayer } = await ensureVoiceSession({ guild: i.guild, voiceChannel: channel, textChannel: i.channel, userId: i.user.id, initial247: true });
    const restored = await restoreKickSnapshotIfAny(createdPlayer, channel, i.user.id);
    if (restored) {
     const posNote = restored.resumedAtMs > 0 ? ` từ mốc **${formatDuration(restored.resumedAtMs)}**` : '';
     const queueNote = restored.queuedCount > 0 ? ` *(kèm ${restored.queuedCount} bài trong hàng đợi)*` : '';
     return await reply(`🌙 Đã vào lại <#${channel.id}>, bật **24/7** và phát tiếp bài lúc trước khi bị kick: **${cleanText(restored.track.title, 85)}**${posNote}${queueNote}!`);
    }
    await closeCurrentPanel(createdPlayer, 'Bot đang treo trong kênh thoại 24/7 và sẵn sàng phát nhạc.', { keepIdle247: true });
    return await reply(`🌙 Đã tham gia <#${channel.id}> và **BẬT** chế độ treo kênh thoại 24/7.`);
   }
   const next247 = chosen ? chosen === 'on' : !p.userdata?.stay247;
   if (p.userdata) p.userdata.textChannel = i.channel;
   apply247State(p, next247);
   if (p.queue.currentTrack) {
    schedulePanelUpdate(p, { stay247: next247 });
   } else if (next247) {
    await closeCurrentPanel(p, 'Bot đang treo trong kênh thoại 24/7 và sẵn sàng phát nhạc.', { keepIdle247: true });
   } else {
    await closeCurrentPanel(p, 'Đã tắt chế độ 24/7 — bot sẽ tự rời kênh thoại sau 30 giây nếu không phát nhạc.');
   }
   return await reply(
    next247
     ? `🌙 Đã **BẬT** chế độ 24/7 — bot sẽ giữ kết nối trong <#${channel.id}> ngay cả khi hết nhạc hoặc vắng người.`
     : '🌙 Đã **TẮT** chế độ 24/7 — bot sẽ tự rời kênh thoại sau 30 giây khi hết nhạc hoặc không còn người nghe.',
   );
  }

  if (i.commandName === 'leave') {
   guildKickSnapshots.delete(i.guildId);
   if (!p) throw new Error('Bot hiện không ở trong kênh thoại nào.');
   await destroyPlayerSession(i.guildId, 'Đã dừng phát nhạc và rời kênh thoại theo lệnh `/leave`.');
   return await reply('👋 Đã tắt chế độ 24/7, xóa hàng đợi và rời khỏi kênh thoại.');
  }

  if (i.commandName === 'play') {
   const { track, queued, insertedNext } = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    rawQuery: i.options.getString('query', true),
    userId: i.user.id,
    playNext: Boolean(i.options.getBoolean('next')),
   });
   return await reply(
    insertedNext
     ? `⏭️ Đã chèn lên đầu hàng đợi (phát ngay kế tiếp): **${cleanText(track.title, 90)}**`
     : queued
      ? `✅ Đã thêm vào hàng đợi: **${cleanText(track.title, 90)}**`
      : `▶️ Đang phát: **${cleanText(track.title, 90)}** — dùng khung điều khiển bên dưới kênh chat để thao tác nhanh!`,
   );
  }

  if (!p) throw new Error('Chưa có phiên phát nhạc nào.');
  switch (i.commandName) {
   case 'autoplay': {
    const chosen = i.options.getString('mode');
    const nextAuto = chosen ? chosen === 'on' : !p.autoPlay();
    p.autoPlay(nextAuto);
    schedulePanelUpdate(p, { autoPlay: nextAuto });
    return await reply(
     nextAuto
      ? '✨ Đã **BẬT** tự động phát (AutoPlay) — khi hết hàng đợi, bot sẽ tự tìm và phát tiếp nhạc cùng gu.'
      : '✨ Đã **TẮT** tự động phát (AutoPlay).',
    );
   }
   case 'loop': {
    const mode = i.options.getString('mode', true);
    if (!LOOP_LABELS[mode]) throw new Error('Lệnh lặp không hợp lệ.');
    p.loop(mode);
    schedulePanelUpdate(p, { loopMode: mode });
    return await reply(`Chế độ lặp: ${LOOP_LABELS[mode]}.`);
   }
   case 'shuffle':
    if (p.upcomingTracks.length < 2) throw new Error('Hàng đợi cần ít nhất 2 bài để trộn.');
    p.shuffle();
    schedulePanelUpdate(p);
    return await reply('Đã trộn ngẫu nhiên các bài đang chờ.');
   case 'move': {
    const from = i.options.getInteger('from', true);
    const to = i.options.getInteger('to', true);
    const len = p.upcomingTracks.length;
    if (from < 1 || from > len || to < 1 || to > len) {
     throw new Error('Vị trí bài trong hàng đợi không tồn tại (dùng `/queue` để xem số thứ tự).');
    }
    const movingTitle = cleanText(p.upcomingTracks[from - 1]?.title, 80);
    if (!p.queue.move(from - 1, to - 1)) throw new Error('Không thể đổi vị trí bài hát này.');
    schedulePanelUpdate(p);
    return await reply(`🔀 Đã chuyển **${movingTitle}** từ vị trí **#${from}** sang **#${to}**.`);
   }
   case 'clear': {
    const count = p.upcomingTracks.length;
    if (count === 0) throw new Error('Hàng đợi chờ hiện đang trống.');
    p.clearQueue();
    schedulePanelUpdate(p);
    return await reply(`🗑️ Đã xóa sạch **${count}** bài đang chờ trong hàng đợi.`);
   }
   case 'volume': {
    configurePlayerAudio(p);
    const percent = i.options.getInteger('percent', true);
    if (percent < MIN_VOLUME_PERCENT || percent > MAX_VOLUME_PERCENT) {
     throw new Error(`Lệnh âm lượng chỉ nhận từ ${MIN_VOLUME_PERCENT} đến ${MAX_VOLUME_PERCENT}%.`);
    }
    if (!p.setVolume(percent)) throw new Error('Không thể chỉnh âm lượng lúc này.');
    nowPlayingHub.publish({ player: p, volume: percent });
    schedulePanelUpdate(p, { volume: percent });
    return await reply(`🔊 Đã đặt âm lượng: **${percent}%**.`);
   }
   case 'remove': {
    const position = i.options.getInteger('position', true);
    if (position < 1 || position > p.upcomingTracks.length) throw new Error('Hàng đợi không có vị trí này.');
    const removed = p.queue.remove(position - 1);
    if (!removed) throw new Error('Không thể xóa bài ở vị trí này.');
    schedulePanelUpdate(p);
    return await reply(`Đã xóa khỏi hàng đợi: ${cleanText(removed.title, 90)}`);
   }
   case 'seek': {
    const cur = p.queue.currentTrack;
    if (!cur) throw new Error('Hiện chưa phát bài hát nào để tua.');
    const targetMs = parseSeekTime(i.options.getString('time', true));
    const durationMs = cur.duration > 1000 ? cur.duration : cur.duration * 1000;
    if (durationMs > 0 && targetMs >= durationMs) {
     throw new Error(`Thời gian tua vượt quá độ dài bài hát (${formatDuration(durationMs)}).`);
    }
    if (!(await p.seek(targetMs))) throw new Error('Không thể tua bài hát lúc này.');
    schedulePanelUpdate(p);
    return await reply(`⏩ Đã tua bài hát tới mốc **${formatDuration(targetMs)}**.`);
   }
   case 'previous': {
    if (!p.previousTrack) throw new Error('Không có bài hát trước đó để quay lại.');
    if (!(await p.previous())) throw new Error('Không thể quay lại bài trước.');
    return await reply('⏮️ Đã quay lại bài hát trước đó.');
   }
   case 'pause':
    if (p.userdata) p.userdata.autoPausedByMute = false;
    p.pause();
    schedulePanelUpdate(p, { paused: true });
    return await reply('Đã tạm dừng phát nhạc.');
   case 'resume':
    if (p.userdata) p.userdata.autoPausedByMute = false;
    p.resume();
    schedulePanelUpdate(p, { paused: false });
    return await reply('Đã tiếp tục phát nhạc.');
   case 'skip': {
    const jumpTo = i.options.getInteger('to');
    if (jumpTo !== null) {
     if (jumpTo < 1 || jumpTo > p.upcomingTracks.length) {
      throw new Error('Hàng đợi không có vị trí này để nhảy tới.');
     }
     const targetTitle = cleanText(p.upcomingTracks[jumpTo - 1]?.title, 85);
     if (!(await p.skip(jumpTo - 1))) throw new Error('Không thể nhảy tới bài hát này.');
     return await reply(`⏭️ Đã nhảy thẳng tới bài **#${jumpTo}**: **${targetTitle}**.`);
    }
    await p.skip();
    return await reply('Đã bỏ qua bài hiện tại.');
   }
   case 'stop':
    guildKickSnapshots.delete(i.guildId);
    if (p.userdata?.stay247) {
     p.userdata.idleOpen = true;
     p.userdata.skipNextStopEvent = true;
     p.queue.reset();
     p.stop();
     p.clearLeaveTimeout?.();
     await closeCurrentPanel(p, 'Đã dừng phát nhạc và xóa hàng đợi — Bot vẫn đang giữ kết nối 24/7.', { keepIdle247: true });
     return await reply('⏹️ Đã dừng nhạc và xóa hàng đợi (bot vẫn ở lại kênh thoại do đang bật `/247`; dùng `/leave` nếu muốn rời kênh).');
    }
    await destroyPlayerSession(i.guildId, 'Đã dừng phát nhạc, xóa hàng đợi và rời kênh thoại.');
    return await reply('Đã dừng nhạc, xóa hàng đợi và rời kênh thoại.');
   default: throw new Error('Lệnh không hợp lệ.');
  }
 } catch (e) {
  await replyInteractionError(i, e);
 } finally {
  if (ownsLock) busy = false;
 }
});

// Lưu lại phòng thoại & nhạc đang phát ra cả ổ đĩa cục bộ lẫn đám mây trước khi tắt tiến trình để tự vào lại ngay sau khi reset/update.
async function shutdown(code = 0) {
 if (closing) return; closing = true;
 const timer = setTimeout(() => process.exit(code || 1), 5000); timer.unref();
 try {
  const activePlayers = manager.getAll();
  sessionStore.flushAllSync(activePlayers);

  const cleanupTargets = [];
  for (const p of activePlayers) {
   clearPanelTimer(p);
   stopProgressTicker(p);
   clearEmptyTimer(p);
   const chId = p.userdata?.textChannel?.id ?? null;
   if (p.userdata?.panelMessage) {
    cleanupTargets.push({ msg: p.userdata.panelMessage, channelId: chId });
    p.userdata.panelMessage = null;
   }
   if (p.userdata?.voiceAlertMessage) {
    cleanupTargets.push({ msg: p.userdata.voiceAlertMessage, channelId: chId });
    p.userdata.voiceAlertMessage = null;
   }
  }
  if (pendingAutoDeletes.size > 0) {
   for (const e of pendingAutoDeletes.values()) {
    clearTimeout(e.timer);
    cleanupTargets.push({ msg: e.msg, channelId: e.channelId });
   }
   pendingAutoDeletes.clear();
  }

  const preExitTasks = [voiceRoomStatus.clearAllNow().catch(() => {})];
  if (activePlayers.length > 0) {
   preExitTasks.push(nowPlayingHub.flushOutboundPush().catch(() => {}));
  }
  if (cleanupTargets.length > 0) {
   preExitTasks.push(Promise.allSettled(cleanupTargets.map(t => deleteDiscordMessage(client.rest, t.msg, t.channelId))));
  }
  if (preExitTasks.length > 0) {
   await Promise.race([
    Promise.allSettled(preExitTasks),
    new Promise(r => setTimeout(r, 2000)),
   ]);
  }

  // Dừng tiến trình âm thanh FFmpeg cục bộ nhưng KHÔNG gọi manager.destroy() để tránh ép Discord ngắt voice hoặc phát sinh thông báo thừa trước khi restart.
  for (const p of activePlayers) {
   try { p.destroyCurrentStream?.(); } catch {}
   try { p.audioPlayer?.stop?.(true); } catch {}
  }
  nowPlayingHub.close();
  client.destroy();
  server.close(() => process.exit(code));
 } catch { process.exit(1); }
}
function fatal(e) { console.error('[lỗi-nghiêm-trọng]', e?.name ?? 'Error'); void shutdown(1); }
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
process.once('SIGHUP', () => shutdown());
process.on('unhandledRejection', fatal);
process.on('uncaughtException', fatal);
await client.login(DISCORD_TOKEN).catch(fatal);
