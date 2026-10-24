import 'dotenv/config';
import express from 'express';
import { Client, Events, GatewayIntentBits, MessageFlags, Options, PermissionFlagsBits, Routes } from 'discord.js';
import { PlayerManager } from 'ziplayer';
import ffmpeg from 'ffmpeg-static';
import { parseSeekTime, pickBestMatchingTrack, resolveConfig, resolveMusicRequest } from './src/policy.js';
import { getNextSoundPreset, installAudioEnhancer, setAudioEnhancement, SOUND_PRESETS } from './src/audioEnhancer.js';
import { assertMusicAccess, isBotOwner, resolveHumanRequester } from './src/access.js';
import { fetchTrackLyrics, sanitizeLyricsTitle } from './src/lyrics.js';
import { createNowPlayingHub } from './src/nowPlayingHub.js';
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
 cleanText,
 formatDuration,
 LOOP_LABELS,
 renderSyncedProgress,
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

// Trung tâm Website "Now Playing" (giao diện kiểu Ziji V10 + SSE thời gian thực + tùy chọn đẩy dữ liệu ra Cloudflare Worker ngoài).
const nowPlayingHub = createNowPlayingHub({
 getPlayer: () => manager.getAll()[0] ?? null,
 client,
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
const PROGRESS_TICK_MS = 5000; // Chu kỳ cập nhật thanh tiến trình (5 giây/lần: chuẩn mượt, không bao giờ chạm giới hạn rate-limit Discord).
const KNOWN_ERROR_RE = /^(Hãy|Bạn|Bot|Chờ|Chỉ|Hàng|Không|Chưa|Tên|URL|Lệnh|Bản|Link|Thời|Số|Định|Vị)/;

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

function markPanelTouched(player, overrides = {}) {
 const ud = player?.userdata;
 if (ud) {
  ud.lastPanelEditAt = Date.now();
  ud.lastProgressText = renderSyncedProgress(player).barText;
 }
 if (player && !player.destroyed) nowPlayingHub.publish({ player, ...overrides });
}

// Kiểm tra trong kênh thoại có ít nhất 1 người nghe thật (để không tốn API cập nhật thanh nhạc khi phòng trống).
function hasHumanListener(player) {
 const guild = client.guilds.cache.get(player?.guildId);
 const channelId = player?.userdata?.voiceChannelId ?? guild?.members?.me?.voice?.channelId;
 if (!guild || !channelId) return true;
 const ch = guild.channels.cache.get(channelId);
 if (!ch?.members) return true;
 return ch.members.some(m => !m.user?.bot);
}

function clearEmptyTimer(player) {
 if (player?.userdata?.emptyTimer) {
  clearTimeout(player.userdata.emptyTimer);
  player.userdata.emptyTimer = null;
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
 const oldMsg = ud.panelMessage;
 ud.panelMessage = null;
 if (oldMsg) oldMsg.delete().catch(() => {});
 if (!ud.textChannel?.send) return;
 try {
  const sent = await ud.textChannel.send(buildPlayerPayload(player, { track }));
  if (player.destroyed || ud.ending || ud.manualDisconnect) {
   sent.edit(buildEndedPayload()).catch(() => {});
   return;
  }
  ud.panelMessage = sent;
  markPanelTouched(player);
  if (!player.isPaused) startProgressTicker(player);
 } catch (e) {
  console.warn('[khung-nhạc] Không thể gửi khung điều khiển vào kênh chat (kiểm tra quyền Gửi tin nhắn):', e?.code ?? e?.name ?? 'Lỗi');
 }
}

// Gom các thay đổi liên tiếp (âm lượng, lặp, 24/7, hàng đợi, tạm dừng, tua nhạc) để cập nhật khung điều khiển & Website mượt mà.
function schedulePanelUpdate(player, overrides = {}) {
 if (player && !player.destroyed) nowPlayingHub.publish({ player, ...overrides });
 const ud = player?.userdata;
 if (!ud || player.destroyed || ud.ending || !ud.panelMessage) return;
 clearPanelTimer(player);
 ud.panelTimer = setTimeout(() => {
  ud.panelTimer = null;
  void editPanelSafely(player, overrides);
 }, 250);
 ud.panelTimer.unref?.();
}

// Đóng khung điều khiển của bài hiện tại (hoặc chuyển sang khung chờ 24/7 nếu đang bật 24/7).
async function closeCurrentPanel(player, reason, { keepIdle247 = false } = {}) {
 const ud = player?.userdata;
 if (!ud) return;
 ud.ending = true;
 clearPanelTimer(player);
 stopProgressTicker(player);
 const shouldKeepIdle = keepIdle247 && ud.stay247 && !ud.manualDisconnect;
 nowPlayingHub.publish({
  player: shouldKeepIdle ? player : null,
  track: null,
  reason,
 });
 const payload = shouldKeepIdle
  ? buildIdle247Payload(player, reason)
  : buildEndedPayload(reason);
 const msg = ud.panelMessage;
 if (shouldKeepIdle) {
  if (msg) {
   await msg.edit(payload).catch(() => {});
   return;
  }
  if (ud.textChannel?.send) {
   ud.panelMessage = await ud.textChannel.send(payload).catch(() => null);
  }
  return;
 }
 ud.panelMessage = null;
 if (msg) await msg.edit(payload).catch(() => {});
}

// Gửi hoặc cập nhật thông báo trạng thái mic / kick khỏi phòng gọn gàng (chống spam kênh chat).
async function sendVoiceGuardAlert(textChannel, userdata, event) {
 const embed = buildVoiceGuardEmbed(event);
 if (!embed || !textChannel?.send) return;
 const payload = { embeds: [embed], allowedMentions: { parse: [] } };

 // Khi mở lại mic, ưu tiên sửa đè ngay lên khung báo tắt mic trước đó để kênh chat luôn sạch sẽ.
 if (event.action === 'unmuted' && userdata?.voiceAlertMessage) {
  const edited = await userdata.voiceAlertMessage.edit(payload).catch(() => null);
  if (edited) return;
 }

 const isKickEvent = String(event.action).startsWith('kicked_');
 const now = Date.now();
 if (!isKickEvent && userdata && now - (userdata.lastVoiceAlertAt ?? 0) < 3000) return;
 if (userdata) {
  userdata.lastVoiceAlertAt = now;
  if (userdata.voiceAlertMessage) {
   userdata.voiceAlertMessage.delete().catch(() => {});
   userdata.voiceAlertMessage = null;
  }
 }
 const sent = await textChannel.send(payload).catch(() => null);
 if (userdata && sent && !isKickEvent) userdata.voiceAlertMessage = sent;
}

// Đóng toàn bộ phiên phát, xóa mọi bộ hẹn giờ/tham chiếu và cho bot rời khỏi kênh thoại.
async function destroyPlayerSession(guildId, reason) {
 const p = manager.get(guildId);
 if (!p) {
  nowPlayingHub.publish({ player: null, track: null, reason });
  return;
 }
 const ud = p.userdata;
 if (ud) {
  ud.manualDisconnect = true;
  ud.stay247 = false;
  ud.voiceAlertMessage = null;
  stopProgressTicker(p);
  clearEmptyTimer(p);
  await closeCurrentPanel(p, reason);
  ud.textChannel = null;
 }
 manager.delete(guildId);
 nowPlayingHub.publish({ player: null, track: null, reason });
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
 nowPlayingHub.publish({ player, track, paused: Boolean(player?.isPaused) });
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
  setAudioEnhancement({
   preset: p.userdata?.soundPreset ?? 'hd',
   channelBitrate: voiceChannel.bitrate,
  });
  if (!p.connection) await p.connect(voiceChannel);
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
 const guild = newState.guild ?? oldState.guild;
 const p = manager.get(guild.id);
 if (!p || p.destroyed || !p.userdata) return;

 // Trường hợp trạng thái thoại của chính bot thay đổi (vào phòng, bị tắt/mở mic, bị kéo phòng hoặc bị kick).
 if ((newState.id ?? oldState.id) === client.user?.id) {
  const ev = evaluateBotVoiceTransition(oldState, newState, p.userdata, {
   afkChannelId: guild.afkChannelId,
   isPlaying: Boolean(p.isPlaying || p.queue?.currentTrack),
   isPaused: Boolean(p.isPaused),
  });

  if (ev.action === 'manual_leave') return;

  if (ev.action === 'kicked_stop') {
   const alertChannel = p.userdata.textChannel;
   void destroyPlayerSession(guild.id, `👢 Bot đã bị kick (ngắt kết nối) khỏi kênh thoại <#${ev.oldChannelId}>.`);
   void sendVoiceGuardAlert(alertChannel, null, ev);
   return;
  }

  if (ev.action === 'kicked_abort_247') {
   const alertChannel = p.userdata.textChannel;
   void destroyPlayerSession(
    guild.id,
    `👢 Phát hiện bot bị kick khỏi kênh <#${ev.oldChannelId}> liên tiếp — đã tự tắt 24/7 và rời phòng.`,
   );
   void sendVoiceGuardAlert(alertChannel, null, ev);
   return;
  }

  if (ev.action === 'kicked_reconnect_247') {
   void sendVoiceGuardAlert(p.userdata.textChannel, p.userdata, ev);
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
   p.userdata.voiceChannelId = newState.channelId;
   if (newState.channel?.bitrate) setAudioEnhancement({ channelBitrate: newState.channel.bitrate });
  }

  if (ev.action === 'muted' || ev.action === 'joined_muted') {
   if (ev.muteReason === 'stage_suppress') {
    newState.setSuppressed?.(false).catch(() => newState.requestToSpeak?.().catch(() => {}));
   }
   if (ev.shouldPause && !p.isPaused) p.pause();
   if (p.userdata.idleOpen && !p.queue?.currentTrack) {
    void closeCurrentPanel(p, undefined, { keepIdle247: true });
   } else {
    schedulePanelUpdate(p, { paused: Boolean(p.isPaused), voiceMuted: true, muteReason: ev.muteReason });
   }
   void sendVoiceGuardAlert(p.userdata.textChannel, p.userdata, ev);
   return;
  }

  if (ev.action === 'unmuted') {
   if (ev.shouldResume && p.isPaused) p.resume();
   if (p.userdata.idleOpen && !p.queue?.currentTrack) {
    void closeCurrentPanel(p, undefined, { keepIdle247: true });
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

client.once(Events.ClientReady, async c => {
 console.log(`[khởi-động] Đã đăng nhập: ${c.user.tag}`);
 nowPlayingHub.publish();
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
  if (!p || !p.queue.currentTrack) return void await i.update(buildEndedPayload());
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

 // Tất cả các nút & mục menu thay đổi nhạc còn lại: bắt buộc cùng kênh thoại và là chủ bài đang phát.
 if (!p) {
  if (i.isButton() || i.isStringSelectMenu()) return void await i.update(buildEndedPayload());
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
     if (p.userdata) {
      p.userdata.manualDisconnect = true;
      p.userdata.stay247 = false;
      p.userdata.ending = true;
      clearPanelTimer(p);
      stopProgressTicker(p);
      clearEmptyTimer(p);
      p.userdata.panelMessage = null;
      p.userdata.textChannel = null;
     }
     await i.update(buildEndedPayload('Đã tắt chế độ 24/7 và rời khỏi kênh thoại.'));
     manager.delete(i.guildId);
     return;
    }
    case 'player_stop': {
     if (p.userdata?.stay247) {
      p.userdata.ending = true;
      p.userdata.idleOpen = true;
      p.userdata.skipNextStopEvent = true;
      clearPanelTimer(p);
      stopProgressTicker(p);
      p.queue.reset();
      p.stop();
      p.clearLeaveTimeout?.();
      await i.update(buildIdle247Payload(p, 'Đã dừng phát nhạc và xóa hàng đợi — Bot vẫn đang giữ kết nối 24/7.'));
      return;
     }
     if (p.userdata) {
      p.userdata.manualDisconnect = true;
      p.userdata.ending = true;
      clearPanelTimer(p);
      stopProgressTicker(p);
      clearEmptyTimer(p);
      p.userdata.panelMessage = null;
      p.userdata.textChannel = null;
     }
     await i.update(buildEndedPayload('Đã dừng phát nhạc, xóa hàng đợi và rời kênh thoại.'));
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
    case 'cycle_sound': {
     const nextPreset = getNextSoundPreset(p.userdata?.soundPreset ?? 'hd');
     if (p.userdata) p.userdata.soundPreset = nextPreset;
     setAudioEnhancement({ preset: nextPreset });
     markPanelTouched(p);
     await i.update(buildPlayerPayload(p, { soundPreset: nextPreset }));
     const presetInfo = SOUND_PRESETS[nextPreset];
     await i.followUp({
      content: `🎧 Đã chuyển chất âm sang **${presetInfo.label}** (*${presetInfo.description}*) — sẽ áp dụng mượt từ bài kế tiếp để không ngắt nhạc đang phát.`,
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
     const target = i.values[0] === 'vol_100' ? 100 : Math.min(100, Math.max(0, p.volume + (i.values[0] === 'vol_up' ? 20 : -20)));
     if (!p.setVolume(target)) throw new Error('Không thể chỉnh âm lượng lúc này.');
     clearPanelTimer(p);
     markPanelTouched(p);
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
   nowPlayingHub.publish({ player: joinedPlayer });
   return await reply(alreadyConnected ? `✅ Bot đang ở sẵn trong kênh thoại <#${channel.id}>.` : `✅ Đã tham gia kênh thoại <#${channel.id}>. Dùng \`/play\` để phát nhạc hoặc \`/247\` để giữ bot ở lại 24/7.`);
  }

  if (i.commandName === '247') {
   const chosen = i.options.getString('mode');
   if (!p) {
    if (chosen === 'off') return await reply('Chế độ 24/7 hiện đang tắt (bot chưa ở trong kênh thoại).');
    const { player: createdPlayer } = await ensureVoiceSession({ guild: i.guild, voiceChannel: channel, textChannel: i.channel, userId: i.user.id, initial247: true });
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
    const percent = i.options.getInteger('percent', true);
    if (percent < 0 || percent > 100) throw new Error('Lệnh âm lượng chỉ nhận 0–100.');
    if (!p.setVolume(percent)) throw new Error('Không thể chỉnh âm lượng lúc này.');
    schedulePanelUpdate(p, { volume: percent });
    return await reply(`Đã đặt âm lượng: ${percent}%.`);
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

// Dọn dẹp tài nguyên phát nhạc, kết nối Discord và cổng HTTP khi tắt tiến trình.
async function shutdown(code = 0) {
 if (closing) return; closing = true;
 const timer = setTimeout(() => process.exit(code || 1), 5000); timer.unref();
 try {
  for (const p of manager.getAll()) {
   clearPanelTimer(p);
   stopProgressTicker(p);
   clearEmptyTimer(p);
  }
  manager.destroy();
  client.destroy();
  nowPlayingHub.close();
  server.close(() => process.exit(code));
 } catch { process.exit(1); }
}
function fatal(e) { console.error('[lỗi-nghiêm-trọng]', e?.name ?? 'Error'); void shutdown(1); }
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
process.on('unhandledRejection', fatal);
process.on('uncaughtException', fatal);
await client.login(DISCORD_TOKEN).catch(fatal);
