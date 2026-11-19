import { EmbedBuilder } from 'discord.js';

export const KICK_WINDOW_MS = 30_000;
export const MAX_RECONNECT_KICKS = 2;

// Thông báo mute gửi chậm hơn sự kiện mở mic không được lưu lại trong kênh chat.
export function isMuteNoticeStale(userdata, generation) {
 return !userdata?.voiceMuted || Boolean(userdata.manualDisconnect) || userdata.muteAlertGeneration !== generation;
}

export function invalidateMuteNotice(userdata) {
 if (!userdata) return null;
 userdata.muteAlertGeneration = (userdata.muteAlertGeneration ?? 0) + 1;
 if (userdata.voiceAlertKind !== 'mute') return null;
 const message = userdata.voiceAlertMessage;
 userdata.voiceAlertMessage = null;
 userdata.voiceAlertKind = null;
 return message ?? null;
}
export function shouldAttemptSelfUnmute({ serverMute, channelId, isVoiceChannel, isAfk, canMuteMembers }) {
 return Boolean(serverMute && channelId && isVoiceChannel && !isAfk && canMuteMembers);
}

// Phân tích trạng thái thoại của bot (bị tắt mic Server Mute / khóa mic Sân khấu / bị kick khỏi phòng / bị kéo sang kênh AFK).
export function evaluateBotVoiceTransition(oldState, newState, session = {}, options = {}) {
 const now = options.now ?? Date.now();
 const afkChannelId = options.afkChannelId ?? null;

 const oldChannelId = oldState?.channelId ?? null;
 const newChannelId = newState?.channelId ?? null;

 // Ưu tiên trạng thái thật do Discord gửi; cờ phiên có thể còn sót sau khi
 // chuyển phòng/khôi phục, không được che sự kiện Server Mute mới.
 const wasMuted = Boolean(oldState?.serverMute || oldState?.suppress);
 const isMuted = Boolean(newState?.serverMute || newState?.suppress);
 const muteReason = newState?.serverMute
  ? 'server_mute'
  : (newState?.suppress ? 'stage_suppress' : null);

 // 1. Trường hợp bot bị ngắt kết nối khỏi kênh thoại (rời phòng).
 if (oldChannelId && !newChannelId) {
  if (session.manualDisconnect) {
   return { action: 'manual_leave', oldChannelId };
  }

  if (session.stay247 || options.autoReconnectNormal) {
   const was247 = Boolean(session.stay247);
   const prevKicks = Array.isArray(session.kickTimestamps) ? session.kickTimestamps : [];
   const recentKicks = prevKicks.filter(ts => now >= ts && now - ts < KICK_WINDOW_MS);
   recentKicks.push(now);
   session.kickTimestamps = recentKicks;

   if (recentKicks.length >= MAX_RECONNECT_KICKS) {
    session.stay247 = false;
    session.voiceMuted = false;
    session.muteReason = null;
    session.autoPausedByMute = false;
    return {
     action: was247 ? 'kicked_abort_247' : 'kicked_abort_reconnect',
     oldChannelId,
     kickCount: recentKicks.length,
    };
   }

   return {
    action: was247 ? 'kicked_reconnect_247' : 'kicked_reconnect',
    oldChannelId,
    kickCount: recentKicks.length,
   };
  }

  session.voiceMuted = false;
  session.muteReason = null;
  session.autoPausedByMute = false;
  return {
   action: 'kicked_stop',
   oldChannelId,
  };
 }

 // Nếu vẫn đang ở trong kênh thoại (vừa vào phòng, bị đổi phòng hoặc đổi trạng thái mic).
 if (!newChannelId) {
  return { action: 'none' };
 }

 session.voiceMuted = isMuted;
 session.muteReason = muteReason;

 // 2. Trường hợp bot vừa vào phòng mà đang bị tắt mic sẵn từ trước.
 if (!oldChannelId && newChannelId) {
  if (isMuted) {
   return {
    action: 'joined_muted',
    newChannelId,
    muteReason,
    shouldPause: Boolean(options.isPlaying && !options.isPaused),
   };
  }
  return { action: 'joined', newChannelId };
 }

 // 3. Trường hợp bot bị kéo sang kênh AFK của máy chủ.
 if (oldChannelId && newChannelId !== oldChannelId && afkChannelId && newChannelId === afkChannelId) {
  return {
   action: 'moved_afk',
   oldChannelId,
   newChannelId,
   shouldPause: Boolean(options.isPlaying && !options.isPaused),
  };
 }

 // 4. Trường hợp phát hiện thay đổi trạng thái mic (bị tắt mic hoặc được mở lại mic).
 if (isMuted && (!wasMuted || (options.isPlaying && !options.isPaused) || Boolean(oldState?.serverMute) !== Boolean(newState?.serverMute))) {
  const shouldPause = Boolean(options.isPlaying && !options.isPaused);
  if (shouldPause) session.autoPausedByMute = true;
  return {
   action: 'muted',
   newChannelId,
   muteReason,
   shouldPause,
  };
 }

 if (wasMuted && !isMuted) {
  // PAUSE là RPC bất đồng bộ; sự kiện mở mic có thể đến trước khi isPaused đổi thành true.
  const shouldResume = Boolean(session.autoPausedByMute);
  session.autoPausedByMute = false;
  return {
   action: 'unmuted',
   newChannelId,
   shouldResume,
  };
 }

 // 5. Trường hợp bot được quản trị viên kéo sang một kênh thoại thường khác.
 if (oldChannelId && newChannelId !== oldChannelId) {
  return {
   action: 'moved_channel',
   oldChannelId,
   newChannelId,
  };
 }

 return { action: 'none' };
}

// Dựng khung thông báo Embed tiếng Việt gọn gàng cho từng sự kiện tắt mic / mở mic / bị kick khỏi phòng.
export function buildVoiceGuardEmbed(event, { autoDeleteMs = 270000 } = {}) {
 const deleteAtUnix = autoDeleteMs > 0 ? Math.floor((Date.now() + autoDeleteMs) / 1000) : null;
 const autoCleanLine = deleteAtUnix
  ? `🧹 Thông báo này sẽ tự xóa <t:${deleteAtUnix}:R> (hoặc tự dọn ngay khi gọi bot vào lại).`
  : null;

 switch (event?.action) {
  case 'muted':
  case 'joined_muted': {
   const isStage = event.muteReason === 'stage_suppress';
   const desc = isStage
    ? [
       `🎙️ Bot đang ở kênh sân khấu <#${event.newChannelId}> nhưng **chưa được cấp quyền nói (Suppressed)**.`,
       event.shouldPause ? '⏸️ Đã **tự động tạm dừng nhạc** để không trôi mất bài.' : null,
       '💡 Hãy bấm **Mời lên phát biểu (Invite to Speak)** cho bot để phát nhạc.',
      ].filter(Boolean).join('\n')
    : [
       `🔇 Bot đang bị **Tắt mic máy chủ (Server Mute)** trong kênh <#${event.newChannelId}>.`,
       event.shouldPause ? '⏸️ Đã **tự động tạm dừng nhạc** — khi bạn mở lại mic, bot sẽ tự phát tiếp!' : null,
       event.autoUnmuteAttempted
        ? '🔓 Bot sẽ thử tự mở mic **mỗi 5 giây** khi còn bị Server Mute trong phòng thoại.'
        : event.autoUnmutePermissionMissing
         ? '💡 Muốn bot tự mở mic, hãy cấp quyền **Tắt tiếng thành viên (Mute Members)**; nếu không, nhờ quản trị viên mở mic thủ công.'
         : '💡 Bot không thể tự mở mic tại kênh này; nhờ quản trị viên kiểm tra.',
      ].filter(Boolean).join('\n');
   return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(isStage ? '🔇 Bot đang bị khóa mic trên Kênh Sân Khấu' : '🔇 Phát hiện bot bị tắt mic (Server Mute)')
    .setDescription(desc);
  }

  case 'unmuted':
   return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🔊 Bot đã được mở lại mic')
    .setDescription(
     event.shouldResume
      ? `▶️ Mic tại kênh <#${event.newChannelId}> đã mở lại — bot **tự động tiếp tục phát nhạc**!`
      : `✅ Mic tại kênh <#${event.newChannelId}> đã hoạt động bình thường trở lại.`,
    );

  case 'kicked_stop':
   return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('👢 Phát hiện bot bị kick khỏi kênh thoại')
    .setDescription([
     `Bot vừa bị ngắt kết nối khỏi phòng <#${event.oldChannelId}>.`,
     event.hasSavedMusic
      ? '💾 Đã **lưu lại bài đang phát, mốc thời gian & hàng đợi** (giữ trong 30 phút).'
      : '⏹️ Đã tự động dừng phát nhạc và dọn sạch phiên để tiết kiệm tài nguyên.',
     event.hasSavedMusic
      ? '💡 Gõ `/join` để gọi bot vào lại và **phát tiếp đúng bài nhạc vừa dở**, hoặc `/play` để mở bài mới.'
      : '💡 Gõ `/play` hoặc `/join` bất cứ lúc nào nếu bạn muốn gọi bot vào lại.',
     autoCleanLine,
    ].filter(Boolean).join('\n'));

  case 'kicked_reconnect':
  case 'kicked_reconnect_247':
   return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('⚠️ Bot bị ngắt kết nối khỏi phòng thoại')
    .setDescription([
     `Bot vừa rời phòng <#${event.oldChannelId}>; sẽ **thử vào lại một lần sau 3 giây**.`,
     event.hasSavedMusic ? '💾 Đã lưu bài, mốc đang phát và hàng đợi để thử khôi phục.' : null,
     '🛑 Nếu bot tiếp tục bị kick trong 30 giây, bot sẽ dừng tự vào lại để tôn trọng quản trị viên.',
    ].filter(Boolean).join('\n'));

  case 'kicked_abort_reconnect':
  case 'kicked_abort_247':
   return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('👢 Bot bị kick liên tiếp — Đã dừng tự vào lại')
    .setDescription([
     `Phát hiện bot bị đưa ra khỏi phòng <#${event.oldChannelId}> nhiều lần trong 30 giây.`,
     event.action === 'kicked_abort_247' ? '🛑 Đã tắt chế độ 24/7.' : null,
     '🛑 Bot sẽ không tiếp tục tự vào lại để tránh làm phiền quản trị viên.',
     event.hasSavedMusic
      ? '💾 Nhạc & hàng đợi được giữ tạm; dùng `/join` để thử phát tiếp khi được phép.'
      : null,
     autoCleanLine,
    ].filter(Boolean).join('\n'));

  case 'moved_afk':
   return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('💤 Bot vừa bị chuyển sang kênh AFK')
    .setDescription([
     `Bot vừa được kéo từ <#${event.oldChannelId}> sang kênh nghỉ AFK <#${event.newChannelId}>.`,
     event.shouldPause ? '⏸️ Đã tự động tạm dừng nhạc.' : null,
    ].filter(Boolean).join('\n'));

  default:
   return null;
 }
}
