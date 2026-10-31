import 'dotenv/config';
import express from 'express';
import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, Options, PermissionFlagsBits, Routes } from 'discord.js';
import { PlayerManager } from 'ziplayer';
import ffmpeg from 'ffmpeg-static';
import { parseSeekTime, pickBestMatchingTrack, resolveConfig, resolveMusicRequest } from './src/policy.js';
import {
 AMBIENT_MODES,
 clampVolumePercent,
 configurePlayerAudio,
 getNextAmbientMode,
 getNextSoundPreset,
 getNextVibeMode,
 installAudioEnhancer,
 MAX_VOLUME_PERCENT,
 MIN_VOLUME_PERCENT,
 parseCustomVolumeInput,
 setAudioEnhancement,
 SOUND_PRESETS,
 triggerSmoothTransitionFade,
 VIBE_MODES,
} from './src/audioEnhancer.js';
import { assertMusicAccess, isBotOwner, resolveHumanRequester } from './src/access.js';
import {
 buildAvatarMessagePayload,
 createAvatarGuardManager,
 downloadAvatarBuffer,
 resolveAvatarTargetInfo,
} from './src/avatarGuard.js';
import { buildFavoritesEmbed, createFavoritesStore } from './src/favoritesStore.js';
import { fetchTrackLyrics, fetchWebKaraokeLyrics, sanitizeLyricsTitle } from './src/lyrics.js';
import { buildMixtapeDetailEmbed, buildMixtapesListEmbed, createMixtapeStore } from './src/mixtapeStore.js';
import { createNowPlayingHub } from './src/nowPlayingHub.js';
import { deleteDiscordMessage, extractMessageRef, sweepChannelStaleNotices } from './src/messageCleaner.js';
import { resolveRadioStation } from './src/radioStations.js';
import { captureGatewayFallbackSessions, createRuntimeSessionStore, sealSessionPayload } from './src/sessionStore.js';
import { synthesizeSfxWav } from './src/sfx.js';
import { createSleepTimerManager } from './src/sleepTimer.js';
import { buildStatsEmbed, createStatsStore } from './src/statsStore.js';
import { createVoiceRoomStatusSync } from './src/voiceStatus.js';
import { createGuildTtsController, synthesizeGoogleTtsBuffer, TTS_VOICES } from './src/tts.js';
import { resolveTrackWebAudio, WEB_AUDIO_REFRESH_MS } from './src/webAudio.js';
import { createWebRemoteManager } from './src/webRemote.js';
import { buildSaveQueuePayload, extractPlayableFromMessage, extractSaveQueueUrls } from './src/saveQueue.js';
import {
 ANNOUNCE_FONT_MODES,
 buildAnnounceModal,
 buildChannelLockButtons,
 buildDmAnnounceModal,
 buildDmAnnounceStudioPayload,
 buildDmUserTagModal,
 createChannelLockManager,
 getNextAnnounceFont,
} from './src/channelLock.js';
import { buildSpamControlRow, createSpamTagManager } from './src/spamTag.js';
import {
 BOOSTED_DISCORD_GIF_BYTES,
 buildGifActionComponents,
 buildGifTuneModal,
 createVideoToGifManager,
 extractVideoFromMessage,
 formatGifSummaryLine,
 MAX_DISCORD_GIF_BYTES,
 MAX_VIDEO_DOWNLOAD_BYTES,
 parseGifTimingRange,
 parseQualityAndFpsInput,
} from './src/videoToGif.js';
import { buildVoiceGuardEmbed, evaluateBotVoiceTransition } from './src/voiceGuard.js';
import { buildHelpPayload, commands, CONTEXT_AVATAR_NAME, CONTEXT_GIF_NAME, CONTEXT_PLAY_NAME, dmCommands } from './src/commands.js';
import {
 buildAddSongModal,
 buildEndedPayload,
 buildGrabDmEmbed,
 buildHistoryEmbed,
 buildIdle247Payload,
 buildLyricsEmbed,
 buildNowPlayingEmbed,
 buildPlayerPayload,
 buildQueueEmbed,
 buildSearchPickerPayload,
 buildVolumeModal,
 cleanText,
 formatDuration,
 IDLE_PANEL_AUTO_DELETE_MS,
 LOOP_LABELS,
 renderSyncedProgress,
 resolveNowPlayingWebUrl,
 syncPlayerVibeAnchor,
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
// Bật GuildMessages & DirectMessages (đều là intent thường, KHÔNG cần quyền đặc biệt trên Portal & MessageManager vẫn bằng 0 MB)
// để bắt MESSAGE_DELETE chống xóa /avatar và nhận lệnh /announce nhắn trực tiếp trong DM của Chủ Bot tức thì (không cần chờ cache lệnh global trên điện thoại).
const client = new Client({
 intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
 ],
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
  if (/^https:\/\/soundcloud\.com\/[^/]+\/sets\/[^/?#]+/i.test(trimmed)) {
   const playlist = await this.client.getPlaylistDetails(trimmed);
   let rawItems = Array.isArray(playlist?.tracks) ? playlist.tracks.slice(0, 30) : [];
   const stubIds = rawItems.filter(t => t?.id && (!t.title || !t.permalink_url)).map(t => t.id);
   if (stubIds.length > 0 && typeof this.client.fetchTracksByIds === 'function') {
    const hydrated = await this.client.fetchTracksByIds(stubIds).catch(() => []);
    const byId = new Map((Array.isArray(hydrated) ? hydrated : []).map(h => [String(h.id), h]));
    rawItems = rawItems.map(t => byId.get(String(t.id)) ?? t);
   }
   const playable = rawItems.filter(t => t?.title && t?.permalink_url && isPlayableSoundCloudRaw(t));
   const tracks = (playable.length ? playable : rawItems.filter(t => t?.title && t?.permalink_url))
    .slice(0, 20)
    .map(item => mapSoundCloudRawTrack(item, requestedBy));
   return {
    tracks,
    playlist: {
     name: playlist?.title || 'SoundCloud Playlist',
     url: playlist?.permalink_url || trimmed,
     thumbnail: typeof playlist?.artwork_url === 'string'
      ? playlist.artwork_url.replace('-large.', '-t500x500.')
      : undefined,
    },
   };
  }
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

// Tủ nhạc Yêu thích cá nhân theo từng người dùng (sao lưu cả đĩa cục bộ lẫn mã hóa đám mây Cloudflare).
const favoritesStore = createFavoritesStore();

// Bảng Vàng thống kê âm nhạc toàn máy chủ & Top DJ (sao lưu đĩa cục bộ + mã hóa đám mây Cloudflare).
const statsStore = createStatsStore();

// Tủ nhạc chung theo chủ đề của cả máy chủ (/mixtape, tối đa 5 tủ * 20 bài, sao lưu đám mây Cloudflare).
const mixtapeStore = createMixtapeStore();

// Bộ chuyển đổi Video -> GIF nét cao 2-pass trên ổ tạm (an toàn tuyệt đối cho mốc 512MB RAM, hỗ trợ cả Server & DM).
const videoToGifManager = createVideoToGifManager({ ffmpegPath: ffmpeg });

// Bộ bảo vệ chống xóa cho tin nhắn /avatar: nếu bị xóa trên kênh chat sẽ tự động khôi phục lại ngay lập tức.
const avatarGuard = createAvatarGuardManager({
 rest: client.rest,
 getChannel: async channelId => client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId).catch(() => null),
});
client.on(Events.Raw, packet => {
 avatarGuard.handleRawGatewayPacket(packet);
 void handleDmRawPacket(packet);
});

// Bộ réo tên (@tag liên tục) siêu nhẹ (~0 MB RAM) chỉ dành riêng cho Chủ Bot, hỗ trợ Dừng tức thì & Xóa sạch hàng loạt.
const spamTagManager = createSpamTagManager({
 rest: client.rest,
 env: process.env,
});

// Bộ Khóa / Mở khóa kênh (hỗ trợ Kênh 📢 Thông Báo có nút xanh "Theo dõi") & Đăng bài bằng Bot (chỉ Chủ Bot, ~0 MB RAM).
const channelLockManager = createChannelLockManager({
 rest: client.rest,
 env: process.env,
});

// Bộ tự động đặt trạng thái Kênh Thoại (Voice Channel Status) theo tên bài hát đang phát & dọn sạch khi dừng nhạc/rời phòng.
const voiceRoomStatus = createVoiceRoomStatusSync({ rest: client.rest, client });

// Bộ quản lý mã PIN 6 số điều khiển nhạc 2 chiều trên Website (/webkey — không cần Ngrok hay cơ sở dữ liệu ngoài).
const webRemote = createWebRemoteManager({ env: process.env });

// Trung tâm Website "Now Playing" (giao diện kiểu Ziji V10 + SSE thời gian thực + điều khiển 2 chiều + tự động đồng bộ ra Cloudflare Worker).
const nowPlayingHub = createNowPlayingHub({
 getPlayer: () => manager.getAll()[0] ?? null,
 getResumeSeal: () => {
  const exported = sessionStore.exportSessionsObject();
  return Object.keys(exported).length > 0 ? sealSessionPayload(exported, DISCORD_TOKEN) : null;
 },
 getFavoritesSeal: () => favoritesStore.exportSeal(DISCORD_TOKEN),
 onRemoteFavorites: opened => favoritesStore.importPlainUsers(opened),
 getStatsSeal: () => statsStore.exportSeal(DISCORD_TOKEN),
 onRemoteStats: opened => statsStore.importPlainStats(opened),
 getMixtapesSeal: () => mixtapeStore.exportSeal(DISCORD_TOKEN),
 onRemoteMixtapes: opened => mixtapeStore.importPlainMixtapes(opened),
 webRemote,
 onRemoteCommand: cmd => executeWebRemoteCommand(cmd),
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
const pendingSearches = new Map(); // token -> { userId, guildId, playNext, tracks, expiresAt }
const channelLastSweepAt = new Map();
const KICK_SNAPSHOT_TTL_MS = 30 * 60 * 1000; // Giữ trạng thái bài đang phát & hàng đợi trong 30 phút sau khi bị kick để khôi phục khi /join.
const PROGRESS_TICK_MS = 5000; // Chu kỳ cập nhật thanh tiến trình (5 giây/lần: chuẩn mượt, không bao giờ chạm giới hạn rate-limit Discord).
const CHANNEL_SWEEP_COOLDOWN_MS = 180000; // Quét dọn tin nhắn mồ côi tối đa 3 phút/lần mỗi kênh.
const KNOWN_ERROR_RE = /^(Hãy|Bạn|Bot|Chờ|Chỉ|Hàng|Không|Chưa|Tên|URL|Lệnh|Bản|Link|Thời|Số|Định|Vị|Mức|Âm|Nội|Tủ|Hẹn|Hiệu|Đài|Người|Máy|Phiên|Bài|Tin|Mã|Hiện|Thao|Kênh|Bảng|Video|Tệp|Ảnh|Quá)/;
const ttsController = createGuildTtsController();

function syncSleepTimerLabel(player) {
 if (!player?.userdata) return;
 const st = sleepTimerManager.getStatus(player.guildId);
 if (!st) {
  player.userdata.sleepTimerLabel = null;
  return;
 }
 if (st.mode === 'after_track') {
  player.userdata.sleepTimerLabel = 'Hết bài tắt';
 } else {
  const remMin = Math.max(1, Math.ceil((st.remainingMs ?? 0) / 60000));
  player.userdata.sleepTimerLabel = `${remMin}p`;
 }
}

const sleepTimerManager = createSleepTimerManager({
 getPlayer: guildId => manager.get(guildId),
 onTriggerStop: async ({ guildId, player: activePl, leaveVoice, originalVolume }) => {
  const p = activePl ?? manager.get(guildId);
  if (p?.userdata) p.userdata.sleepTimerLabel = null;
  guildKickSnapshots.delete(guildId);
  if (p && !p.destroyed && !leaveVoice && p.userdata?.stay247) {
   p.userdata.idleOpen = true;
   p.userdata.skipNextStopEvent = true;
   p.queue.reset();
   p.stop();
   if (typeof originalVolume === 'number' && typeof p.setVolume === 'function') {
    try { p.setVolume(originalVolume); } catch {}
   }
   p.clearLeaveTimeout?.();
   await closeCurrentPanel(p, '💤 Đã tự động tắt nhạc êm ái theo hẹn giờ đi ngủ — Bot vẫn đang giữ kết nối 24/7.', { keepIdle247: true });
   return;
  }
  await destroyPlayerSession(guildId, '💤 Đã tự động giảm nhỏ âm lượng và tắt nhạc theo hẹn giờ đi ngủ. Chúc bạn ngủ ngon!');
 },
});

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
  syncSleepTimerLabel(player);
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

function clearWebAudioTimer(player) {
 if (player?.userdata?.webAudioTimer) {
  clearTimeout(player.userdata.webAudioTimer);
  player.userdata.webAudioTimer = null;
 }
}

// Đồng bộ luồng âm thanh trực tiếp lên Website để trình duyệt phát nhạc cùng nhịp với Bot mà không tốn băng thông/RAM của bot.
async function syncTrackWebAudio(player, track, { forceRefresh = false } = {}) {
 clearWebAudioTimer(player);
 if (!player || player.destroyed || !track) return;
 const webAudio = await resolveTrackWebAudio(soundCloudPlugin.client, track, {
  forceRefreshDetails: forceRefresh,
 });
 if (!webAudio || player.destroyed) return;
 const active = player.queue?.currentTrack ?? player.currentTrack ?? null;
 if (!active || (active !== track && active.url !== track.url)) return;

 active.metadata = { ...(active.metadata || {}), webAudio };
 track.metadata = active.metadata;
 nowPlayingHub.publish(
  { player, track: active, paused: Boolean(player.isPaused), webAudio },
  { immediatePush: true },
 );

 if (player.userdata) {
  player.userdata.webAudioTimer = setTimeout(() => {
   void syncTrackWebAudio(player, active);
  }, WEB_AUDIO_REFRESH_MS);
  player.userdata.webAudioTimer.unref?.();
 }
}

// Tải lời bài hát Karaoke đồng bộ từng mili-giây [mm:ss.xx] từ LRCLIB đẩy lên Website Live Radio.
async function syncTrackWebLyrics(player, track) {
 if (!player || player.destroyed || !track) return;
 const webLyrics = await fetchWebKaraokeLyrics(track).catch(() => null);
 if (!webLyrics || player.destroyed) return;
 const active = player.queue?.currentTrack ?? player.currentTrack ?? null;
 if (!active || (active !== track && active.url !== track.url)) return;
 active.metadata = { ...(active.metadata || {}), webLyrics };
 track.metadata = active.metadata;
 nowPlayingHub.publish(
  { player, track: active, paused: Boolean(player.isPaused), webLyrics },
  { immediatePush: true },
 );
}

// Đóng khung điều khiển của bài hiện tại (hoặc chuyển sang khung chờ 24/7 nếu đang bật 24/7) và hẹn giờ tự xóa sau 4.5 phút.
async function closeCurrentPanel(player, reason, { keepIdle247 = false } = {}) {
 const ud = player?.userdata;
 if (!ud) return;
 ud.ending = true;
 clearPanelTimer(player);
 stopProgressTicker(player);
 clearAutoDeleteTimer(player);
 clearWebAudioTimer(player);
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
 let cleanMeta;
 if (t.metadata && typeof t.metadata === 'object') {
  const { webAudio: _wa, webLyrics: _wl, ...rest } = t.metadata;
  cleanMeta = rest;
 }
 return {
  id: t.id,
  title: t.title,
  url: t.url,
  duration: t.duration,
  thumbnail: t.thumbnail,
  requestedBy: t.requestedBy,
  source: t.source,
  isLive: t.isLive,
  metadata: cleanMeta,
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
 sleepTimerManager.cancel(guildId);
 ttsController.cancelGuild(guildId);
 clearPersistedSession(guildId);
 setAudioEnhancement({ vibe: 'normal', ambient: 'off' });
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
 syncPlayerVibeAnchor(player, player?.userdata?.vibeMode ?? 'normal', 0);
 statsStore.recordTrackPlay(track);
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
 syncSleepTimerLabel(player);
 nowPlayingHub.publish({ player, track, paused: Boolean(player?.isPaused) }, { immediatePush: true });
 updateBotPresence(track);
 voiceRoomStatus.syncPlayer(player, { track, paused: Boolean(player?.isPaused) });
 void syncTrackWebAudio(player, track);
 void syncTrackWebLyrics(player, track);
 void postFreshPanel(player, track);
});
manager.on('trackEnd', player => {
 triggerSmoothTransitionFade(360);
 if (!player?.guildId) return;
 sleepTimerManager.notifyTrackEnded(player.guildId);
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
 if (player?.guildId) sleepTimerManager.cancel(player.guildId);
 clearPersistedSession(player?.guildId);
 clearEmptyTimer(player);
 clearWebAudioTimer(player);
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
    vibeMode: 'normal',
    vibeAnchor: null,
    ambientMode: 'off',
    ambientLevel: 0.35,
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
   vibe: p.userdata?.vibeMode ?? 'normal',
   ambient: p.userdata?.ambientMode ?? 'off',
   ambientLevel: p.userdata?.ambientLevel ?? 0.35,
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

// Nạp một danh sách bài hát đã tìm thấy (từ Playlist/Album hoặc Đài Radio) vào phiên phát hiện tại, tối đa 20 bài chờ.
async function enqueueTrackBatch(p, tracks, userId, playNext = false) {
 const validTracks = (Array.isArray(tracks) ? tracks : [])
  .filter(t => t && !t.isLive && !(Number(t.duration) > 10800000));
 if (validTracks.length === 0) {
  throw new Error('Không tìm thấy bài hát hợp lệ nào trong danh sách (hoặc toàn bộ bài vượt quá 180 phút).');
 }
 const hadCurrent = Boolean(p.queue.currentTrack);
 if (!hadCurrent) {
  const [first, ...rest] = validTracks;
  if (p.userdata) {
   p.userdata.ownerId = userId;
   p.userdata.idleOpen = false;
   p.userdata.ttsOnlyIdle = false;
  }
  if (!(await p.play(first, userId))) {
   throw new Error('Không thể phát danh sách bài hát này.');
  }
  const canQueue = rest.slice(0, Math.max(0, 20 - p.queue.size));
  if (canQueue.length > 0) {
   if (typeof p.queue?.addMultiple === 'function') p.queue.addMultiple(canQueue);
   else for (const t of canQueue) p.queue?.insert?.(t, p.queue.size);
  }
  schedulePanelUpdate(p);
  return { firstTrack: first, addedCount: 1 + canQueue.length, queued: false };
 }

 const roomLeft = Math.max(0, 20 - p.queue.size);
 if (roomLeft === 0) throw new Error('Hàng đợi đã đủ 20 bài.');
 const slice = validTracks.slice(0, roomLeft);
 if (playNext) {
  for (let idx = slice.length - 1; idx >= 0; idx--) {
   p.queue.insert(slice[idx], 0);
  }
 } else if (typeof p.queue?.addMultiple === 'function') {
  p.queue.addMultiple(slice);
 } else {
  for (const t of slice) p.queue?.insert?.(t, p.queue.size);
 }
 schedulePanelUpdate(p);
 return { firstTrack: slice[0], addedCount: slice.length, queued: true };
}

// Dùng chung logic kiểm tra, tìm kiếm và thêm bài hát / Playlist / Album cho cả lệnh /play, /dedicate lẫn hộp thoại "Thêm bài hát mới".
async function enqueueAndPlay({ guild, voiceChannel, textChannel, rawQuery, userId, playNext = false, dedication = null }) {
 const now = Date.now();
 if (now - (cooldown.get(userId) ?? 0) < 3000) throw new Error('Chờ 3 giây giữa hai lần thêm nhạc.');
 const { query: q, spotifyMeta, spotifyCollection, isSoundCloudSet } = await resolveMusicRequest(rawQuery);
 if (cooldown.size >= 100) cooldown.clear();
 cooldown.set(userId, Date.now());

 const { player: p, created } = await ensureVoiceSession({ guild, voiceChannel, textChannel, userId });
 guildKickSnapshots.delete(guild.id);
 try {
  if (p.queue.size >= 20) throw new Error('Hàng đợi đã đủ 20 bài.');

  // Trường hợp 1: Playlist hoặc Album Spotify -> tìm các bài tương ứng trên SoundCloud với độ song song tối đa 3 luồng nhẹ RAM.
  if (spotifyCollection?.items?.length) {
   const hadCurrent = Boolean(p.queue.currentTrack);
   const maxWanted = Math.min(spotifyCollection.items.length, (hadCurrent ? 0 : 1) + Math.max(0, 20 - p.queue.size));
   const targets = spotifyCollection.items.slice(0, Math.max(1, maxWanted));
   const resolvedTracks = new Array(targets.length).fill(null);
   let cursor = 0;
   const workers = Array.from({ length: Math.min(3, targets.length) }, async () => {
    while (cursor < targets.length) {
     const idx = cursor++;
     const item = targets[idx];
     const res = await p.search(item.query, userId).catch(() => null);
     const best = pickBestMatchingTrack(res?.tracks ?? [], item);
     if (best && !best.isLive && !(Number(best.duration) > 10800000)) {
      if (item.thumbnail && !best.thumbnail) best.thumbnail = item.thumbnail;
      resolvedTracks[idx] = best;
     }
    }
   });
   await Promise.all(workers);
   const finalList = resolvedTracks.filter(Boolean);
   const batch = await enqueueTrackBatch(p, finalList, userId, playNext);
   return {
    track: batch.firstTrack,
    queued: batch.queued,
    insertedNext: Boolean(playNext && batch.queued),
    collectionName: spotifyCollection.name,
    addedCount: batch.addedCount,
   };
  }

  let result = await p.search(q, userId).catch(() => null);

  // Trường hợp 2: SoundCloud Playlist / Set (/sets/...).
  if (isSoundCloudSet) {
   const batch = await enqueueTrackBatch(p, result?.tracks ?? [], userId, playNext);
   return {
    track: batch.firstTrack,
    queued: batch.queued,
    insertedNext: Boolean(playNext && batch.queued),
    collectionName: result?.playlist?.name || 'SoundCloud Playlist',
    addedCount: batch.addedCount,
   };
  }

  // Trường hợp 3: Bài hát đơn lẻ (từ khóa, YouTube lẻ, SoundCloud lẻ, Spotify track lẻ).
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
  if (dedication && typeof dedication === 'object') {
   track.metadata = { ...(track.metadata ?? {}), dedication };
  }
  if (track.isLive || track.duration > 10800000) {
   throw new Error('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
  }
  const hadCurrent = Boolean(p.queue.currentTrack);
  if (!hadCurrent && p.userdata) {
   p.userdata.ownerId = userId;
   p.userdata.idleOpen = false;
   p.userdata.ttsOnlyIdle = false;
  }
  if (hadCurrent && playNext) {
   p.queue.insert(track, 0);
   schedulePanelUpdate(p);
   return { track, queued: true, insertedNext: true, collectionName: null, addedCount: 1 };
  }
  if (!(await p.play(track, userId))) throw new Error('Không thể phát bài hát này.');
  if (hadCurrent) schedulePanelUpdate(p);
  return { track, queued: hadCurrent, insertedNext: false, collectionName: null, addedCount: 1 };
 } catch (e) {
  cooldown.delete(userId);
  if (created && !p.userdata?.stay247) manager.delete(guild.id);
  throw e;
 }
}

// Mở Đài Radio Không Ngủ theo tâm trạng: tự chọn lọc các bài chuẩn gu, xáo trộn ngẫu nhiên và bật AutoPlay xuyên đêm.
async function startRadioStation({ guild, voiceChannel, textChannel, stationId, userId }) {
 const station = resolveRadioStation(stationId);
 const queries = [...station.queries];
 for (let idx = queries.length - 1; idx > 0; idx--) {
  const j = Math.floor(Math.random() * (idx + 1));
  [queries[idx], queries[j]] = [queries[j], queries[idx]];
 }

 const { player: p, created } = await ensureVoiceSession({ guild, voiceChannel, textChannel, userId });
 guildKickSnapshots.delete(guild.id);
 try {
  const chosenQueries = queries.slice(0, 4);
  const searchBatches = await Promise.all(
   chosenQueries.map(q => p.search(`sc:${q}`, userId).catch(() => null)),
  );
  const seenUrls = new Set();
  const pool = [];
  for (const res of searchBatches) {
   for (const t of res?.tracks ?? []) {
    if (!t?.url || seenUrls.has(t.url)) continue;
    if (t.isLive || Number(t.duration) > 10800000 || Number(t.duration) < 60000) continue;
    seenUrls.add(t.url);
    pool.push(t);
   }
  }
  if (pool.length === 0) {
   throw new Error('Đài Radio hiện tạm thời chưa lấy được danh sách phát, vui lòng thử lại sau giây lát.');
  }
  for (let idx = pool.length - 1; idx > 0; idx--) {
   const j = Math.floor(Math.random() * (idx + 1));
   [pool[idx], pool[j]] = [pool[j], pool[idx]];
  }
  const radioTracks = pool.slice(0, 12);
  p.clearQueue();
  p.autoPlay(true);
  if (p.queue?.currentTrack) {
   const [first, ...rest] = radioTracks;
   p.queue.insert(first, 0);
   const canAdd = rest.slice(0, Math.max(0, 20 - p.queue.size));
   if (canAdd.length > 0) {
    if (typeof p.queue?.addMultiple === 'function') p.queue.addMultiple(canAdd);
    else for (const t of canAdd) p.queue?.insert?.(t, p.queue.size);
   }
   await p.skip();
   schedulePanelUpdate(p, { autoPlay: true });
   return { station, firstTrack: first, totalTracks: 1 + canAdd.length };
  }
  const batch = await enqueueTrackBatch(p, radioTracks, userId, false);
  p.autoPlay(true);
  schedulePanelUpdate(p, { autoPlay: true });
  return { station, firstTrack: batch.firstTrack, totalTracks: batch.addedCount };
 } catch (e) {
  if (created && !p.userdata?.stay247) manager.delete(guild.id);
  throw e;
 }
}

// Phát hoặc chèn một bài hát đã được người dùng chọn sẵn từ danh sách /search Top 5.
async function enqueuePickedTrack({ guild, voiceChannel, textChannel, track, userId, playNext = false }) {
 const { player: p, created } = await ensureVoiceSession({ guild, voiceChannel, textChannel, userId });
 guildKickSnapshots.delete(guild.id);
 try {
  if (p.queue.size >= 20) throw new Error('Hàng đợi đã đủ 20 bài.');
  track.requestedBy = userId;
  const hadCurrent = Boolean(p.queue.currentTrack);
  if (!hadCurrent && p.userdata) {
   p.userdata.ownerId = userId;
   p.userdata.idleOpen = false;
   p.userdata.ttsOnlyIdle = false;
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
  if (created && !p.userdata?.stay247) manager.delete(guild.id);
  throw e;
 }
}

// Bơm ngay tối đa 5 bài cùng gu & cùng Vibe với bài đang phát (/similar), tự lọc trùng lịch sử và hàng đợi.
async function enqueueSimilarTracks(p, userId) {
 const cur = p?.queue?.currentTrack;
 if (!cur) throw new Error('Hiện chưa phát bài hát nào để dò nhạc cùng gu.');
 const roomLeft = Math.max(0, 20 - p.queue.size);
 if (roomLeft === 0) throw new Error('Hàng đợi đã đủ 20 bài.');

 const historyPool = [
  cur,
  ...(p.upcomingTracks ?? []),
  ...(p.previousTracks ?? []),
 ];
 const related = await soundCloudPlugin.getRelatedTracks(cur, {
  limit: Math.min(8, roomLeft + 3),
  history: historyPool,
 }).catch(() => []);

 const seenUrls = new Set(historyPool.map(t => t?.url?.toLowerCase()).filter(Boolean));
 const picked = [];
 for (const item of Array.isArray(related) ? related : []) {
  if (!item?.url || item.isLive || Number(item.duration) > 10800000) continue;
  const norm = item.url.toLowerCase();
  if (seenUrls.has(norm)) continue;
  seenUrls.add(norm);
  item.requestedBy = userId;
  picked.push(item);
  if (picked.length >= Math.min(5, roomLeft)) break;
 }

 if (picked.length === 0) {
  throw new Error('Không tìm thêm được bài tương tự mới nào chưa phát trong phiên này.');
 }
 if (typeof p.queue?.addMultiple === 'function') p.queue.addMultiple(picked);
 else for (const t of picked) p.queue?.insert?.(t, p.queue.size);
 schedulePanelUpdate(p);
 return picked;
}

// Áp dụng tiếng thiên nhiên nền (/ambient) trực tiếp lên luồng phát hiện tại và đồng bộ lên Website.
function applyPlayerAmbient(p, nextMode, levelPercent = null) {
 if (!AMBIENT_MODES[nextMode]) throw new Error('Không hỗ trợ chế độ âm thanh nền này.');
 const nextLevel = levelPercent !== null && Number.isFinite(Number(levelPercent))
  ? Math.min(0.85, Math.max(0.1, Number(levelPercent) / 100))
  : (p.userdata?.ambientLevel ?? 0.35);
 if (p.userdata) {
  p.userdata.ambientMode = nextMode;
  p.userdata.ambientLevel = nextLevel;
 }
 setAudioEnhancement({ ambient: nextMode, ambientLevel: nextLevel });
 nowPlayingHub.publish({ player: p, ambientMode: nextMode });
 return { info: AMBIENT_MODES[nextMode], levelPercent: Math.round(nextLevel * 100) };
}

// Áp dụng chế độ Vibe trực tiếp lên bài đang phát mà không cần tải lại luồng âm thanh, đồng bộ luôn lên Website.
function applyPlayerVibe(p, nextVibe) {
 if (!VIBE_MODES[nextVibe]) throw new Error('Không hỗ trợ chế độ Vibe này.');
 syncPlayerVibeAnchor(p, nextVibe);
 if (p.userdata) p.userdata.vibeMode = nextVibe;
 setAudioEnhancement({ vibe: nextVibe });
 nowPlayingHub.publish({ player: p, vibeMode: nextVibe }, { immediatePush: true });
 return VIBE_MODES[nextVibe];
}

// Bỏ túi thông tin bài đang nghe về Tin nhắn riêng (DM) của bất kỳ thành viên nào.
async function sendGrabDmToUser(user, track, p, guild) {
 if (!track) throw new Error('Hiện chưa phát bài hát nào để bỏ túi về Tin nhắn riêng.');
 const embed = buildGrabDmEmbed(track, p, guild, client.user);
 try {
  await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
 } catch (err) {
  if (err?.code === 50007) {
   throw new Error('Không thể gửi tin nhắn riêng (DM) cho bạn — hãy bật **"Cho phép tin nhắn trực tiếp từ thành viên máy chủ"** trong Cài đặt quyền riêng tư Discord rồi thử lại nhé!');
  }
  throw new Error('Không thể gửi tin nhắn riêng (DM) lúc này, vui lòng kiểm tra cài đặt hộp thư của bạn.');
 }
}

// Đưa danh sách Tủ nhạc Yêu thích của người dùng vào phát hoặc nối tiếp vào hàng đợi (tối đa 20 bài chờ).
async function enqueueFavoriteTracks({ guild, voiceChannel, textChannel, favItems, userId, shuffle = false }) {
 if (!Array.isArray(favItems) || favItems.length === 0) {
  throw new Error('Tủ nhạc Yêu thích của bạn đang trống. Hãy lưu bài hát bằng `/fav action:add` hoặc chọn **❤️ Lưu vào Tủ nhạc Yêu thích** trên khung nhạc!');
 }
 const list = favItems.map(item => ({
  id: item.id,
  title: item.title,
  url: item.url,
  duration: item.duration,
  thumbnail: item.thumbnail,
  requestedBy: userId,
  source: item.source || 'soundcloud',
  metadata: { author: item.author || 'Nghệ sĩ' },
 }));
 if (shuffle && list.length > 1) {
  for (let idx = list.length - 1; idx > 0; idx--) {
   const j = Math.floor(Math.random() * (idx + 1));
   [list[idx], list[j]] = [list[j], list[idx]];
  }
 }

 const { player: p, created } = await ensureVoiceSession({ guild, voiceChannel, textChannel, userId });
 guildKickSnapshots.delete(guild.id);
 try {
  const hadCurrent = Boolean(p.queue.currentTrack);
  if (hadCurrent && p.queue.size >= 20) {
   throw new Error('Hàng đợi đã đủ 20 bài.');
  }
  if (!hadCurrent) {
   const [first, ...rest] = list;
   if (p.userdata) {
    p.userdata.ownerId = userId;
    p.userdata.idleOpen = false;
    p.userdata.ttsOnlyIdle = false;
   }
   if (!(await p.play(first, userId))) {
    throw new Error('Không thể phát danh sách Yêu thích lúc này.');
   }
   const canQueue = rest.slice(0, Math.max(0, 20 - p.queue.size));
   if (canQueue.length > 0) {
    if (typeof p.queue?.addMultiple === 'function') p.queue.addMultiple(canQueue);
    else for (const t of canQueue) p.queue?.insert?.(t, p.queue.size);
    schedulePanelUpdate(p);
   }
   return { startedTrack: first, addedCount: 1 + canQueue.length };
  }

  const slots = Math.max(0, 20 - p.queue.size);
  const toQueue = list.slice(0, slots);
  if (toQueue.length === 0) throw new Error('Hàng đợi đã đủ 20 bài.');
  if (typeof p.queue?.addMultiple === 'function') p.queue.addMultiple(toQueue);
  else for (const t of toQueue) p.queue?.insert?.(t, p.queue.size);
  schedulePanelUpdate(p);
  return { startedTrack: null, addedCount: toQueue.length };
 } catch (e) {
  if (created && !p.userdata?.stay247) manager.delete(guild.id);
  throw e;
 }
}

// Khôi phục toàn bộ danh sách bài hát từ Thẻ Phiên Nhạc (/savequeue) chỉ với 1 chạm (tối đa 3 luồng tìm song song nhẹ RAM).
async function restoreSavedQueueBatch({ guild, voiceChannel, textChannel, urls, userId }) {
 if (!Array.isArray(urls) || urls.length === 0) {
  throw new Error('Thẻ phiên nhạc này không có đường dẫn hợp lệ để khôi phục.');
 }
 const { player: p, created } = await ensureVoiceSession({ guild, voiceChannel, textChannel, userId });
 guildKickSnapshots.delete(guild.id);
 try {
  const hadCurrent = Boolean(p.queue.currentTrack);
  const maxWanted = Math.min(urls.length, (hadCurrent ? 0 : 1) + Math.max(0, 20 - p.queue.size));
  if (maxWanted <= 0) throw new Error('Hàng đợi đã đủ 20 bài.');
  const targets = urls.slice(0, maxWanted);
  const resolved = new Array(targets.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, targets.length) }, async () => {
   while (cursor < targets.length) {
    const idx = cursor++;
    const rawUrl = targets[idx];
    const res = await p.search(rawUrl, userId).catch(() => null);
    const track = res?.tracks?.[0] ?? null;
    if (track && !track.isLive && !(Number(track.duration) > 10800000)) {
     resolved[idx] = track;
    }
   }
  });
  await Promise.all(workers);
  const finalList = resolved.filter(Boolean);
  if (finalList.length === 0) {
   throw new Error('Không khôi phục được bài hát nào từ hộp lưu này.');
  }
  const batch = await enqueueTrackBatch(p, finalList, userId, false);
  return {
   track: batch.firstTrack,
   addedCount: batch.addedCount,
   queued: batch.queued,
  };
 } catch (e) {
  if (created && !p.userdata?.stay247) manager.delete(guild.id);
  throw e;
 }
}

// Thực thi lệnh điều khiển 2 chiều từ Website (đã xác thực PIN 6 số /webkey, kiểm tra chặt quyền Chủ Bot & Người đang cầm bài).
async function executeWebRemoteCommand(cmd) {
 const p = manager.getAll()[0] ?? null;
 if (!p || p.destroyed) {
  throw new Error('Bot hiện chưa ở trong kênh thoại — hãy gọi /join hoặc /play trong Discord trước.');
 }
 const guild = client.guilds.cache.get(p.guildId) ?? await client.guilds.fetch(p.guildId).catch(() => null);
 const actorId = String(cmd?.userId ?? '').trim();
 const isOwnerRole = cmd?.role === 'owner' || isBotOwner(actorId);

 if (!isOwnerRole) {
  assertMusicAccess('play', actorId, p);
  const memberChannelId = guild?.voiceStates?.cache?.get(actorId)?.channelId ?? null;
  if (p.userdata?.voiceChannelId && memberChannelId && memberChannelId !== p.userdata.voiceChannelId) {
   throw new Error('Bạn cần ở cùng kênh thoại với bot để điều khiển từ xa.');
  }
 }

 const syncPanelAndWeb = (overrides = {}) => {
  markPanelTouched(p);
  schedulePanelUpdate(p, overrides);
  nowPlayingHub.publish({ player: p, ...overrides }, { immediatePush: true });
 };

 switch (cmd.action) {
  case 'toggle_pause': {
   if (!p.queue?.currentTrack) throw new Error('Hiện chưa có bài hát nào đang phát.');
   if (p.isPaused) {
    triggerSmoothTransitionFade(180);
    p.resume();
    syncPanelAndWeb({ paused: false });
    return { message: '▶️ Đã tiếp tục phát nhạc.' };
   }
   p.pause();
   syncPanelAndWeb({ paused: true });
   return { message: '⏸️ Đã tạm dừng phát nhạc.' };
  }
  case 'skip': {
   if (!p.queue?.currentTrack) throw new Error('Hiện chưa có bài hát nào để bỏ qua.');
   triggerSmoothTransitionFade(360);
   p.skip();
   syncPanelAndWeb();
   return { message: '⏭️ Đã chuyển sang bài tiếp theo.' };
  }
  case 'previous': {
   triggerSmoothTransitionFade(360);
   const ok = await p.previous().catch(() => false);
   if (!ok) throw new Error('Chưa có bài hát trước đó trong lịch sử.');
   syncPanelAndWeb();
   return { message: '⏮️ Đã quay lại bài trước đó.' };
  }
  case 'replay': {
   if (!p.queue?.currentTrack) throw new Error('Hiện chưa có bài hát nào để phát lại từ đầu.');
   triggerSmoothTransitionFade(260);
   await p.seek(0);
   syncPlayerVibeAnchor(p, p.userdata?.vibeMode ?? 'normal', 0);
   syncPanelAndWeb();
   return { message: '⏪ Đã tua bài hát về lại 0:00.' };
  }
  case 'shuffle': {
   if (p.upcomingTracks.length < 2) throw new Error('Hàng đợi cần ít nhất 2 bài để trộn.');
   p.shuffle();
   syncPanelAndWeb();
   return { message: '🔀 Đã trộn ngẫu nhiên hàng đợi.' };
  }
  case 'loop': {
   const order = ['off', 'track', 'queue'];
   const nextMode = (cmd.value && order.includes(cmd.value))
    ? cmd.value
    : order[(order.indexOf(p.loop()) + 1) % order.length];
   p.loop(nextMode);
   syncPanelAndWeb({ loopMode: nextMode });
   return { message: `🔁 Chế độ lặp: ${LOOP_LABELS[nextMode]}` };
  }
  case 'autoplay': {
   const nextAuto = !p.autoPlay();
   p.autoPlay(nextAuto);
   syncPanelAndWeb({ autoPlay: nextAuto });
   return { message: `♾️ Tự phát liên quan: ${nextAuto ? 'Đã bật' : 'Đã tắt'}` };
  }
  case 'volume': {
   configurePlayerAudio(p);
   const target = clampVolumePercent(cmd.value);
   if (!p.setVolume(target)) throw new Error('Không thể chỉnh âm lượng lúc này.');
   syncPanelAndWeb({ volume: target });
   return { message: `🔊 Âm lượng phòng thoại: ${target}%` };
  }
  case 'preset': {
   const nextPreset = cmd.value && SOUND_PRESETS[cmd.value]
    ? cmd.value
    : getNextSoundPreset(p.userdata?.soundPreset ?? 'hd');
   if (p.userdata) p.userdata.soundPreset = nextPreset;
   setAudioEnhancement({ preset: nextPreset });
   syncPanelAndWeb({ soundPreset: nextPreset });
   return { message: `🎧 Chất âm phòng thoại: ${SOUND_PRESETS[nextPreset].label}` };
  }
  case 'vibe': {
   const nextVibe = cmd.value && VIBE_MODES[cmd.value]
    ? cmd.value
    : getNextVibeMode(p.userdata?.vibeMode ?? 'normal');
   const info = applyPlayerVibe(p, nextVibe);
   schedulePanelUpdate(p, { vibeMode: nextVibe });
   return { message: `${info.emoji} Đã chuyển Vibe phòng thoại: ${info.label}` };
  }
  case 'ambient': {
   const nextAmb = cmd.value && AMBIENT_MODES[cmd.value]
    ? cmd.value
    : getNextAmbientMode(p.userdata?.ambientMode ?? 'off');
   const { info } = applyPlayerAmbient(p, nextAmb);
   schedulePanelUpdate(p, { ambientMode: nextAmb });
   return { message: `${info.emoji} Nền phòng thoại: ${info.label}` };
  }
  case 'play': {
   if (!guild || !p.userdata?.voiceChannelId) {
    throw new Error('Không tìm thấy kênh thoại hiện tại của bot.');
   }
   const voiceCh = guild.channels.cache.get(p.userdata.voiceChannelId)
    ?? await guild.channels.fetch(p.userdata.voiceChannelId).catch(() => null);
   if (!voiceCh) throw new Error('Không đọc được kênh thoại của bot.');
   const effectiveRequester = actorId || p.userdata?.ownerId || client.user?.id;
   const res = await enqueueAndPlay({
    guild,
    voiceChannel: voiceCh,
    textChannel: p.userdata?.textChannel ?? null,
    rawQuery: cmd.value,
    userId: effectiveRequester,
    playNext: Boolean(cmd.playNext),
   });
   nowPlayingHub.publish({ player: p }, { immediatePush: true });
   return {
    message: res.collectionName
     ? `📚 Đã nạp ${res.addedCount} bài từ "${cleanText(res.collectionName, 50)}"`
     : (res.queued ? `✅ Đã thêm vào hàng đợi: ${cleanText(res.track.title, 65)}` : `▶️ Đang phát: ${cleanText(res.track.title, 65)}`),
   };
  }
  default:
   throw new Error('Thao tác điều khiển từ xa chưa được hỗ trợ.');
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
  // Đăng ký riêng bộ lệnh BotDM (/announce, /gif & Đổi video sang GIF trong hộp thư riêng của Bot, contexts=[BotDM] nên không trùng ngoài Server).
  await client.rest.put(Routes.applicationCommands(c.application.id), { body: dmCommands });
  console.log(`[đồng-bộ-dm] ✅ Đã đăng ký ${dmCommands.length} lệnh cho hộp thư riêng (BotDM: /announce, /gif & Đổi sang GIF).`);
 } catch (e) {
  console.error('[đồng-bộ-dm-lỗi]', e?.code ?? e?.name ?? 'Error', e?.message ?? '');
 }
 try {
  const targets = GUILD_ID ? [GUILD_ID] : [...c.guilds.cache.keys()].slice(0, 5);
  await Promise.all(targets.map(gid => syncGuildCommands(c.application.id, gid)));
  console.log(`[đồng-bộ] Đã cập nhật ${commands.length} lệnh máy chủ cho ${targets.length} máy chủ.`);
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

client.on(Events.Error, e => console.error('[discord]', e?.name ?? 'Error'));
client.on(Events.ShardError, e => console.warn('[discord-shard] Mạng chập chờn, đang tự kết nối lại:', e?.name ?? 'Error'));

// Gửi thông báo lỗi tiếng Việt gọn gàng cho mọi loại tương tác (Slash, Nút bấm, Menu, Modal).
async function replyInteractionError(i, e) {
 if (e?.code === 40060) {
  console.error('[CẢNH BÁO] Lệnh đã bị một nơi khác (ví dụ BMH) phản hồi trước! Token bot đang bị dùng trùng — hãy vào Discord Developer Portal bấm Reset Token rồi cập nhật lại trên Botkeep.');
  return;
 }
 console.error('[lỗi-tương-tác]', i.commandName ?? i.customId, e?.name ?? 'Error', '-', String(e?.message ?? '').slice(0, 160));
 const content = KNOWN_ERROR_RE.test(e?.message ?? '') ? e.message : 'Nguồn nhạc hoặc kết nối gặp lỗi. Vui lòng thử lại sau.';
 if (!i.guild && (i.deferred || i.replied) && !i.isChatInputCommand()) {
  await i.followUp({ content: `⚠️ ${content}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  return;
 }
 if (i.deferred || i.replied) {
  const errMsg = await i.editReply({ content, allowedMentions: { parse: [] } }).catch(() => null);
  if (!i.guild && errMsg?.id && i.channelId) {
   const t = setTimeout(() => {
    client.rest.delete(Routes.channelMessage(i.channelId, errMsg.id)).catch(() => {});
   }, 30000);
   t.unref?.();
  }
 } else {
  await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
 }
}

function resolveGuildGifUploadCap(guild) {
 return (Number(guild?.premiumTier) || 0) >= 2
  ? BOOSTED_DISCORD_GIF_BYTES
  : MAX_DISCORD_GIF_BYTES;
}

// Xử lý chung lệnh /gif và Menu chuột phải "🎞️ Đổi video sang GIF" (chạy mượt cả trên Server lẫn trong hộp chat riêng DM).
async function handleGifCommandOrContext(i) {
 const inDm = !i.guild;
 const isPrivate = !inDm && Boolean(i.isChatInputCommand() && i.options.getBoolean('private'));
 await i.deferReply(isPrivate ? { flags: MessageFlags.Ephemeral } : undefined);

 let sourceUrl = '';
 let options = {};

 if (i.isMessageContextMenuCommand?.()) {
  const found = extractVideoFromMessage(i.targetMessage);
  if (found.sizeBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
   throw new Error('Video quá lớn (vượt mức an toàn 45MB) — hãy cắt ngắn hoặc gửi clip nhẹ hơn nhé!');
  }
  sourceUrl = found.url;
 } else {
  const att = i.options.getAttachment('video');
  const rawUrl = i.options.getString('url')?.trim() ?? '';
  if (!att && !rawUrl) {
   throw new Error('Hãy tải file video lên ở mục `video` hoặc dán link video (.mp4, .mov, .webm) vào mục `url` nhé! *(Mẹo: Chuột phải vào tin nhắn có video -> Ứng dụng -> 🎞️ Đổi video sang GIF cũng được luôn!)*');
  }
  if (att) {
   if (Number(att.size) > MAX_VIDEO_DOWNLOAD_BYTES) {
    throw new Error('Video quá lớn (vượt mức an toàn 45MB) — hãy cắt ngắn hoặc gửi clip nhẹ hơn nhé!');
   }
   sourceUrl = att.url || att.proxyURL;
  } else {
   sourceUrl = rawUrl;
  }
  options = {
   caption: i.options.getString('caption') ?? '',
   captionStyle: i.options.getString('caption_style') || 'bar',
   start: i.options.getString('start') ?? '',
   duration: i.options.getNumber('duration'),
   speed: i.options.getNumber('speed'),
   quality: i.options.getString('quality') || undefined,
   fps: i.options.getInteger('fps'),
  };
 }

 await i.editReply({
  content: '🎞️ Đang kết xuất ảnh **GIF nét cao & mượt FPS** (khử răng cưa `sierra2_4a` + làm nét cạnh)...',
  allowedMentions: { parse: [] },
 }).catch(() => {});

 const res = await videoToGifManager.convertVideoToGif({
  sourceUrl,
  requesterId: i.user.id,
  options,
  maxUploadBytes: resolveGuildGifUploadCap(i.guild),
  onQueued: pos => i.editReply({
   content: `⏳ Đang xếp hàng tạo GIF (vị trí **#${pos}** — chống tràn RAM 512MB), vui lòng đợi vài giây...`,
   allowedMentions: { parse: [] },
  }),
 });

 const components = buildGifActionComponents({
  token: res.session.token,
  requesterId: i.user.id,
  includeDmSave: !inDm && !isPrivate,
  includeDelete: !isPrivate,
 });

 await i.editReply({
  content: formatGifSummaryLine(res.meta),
  files: [res.attachment],
  components,
  allowedMentions: { parse: [] },
 });
}

// Xử lý các nút bấm & hộp thoại chỉnh sửa nhanh bên dưới ảnh GIF (Chèn chữ Meme, Cắt giây, Tốc độ, Lưu về DM, Xóa).
async function handleGifComponent(i) {
 if (i.isButton() && i.customId.startsWith('gif_tune:')) {
  const token = i.customId.slice('gif_tune:'.length);
  const session = videoToGifManager.getTuneSession(token);
  if (!session) {
   throw new Error('Phiên chỉnh sửa nhanh của ảnh GIF này đã hết hạn (20 phút) — hãy chuột phải vào video gốc chọn 🎞️ Đổi video sang GIF hoặc gõ lại `/gif` nhé!');
  }
  await i.showModal(buildGifTuneModal(session.token, session));
  return true;
 }

 if (i.isModalSubmit() && i.customId.startsWith('gif_tune_modal:')) {
  const token = i.customId.slice('gif_tune_modal:'.length);
  const session = videoToGifManager.getTuneSession(token);
  if (!session) {
   throw new Error('Phiên chỉnh sửa nhanh của ảnh GIF này đã hết hạn (20 phút) — hãy gõ lại `/gif` nhé!');
  }
  const caption = i.fields.getTextInputValue('gif_caption') ?? '';
  const rawStyle = String(i.fields.getTextInputValue('gif_caption_style') ?? '').trim().toLowerCase();
  const captionStyle = ['bar', 'bottom', 'top'].includes(rawStyle) ? rawStyle : session.captionStyle;
  const { startSec, durationSec } = parseGifTimingRange(
   i.fields.getTextInputValue('gif_timing'),
   session.startSec,
   session.durationSec,
  );
  const rawSpeed = String(i.fields.getTextInputValue('gif_speed') ?? '').trim();
  const speed = rawSpeed ? rawSpeed : session.speed;
  const rawQFps = i.fields.fields?.has?.('gif_quality_fps')
   ? i.fields.getTextInputValue('gif_quality_fps')
   : '';
  const { quality: nextQuality, fps: nextFps } = parseQualityAndFpsInput(
   rawQFps,
   session.quality ?? 'hd',
   session.fps ?? null,
  );
  const uploadCap = resolveGuildGifUploadCap(i.guild);

  const inDm = !i.guild;
  const wasEphemeral = Boolean(i.message?.flags?.has?.(MessageFlags.Ephemeral));
  const canEditInPlace = Boolean(i.message) && (i.user.id === session.requesterId || isBotOwner(i.user.id));

  if (canEditInPlace) {
   await i.deferUpdate();
   const res = await videoToGifManager.convertVideoToGif({
    sourceUrl: session.sourceUrl,
    requesterId: session.requesterId,
    existingToken: session.token,
    skipCooldown: true,
    maxUploadBytes: uploadCap,
    options: {
     startSec,
     duration: durationSec,
     speed,
     caption,
     captionStyle,
     quality: nextQuality,
     fps: nextFps,
    },
   });
   await i.editReply({
    content: formatGifSummaryLine(res.meta),
    attachments: [],
    files: [res.attachment],
    components: buildGifActionComponents({
     token: res.session.token,
     requesterId: session.requesterId,
     includeDmSave: !inDm && !wasEphemeral,
     includeDelete: !wasEphemeral,
    }),
    allowedMentions: { parse: [] },
   });
  } else {
   await i.deferReply({ flags: MessageFlags.Ephemeral });
   const res = await videoToGifManager.convertVideoToGif({
    sourceUrl: session.sourceUrl,
    requesterId: i.user.id,
    maxUploadBytes: uploadCap,
    options: {
     startSec,
     duration: durationSec,
     speed,
     caption,
     captionStyle,
     quality: nextQuality,
     fps: nextFps,
    },
   });
   await i.editReply({
    content: formatGifSummaryLine(res.meta),
    files: [res.attachment],
    components: buildGifActionComponents({
     token: res.session.token,
     requesterId: i.user.id,
     includeDmSave: false,
     includeDelete: false,
    }),
    allowedMentions: { parse: [] },
   });
  }
  return true;
 }

 if (i.isButton() && i.customId === 'gif_dm') {
  const att = i.message?.attachments?.first?.();
  if (!att?.url) {
   throw new Error('Không tìm thấy tệp ảnh GIF trên tin nhắn này để gửi về DM.');
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
   if (Number(att.size) > MAX_DISCORD_GIF_BYTES) {
    await i.user.send({
     content: `🎞️ **Bản lưu ảnh GIF Full HD của bạn đây!** *(Do file nặng >10MB từ Server Boost nên gửi link gốc chất lượng 100%)*:\n${att.url}`,
     allowedMentions: { parse: [] },
    });
   } else {
    const buf = await videoToGifManager.downloadSmallGifBuffer(att.url);
    await i.user.send({
     content: '🎞️ **Bản lưu ảnh GIF của bạn đây!** *(Chạm biểu tượng ⭐ ở góc trên ảnh để lưu vào kho GIF yêu thích của Discord nhé)*',
     files: [{ attachment: buf, name: 'bat-don.gif' }],
     allowedMentions: { parse: [] },
    });
   }
  } catch (err) {
   if (err?.code === 50007) {
    throw new Error('Không thể gửi tin nhắn riêng (DM) cho bạn — hãy bật **"Cho phép tin nhắn trực tiếp từ thành viên máy chủ"** trong Cài đặt quyền riêng tư Discord nhé!');
   }
   throw new Error('Không thể gửi ảnh GIF về hộp thư riêng lúc này.');
  }
  await i.editReply({
   content: '📩 Đã gửi bản sao ảnh **GIF** về **Tin nhắn riêng (DM)** của bạn!',
   allowedMentions: { parse: [] },
  });
  return true;
 }

 if (i.isButton() && i.customId.startsWith('gif_del:')) {
  const ownerOfGif = i.customId.slice('gif_del:'.length);
  if (i.user.id !== ownerOfGif && !isBotOwner(i.user.id)) {
   await i.reply({
    content: '🔒 Chỉ người tạo ảnh GIF này hoặc **Chủ Bot** mới có thể xóa!',
    flags: MessageFlags.Ephemeral,
   });
   return true;
  }
  await i.deferUpdate().catch(() => {});
  await deleteDiscordMessage(client.rest, i.message, i.channelId);
  return true;
 }

 return false;
}

// Xử lý tương tác trên khung Music Player (Nút bấm, Menu thả xuống và Hộp thoại thêm nhạc).
async function handlePlayerComponent(i) {
 if (await handleGifComponent(i)) return;

 // Menu chuyển đổi danh mục lệnh trong /help (nhảy trang tức thì, không khóa hàng đợi hay kênh thoại).
 if (i.isStringSelectMenu() && i.customId === 'help_category') {
  const picked = i.values[0] || 'overview';
  await i.update(buildHelpPayload({
   botUser: client.user,
   guild: i.guild,
   category: picked,
  }));
  return;
 }

 // Nút Mở khóa / Khóa lại kênh nhanh 1 chạm — CHỈ Chủ Bot mới bấm được.
 if (i.isButton() && (i.customId.startsWith('chlock_unlock:') || i.customId.startsWith('chlock_lock:'))) {
  if (!isBotOwner(i.user.id)) {
   await i.reply({
    content: '🔒 Chỉ **Chủ Bot** mới có quyền khóa hoặc mở khóa kênh này.',
    flags: MessageFlags.Ephemeral,
   });
   return;
  }
  const wantUnlock = i.customId.startsWith('chlock_unlock:');
  const targetChId = i.customId.split(':')[1] || i.channelId;
  await i.deferUpdate();
  if (wantUnlock) {
   await channelLockManager.unlockChannel({
    guildId: i.guildId,
    channelId: targetChId,
    requesterId: i.user.id,
   });
   await i.editReply({
    content: `🔓 Đã **mở khóa lại** kênh <#${targetChId}> về trạng thái bình thường!`,
    components: [buildChannelLockButtons(targetChId, { locked: false })],
    allowedMentions: { parse: [] },
   });
  } else {
   const res = await channelLockManager.lockChannel({
    guildId: i.guildId,
    channelId: targetChId,
    requesterId: i.user.id,
    botUserId: client.user?.id,
    mode: 'announcement',
    allowReactions: true,
   });
   const note = res.announcementStatus === 'community_needed'
    ? '\n> 💡 *Mẹo:* Bật **Cộng đồng (Community)** trong Cài đặt Server nếu muốn hiện nút xanh **[Theo dõi]** ở đáy kênh.'
    : '';
   await i.editReply({
    content: `🔒 Đã **khóa lại** kênh <#${targetChId}> thành công!${note}`,
    components: [buildChannelLockButtons(targetChId, { locked: true })],
    allowedMentions: { parse: [] },
   });
  }
  return;
 }

 // Xử lý hộp thoại gõ nhiều dòng khi Chủ Bot dùng /announce mà để trống tham số message.
 if (i.isModalSubmit() && i.customId.startsWith('announce_modal:')) {
  channelLockManager.assertOwner(i.user.id);
  const parts = i.customId.slice('announce_modal:'.length).split(':');
  const targetChId = parts[0] || i.channelId;
  const pingRoleId = parts[1] && parts[1] !== '0' ? parts[1] : null;
  const pingEveryone = parts[2] === '1';
  const style = parts[3] === 'embed' ? 'embed' : 'text';
  const autoReact = parts[4] !== '0';
  const fontMode = parts[5] || 'normal';
  const rawContent = i.fields.getTextInputValue('announce_content');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await channelLockManager.postBotAnnouncement({
   guildId: i.guildId,
   channelId: targetChId,
   requesterId: i.user.id,
   rawContent,
   pingRoleId,
   pingEveryone,
   fontMode,
   style,
   autoReact,
  });
  const pubNote = res.published ? ' *(đã tự động Xuất bản tới tất cả máy chủ đang Theo dõi)*' : '';
  await i.editReply({
   content: `📢 Đã dùng Bot đăng thông báo lên kênh <#${targetChId}> thành công!${pubNote}`,
   allowedMentions: { parse: [] },
  });
  return;
 }

 // Nút Dừng réo tên (@tag) ngay lập tức — CHỈ Chủ Bot mới bấm được.
 if (i.isButton() && i.customId.startsWith('spamtag_stop:')) {
  if (!isBotOwner(i.user.id)) {
   await i.reply({
    content: '🔒 Chỉ **Chủ Bot** mới có quyền tắt hoặc xóa đợt réo tên này.',
    flags: MessageFlags.Ephemeral,
   });
   return;
  }
  const targetChId = i.customId.slice('spamtag_stop:'.length) || i.channelId;
  const res = spamTagManager.stopChannel(targetChId);
  const nextComponents = res.trackedCount > 0
   ? [buildSpamControlRow(targetChId, { running: false, trackedCount: res.trackedCount })]
   : [];
  await i.update({ components: nextComponents }).catch(() => {});
  const stopMsg = res.wasRunning
   ? `🛑 Đã **dừng réo ngay lập tức** (đã gửi **${res.sent}/${res.total}** tin) — bấm nút **🧹 Xóa sạch dấu vết** bất cứ lúc nào nếu muốn dọn kênh!`
   : '🛑 Đợt réo tên đã dừng từ trước.';
  await i.followUp({ content: stopMsg, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  return;
 }

 // Nút Dừng & Xóa sạch toàn bộ tin nhắn @tag vừa gửi — CHỈ Chủ Bot mới bấm được.
 if (i.isButton() && i.customId.startsWith('spamtag_clean:')) {
  if (!isBotOwner(i.user.id)) {
   await i.reply({
    content: '🔒 Chỉ **Chủ Bot** mới có quyền tắt hoặc xóa đợt réo tên này.',
    flags: MessageFlags.Ephemeral,
   });
   return;
  }
  const targetChId = i.customId.slice('spamtag_clean:'.length) || i.channelId;
  const isEphemeralCard = Boolean(i.message?.flags?.has?.(MessageFlags.Ephemeral));
  if (isEphemeralCard) {
   await i.deferUpdate();
   const res = await spamTagManager.stopAndCleanChannel(targetChId);
   await i.editReply({
    content: `🧹 Đã **tắt réo & dọn sạch hoàn toàn ${res.deletedCount} tin nhắn** khỏi kênh <#${targetChId}>!`,
    components: [],
    allowedMentions: { parse: [] },
   }).catch(() => {});
   return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await spamTagManager.stopAndCleanChannel(targetChId);
  await i.editReply({
   content: `🧹 Đã **tắt réo & dọn sạch hoàn toàn ${res.deletedCount} tin nhắn** khỏi kênh chat!`,
   allowedMentions: { parse: [] },
  }).catch(() => {});
  return;
 }

 // Nút lưu bản sao Avatar vĩnh viễn về Tin nhắn riêng (DM) — ai bấm cũng tự lưu về hộp thư của mình được.
 if (i.isButton() && i.customId.startsWith('avatar_dm:')) {
  const parts = i.customId.split(':');
  const targetUserId = parts[1];
  const reqType = parts[2] || 'auto';
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const targetUser = await client.users.fetch(targetUserId, { force: true }).catch(() => null);
  if (!targetUser) throw new Error('Không tải được thông tin người dùng để gửi ảnh về DM.');
  const targetMember = await i.guild?.members?.fetch?.(targetUserId).catch(() => null);
  const info = resolveAvatarTargetInfo(targetUser, targetMember, reqType);
  const buf = await downloadAvatarBuffer(info.attachUrl);
  const dmPayload = buildAvatarMessagePayload(info, {
   imageBuffer: buf,
   includeGuardButtons: false,
  });
  try {
   await i.user.send(dmPayload);
  } catch (err) {
   if (err?.code === 50007) {
    throw new Error('Không thể gửi tin nhắn riêng (DM) cho bạn — hãy bật **"Cho phép tin nhắn trực tiếp từ thành viên máy chủ"** trong Cài đặt quyền riêng tư Discord nhé!');
   }
   throw new Error('Không thể gửi ảnh về hộp thư riêng lúc này.');
  }
  await i.editReply({ content: `📩 Đã lưu vĩnh viễn ảnh của **${info.displayName}** kèm file gốc vào **Tin nhắn riêng (DM)** của bạn!`, allowedMentions: { parse: [] } });
  return;
 }

 // Nút gỡ chế độ bảo vệ chống xóa & xóa khung /avatar — CHỈ Chủ Bot mới có quyền gỡ.
 if (i.isButton() && i.customId.startsWith('avatar_unpin:')) {
  const res = await avatarGuard.unpinAndDelete(i.message?.id, i.channelId, i.user.id);
  if (!res.allowed) {
   await i.reply({
    content: '🔒 Khung soi Avatar này đang bật **Chống xóa tự động** — chỉ **Chủ bot** mới có quyền gỡ bỏ!',
    flags: MessageFlags.Ephemeral,
   });
   return;
  }
  await i.reply({ content: '🗑️ Đã gỡ bảo vệ chống xóa và thu hồi khung Avatar.', flags: MessageFlags.Ephemeral }).catch(() => {});
  return;
 }

 // Nút Khôi phục 1 chạm trên Thẻ Phiên Nhạc (/savequeue) — tự đọc ngược danh sách URL ngay trên thẻ mà không tốn RAM lưu trữ.
 if (i.isButton() && i.customId === 'savequeue_restore') {
  const saved = extractSaveQueueUrls(i.message);
  if (!saved?.urls?.length) {
   throw new Error('Không tìm thấy danh sách bài hát trên thẻ phiên nhạc này.');
  }
  let ownsLock = false;
  try {
   await i.deferReply({ flags: MessageFlags.Ephemeral });
   if (busy) {
    await i.editReply({ content: 'Đang xử lý thao tác khác, vui lòng thử lại.' });
    return;
   }
   busy = true; ownsLock = true;
   const voiceCh = await requireSameVoiceChannel(i.guild, i.user.id);
   assertMusicAccess('play', i.user.id, manager.get(i.guildId));
   const restored = await restoreSavedQueueBatch({
    guild: i.guild,
    voiceChannel: voiceCh,
    textChannel: i.channel,
    urls: saved.urls,
    userId: i.user.id,
   });
   const msg = restored.queued
    ? `✅ Đã nối thêm **${restored.addedCount} bài** từ **${saved.title}** vào hàng đợi!`
    : `▶️ Đã khôi phục **${restored.addedCount} bài** từ **${saved.title}** — bắt đầu phát: **${cleanText(restored.track.title, 80)}**!`;
   await i.editReply({ content: msg, allowedMentions: { parse: [] } });
  } finally {
   if (ownsLock) busy = false;
  }
  return;
 }

 // Menu chọn 1 trong 5 phiên bản bài hát từ lệnh /search.
 if (i.isStringSelectMenu() && i.customId.startsWith('search_pick:')) {
  const token = i.customId.slice('search_pick:'.length);
  const entry = pendingSearches.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
   pendingSearches.delete(token);
   throw new Error('Phiên chọn bài hát đã hết hạn (60 giây) — vui lòng gõ lại `/search` nhé!');
  }
  if (entry.userId !== i.user.id && !isBotOwner(i.user.id)) {
   throw new Error('Chỉ người vừa gõ lệnh `/search` này mới được chọn bài.');
  }
  const chosenTrack = entry.tracks[Number(i.values[0])];
  if (!chosenTrack) throw new Error('Bài hát đã chọn không hợp lệ.');

  let ownsLock = false;
  try {
   await i.deferUpdate();
   if (busy) {
    await i.followUp({ content: 'Đang xử lý thao tác khác, vui lòng thử lại.', flags: MessageFlags.Ephemeral });
    return;
   }
   busy = true; ownsLock = true;
   pendingSearches.delete(token);
   const voiceCh = await requireSameVoiceChannel(i.guild, i.user.id);
   assertMusicAccess('search', i.user.id, manager.get(i.guildId));
   const { track, queued, insertedNext } = await enqueuePickedTrack({
    guild: i.guild,
    voiceChannel: voiceCh,
    textChannel: i.channel,
    track: chosenTrack,
    userId: i.user.id,
    playNext: entry.playNext,
   });
   const summary = insertedNext
    ? `⏭️ Đã chèn lên đầu hàng đợi: **${cleanText(track.title, 90)}**`
    : (queued ? `✅ Đã thêm vào hàng đợi: **${cleanText(track.title, 90)}**` : `▶️ Đang phát phiên bản đã chọn: **${cleanText(track.title, 90)}**`);
   await i.editReply({ content: summary, embeds: [], components: [], allowedMentions: { parse: [] } });
  } finally {
   if (ownsLock) busy = false;
  }
  return;
 }

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

 // Trường hợp lưu nhanh bài đang phát vào Tủ nhạc Yêu thích cá nhân (ai trong máy chủ cũng lưu cho riêng mình được).
 if (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'save_fav') {
  const cur = p?.queue?.currentTrack;
  if (!cur) throw new Error('Hiện chưa phát bài hát nào để lưu vào Tủ nhạc Yêu thích.');
  const { added, track: savedItem, total } = favoritesStore.addTrack(i.user.id, cur);
  schedulePanelUpdate(p);
  const note = added
   ? `❤️ Đã lưu **${cleanText(savedItem.title, 85)}** vào **Tủ nhạc Yêu thích** của riêng bạn (**${total}/25** bài)!`
   : `💖 Bài **${cleanText(savedItem.title, 85)}** đã có sẵn trong Tủ nhạc Yêu thích của bạn (**${total}/25** bài) — đã đẩy lên đầu tủ!`;
  await i.reply({ content: note, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  return;
 }

 // Trường hợp bỏ túi thông tin & link bài đang nghe về Tin nhắn riêng (ai trong máy chủ cũng dùng được).
 if (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'grab_dm') {
  const cur = p?.queue?.currentTrack;
  if (!cur) throw new Error('Hiện chưa phát bài hát nào để bỏ túi về Tin nhắn riêng.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  schedulePanelUpdate(p);
  await sendGrabDmToUser(i.user, cur, p, i.guild);
  await i.editReply({
   content: `📩 Đã gửi thẻ bài hát **${cleanText(cur.title, 85)}** về **Tin nhắn riêng (DM)** của bạn!`,
   allowedMentions: { parse: [] },
  });
  return;
 }

 // Trường hợp xem Bảng Vàng Top Nhạc & Top DJ trực tiếp từ menu (ai trong máy chủ cũng xem được).
 if (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'view_stats') {
  if (p) schedulePanelUpdate(p);
  const embed = buildStatsEmbed(statsStore.getSummary(i.user.id), {
   scope: 'server',
   discordUser: i.user,
   botUser: client.user,
  });
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
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
   const { track, queued, collectionName, addedCount } = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    rawQuery: i.fields.getTextInputValue('query'),
    userId: i.user.id,
   });
   const modalNote = collectionName
    ? `💿 Đã nạp **${addedCount}** bài từ **${cleanText(collectionName, 65)}** (${queued ? 'vào hàng đợi' : `đang phát **${cleanText(track.title, 65)}**`})!`
    : (queued ? `✅ Đã thêm vào hàng đợi: **${cleanText(track.title, 90)}**` : `▶️ Đang phát: **${cleanText(track.title, 90)}**`);
   await i.editReply({
    content: modalNote,
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
     if (p.userdata) {
      p.userdata.autoPausedByMute = false;
      p.userdata.autoPausedByTts = false;
     }
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
    case 'play_fav': {
     const favList = favoritesStore.getList(i.user.id);
     if (favList.length === 0) {
      throw new Error('Tủ nhạc Yêu thích của bạn đang trống. Hãy chọn mục ❤️ Lưu vào Tủ nhạc Yêu thích hoặc gõ `/fav action:add` trước nhé!');
     }
     await i.deferReply({ flags: MessageFlags.Ephemeral });
     const channel = await requireSameVoiceChannel(i.guild, i.user.id);
     const { startedTrack, addedCount } = await enqueueFavoriteTracks({
      guild: i.guild,
      voiceChannel: channel,
      textChannel: i.channel,
      favItems: favList,
      userId: i.user.id,
     });
     await i.editReply({
      content: startedTrack
       ? `💖 Đã nạp **${addedCount}** bài từ Tủ nhạc Yêu thích của bạn — đang phát **${cleanText(startedTrack.title, 80)}**!`
       : `💖 Đã thêm **${addedCount}** bài từ Tủ nhạc Yêu thích của bạn vào hàng đợi!`,
      allowedMentions: { parse: [] },
     });
     return;
    }
    case 'replay_track': {
     const cur = p.queue.currentTrack;
     if (!cur) throw new Error('Hiện chưa phát bài hát nào để nghe lại từ đầu.');
     if (!(await p.seek(0))) throw new Error('Không thể tua lại bài hát lúc này.');
     syncPlayerVibeAnchor(p, p.userdata?.vibeMode ?? 'normal', 0);
     clearPanelTimer(p);
     markPanelTouched(p);
     nowPlayingHub.publish({ player: p }, { immediatePush: true });
     await i.update(buildPlayerPayload(p));
     return;
    }
    case 'cycle_vibe': {
     const nextVibe = getNextVibeMode(p.userdata?.vibeMode ?? 'normal');
     const vibeInfo = applyPlayerVibe(p, nextVibe);
     clearPanelTimer(p);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p, { vibeMode: nextVibe }));
     await i.followUp({
      content: `${vibeInfo.emoji} Đã chuyển Vibe bài hát sang **${vibeInfo.label}** (*${vibeInfo.description}*) — biến đổi trực tiếp ngay tại giây đang nghe!`,
      flags: MessageFlags.Ephemeral,
     }).catch(() => {});
     return;
    }
    case 'cycle_ambient': {
     const nextAmb = getNextAmbientMode(p.userdata?.ambientMode ?? 'off');
     const { info: ambInfo, levelPercent } = applyPlayerAmbient(p, nextAmb);
     clearPanelTimer(p);
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p, { ambientMode: nextAmb }));
     const ambMsg = nextAmb === 'off'
      ? '🔇 Đã **tắt** lớp âm thanh thiên nhiên nền.'
      : `${ambInfo.emoji} Đã bật nền **${ambInfo.label}** ở mức **${levelPercent}%** (*${ambInfo.description}*) — gõ \`/ambient\` nếu muốn chỉnh to/nhỏ!`;
     await i.followUp({ content: ambMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
     return;
    }
    case 'cycle_sound':
    case 'preset_hd':
    case 'preset_vocal':
    case 'preset_bass':
    case 'preset_8d':
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

function resolveTargetGuildForOwnerDm() {
 const targetGuild = (GUILD_ID ? client.guilds.cache.get(GUILD_ID) : null) ?? client.guilds.cache.first() ?? null;
 const targetGuildId = targetGuild?.id ?? GUILD_ID;
 if (!targetGuildId) {
  throw new Error('Bot hiện chưa tham gia máy chủ nào để đăng thông báo.');
 }
 return { guildId: targetGuildId, guildName: targetGuild?.name ?? 'Máy chủ Discord' };
}

// Chống lặp gói tin Gateway DM (giữ tối đa 12 ID gần nhất ~ 0 KB RAM).
const seenOwnerDmIds = new Set();

function formatUserResolveBanner(res) {
 if (res.cleared) {
  return '🧹 **Đã xóa sạch danh sách Tag người dùng.**';
 }
 const parts = [];
 if (res.resolved.length > 0) {
  parts.push(`🎯 **Đã gắn Tag (${res.resolved.length}) :** ${res.resolved.map(u => `<@${u.id}> *(${cleanText(u.label, 25)})*`).join(', ')}`);
 }
 if (res.ambiguous.length > 0) {
  parts.push(`🔎 **Có ${res.ambiguous.length} thành viên trùng tên** — hãy bấm vào thanh **Có ${res.ambiguous.length} thành viên khớp tên** ngay bên dưới để tích chọn đúng người!`);
 }
 if (res.notFound.length > 0) {
  parts.push(`⚠️ Không tìm thấy trong Server: \`${res.notFound.join(', ')}\` *(hãy gõ chữ cái đầu của username/biệt danh hoặc dán ID số)*`);
 }
 return parts.join('\n> ') || '🎯 Đã cập nhật danh sách Tag người dùng.';
}

// Hỗ trợ nhắn trực tiếp trong hộp chat riêng (DM) với Bot:
// - Mọi thành viên: gõ `gif [chữ meme]` kèm video (hoặc thành viên thả thẳng video vào DM) để đổi sang GIF tức thì!
// - Chủ Bot: giữ nguyên gõ thẳng `/announce`, `tag <tên/ID>`, `font <kiểu>` hoặc dán bài nháp thông báo chạy 0.1s!
async function handleDmRawPacket(packet) {
 if (packet?.t !== 'MESSAGE_CREATE') return;
 const d = packet.d;
 if (!d || d.guild_id || d.author?.bot) return;
 const authorId = String(d.author?.id ?? '');
 if (!authorId) return;

 const msgId = String(d.id ?? '');
 if (!msgId || seenOwnerDmIds.has(msgId)) return;
 if (seenOwnerDmIds.size >= 16) {
  const oldest = seenOwnerDmIds.values().next().value;
  if (oldest) seenOwnerDmIds.delete(oldest);
 }
 seenOwnerDmIds.add(msgId);

 const dmChannelId = String(d.channel_id ?? '');
 if (!dmChannelId) return;

 const plainContent = String(d.content ?? '').trim();
 const explicitGifMatch = plainContent.match(/^\/?gif(?:\s+([\s\S]*))?$/i);
 const hasDirectAttachments = Array.isArray(d.attachments) && d.attachments.length > 0;
 const ownerCheck = isBotOwner(authorId);

 // Nhánh 1: Đổi Video -> GIF trực tiếp trong DM (ai gõ `gif ...` hoặc thành viên gửi thẳng video cho Bot trong DM).
 if (explicitGifMatch || (!ownerCheck && hasDirectAttachments)) {
  let progressMsgId = null;
  try {
   const found = extractVideoFromMessage(d);
   if (found.sizeBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
    throw new Error('Video quá lớn (vượt mức an toàn 42MB) — hãy cắt ngắn hoặc gửi clip nhẹ hơn nhé!');
   }
   const rawCaptionArg = explicitGifMatch ? String(explicitGifMatch[1] ?? '').trim() : plainContent;
   const caption = rawCaptionArg.replace(/https?:\/\/[^\s<>()]+/gi, '').trim();

   const waitSent = await client.rest.post(Routes.channelMessages(dmChannelId), {
    body: {
     content: '🎞️ Đang tách khung hình & tối ưu bảng màu GIF nét cao...',
     allowed_mentions: { parse: [] },
    },
   }).catch(() => null);
   progressMsgId = waitSent?.id ?? null;

   const res = await videoToGifManager.convertVideoToGif({
    sourceUrl: found.url,
    requesterId: authorId,
    options: { caption },
   });
   if (progressMsgId) {
    await client.rest.delete(Routes.channelMessage(dmChannelId, progressMsgId)).catch(() => {});
    progressMsgId = null;
   }
   await client.rest.post(Routes.channelMessages(dmChannelId), {
    body: {
     content: formatGifSummaryLine(res.meta),
     components: buildGifActionComponents({
      token: res.session.token,
      requesterId: authorId,
      includeDmSave: false,
      includeDelete: true,
     }),
     allowed_mentions: { parse: [] },
    },
    files: [{
     name: res.filename,
     data: res.gifBuffer,
     contentType: 'image/gif',
    }],
   });
  } catch (e) {
   if (progressMsgId) {
    await client.rest.delete(Routes.channelMessage(dmChannelId, progressMsgId)).catch(() => {});
   }
   // Nếu thành viên chỉ nhắn chữ thường (không gõ `gif`) mà gửi ảnh tĩnh không phải video thì bỏ qua êm ái, chỉ báo lỗi khi có gõ `gif` hoặc lỗi rõ ràng.
   if (!explicitGifMatch && /Tin nhắn này không có file video/.test(e?.message ?? '')) return;
   const msg = KNOWN_ERROR_RE.test(e?.message ?? '') ? e.message : 'Không thể chuyển đổi video sang GIF lúc này.';
   const errSent = await client.rest.post(Routes.channelMessages(dmChannelId), {
    body: { content: `⚠️ ${msg}`, allowed_mentions: { parse: [] } },
   }).catch(() => null);
   if (errSent?.id) {
    const t = setTimeout(() => {
     client.rest.delete(Routes.channelMessage(dmChannelId, errSent.id)).catch(() => {});
    }, 30000);
    t.unref?.();
   }
  }
  return;
 }

 // Nhánh 2: Trạm Đăng Thông Báo & Khóa Kênh từ xa trong DM dành riêng cho Chủ Bot.
 if (!ownerCheck) return;

 const attachmentUrls = Array.isArray(d.attachments)
  ? d.attachments.map(a => a?.url).filter(Boolean)
  : [];
 const rawText = [plainContent, ...attachmentUrls].filter(Boolean).join('\n').trim();
 if (!rawText) return;

 try {
  const { guildId, guildName } = resolveTargetGuildForOwnerDm();
  const fontCmdMatch = rawText.match(/^\/?font(?:\s+([a-z0-9_-]+))?$/i);
  const tagCmdMatch = rawText.match(/^\/?tag(?:\s+([\s\S]*))?$/i);
  const cmdMatch = rawText.match(/^\/?(?:announce|tb|thongbao|menu|lock|unlock|help)(?:\s+([\s\S]*))?$/i);
  let session;
  let banner = null;

  if (fontCmdMatch) {
   session = await channelLockManager.openOrReuseOwnerDmDraft({
    guildId,
    guildName,
    requesterId: authorId,
    draftText: '',
    forceFresh: false,
   });
   const arg = String(fontCmdMatch[1] ?? '').toLowerCase();
   const aliasMap = {
    normal: 'normal', thuong: 'normal', off: 'normal',
    title: 'h1_title', tieude: 'h1_title',
    h1: 'h1_all', to: 'h1_all', sieuto: 'h1_all',
    h2: 'h2_all', vua: 'h2_all',
    h3: 'h3_bold',
    quote: 'quote_bold', trichdan: 'quote_bold',
    sub: 'subtext', nho: 'subtext',
   };
   session.fontMode = aliasMap[arg] ?? getNextAnnounceFont(session.fontMode);
   const fi = ANNOUNCE_FONT_MODES[session.fontMode] ?? ANNOUNCE_FONT_MODES.normal;
   banner = `🔤 **Đã chuyển cỡ chữ sang:** ${fi.fullLabel}`;
  } else if (tagCmdMatch) {
   session = await channelLockManager.openOrReuseOwnerDmDraft({
    guildId,
    guildName,
    requesterId: authorId,
    draftText: '',
    forceFresh: false,
   });
   const tagArg = String(tagCmdMatch[1] ?? '').trim();
   const res = await channelLockManager.resolveDmUserTargets(session, tagArg, {
    requesterId: authorId,
    merge: Boolean(tagArg && !/^(?:xoa|xóa|clear|off|none|0)$/i.test(tagArg)),
   });
   banner = formatUserResolveBanner(res);
  } else if (cmdMatch) {
   const inlineDraft = String(cmdMatch[1] ?? '').trim();
   session = await channelLockManager.openOrReuseOwnerDmDraft({
    guildId,
    guildName,
    requesterId: authorId,
    draftText: inlineDraft,
    forceFresh: !inlineDraft,
   });
   if (inlineDraft) {
    banner = '✍️ **Đã nạp nội dung nháp!** Chọn kênh / tag bên dưới rồi bấm **🚀 Đăng ngay** để đăng lên Server!';
   }
  } else {
   const prevDraftKeep = await channelLockManager.openOrReuseOwnerDmDraft({
    guildId,
    guildName,
    requesterId: authorId,
    draftText: rawText,
    forceFresh: false,
   });
   session = prevDraftKeep;
   banner = '✍️ **Đã nhận tin nhắn làm bản nháp sẵn sàng!** Chọn kênh / tag (hoặc bấm **🎯 Tag Tên / ID**) rồi bấm **🚀 Đăng ngay**!';
  }

  // Dọn bảng cũ trong DM (nếu có) & hẹn giờ 4 phút 30 giây không thao tác sẽ tự động xóa sạch khung điều khiển!
  const prevMsgId = session.lastDmMessageId;
  const prevChId = session.lastDmChannelId;
  const payload = buildDmAnnounceStudioPayload(session, banner);
  const sent = await client.rest.post(Routes.channelMessages(dmChannelId), {
   body: {
    embeds: payload.embeds,
    components: payload.components,
    allowed_mentions: { parse: [] },
   },
  });
  if (prevMsgId && prevChId === dmChannelId && prevMsgId !== sent?.id) {
   await client.rest.delete(Routes.channelMessage(prevChId, prevMsgId)).catch(() => {});
  }
  channelLockManager.bindDmStudioMessage(session, {
   channelId: dmChannelId,
   messageId: sent?.id ?? null,
  });
 } catch (e) {
  const msg = KNOWN_ERROR_RE.test(e?.message ?? '') ? e.message : 'Không thể mở bảng điều khiển DM lúc này.';
  const errSent = await client.rest.post(Routes.channelMessages(dmChannelId), {
   body: { content: `⚠️ ${msg}`, allowed_mentions: { parse: [] } },
  }).catch(() => null);
  if (errSent?.id) {
   const t = setTimeout(() => {
    client.rest.delete(Routes.channelMessage(dmChannelId, errSent.id)).catch(() => {});
   }, 30000);
   t.unref?.();
  }
 }
}

// Xử lý tương tác trong hộp thư Tin nhắn riêng (DM) với Bot:
// - /gif & Chuột phải "🎞️ Đổi video sang GIF" + nút chỉnh GIF: mở cho mọi người.
// - /announce & Trạm Đăng Thông Báo / Khóa Kênh từ xa: chỉ Chủ Bot sử dụng.
async function handleBotDmInteraction(i) {
 if (await handleGifComponent(i)) return;
 if (
  (i.isChatInputCommand() && i.commandName === 'gif')
  || (i.isMessageContextMenuCommand?.() && i.commandName === CONTEXT_GIF_NAME)
 ) {
  await handleGifCommandOrContext(i);
  return;
 }

 if (i.isChatInputCommand() && i.commandName === 'announce') {
  channelLockManager.assertOwner(i.user.id);
  await i.deferReply();
  const { guildId, guildName } = resolveTargetGuildForOwnerDm();
  const session = await channelLockManager.openDmStudioSession({
   guildId,
   guildName,
   requesterId: i.user.id,
   initialMessage: i.options.getString('message') ?? '',
   fontMode: i.options.getString('font') || 'normal',
   style: i.options.getString('style') || 'text',
   autoReact: i.options.getBoolean('auto_react') ?? true,
  });
  const initUsers = i.options.getString('ping_users') ?? '';
  let banner = null;
  if (initUsers.trim()) {
   const r = await channelLockManager.resolveDmUserTargets(session, initUsers, { requesterId: i.user.id });
   banner = formatUserResolveBanner(r);
  }
  const replyMsg = await i.editReply(buildDmAnnounceStudioPayload(session, banner));
  const resolvedDmChId = i.channelId ?? replyMsg?.channel_id ?? replyMsg?.channelId ?? null;
  const appId = i.applicationId ?? client.application?.id;
  const intToken = i.token;
  channelLockManager.bindDmStudioMessage(session, {
   channelId: resolvedDmChId,
   messageId: replyMsg?.id ?? null,
   webhookDelete: appId && intToken
    ? () => client.rest.delete(Routes.webhookMessage(appId, intToken, '@original'))
    : null,
  });
  return;
 }

 const loadSession = async token => {
  const { guildId, guildName } = resolveTargetGuildForOwnerDm();
  const s = await channelLockManager.ensureDmStudioSession(token, {
   requesterId: i.user.id,
   guildId,
   guildName,
  });
  channelLockManager.bindDmStudioMessage(s, {
   channelId: i.channelId ?? s.lastDmChannelId,
   messageId: i.message?.id ?? s.lastDmMessageId,
  });
  return s;
 };

 if (i.isStringSelectMenu() && i.customId.startsWith('dm_ann_ch:')) {
  const token = i.customId.slice('dm_ann_ch:'.length);
  const session = await loadSession(token);
  session.channelId = i.values[0];
  const idx = session.channels.findIndex(c => c.id === session.channelId);
  if (idx >= 0) session.channelPage = Math.floor(idx / 25);
  await i.update(buildDmAnnounceStudioPayload(session));
  return;
 }

 if (i.isButton() && i.customId.startsWith('dm_ann_chpage:')) {
  const token = i.customId.slice('dm_ann_chpage:'.length);
  const session = await loadSession(token);
  const totalPages = Math.max(1, Math.ceil(session.channels.length / 25));
  session.channelPage = ((Number(session.channelPage) || 0) + 1) % totalPages;
  const firstOnPage = session.channels[session.channelPage * 25];
  if (firstOnPage) session.channelId = firstOnPage.id;
  await i.update(buildDmAnnounceStudioPayload(session));
  return;
 }

 if (i.isStringSelectMenu() && i.customId.startsWith('dm_ann_ping:')) {
  const token = i.customId.slice('dm_ann_ping:'.length);
  const session = await loadSession(token);
  session.pingMode = i.values[0] || 'none';
  await i.update(buildDmAnnounceStudioPayload(session));
  return;
 }

 // Thanh chọn nhanh người dùng Discord gốc (UserSelectMenu ở Hàng 3)
 if (i.isUserSelectMenu() && i.customId.startsWith('dm_ann_users:')) {
  const token = i.customId.slice('dm_ann_users:'.length);
  const session = await loadSession(token);
  session.pendingUserMatches = [];
  session.pingUsers = i.values.slice(0, 15).map(uid => {
   const u = i.users?.get?.(uid);
   const label = u
    ? (u.globalName && u.globalName !== u.username ? `${u.globalName} (@${u.username})` : `@${u.username}`)
    : `ID:${uid}`;
   return { id: String(uid), label };
  });
  await i.update(buildDmAnnounceStudioPayload(session));
  return;
 }

 // Khi tìm theo tên khớp nhiều thành viên trên Server -> Chủ Bot tích chọn đúng thành viên từ danh sách gợi ý
 if (i.isStringSelectMenu() && i.customId.startsWith('dm_ann_pickmatch:')) {
  const token = i.customId.slice('dm_ann_pickmatch:'.length);
  const session = await loadSession(token);
  const pool = new Map((session.pendingUserMatches ?? []).map(m => [m.id, m]));
  const merged = new Map((session.pingUsers ?? []).map(u => [u.id, u]));
  for (const uid of i.values) {
   const found = pool.get(uid);
   merged.set(String(uid), { id: String(uid), label: found?.label ?? `ID:${uid}` });
  }
  session.pingUsers = [...merged.values()].slice(0, 15);
  session.pendingUserMatches = [];
  await i.update(
   buildDmAnnounceStudioPayload(session, `🎯 **Đã thêm ${i.values.length} thành viên vào danh sách Tag!**`),
  );
  return;
 }

 // Nút mở hộp thoại Tìm theo Tên / Biệt danh Server hoặc dán ID người dùng
 if (i.isButton() && i.customId.startsWith('dm_ann_usertag:')) {
  const token = i.customId.slice('dm_ann_usertag:'.length);
  const session = await loadSession(token);
  await i.showModal(buildDmUserTagModal(session.token, session.pingUsers));
  return;
 }

 // Xử lý kết quả nhập Tên / ID người dùng từ hộp thoại 🎯 Tag Tên / ID
 if (i.isModalSubmit() && i.customId.startsWith('dm_ann_usertag_modal:')) {
  const token = i.customId.slice('dm_ann_usertag_modal:'.length);
  const session = await loadSession(token);
  const rawTargets = i.fields.getTextInputValue('user_targets');
  await i.deferUpdate();
  const res = await channelLockManager.resolveDmUserTargets(session, rawTargets, {
   requesterId: i.user.id,
   merge: false,
  });
  await i.editReply(buildDmAnnounceStudioPayload(session, formatUserResolveBanner(res)));
  return;
 }

 // Nút xóa nhanh danh sách người dùng đang được Tag
 if (i.isButton() && i.customId.startsWith('dm_ann_clearusers:')) {
  const token = i.customId.slice('dm_ann_clearusers:'.length);
  const session = await loadSession(token);
  session.pingUsers = [];
  session.pendingUserMatches = [];
  await i.update(buildDmAnnounceStudioPayload(session, '🧹 **Đã xóa sạch danh sách Tag người dùng.**'));
  return;
 }

 // Nút đổi cỡ chữ / kiểu chữ (🔤 Font: Tự do -> # Tiêu đề Lớn -> # Siêu To H1 -> ## To Vừa H2 -> ### Vừa H3 -> > Trích Dẫn -> -# Chữ Nhỏ)
 if (i.isButton() && i.customId.startsWith('dm_ann_font:')) {
  const token = i.customId.slice('dm_ann_font:'.length);
  const session = await loadSession(token);
  session.fontMode = getNextAnnounceFont(session.fontMode);
  const fi = ANNOUNCE_FONT_MODES[session.fontMode] ?? ANNOUNCE_FONT_MODES.normal;
  await i.update(buildDmAnnounceStudioPayload(session, `🔤 **Đã đổi cỡ chữ sang:** ${fi.fullLabel}`));
  return;
 }

 if (i.isButton() && i.customId.startsWith('dm_ann_style:')) {
  const token = i.customId.slice('dm_ann_style:'.length);
  const session = await loadSession(token);
  session.style = session.style === 'embed' ? 'text' : 'embed';
  await i.update(buildDmAnnounceStudioPayload(session));
  return;
 }

 if (i.isButton() && i.customId.startsWith('dm_ann_react:')) {
  const token = i.customId.slice('dm_ann_react:'.length);
  const session = await loadSession(token);
  session.autoReact = !session.autoReact;
  await i.update(buildDmAnnounceStudioPayload(session));
  return;
 }

 if (i.isButton() && i.customId.startsWith('dm_ann_compose:')) {
  const token = i.customId.slice('dm_ann_compose:'.length);
  const session = await loadSession(token);
  await i.showModal(buildDmAnnounceModal(session.token, session.draftText, session.pingUsers));
  return;
 }

 if (i.isButton() && i.customId.startsWith('dm_ann_send:')) {
  const token = i.customId.slice('dm_ann_send:'.length);
  const session = await loadSession(token);
  if (!session.draftText) {
   throw new Error('Chưa có nội dung nháp — hãy bấm nút **✍️ Soạn & Đăng** hoặc gõ tin nhắn vào DM nhé!');
  }
  await i.deferUpdate();
  const res = await channelLockManager.postBotAnnouncement({
   guildId: session.guildId,
   channelId: session.channelId,
   requesterId: i.user.id,
   rawContent: session.draftText,
   pingRoleId: session.pingMode !== 'none' && session.pingMode !== 'everyone' ? session.pingMode : null,
   pingEveryone: session.pingMode === 'everyone',
   pingUserIds: (session.pingUsers ?? []).map(u => u.id),
   fontMode: session.fontMode,
   style: session.style,
   autoReact: session.autoReact,
  });
  const chObj = session.channels.find(c => c.id === session.channelId);
  session.draftText = '';
  const pubNote = res.published ? ' (đã Xuất bản tới người Theo dõi)' : '';
  const jumpLink = res.messageId ? ` • [🔗 Xem bài đăng](https://discord.com/channels/${session.guildId}/${session.channelId}/${res.messageId})` : '';
  await i.editReply(
   buildDmAnnounceStudioPayload(session, `✅ **Đã đăng bài thành công lên #${chObj?.name ?? 'kênh'}!**${pubNote}${jumpLink}`),
  );
  return;
 }

 if (i.isModalSubmit() && i.customId.startsWith('dm_ann_modal:')) {
  const token = i.customId.slice('dm_ann_modal:'.length);
  const session = await loadSession(token);
  const rawContent = i.fields.getTextInputValue('announce_content');
  let rawUserTargets = '';
  try {
   rawUserTargets = i.fields.getTextInputValue('announce_user_targets') ?? '';
  } catch {}
  await i.deferUpdate();

  if (rawUserTargets.trim()) {
   const resolved = await channelLockManager.resolveDmUserTargets(session, rawUserTargets, {
    requesterId: i.user.id,
    merge: false,
   });
   // Nếu từ khóa tên khớp nhiều người khác nhau trên Server, dừng lại cho Chủ Bot tích chọn đúng người rồi mới bấm 🚀 Đăng ngay (tránh tag nhầm người trùng tên!)
   if (resolved.ambiguous.length > 0) {
    session.draftText = String(rawContent ?? '').trim();
    await i.editReply(
     buildDmAnnounceStudioPayload(
      session,
      `${formatUserResolveBanner(resolved)}\n> 💡 *Sau khi tích chọn đúng người ở menu bên dưới, chỉ cần bấm **🚀 Đăng ngay** là bài lên Server!*`,
     ),
    );
    return;
   }
  } else if ((session.pingUsers ?? []).length > 0) {
   // Nếu Chủ Bot chủ động xóa trắng ô Tag trong Modal -> gỡ tag người dùng
   session.pingUsers = [];
   session.pendingUserMatches = [];
  }

  const res = await channelLockManager.postBotAnnouncement({
   guildId: session.guildId,
   channelId: session.channelId,
   requesterId: i.user.id,
   rawContent,
   pingRoleId: session.pingMode !== 'none' && session.pingMode !== 'everyone' ? session.pingMode : null,
   pingEveryone: session.pingMode === 'everyone',
   pingUserIds: (session.pingUsers ?? []).map(u => u.id),
   fontMode: session.fontMode,
   style: session.style,
   autoReact: session.autoReact,
  });
  const chObj = session.channels.find(c => c.id === session.channelId);
  session.draftText = '';
  const pubNote = res.published ? ' (đã Xuất bản tới người Theo dõi)' : '';
  const jumpLink = res.messageId ? ` • [🔗 Xem bài đăng](https://discord.com/channels/${session.guildId}/${session.channelId}/${res.messageId})` : '';
  await i.editReply(
   buildDmAnnounceStudioPayload(session, `✅ **Đã đăng bài thành công lên #${chObj?.name ?? 'kênh'}!**${pubNote}${jumpLink}`),
  );
  return;
 }

 if (i.isButton() && (i.customId.startsWith('dm_ann_lock:') || i.customId.startsWith('dm_ann_unlock:'))) {
  const wantLock = i.customId.startsWith('dm_ann_lock:');
  const token = i.customId.split(':')[1];
  const session = await loadSession(token);
  await i.deferUpdate();
  const chObj = session.channels.find(c => c.id === session.channelId);
  if (wantLock) {
   const res = await channelLockManager.lockChannel({
    guildId: session.guildId,
    channelId: session.channelId,
    requesterId: i.user.id,
    botUserId: client.user?.id,
    mode: 'announcement',
    allowReactions: true,
   });
   if (res.announcementStatus === 'converted_announcement' && chObj) {
    chObj.type = 5;
   }
   const badge = res.announcementStatus === 'community_needed'
    ? `🔒 Đã khóa ô chat **#${chObj?.name ?? 'kênh'}**! *(Bật Cộng đồng trên Server nếu muốn hiện nút xanh Theo dõi)*`
    : `🔒📢 Đã khóa **#${chObj?.name ?? 'kênh'}** ở chế độ **Kênh Thông Báo (hiện nút xanh Theo dõi)**!`;
   await i.editReply(buildDmAnnounceStudioPayload(session, badge));
  } else {
   await channelLockManager.unlockChannel({
    guildId: session.guildId,
    channelId: session.channelId,
    requesterId: i.user.id,
   });
   await i.editReply(buildDmAnnounceStudioPayload(session, `🔓 Đã **mở khóa** lại kênh **#${chObj?.name ?? 'kênh'}** trên máy chủ!`));
  }
 }
}

// Xử lý toàn bộ tương tác từ Discord (Lệnh slash + Nút bấm + Menu + Modal trên khung Music Player & Trạm DM).
client.on(Events.InteractionCreate, async i => {
 if (!i.guild) {
  try { await handleBotDmInteraction(i); } catch (e) { await replyInteractionError(i, e); }
  return;
 }
 if (GUILD_ID && i.guildId !== GUILD_ID) {
  return void i.reply({ content: 'Bot chỉ phục vụ máy chủ đã cấu hình.', flags: MessageFlags.Ephemeral }).catch(() => {});
 }
 if (i.channelId) triggerChannelSweep(i.channelId);

 if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) {
  try { await handlePlayerComponent(i); } catch (e) { await replyInteractionError(i, e); }
  return;
 }

 // Lệnh Menu ngữ cảnh trên Tin nhắn (Chạm giữ / Chuột phải tin nhắn -> Ứng dụng -> "▶️ Phát / Thêm nhạc").
 if (i.isMessageContextMenuCommand?.() && i.commandName === CONTEXT_PLAY_NAME) {
  let ownsLock = false;
  try {
   await i.deferReply({ flags: MessageFlags.Ephemeral });
   if (busy) {
    await i.editReply({ content: 'Đang xử lý lệnh khác, vui lòng thử lại.' });
    return;
   }
   busy = true; ownsLock = true;
   const extracted = extractPlayableFromMessage(i.targetMessage);
   const voiceCh = await requireSameVoiceChannel(i.guild, i.user.id);
   assertMusicAccess('play', i.user.id, manager.get(i.guildId));
   if (extracted.kind === 'savequeue') {
    const restored = await restoreSavedQueueBatch({
     guild: i.guild,
     voiceChannel: voiceCh,
     textChannel: i.channel,
     urls: extracted.urls,
     userId: i.user.id,
    });
    const text = restored.queued
     ? `✅ Đã khôi phục & nối **${restored.addedCount} bài** từ **${extracted.title}** vào hàng đợi!`
     : `▶️ Đã khôi phục **${restored.addedCount} bài** từ **${extracted.title}** — đang phát: **${cleanText(restored.track.title, 80)}**!`;
    await i.editReply({ content: text, allowedMentions: { parse: [] } });
    return;
   }
   const res = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: voiceCh,
    textChannel: i.channel,
    rawQuery: extracted.query,
    userId: i.user.id,
    playNext: false,
   });
   const summary = res.collectionName
    ? `📚 Đã nạp **${res.addedCount} bài** từ **${cleanText(res.collectionName, 70)}**!`
    : (res.queued
       ? `✅ Đã bắt từ tin nhắn & thêm vào hàng đợi: **${cleanText(res.track.title, 85)}**`
       : `▶️ Đang phát ngay từ tin nhắn: **${cleanText(res.track.title, 85)}**`);
   await i.editReply({ content: summary, allowedMentions: { parse: [] } });
  } catch (e) {
   await replyInteractionError(i, e);
  } finally {
   if (ownsLock) busy = false;
  }
  return;
 }

 // Lệnh Menu ngữ cảnh trên Tin nhắn: "🎞️ Đổi video sang GIF" (ai trong Server cũng dùng được, không khóa hàng đợi nhạc).
 if (i.isMessageContextMenuCommand?.() && i.commandName === CONTEXT_GIF_NAME) {
  try { await handleGifCommandOrContext(i); } catch (e) { await replyInteractionError(i, e); }
  return;
 }

 // Lệnh Menu ngữ cảnh trên Thành viên (Chạm giữ / Chuột phải người dùng -> Ứng dụng -> "🖼️ Soi Avatar 4K").
 if (i.isUserContextMenuCommand?.() && i.commandName === CONTEXT_AVATAR_NAME) {
  try {
   await i.deferReply();
   const targetUser = await client.users.fetch(i.targetUser.id, { force: true }).catch(() => i.targetUser);
   const targetMember = i.targetMember?.avatar !== undefined
    ? i.targetMember
    : await i.guild.members.fetch(targetUser.id).catch(() => null);
   const info = resolveAvatarTargetInfo(targetUser, targetMember, 'auto');
   const imageBuffer = await downloadAvatarBuffer(info.attachUrl);
   const payload = buildAvatarMessagePayload(info, {
    requesterId: i.user.id,
    imageBuffer,
    includeGuardButtons: true,
   });
   const sentMsg = await i.editReply(payload);
   avatarGuard.registerProtectedMessage(sentMsg, {
    info,
    requesterId: i.user.id,
    imageBuffer,
   });
  } catch (e) {
   await replyInteractionError(i, e);
  }
  return;
 }

 if (!i.isChatInputCommand()) return;
 const reply = content => i.editReply({ content, allowedMentions: { parse: [] } });
 let ownsLock = false;
 try {
  // Lệnh /gif chuyển Video sang ảnh động GIF nét cao (ai trong Server cũng dùng được, có hàng đợi riêng bảo vệ RAM 512MB).
 if (i.commandName === 'gif') {
  await handleGifCommandOrContext(i);
  return;
 }

 // Lệnh /avatar đăng CÔNG KHAI ra kênh chat (không Ephemeral, không tự xóa, chống xóa tự động theo yêu cầu).
  if (i.commandName === 'avatar') {
   await i.deferReply();
   const targetOptUser = i.options.getUser('user') ?? i.user;
   const reqType = i.options.getString('type') || 'auto';
   // Force fetch để lấy đủ ảnh bìa hồ sơ (Banner) & màu trang trí hồ sơ mới nhất từ Discord API.
   const targetUser = await client.users.fetch(targetOptUser.id, { force: true }).catch(() => targetOptUser);
   const targetMember = await i.guild.members.fetch(targetUser.id).catch(() => null);
   const info = resolveAvatarTargetInfo(targetUser, targetMember, reqType);
   const imageBuffer = await downloadAvatarBuffer(info.attachUrl);
   const payload = buildAvatarMessagePayload(info, {
    requesterId: i.user.id,
    imageBuffer,
    includeGuardButtons: true,
   });
   const sentMsg = await i.editReply(payload);
   avatarGuard.registerProtectedMessage(sentMsg, {
    info,
    requesterId: i.user.id,
    imageBuffer,
   });
   return;
  }

  // Lệnh /savequeue gửi Thẻ Phiên Nhạc ra kênh chat (để hôm sau bấm nút Khôi phục 1 chạm) hoặc gửi về hộp thư DM riêng.
  if (i.commandName === 'savequeue') {
   const dest = i.options.getString('destination') || 'channel';
   const customTitle = i.options.getString('title')?.trim() || null;
   const pSnap = manager.get(i.guildId);
   if (dest === 'dm') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { payload, count } = buildSaveQueuePayload(pSnap, {
     customTitle,
     requesterId: i.user.id,
     botUser: client.user,
     includeRestoreButton: false,
    });
    try {
     await i.user.send(payload);
    } catch (err) {
     if (err?.code === 50007) {
      throw new Error('Không thể gửi tin nhắn riêng (DM) cho bạn — hãy bật **"Cho phép tin nhắn trực tiếp từ thành viên máy chủ"** trong Cài đặt quyền riêng tư Discord nhé!');
     }
     throw new Error('Không thể gửi hộp phiên nhạc về DM lúc này.');
    }
    return await reply(`💾 Đã đóng gói **${count} bài hát** và gửi về **Tin nhắn riêng (DM)** của bạn!`);
   }
   if (!pSnap || (!pSnap.queue?.currentTrack && !(pSnap.upcomingTracks?.length > 0))) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    return await reply('Hiện chưa có bài hát nào đang phát hoặc trong hàng đợi để đóng gói.');
   }
   await i.deferReply();
   const { payload } = buildSaveQueuePayload(pSnap, {
    customTitle,
    requesterId: i.user.id,
    botUser: client.user,
    includeRestoreButton: true,
   });
   return await i.editReply(payload);
  }

  // Nếu Chủ Bot gõ /announce mà để trống tham số message -> mở ngay bảng gõ nhiều dòng (Modal) tiện lợi trên Điện thoại & PC!
  if (i.commandName === 'announce' && !i.options.getString('message')?.trim()) {
   channelLockManager.assertOwner(i.user.id);
   const targetCh = i.options.getChannel('channel') ?? i.channel;
   const pingRole = i.options.getRole('ping_role');
   const pingEveryone = i.options.getBoolean('ping_everyone') ?? false;
   const fontMode = i.options.getString('font') || 'normal';
   const style = i.options.getString('style') || 'text';
   const autoReact = i.options.getBoolean('auto_react') ?? true;
   await i.showModal(buildAnnounceModal({
    channelId: targetCh.id,
    pingRoleId: pingRole?.id ?? '',
    pingEveryone,
    fontMode,
    style,
    autoReact,
   }));
   return;
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (i.commandName === 'help') {
   const initialCat = i.options.getString('category') || 'overview';
   return await i.editReply(buildHelpPayload({
    botUser: client.user,
    guild: i.guild,
    category: initialCat,
   }));
  }
  if (i.commandName === 'ping') return await reply(`Độ trễ: ${client.ws.ping} ms • Bộ nhớ Node: ${Math.round(process.memoryUsage().rss / 1048576)} MiB (chưa tính tiến trình FFmpeg).`);

  // Nhóm lệnh Quản trị Kênh & Đăng bài bằng Bot (/lock, /unlock, /announce — chỉ Chủ Bot sử dụng).
  if (i.commandName === 'lock') {
   const targetCh = i.options.getChannel('channel') ?? i.channel;
   const mode = i.options.getString('mode') || 'announcement';
   const allowReactions = i.options.getBoolean('reactions') ?? true;
   const extraRole = i.options.getRole('role');
   const res = await channelLockManager.lockChannel({
    guildId: i.guildId,
    channelId: targetCh.id,
    requesterId: i.user.id,
    botUserId: client.user?.id,
    mode,
    allowReactions,
    extraRoleId: extraRole?.id ?? null,
   });
   const reactLine = res.allowReactions
    ? '• Thành viên vẫn **xem tin & thả biểu cảm ❤️ 🔥** được (ô gõ chat & tạo Thread đã bị khóa).'
    : '• Đã khóa cả ô gõ chat, tạo Thread lẫn thả biểu cảm.';
   let statusHeader = `🔒 Đã **khóa kênh** <#${res.channelId}> thành công!`;
   let extraTip = '';
   if (mode === 'announcement') {
    if (res.announcementStatus === 'converted_announcement' || res.announcementStatus === 'already_announcement') {
     statusHeader = `🔒📢 Đã **khóa kênh** <#${res.channelId}> ở chế độ **Kênh Thông Báo** — đáy kênh nay hiện hộp nút xanh **\`[Theo dõi]\`** y hệt mẫu!`;
    } else if (res.announcementStatus === 'community_needed') {
     extraTip = '\n> 💡 *Để đáy kênh hiện hộp nút xanh **`[Theo dõi]`** thay vì dòng chữ xám: bạn vào **Cài đặt Máy chủ -> Bật Cộng đồng (Enable Community)** (miễn phí, mất 10 giây) rồi gõ lại `/lock` một lần nữa là lên ngay!*';
    }
   }
   return await i.editReply({
    content: [
     statusHeader,
     reactLine,
     '• **Chủ Bot & Bot** vẫn nhắn tin / dùng `/announce` vào kênh này bình thường.',
     extraTip,
    ].filter(Boolean).join('\n'),
    components: [buildChannelLockButtons(res.channelId, { locked: true })],
    allowedMentions: { parse: [] },
   });
  }

  if (i.commandName === 'unlock') {
   const targetCh = i.options.getChannel('channel') ?? i.channel;
   const revertNormal = i.options.getBoolean('revert_normal') ?? false;
   const extraRole = i.options.getRole('role');
   const res = await channelLockManager.unlockChannel({
    guildId: i.guildId,
    channelId: targetCh.id,
    requesterId: i.user.id,
    extraRoleId: extraRole?.id ?? null,
    revertNormalText: revertNormal,
   });
   const revertMsg = res.revertedType ? ' *(đã chuyển về lại kênh chữ `#` thường)*' : '';
   return await i.editReply({
    content: `🔓 Đã **mở khóa** kênh <#${res.channelId}> về trạng thái bình thường${revertMsg}!`,
    components: [buildChannelLockButtons(res.channelId, { locked: false })],
    allowedMentions: { parse: [] },
   });
  }

  if (i.commandName === 'announce') {
   const targetCh = i.options.getChannel('channel') ?? i.channel;
   const rawContent = i.options.getString('message') ?? '';
   const pingRole = i.options.getRole('ping_role');
   const pingEveryone = i.options.getBoolean('ping_everyone') ?? false;
   const fontMode = i.options.getString('font') || 'normal';
   const style = i.options.getString('style') || 'text';
   const autoReact = i.options.getBoolean('auto_react') ?? true;
   const res = await channelLockManager.postBotAnnouncement({
    guildId: i.guildId,
    channelId: targetCh.id,
    requesterId: i.user.id,
    rawContent,
    pingRoleId: pingRole?.id ?? null,
    pingEveryone,
    fontMode,
    style,
    autoReact,
   });
   const pubNote = res.published ? ' *(đã tự động Xuất bản tới người Theo dõi)*' : '';
   return await reply(`📢 Đã dùng Bot đăng thông báo lên kênh <#${targetCh.id}> thành công!${pubNote}`);
  }

  // Lệnh /spamtag: Réo tên (@tag) gọi hồn bạn bè liên tục kèm nút Dừng & Xóa sạch (chỉ Chủ Bot sử dụng, không khóa hàng đợi nhạc).
  if (i.commandName === 'spamtag') {
   spamTagManager.assertOwner(i.user.id);
   const targetOptUser = i.options.getUser('user');
   const action = i.options.getString('action') || (targetOptUser ? 'start' : null);
   if (!action) {
    throw new Error('Hãy chọn thành viên ở tham số `user` để bắt đầu réo, hoặc chọn `action: stop` / `action: clear` để tắt & xóa tin nhắn.');
   }
   if (action === 'stop') {
    const res = spamTagManager.stopChannel(i.channelId);
    const comps = res.trackedCount > 0
     ? [buildSpamControlRow(i.channelId, { running: false, trackedCount: res.trackedCount })]
     : [];
    const txt = res.wasRunning
     ? `🛑 Đã **dừng réo ngay lập tức** sau **${res.sent}/${res.total}** tin nhắn.`
     : (res.trackedCount > 0
        ? `ℹ️ Hiện không có đợt réo nào đang chạy (còn **${res.trackedCount} tin cũ** có thể dọn sạch bằng nút bên dưới).`
        : 'ℹ️ Hiện không có đợt réo tên nào đang chạy trong kênh này.');
    return await i.editReply({ content: txt, components: comps, allowedMentions: { parse: [] } });
   }
   if (action === 'clear') {
    const res = await spamTagManager.stopAndCleanChannel(i.channelId);
    return await reply(
     res.deletedCount > 0
      ? `🧹 Đã **dừng réo & xóa sạch hoàn toàn ${res.deletedCount} tin nhắn** khỏi kênh chat!`
      : '🧹 Kênh hiện đã sạch sẽ, không còn tin nhắn réo tên nào cần xóa.',
    );
   }
   if (!targetOptUser) {
    throw new Error('Hãy chọn người cần réo tên ở tham số `user` nhé!');
   }
   if (targetOptUser.id === client.user?.id) {
    throw new Error('Không thể tự réo tên chính Bot — hãy chọn một thành viên khác nhé!');
   }
   const count = i.options.getInteger('count') ?? 10;
   const intervalSec = i.options.getInteger('interval');
   const customMessage = i.options.getString('message');
   const started = await spamTagManager.startSpam({
    channelId: i.channelId,
    requesterId: i.user.id,
    targetUserId: targetOptUser.id,
    count,
    intervalSec,
    customMessage,
   });
   const ctrlRow = buildSpamControlRow(i.channelId, {
    running: started.running,
    trackedCount: started.trackedCount,
   });
   const statusText = started.running
    ? `🔔 Đang réo <@${targetOptUser.id}> tổng cộng **${started.total} lần** *(cách nhau ${(started.stepMs / 1000).toFixed(1)}s)*.\n> 👇 Bấm nút bên dưới bất cứ lúc nào để **🛑 Dừng réo** hoặc **🧹 Xóa sạch dấu vết**:`
    : `✅ Đã réo <@${targetOptUser.id}> (**${started.total} lần**).\n> 👇 Bấm nút bên dưới nếu muốn **🧹 Xóa sạch dấu vết**:`;
   return await i.editReply({
    content: statusText,
    components: [ctrlRow],
    allowedMentions: { parse: [] },
   });
  }

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
  if (i.commandName === 'stats') {
   const scope = i.options.getString('scope') ?? 'server';
   const embed = buildStatsEmbed(statsStore.getSummary(i.user.id), {
    scope,
    discordUser: i.user,
    botUser: client.user,
   });
   return await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'grab') {
   const cur = p?.queue?.currentTrack;
   if (!cur) return await reply('Hiện chưa phát bài hát nào để bỏ túi về Tin nhắn riêng.');
   await sendGrabDmToUser(i.user, cur, p, i.guild);
   return await reply(`📩 Đã gửi thẻ thông tin & link bài **${cleanText(cur.title, 85)}** về **Tin nhắn riêng (DM)** của bạn!`);
  }

  // Lệnh /webkey: Cấp / Đổi / Thu hồi mã PIN 6 số bí mật để mở khóa Điều khiển nhạc 2 chiều ngay trên Website.
  if (i.commandName === 'webkey') {
   const action = i.options.getString('action') || 'show';
   const ownerUser = isBotOwner(i.user.id);
   if (!ownerUser) {
    if (!p || !p.queue?.currentTrack) {
     throw new Error('Hiện chưa có bài hát nào đang phát — hãy phát nhạc bằng `/play` trước khi lấy mã PIN điều khiển từ xa.');
    }
    await requireSameVoiceChannel(i.guild, i.user.id);
    assertMusicAccess('webkey', i.user.id, p);
   }
   if (action === 'revoke') {
    const hadAny = webRemote.revokePin(i.user.id);
    nowPlayingHub.publish({}, { immediatePush: true });
    return await reply(
     hadAny
      ? '🔒 Đã thu hồi mã PIN và khóa chế độ **Điều khiển từ xa trên Website**.'
      : '🔒 Hiện không có mã PIN điều khiển Website nào đang mở.',
    );
   }
   const issued = webRemote.issueOrGetPin(i.user.id, { rotate: action === 'rotate' });
   nowPlayingHub.publish({}, { immediatePush: true });
   const webUrl = resolveNowPlayingWebUrl();
   const expUnix = Math.floor(issued.expiresAt / 1000);
   const roleBadge = issued.role === 'owner'
    ? '👑 **Quyền Chủ Bot Toàn Năng (24 giờ)**'
    : '🎧 **Quyền DJ Bài Hiện Tại (2 giờ)**';
   const lines = [
    `🔑 **Mã PIN Điều Khiển Website 2 Chiều:** \`${issued.pin}\``,
    `• Cấp độ: ${roleBadge} • Hết hạn: <t:${expUnix}:R>`,
    webUrl ? `• Mở bảng điều khiển: **[Bấm vào đây để mở Website](${webUrl})** -> chọn mục **🎛️ Điều khiển Bot** rồi nhập mã \`${issued.pin}\`!` : '• Mở trang Website của bot -> chọn mục **🎛️ Điều khiển Bot** rồi nhập mã PIN này!',
    '> 🛡️ *Tin nhắn này chỉ mình bạn nhìn thấy. Không chia sẻ mã PIN nếu không muốn người khác đổi bài!*',
   ];
   return await reply(lines.join('\n'));
  }

  // Lệnh /fav: Xem / Lưu / Xóa Tủ nhạc Yêu thích cá nhân (ai cũng tự quản lý tủ riêng của mình được; khi phát vào phòng mới kiểm tra quyền phòng thoại).
  if (i.commandName === 'fav') {
   const action = i.options.getString('action', true);
   if (action === 'list') {
    const list = favoritesStore.getList(i.user.id);
    return await i.editReply({
     embeds: [buildFavoritesEmbed(i.user, list, client.user)],
     allowedMentions: { parse: [] },
    });
   }
   if (action === 'add') {
    const rawQuery = i.options.getString('query')?.trim();
    let targetTrack = null;
    if (rawQuery) {
     const { query: q, spotifyMeta } = await resolveMusicRequest(rawQuery);
     const searchRes = await soundCloudPlugin.search(q, i.user.id).catch(() => null);
     const isDirectScUrl = q.startsWith('https://soundcloud.com/');
     targetTrack = isDirectScUrl
      ? searchRes?.tracks?.[0]
      : pickBestMatchingTrack(searchRes?.tracks ?? [], spotifyMeta ?? { title: q });
     if (!targetTrack) {
      throw new Error('Không tìm thấy bài hát phù hợp để lưu vào Tủ nhạc Yêu thích.');
     }
     if (spotifyMeta?.thumbnail && !targetTrack.thumbnail) targetTrack.thumbnail = spotifyMeta.thumbnail;
    } else {
     targetTrack = p?.queue?.currentTrack ?? null;
     if (!targetTrack) {
      throw new Error('Hiện chưa phát bài nào — hãy nhập tên bài hoặc link vào tham số `query` để lưu bài bất kỳ vào Tủ nhạc Yêu thích.');
     }
    }
    const { added, track: savedItem, total } = favoritesStore.addTrack(i.user.id, targetTrack);
    nowPlayingHub.publish();
    return await reply(
     added
      ? `❤️ Đã lưu **${cleanText(savedItem.title, 85)}** vào **Tủ nhạc Yêu thích** của bạn (**${total}/25** bài)!`
      : `💖 Bài **${cleanText(savedItem.title, 85)}** đã có trong Tủ nhạc Yêu thích của bạn (**${total}/25** bài) — đã cập nhật lên đầu danh sách!`,
    );
   }
   if (action === 'remove') {
    const pos = i.options.getInteger('position');
    if (!pos) throw new Error('Hãy nhập số thứ tự bài muốn xóa ở tham số `position` (xem số thứ tự bằng `/fav action:list`).');
    const { removed, list } = favoritesStore.removeAt(i.user.id, pos);
    nowPlayingHub.publish();
    return await reply(`🗑️ Đã xóa **${cleanText(removed.title, 85)}** khỏi Tủ nhạc Yêu thích (còn **${list.length}/25** bài).`);
   }
   if (action === 'clear') {
    const count = favoritesStore.clearUser(i.user.id);
    if (count === 0) return await reply('Tủ nhạc Yêu thích của bạn hiện đã trống sẵn.');
    nowPlayingHub.publish();
    return await reply(`🗑️ Đã xóa sạch **${count}** bài khỏi Tủ nhạc Yêu thích của bạn.`);
   }
   if (action === 'play' || action === 'shuffle') {
    const favList = favoritesStore.getList(i.user.id);
    if (favList.length === 0) {
     throw new Error('Tủ nhạc Yêu thích của bạn đang trống. Hãy dùng `/fav action:add` để lưu bài hát yêu thích trước nhé!');
    }
    const favChannel = await requireSameVoiceChannel(i.guild, i.user.id);
    assertMusicAccess('play', i.user.id, p);
    const { startedTrack, addedCount } = await enqueueFavoriteTracks({
     guild: i.guild,
     voiceChannel: favChannel,
     textChannel: i.channel,
     favItems: favList,
     userId: i.user.id,
     shuffle: action === 'shuffle',
    });
    const modeNote = action === 'shuffle' ? ' *(đã trộn ngẫu nhiên)*' : '';
    return await reply(
     startedTrack
      ? `💖 Đã nạp **${addedCount}** bài từ Tủ nhạc Yêu thích${modeNote} — đang phát: **${cleanText(startedTrack.title, 85)}**!`
      : `💖 Đã thêm **${addedCount}** bài từ Tủ nhạc Yêu thích${modeNote} vào hàng đợi!`,
    );
   }
  }

  // Lệnh /mixtape: Tủ đĩa Mixtape chung của toàn máy chủ (tối đa 5 tủ * 20 bài, sao lưu đám mây Cloudflare).
  if (i.commandName === 'mixtape') {
   const action = i.options.getString('action', true);
   const rawName = i.options.getString('name')?.trim();

   if (action === 'list') {
    const mixtapes = mixtapeStore.listMixtapes();
    return await i.editReply({
     embeds: [buildMixtapesListEmbed(mixtapes, client.user)],
     allowedMentions: { parse: [] },
    });
   }
   if (!rawName) {
    throw new Error('Hãy nhập tên tủ Mixtape vào tham số `name` (ví dụ: `/mixtape action:add name:Nhạc Đêm Mưa`).');
   }
   if (action === 'view') {
    const found = mixtapeStore.getMixtape(rawName);
    if (!found) throw new Error('Chưa có tủ Mixtape nào mang tên này — gõ `/mixtape action:list` để xem các tủ hiện có.');
    return await i.editReply({
     embeds: [buildMixtapeDetailEmbed(found, client.user)],
     allowedMentions: { parse: [] },
    });
   }
   if (action === 'add') {
    const rawQuery = i.options.getString('query')?.trim();
    let targetTrack = null;
    if (rawQuery) {
     const { query: q, spotifyMeta } = await resolveMusicRequest(rawQuery);
     const searchRes = await soundCloudPlugin.search(q, i.user.id).catch(() => null);
     const isDirectScUrl = q.startsWith('https://soundcloud.com/');
     targetTrack = isDirectScUrl
      ? searchRes?.tracks?.[0]
      : pickBestMatchingTrack(searchRes?.tracks ?? [], spotifyMeta ?? { title: q });
     if (!targetTrack) throw new Error('Không tìm thấy bài hát phù hợp để thêm vào tủ Mixtape.');
     if (spotifyMeta?.thumbnail && !targetTrack.thumbnail) targetTrack.thumbnail = spotifyMeta.thumbnail;
    } else {
     targetTrack = p?.queue?.currentTrack ?? null;
     if (!targetTrack) {
      throw new Error('Hiện chưa phát bài nào — hãy nhập tên bài hoặc link vào tham số `query` để thêm vào tủ Mixtape.');
     }
    }
    const { createdNew, added, mixtape, track: savedItem } = mixtapeStore.addTrack(rawName, targetTrack, i.user.id);
    nowPlayingHub.publish();
    const head = createdNew ? `📼 Đã khai trương tủ Mixtape mới **${mixtape.name}** và thêm` : (added ? '📼 Đã thêm' : '📼 Đã làm mới bài');
    return await reply(`${head} **${cleanText(savedItem.title, 80)}** vào tủ **${mixtape.name}** (**${mixtape.tracks.length}/20** bài)!`);
   }
   if (action === 'remove') {
    const pos = i.options.getInteger('position');
    if (!pos) throw new Error('Hãy nhập số thứ tự bài cần xóa ở tham số `position` (xem bằng `/mixtape action:view`).');
    const { removed, mixtape } = mixtapeStore.removeTrackAt(rawName, pos, i.user.id);
    nowPlayingHub.publish();
    if (!mixtape) {
     return await reply(`🗑️ Đã gỡ bài cuối cùng **${cleanText(removed.title, 80)}** và tự động đóng tủ Mixtape trống.`);
    }
    return await reply(`🗑️ Đã gỡ **${cleanText(removed.title, 80)}** khỏi tủ Mixtape **${mixtape.name}** (còn **${mixtape.tracks.length}/20** bài).`);
   }
   if (action === 'delete') {
    const removed = mixtapeStore.deleteMixtape(rawName, i.user.id);
    nowPlayingHub.publish();
    return await reply(`🗑️ Đã xóa toàn bộ tủ Mixtape **${removed.name}** (**${removed.tracks.length}** bài).`);
   }
   if (action === 'play' || action === 'shuffle') {
    const found = mixtapeStore.getMixtape(rawName);
    if (!found || found.tracks.length === 0) {
     throw new Error('Tủ Mixtape này chưa tồn tại hoặc đang trống — gõ `/mixtape action:list` để kiểm tra.');
    }
    const mixChannel = await requireSameVoiceChannel(i.guild, i.user.id);
    assertMusicAccess('mixtape', i.user.id, p);
    const { startedTrack, addedCount } = await enqueueFavoriteTracks({
     guild: i.guild,
     voiceChannel: mixChannel,
     textChannel: i.channel,
     favItems: found.tracks,
     userId: i.user.id,
     shuffle: action === 'shuffle',
    });
    const modeNote = action === 'shuffle' ? ' *(đã trộn ngẫu nhiên)*' : '';
    return await reply(
     startedTrack
      ? `📼 Đã mở tủ Mixtape **${found.name}** (**${addedCount}** bài)${modeNote} — đang phát: **${cleanText(startedTrack.title, 80)}**!`
      : `📼 Đã nối **${addedCount}** bài từ tủ Mixtape **${found.name}**${modeNote} vào hàng đợi!`,
    );
   }
  }

  const channel = await requireSameVoiceChannel(i.guild, i.user.id);
  // Kiểm tra quyền điều khiển: chỉ người yêu cầu bài đang phát mới được tác động vào nhạc.
  assertMusicAccess(i.commandName, i.user.id, p);

  if (i.commandName === 'join') {
   const alreadyConnected = Boolean(p?.connection);
   const { player: joinedPlayer } = await ensureVoiceSession({ guild: i.guild, voiceChannel: channel, textChannel: i.channel, userId: i.user.id });
   if (joinedPlayer.userdata) joinedPlayer.userdata.ttsOnlyIdle = false;
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

  if (i.commandName === 'tts') {
   const rawText = i.options.getString('text', true);
   const lang = i.options.getString('lang') || 'vi';
   const voiceKey = i.options.getString('voice') || 'normal';
   const voiceMeta = TTS_VOICES[voiceKey] ?? TTS_VOICES.normal;
   const slow = Boolean(i.options.getBoolean('slow'));

   const { buffer, cleanText: spokenText, langLabel } = await synthesizeGoogleTtsBuffer(rawText, {
    lang,
    slow,
    sanitizeOptions: {
     resolveUserName: id => i.guild.members.cache.get(id)?.displayName ?? null,
     resolveChannelName: id => i.guild.channels.cache.get(id)?.name ?? null,
     resolveRoleName: id => i.guild.roles.cache.get(id)?.name ?? null,
    },
   });

   const { player: ttsVoicePlayer, created } = await ensureVoiceSession({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    userId: i.user.id,
   });
   if (created && ttsVoicePlayer.userdata && !ttsVoicePlayer.queue?.currentTrack) {
    ttsVoicePlayer.userdata.ttsOnlyIdle = true;
   }

   const hadMusic = Boolean(
    ttsVoicePlayer.queue?.currentTrack && !ttsVoicePlayer.isPaused && !ttsVoicePlayer.userdata?.voiceMuted,
   );
   const { queued } = await ttsController.enqueueSpeech({
    guildId: i.guildId,
    player: ttsVoicePlayer,
    getPlayer: () => manager.get(i.guildId),
    mp3Buffer: buffer,
    voiceStyle: voiceKey,
   });

   const preview = cleanText(spokenText, 110);
   const styleTag = voiceKey !== 'normal' ? ` • **${voiceMeta.label}**` : '';
   const musicNote = hadMusic ? ' *(tự tạm dừng nhạc & phát tiếp ngay khi đọc xong)*' : '';
   return await reply(
    queued
     ? `🗣️ Đã xếp vào hàng chờ đọc (${langLabel}${styleTag}): "${preview}"`
     : `🗣️ Đang đọc trong <#${channel.id}> (${langLabel}${styleTag}): "${preview}"${musicNote}`,
   );
  }

  if (i.commandName === 'sfx') {
   const effectKey = i.options.getString('effect', true);
   const { buffer, preset } = synthesizeSfxWav(effectKey);

   const { player: sfxVoicePlayer, created } = await ensureVoiceSession({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    userId: i.user.id,
   });
   if (created && sfxVoicePlayer.userdata && !sfxVoicePlayer.queue?.currentTrack) {
    sfxVoicePlayer.userdata.ttsOnlyIdle = true;
   }

   const hadMusic = Boolean(
    sfxVoicePlayer.queue?.currentTrack && !sfxVoicePlayer.isPaused && !sfxVoicePlayer.userdata?.voiceMuted,
   );
   const { queued } = await ttsController.enqueueSpeech({
    guildId: i.guildId,
    player: sfxVoicePlayer,
    getPlayer: () => manager.get(i.guildId),
    mp3Buffer: buffer,
    presetKey: 'flat',
    volume: 1.15,
   });

   const musicNote = hadMusic ? ' *(tự tạm dừng nhạc & phát tiếp ngay sau hiệu ứng)*' : '';
   return await reply(
    queued
     ? `${preset.emoji} Đã xếp hàng chờ hiệu ứng **${preset.label}** trong <#${channel.id}>!`
     : `${preset.emoji} Đang thả hiệu ứng **${preset.label}** trong <#${channel.id}>!${musicNote}`,
   );
  }

  if (i.commandName === 'radio') {
   const stationId = i.options.getString('station', true);
   const { station, firstTrack, totalTracks } = await startRadioStation({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    stationId,
    userId: i.user.id,
   });
   return await reply(
    `${station.emoji} Đã lên sóng **${station.name}** (*${station.description}*) — nạp sẵn **${totalTracks}** bài & tự động bật **AutoPlay xuyên đêm**!\n▶️ Đang phát mở màn: **${cleanText(firstTrack.title, 85)}**`,
   );
  }

  if (i.commandName === 'search') {
   const rawQuery = i.options.getString('query', true).trim();
   const playNext = Boolean(i.options.getBoolean('next'));
   const { query: q } = await resolveMusicRequest(rawQuery);
   const searchRes = await soundCloudPlugin.search(q, i.user.id).catch(() => null);
   const candidates = (searchRes?.tracks ?? [])
    .filter(t => t && !t.isLive && !(Number(t.duration) > 10800000))
    .slice(0, 5);
   if (candidates.length === 0) {
    throw new Error('Không tìm thấy phiên bản bài hát nào khớp từ khóa này.');
   }
   const now = Date.now();
   for (const [k, v] of pendingSearches) {
    if (now > v.expiresAt) pendingSearches.delete(k);
   }
   if (pendingSearches.size >= 25) {
    const oldestKey = pendingSearches.keys().next().value;
    if (oldestKey) pendingSearches.delete(oldestKey);
   }
   const token = `${i.id.slice(-10)}_${Math.random().toString(36).slice(2, 7)}`;
   pendingSearches.set(token, {
    userId: i.user.id,
    guildId: i.guildId,
    playNext,
    tracks: candidates,
    expiresAt: now + 60_000,
   });
   return await i.editReply(buildSearchPickerPayload(
    token,
    candidates,
    rawQuery,
    playNext,
    client.user,
   ));
  }

  if (i.commandName === 'dedicate') {
   const targetUser = i.options.getUser('to', true);
   const rawQuery = i.options.getString('query', true);
   const wishMsg = cleanText(i.options.getString('message') || '', 140);
   const fromMember = i.guild.members.cache.get(i.user.id);
   const toMember = await i.guild.members.fetch(targetUser.id).catch(() => null);
   const dedication = {
    fromId: i.user.id,
    fromName: cleanText(fromMember?.displayName || i.user.globalName || i.user.username, 36),
    toId: targetUser.id,
    toName: cleanText(toMember?.displayName || targetUser.globalName || targetUser.username, 36),
    message: wishMsg === 'Không rõ' ? '' : wishMsg,
   };
   const { track, queued } = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    rawQuery,
    userId: i.user.id,
    playNext: true,
    dedication,
   });
   const wishNote = dedication.message ? `\n💬 Lời nhắn: *"${dedication.message}"*` : '';
   return await reply(
    queued
     ? `💌 Đã xếp ưu tiên món quà âm nhạc **${cleanText(track.title, 80)}** gửi tặng <@${targetUser.id}> (phát ngay kế tiếp)!${wishNote}`
     : `💌 Đang phát ngay món quà âm nhạc **${cleanText(track.title, 80)}** gửi tặng <@${targetUser.id}> — lời nhắn đã hiện lên Khung Nhạc & Website Karaoke!${wishNote}`,
   );
  }

  if (i.commandName === 'play') {
   const { track, queued, insertedNext, collectionName, addedCount } = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    rawQuery: i.options.getString('query', true),
    userId: i.user.id,
    playNext: Boolean(i.options.getBoolean('next')),
   });
   if (collectionName) {
    return await reply(
     queued
      ? `💿 Đã nạp **${addedCount}** bài từ **${cleanText(collectionName, 65)}** vào ${insertedNext ? 'đầu ' : ''}hàng đợi!`
      : `💿 Đã mở **${cleanText(collectionName, 65)}** (**${addedCount}** bài) — đang phát ngay: **${cleanText(track.title, 80)}**!`,
    );
   }
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
   case 'sleeptimer': {
    const minutes = i.options.getInteger('minutes');
    const afterTrack = i.options.getBoolean('after_track');
    const leaveVoice = Boolean(i.options.getBoolean('leave_voice'));

    if (minutes === null && afterTrack === null) {
     const current = sleepTimerManager.getStatus(i.guildId);
     if (!current) {
      return await reply('💤 Hiện chưa đặt hẹn giờ đi ngủ.\n💡 Gõ `/sleeptimer minutes: 30` để tắt sau 30 phút, hoặc `/sleeptimer after_track: True` để tự tắt sau khi hết bài hiện tại.');
     }
     if (current.mode === 'after_track') {
      return await reply('💤 Đang bật hẹn giờ: **Tự tắt nhạc ngay khi kết thúc bài hiện tại** (gõ `/sleeptimer minutes: 0` để hủy).');
     }
     const endUnix = Math.floor((current.endsAtMs ?? Date.now()) / 1000);
     return await reply(`💤 Đang hẹn giờ tắt nhạc đi ngủ: tự tắt <t:${endUnix}:R> (gõ \`/sleeptimer minutes: 0\` để hủy).`);
    }

    if (minutes === 0 || (minutes === null && afterTrack === false)) {
     const cancelled = sleepTimerManager.cancel(i.guildId);
     syncSleepTimerLabel(p);
     schedulePanelUpdate(p);
     return await reply(cancelled ? '⏰ Đã hủy hẹn giờ tắt nhạc đi ngủ.' : '⏰ Hiện không có bộ hẹn giờ đi ngủ nào đang bật.');
    }

    if (afterTrack) {
     if (!p.queue?.currentTrack) {
      throw new Error('Hiện chưa phát bài hát nào để hẹn tắt sau bài hiện tại.');
     }
     sleepTimerManager.setAfterCurrentTrack(i.guildId, { leaveVoice });
     syncSleepTimerLabel(p);
     schedulePanelUpdate(p);
     const leaveNote = leaveVoice || !p.userdata?.stay247
      ? 'rồi tự rời phòng thoại'
      : 'và chuyển sang chờ 24/7';
     return await reply(`💤 Đã bật hẹn giờ đi ngủ: bot sẽ **tự tắt nhạc ngay khi hết bài hiện tại** (${leaveNote}).`);
    }

    const state = sleepTimerManager.setMinutes(i.guildId, minutes, { leaveVoice });
    syncSleepTimerLabel(p);
    schedulePanelUpdate(p);
    const endUnix = Math.floor(state.endsAtMs / 1000);
    const leaveNote = leaveVoice || !p.userdata?.stay247
     ? 'rồi rời kênh thoại'
     : 'và giữ kết nối 24/7';
    return await reply(`💤 Đã hẹn giờ tắt nhạc sau **${state.minutes} phút** (<t:${endUnix}:R>) — bot sẽ tự giảm nhỏ âm lượng êm ái ở 12 giây cuối ${leaveNote}. Chúc bạn ngủ ngon!`);
   }
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
   case 'vibe': {
    const mode = i.options.getString('mode', true);
    const vibeInfo = applyPlayerVibe(p, mode);
    schedulePanelUpdate(p, { vibeMode: mode });
    return await reply(`${vibeInfo.emoji} Đã chuyển Vibe sang **${vibeInfo.label}** (*${vibeInfo.description}*) — biến đổi trực tiếp ngay trên bài đang phát & đồng bộ lên Website!`);
   }
   case 'ambient': {
    const mode = i.options.getString('mode', true);
    const levelOpt = i.options.getInteger('level');
    const { info: ambInfo, levelPercent } = applyPlayerAmbient(p, mode, levelOpt);
    schedulePanelUpdate(p, { ambientMode: mode });
    if (mode === 'off') {
     return await reply('🔇 Đã **tắt** lớp âm thanh thiên nhiên nền.');
    }
    return await reply(`${ambInfo.emoji} Đã hòa trộn nền **${ambInfo.label}** ở mức **${levelPercent}%** (*${ambInfo.description}*) trực tiếp vào nhạc đang phát!`);
   }
   case 'similar': {
    const addedTracks = await enqueueSimilarTracks(p, i.user.id);
    const previewNames = addedTracks.slice(0, 3).map(t => `**${cleanText(t.title, 48)}**`).join(', ');
    const moreNote = addedTracks.length > 3 ? ` và **+${addedTracks.length - 3}** bài nữa` : '';
    return await reply(`🧬 Đã dò sóng và bơm thêm **${addedTracks.length}** bài cùng gu vào hàng đợi: ${previewNames}${moreNote}!`);
   }
   case 'replay': {
    const cur = p.queue.currentTrack;
    if (!cur) throw new Error('Hiện chưa phát bài hát nào để phát lại từ đầu.');
    triggerSmoothTransitionFade(260);
    if (!(await p.seek(0))) throw new Error('Không thể tua lại bài hát lúc này.');
    syncPlayerVibeAnchor(p, p.userdata?.vibeMode ?? 'normal', 0);
    nowPlayingHub.publish({ player: p }, { immediatePush: true });
    schedulePanelUpdate(p);
    return await reply(`⏪ Đã tua bài **${cleanText(cur.title, 85)}** quay lại từ đầu (**0:00**)!`);
   }
   case 'seek': {
    const cur = p.queue.currentTrack;
    if (!cur) throw new Error('Hiện chưa phát bài hát nào để tua.');
    const targetMs = parseSeekTime(i.options.getString('time', true));
    const durationMs = cur.duration > 1000 ? cur.duration : cur.duration * 1000;
    if (durationMs > 0 && targetMs >= durationMs) {
     throw new Error(`Thời gian tua vượt quá độ dài bài hát (${formatDuration(durationMs)}).`);
    }
    triggerSmoothTransitionFade(240);
    if (!(await p.seek(targetMs))) throw new Error('Không thể tua bài hát lúc này.');
    syncPlayerVibeAnchor(p, p.userdata?.vibeMode ?? 'normal', targetMs);
    nowPlayingHub.publish({ player: p }, { immediatePush: true });
    schedulePanelUpdate(p);
    return await reply(`⏩ Đã tua bài hát tới mốc **${formatDuration(targetMs)}**.`);
   }
   case 'previous': {
    if (!p.previousTrack) throw new Error('Không có bài hát trước đó để quay lại.');
    if (!(await p.previous())) throw new Error('Không thể quay lại bài trước.');
    return await reply('⏮️ Đã quay lại bài hát trước đó.');
   }
   case 'pause':
    if (p.userdata) {
     p.userdata.autoPausedByMute = false;
     p.userdata.autoPausedByTts = false;
    }
    p.pause();
    schedulePanelUpdate(p, { paused: true });
    return await reply('Đã tạm dừng phát nhạc.');
   case 'resume':
    if (p.userdata) {
     p.userdata.autoPausedByMute = false;
     p.userdata.autoPausedByTts = false;
    }
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
  spamTagManager.stopAll();
  const activePlayers = manager.getAll();
  sessionStore.flushAllSync(activePlayers);

  const cleanupTargets = [];
  for (const p of activePlayers) {
   clearPanelTimer(p);
   stopProgressTicker(p);
   clearEmptyTimer(p);
   clearWebAudioTimer(p);
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
  channelLockManager.clearAllDmTimers();

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
// Danh sách mã lỗi mạng / luồng âm thanh thoáng qua trên VPS dùng chung: ghi nhận cảnh báo và giữ bot chạy xuyên suốt 24/24 thay vì tự thoát tiến trình.
const RECOVERABLE_RUNTIME_CODES = new Set([
 'ECONNRESET',
 'EPIPE',
 'ETIMEDOUT',
 'ECONNABORTED',
 'EHOSTUNREACH',
 'ENETUNREACH',
 'EAI_AGAIN',
 'ERR_STREAM_PREMATURE_CLOSE',
 'ERR_STREAM_DESTROYED',
 'ERR_STREAM_WRITE_AFTER_END',
 'UND_ERR_CONNECT_TIMEOUT',
 'UND_ERR_HEADERS_TIMEOUT',
 'UND_ERR_BODY_TIMEOUT',
 'UND_ERR_SOCKET',
]);

function isRecoverableRuntimeError(err) {
 if (!err) return true;
 const code = String(err?.code ?? '');
 const name = String(err?.name ?? '');
 if (RECOVERABLE_RUNTIME_CODES.has(code) || RECOVERABLE_RUNTIME_CODES.has(name)) return true;
 if (name === 'AbortError' || name === 'TimeoutError' || name === 'DiscordAPIError' || name === 'HTTPError') {
  return true;
 }
 return false;
}

function fatal(e) { console.error('[lỗi-nghiêm-trọng]', e?.name ?? 'Error', e?.code ?? ''); void shutdown(1); }
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
process.once('SIGHUP', () => shutdown());
// Không tắt bot khi gặp Promise bị từ chối ngầm (nghẽn mạng Discord/CDN thoáng qua trên node dùng chung) để tránh bị khởi động lại oan.
process.on('unhandledRejection', err => {
 console.warn('[bỏ-qua-lỗi-ngầm]', err?.name ?? 'UnhandledRejection', err?.code ?? '');
});
process.on('uncaughtException', err => {
 if (isRecoverableRuntimeError(err)) {
  console.warn('[bỏ-qua-lỗi-mạng]', err?.name ?? 'Error', err?.code ?? '');
  return;
 }
 fatal(err);
});
await client.login(DISCORD_TOKEN).catch(fatal);
