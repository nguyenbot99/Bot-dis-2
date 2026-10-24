import { EmbedBuilder } from 'discord.js';

export const KICK_WINDOW_MS = 30_000;
export const MAX_RECONNECT_KICKS = 2;

// Phân tích trạng thái thoại của bot (bị tắt mic Server Mute / khóa mic Sân khấu / bị kick khỏi phòng / bị kéo sang kênh AFK).
export function evaluateBotVoiceTransition(oldState, newState, session = {}, options = {}) {
 const now = options.now ?? Date.now();
 const afkChannelId = options.afkChannelId ?? null;

 const oldChannelId = oldState?.channelId ?? null;
 const newChannelId = newState?.channelId ?? null;

 const wasMuted = Boolean(oldState?.serverMute || oldState?.suppress || session.voiceMuted);
 const isMuted = Boolean(newState?.serverMute || newState?.suppress);
 const muteReason = newState?.serverMute
  ? 'server_mute'
  : (newState?.suppress ? 'stage_suppress' : null);

 // 1. Trường hợp bot bị ngắt kết nối khỏi kênh thoại (rời phòng).
 if (oldChannelId && !newChannelId) {
  if (session.manualDisconnect) {
   return { action: 'manual_leave', oldChannelId };
  }

  if (session.stay247) {
   const prevKicks = Array.isArray(session.kickTimestamps) ? session.kickTimestamps : [];
   const recentKicks = prevKicks.filter(ts => now - ts < KICK_WINDOW_MS);
   recentKicks.push(now);
   session.kickTimestamps = recentKicks;

   if (recentKicks.length >= MAX_RECONNECT_KICKS) {
    session.stay247 = false;
    session.voiceMuted = false;
    session.muteReason = null;
    session.autoPausedByMute = false;
    return {
     action: 'kicked_abort_247',
     oldChannelId,
     kickCount: recentKicks.length,
    };
   }

   return {
    action: 'kicked_reconnect_247',
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
 if (!wasMuted && isMuted) {
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
  const shouldResume = Boolean(session.autoPausedByMute && options.isPaused);
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
export function buildVoiceGuardEmbed(event) {
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
       '💡 Hãy chuột phải vào bot trong kênh thoại và bỏ chọn **Tắt mic máy chủ (Server Mute)**.',
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
    ].join('\n'));

  case 'kicked_reconnect_247':
   return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('⚠️ Phát hiện bot bị kick / ngắt kết nối khỏi phòng')
    .setDescription([
     `Bot vừa bị đưa ra khỏi phòng <#${event.oldChannelId}>.`,
     '🌙 Vì chế độ **24/7** đang bật nên bot sẽ thử vào lại sau **3 giây**.',
     '-# Dùng `/leave` hoặc `/247 mode:off` nếu bạn muốn cho bot nghỉ hẳn.',
    ].join('\n'));

  case 'kicked_abort_247':
   return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('👢 Bot bị kick khỏi phòng liên tiếp — Đã tắt 24/7')
    .setDescription([
     `Phát hiện bot bị đưa ra khỏi phòng <#${event.oldChannelId}> nhiều lần liên tiếp.`,
     '🛑 Bot đã **tự tắt chế độ 24/7** và dừng vào lại để tránh làm phiền quản trị viên.',
     event.hasSavedMusic
      ? '💾 Nhạc đang phát & hàng đợi vẫn được lưu tạm — gõ `/join` hoặc `/247` để phát tiếp khi cần.'
      : null,
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
