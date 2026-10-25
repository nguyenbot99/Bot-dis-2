import { PermissionFlagsBits, Routes } from 'discord.js';
import { cleanText } from './playerGui.js';

export const VOICE_STATUS_MIN_INTERVAL_MS = 4500;
export const VOICE_STATUS_MAX_LENGTH = 280;
const PERM_DENIED_BACKOFF_MS = 5 * 60 * 1000;

// Định dạng dòng trạng thái hiển thị ngay bên dưới tên Kênh Thoại trên Discord theo bài hát đang phát.
export function formatVoiceRoomStatus({ track = null, paused = false, voiceMuted = false } = {}) {
 if (!track || typeof track !== 'object') return '';
 const rawTitle = cleanText(track.title ?? '', 140);
 if (!rawTitle) return '';

 const rawAuthor = cleanText(track.metadata?.author ?? '', 65);
 const hasMeaningfulAuthor = Boolean(
  rawAuthor &&
   !/^(unknown|không rõ|nghệ sĩ|soundcloud|youtube)$/i.test(rawAuthor) &&
   !rawTitle.toLowerCase().includes(rawAuthor.toLowerCase()),
 );

 const songText = hasMeaningfulAuthor ? `${rawTitle} • ${rawAuthor}` : rawTitle;
 const prefix = paused || voiceMuted ? '⏸️ ' : '🎵 ';
 const full = `${prefix}${songText}`;
 return full.length > VOICE_STATUS_MAX_LENGTH
  ? `${full.slice(0, VOICE_STATUS_MAX_LENGTH - 1).trimEnd()}…`
  : full;
}

// Bộ đồng bộ trạng thái Kênh Thoại chống chạm giới hạn rate-limit Discord (tự gộp cập nhật & tự dọn sạch khi hết nhạc/rời phòng).
export function createVoiceRoomStatusSync({
 rest,
 client,
 minIntervalMs = VOICE_STATUS_MIN_INTERVAL_MS,
 nowFn = () => Date.now(),
 logger = console,
} = {}) {
 const channels = new Map();
 const warnedMissingPerm = new Set();

 function getEntry(channelId) {
  const key = String(channelId);
  let entry = channels.get(key);
  if (!entry) {
   if (channels.size >= 30) {
    const oldestKey = channels.keys().next().value;
    const oldest = channels.get(oldestKey);
    if (oldest?.timer) clearTimeout(oldest.timer);
    channels.delete(oldestKey);
   }
   entry = {
    appliedStatus: '',
    desiredStatus: '',
    lastSentAt: 0,
    permBlockedUntil: 0,
    timer: null,
    inFlight: false,
    botManaged: false,
   };
   channels.set(key, entry);
  }
  return entry;
 }

 function warnMissingPermissionOnce(channelId, channelName = '') {
  const key = String(channelId);
  if (warnedMissingPerm.has(key)) return;
  if (warnedMissingPerm.size >= 30) warnedMissingPerm.clear();
  warnedMissingPerm.add(key);
  const label = channelName ? `"${channelName}"` : key;
  logger?.warn?.(
   `[trạng-thái-phòng] Bot thiếu quyền "Đặt trạng thái kênh thoại" (Set Voice Channel Status) tại kênh ${label} — hãy bật quyền này nếu muốn hiện tên bài hát lên phòng thoại.`,
  );
 }

 function hasChannelStatusPermission(guildId, channelId) {
  if (!guildId || !client?.guilds?.cache) return true;
  const guild = client.guilds.cache.get(String(guildId));
  const channel = guild?.channels?.cache?.get(String(channelId));
  const me = guild?.members?.me;
  if (!channel || !me || typeof channel.permissionsFor !== 'function') return true;
  const perms = channel.permissionsFor(me);
  if (!perms) return true;
  if (PermissionFlagsBits.SetVoiceChannelStatus && !perms.has(PermissionFlagsBits.SetVoiceChannelStatus)) {
   warnMissingPermissionOnce(channelId, channel.name);
   return false;
  }
  return true;
 }

 async function putVoiceStatus(channelId, statusText, guildId = null, { suppressPermWarn = false } = {}) {
  if (!rest?.put || !channelId) return false;
  const entry = getEntry(channelId);
  const now = nowFn();
  if (entry.permBlockedUntil > now) return false;
  if (!suppressPermWarn && !hasChannelStatusPermission(guildId, channelId)) {
   entry.permBlockedUntil = now + PERM_DENIED_BACKOFF_MS;
   return false;
  }
  if (entry.appliedStatus === statusText) return true;

  const attemptedStatus = statusText;
  entry.inFlight = true;
  entry.lastSentAt = now;
  try {
   await rest.put(Routes.channelVoiceStatus(String(channelId)), {
    body: { status: attemptedStatus },
   });
   entry.appliedStatus = attemptedStatus;
   entry.permBlockedUntil = 0;
   entry.botManaged = Boolean(attemptedStatus);
   return true;
  } catch (err) {
   const code = err?.code ?? err?.status;
   if (code === 50013 || code === 50001 || code === 403) {
    entry.permBlockedUntil = nowFn() + PERM_DENIED_BACKOFF_MS;
    if (!suppressPermWarn) warnMissingPermissionOnce(channelId);
    return false;
   }
   // Nếu tên bài hát vô tình vướng bộ lọc từ ngữ AutoMod của máy chủ (mã 200000 / HTTP 400), đặt nhãn trung tính an toàn.
   if (attemptedStatus && (code === 200000 || err?.status === 400)) {
    const safeFallback = attemptedStatus.startsWith('⏸️') ? '⏸️ Đang tạm dừng nhạc' : '🎵 Đang phát nhạc';
    if (safeFallback !== attemptedStatus) {
     try {
      await rest.put(Routes.channelVoiceStatus(String(channelId)), {
       body: { status: safeFallback },
      });
      entry.appliedStatus = attemptedStatus;
      entry.botManaged = true;
      return true;
     } catch {}
    }
   }
   return false;
  } finally {
   entry.inFlight = false;
   // Chỉ đẩy tiếp nếu trong lúc đang gửi có một trạng thái MỚI KHÁC nữa vừa được yêu cầu.
   if (entry.desiredStatus !== attemptedStatus && entry.desiredStatus !== entry.appliedStatus && !entry.timer && entry.permBlockedUntil <= nowFn()) {
    scheduleFlush(channelId, guildId);
   }
  }
 }

 function scheduleFlush(channelId, guildId = null) {
  const entry = getEntry(channelId);
  if (entry.timer || entry.inFlight) return;
  if (entry.desiredStatus === entry.appliedStatus) return;
  if (entry.permBlockedUntil > nowFn()) return;

  const elapsed = nowFn() - entry.lastSentAt;
  const waitMs = Math.max(0, minIntervalMs - elapsed);
  if (waitMs === 0) {
   void putVoiceStatus(channelId, entry.desiredStatus, guildId);
   return;
  }
  entry.timer = setTimeout(() => {
   entry.timer = null;
   if (entry.desiredStatus !== entry.appliedStatus) {
    void putVoiceStatus(channelId, entry.desiredStatus, guildId);
   }
  }, waitMs);
  entry.timer.unref?.();
 }

 function setChannelStatus(channelId, statusText, guildId = null) {
  if (!channelId) return;
  const normalized = String(statusText ?? '').trim();
  const entry = getEntry(channelId);
  if (!normalized && !entry.botManaged && !entry.appliedStatus) {
   entry.desiredStatus = '';
   if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
   }
   return;
  }
  entry.desiredStatus = normalized;
  if (entry.timer && normalized === entry.appliedStatus) {
   clearTimeout(entry.timer);
   entry.timer = null;
   return;
  }
  scheduleFlush(channelId, guildId);
 }

 // Xóa ngay lập tức trạng thái bài hát trên kênh thoại (gọi TRƯỚC khi bot ngắt kết nối khỏi phòng để không cần quyền ManageChannels).
 async function clearChannelNow(channelId, guildId = null, { suppressPermWarn = false, timeoutMs = 1200 } = {}) {
  if (!channelId) return false;
  const key = String(channelId);
  const entry = channels.get(key);
  if (entry?.timer) {
   clearTimeout(entry.timer);
   entry.timer = null;
  }
  if (!entry || (!entry.botManaged && !entry.appliedStatus)) return true;
  entry.desiredStatus = '';
  return Promise.race([
   putVoiceStatus(key, '', guildId, { suppressPermWarn }),
   new Promise(r => setTimeout(() => r(false), timeoutMs)),
  ]);
 }

 async function clearAllNow({ timeoutMs = 1200 } = {}) {
  const tasks = [];
  for (const [channelId, entry] of channels.entries()) {
   if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
   }
   if (entry.botManaged || entry.appliedStatus) {
    entry.desiredStatus = '';
    tasks.push(putVoiceStatus(channelId, '', null, { suppressPermWarn: true }));
   }
  }
  if (!tasks.length) return;
  await Promise.race([
   Promise.allSettled(tasks),
   new Promise(r => setTimeout(r, timeoutMs)),
  ]);
 }

 function syncPlayer(player, overrides = {}) {
  const channelId = overrides.voiceChannelId ?? player?.userdata?.voiceChannelId;
  if (!channelId) return;
  const hasTrackOverride = Object.prototype.hasOwnProperty.call(overrides, 'track');
  const track = hasTrackOverride
   ? overrides.track
   : (player?.queue?.currentTrack ?? player?.currentTrack ?? null);
  const paused = overrides.paused ?? Boolean(player?.isPaused);
  const voiceMuted = overrides.voiceMuted ?? Boolean(player?.userdata?.voiceMuted);
  const nextStatus = formatVoiceRoomStatus({ track, paused, voiceMuted });
  setChannelStatus(channelId, nextStatus, player?.guildId ?? null);
 }

 function handleRoomMove(oldChannelId, newChannelId, player) {
  if (oldChannelId && oldChannelId !== newChannelId) {
   void clearChannelNow(oldChannelId, player?.guildId ?? null, { suppressPermWarn: true });
  }
  if (newChannelId && player && !player.destroyed) {
   syncPlayer(player, { voiceChannelId: newChannelId });
  }
 }

 return {
  setChannelStatus,
  syncPlayer,
  clearChannelNow,
  clearAllNow,
  handleRoomMove,
 };
}
