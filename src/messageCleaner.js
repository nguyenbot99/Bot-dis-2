import { Routes } from 'discord.js';
import { IDLE_PANEL_AUTO_DELETE_MS } from './playerGui.js';

const KICK_EMBED_RE = /(Phát hiện bot bị kick|Bot bị kick khỏi phòng liên tiếp)/i;
const VOICE_NOTICE_EMBED_RE = /(Phát hiện bot bị tắt mic|Bot đang bị khóa mic trên Kênh Sân Khấu|Bot đã được mở lại mic|Bot vừa bị chuyển sang kênh AFK)/i;
const ENDED_PANEL_RE = /Phiên phát nhạc đã kết thúc/;
const IDLE_247_PANEL_RE = /Chế độ 24\/7 đang hoạt động/;
const LIVE_PLAYER_PANEL_RE = /player_menu|Bảng chức năng điều khiển nhanh/;
const UNIX_COUNTDOWN_RE = /<t:(\d{9,12}):R>/;

// Trích xuất an toàn cặp (channelId, messageId) từ cả đối tượng Message của discord.js lẫn dữ liệu JSON thô từ Interaction/REST.
export function extractMessageRef(msg, fallbackChannelId = null) {
 if (!msg || typeof msg !== 'object') return null;
 const messageId = typeof msg.id === 'string' && msg.id ? msg.id : null;
 const channelId = msg.channelId
  ?? msg.channel_id
  ?? msg.channel?.id
  ?? fallbackChannelId
  ?? null;
 if (!messageId || !channelId) return null;
 return { channelId: String(channelId), messageId: String(messageId) };
}

// Xóa tin nhắn trực tiếp qua Discord REST API (hoạt động 100% ngay cả khi tắt bộ nhớ đệm MessageManager: 0).
export async function deleteDiscordMessage(rest, msg, fallbackChannelId = null) {
 const ref = extractMessageRef(msg, fallbackChannelId);
 if (ref && typeof rest?.delete === 'function') {
  try {
   await rest.delete(Routes.channelMessage(ref.channelId, ref.messageId));
   return true;
  } catch (err) {
   // 10008 = Unknown Message (tin nhắn đã được xóa trước đó).
   if (err?.code === 10008) return true;
  }
 }
 if (typeof msg?.delete === 'function') {
  try {
   await msg.delete();
   return true;
  } catch (err) {
   if (err?.code === 10008) return true;
  }
 }
 return false;
}

function getSnowflakeTimestampMs(id) {
 try {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
 } catch {
  return 0;
 }
}

// Kiểm tra chính xác một tin nhắn cũ trong kênh có phải thông báo kết thúc / bị kick / khung mồ côi của chính bot cần dọn hay không.
export function isStaleBotNoticeMessage(
 rawMsg,
 {
  botId,
  now = Date.now(),
  activeMessageIds = new Set(),
  pendingKeys = new Set(),
  clearAllKickAlerts = false,
 } = {},
) {
 if (!rawMsg || !botId) return false;
 const authorId = rawMsg.author?.id ?? null;
 if (authorId !== botId) return false;

 const msgId = String(rawMsg.id ?? '');
 if (!msgId || activeMessageIds.has(msgId)) return false;

 const chId = String(rawMsg.channel_id ?? rawMsg.channelId ?? '');
 const key = chId ? `${chId}:${msgId}` : '';
 const isTrackedPending = Boolean(key && pendingKeys.has(key));

 const embedsRaw = Array.isArray(rawMsg.embeds) && rawMsg.embeds.length > 0
  ? JSON.stringify(rawMsg.embeds)
  : '';
 const componentsRaw = Array.isArray(rawMsg.components) && rawMsg.components.length > 0
  ? JSON.stringify(rawMsg.components)
  : '';
 const combined = `${embedsRaw}\n${componentsRaw}`;

 // Nếu tin nhắn có mốc đếm ngược <t:UNIX:R> và mốc đó đã trôi qua -> chắc chắn đã quá hạn, cần xóa ngay.
 const countdownMatch = combined.match(UNIX_COUNTDOWN_RE);
 const countdownExpired = countdownMatch
  ? Number(countdownMatch[1]) * 1000 <= now - 3000
  : false;

 // 1. Thông báo bot bị kick khỏi kênh thoại.
 if (embedsRaw && KICK_EMBED_RE.test(embedsRaw)) {
  if (clearAllKickAlerts) return true;
  if (countdownExpired || !isTrackedPending) return true;
  return false;
 }

 // 2. Các thông báo trạng thái mic / AFK cũ bị mồ côi sau khi phiên đã đóng hoặc quá 4.5 phút.
 if (embedsRaw && VOICE_NOTICE_EMBED_RE.test(embedsRaw)) {
  const createdMs = rawMsg.createdTimestamp
   ?? (Date.parse(rawMsg.timestamp ?? '') || getSnowflakeTimestampMs(msgId));
  if (!isTrackedPending && createdMs > 0 && now - createdMs >= IDLE_PANEL_AUTO_DELETE_MS) {
   return true;
  }
  return countdownExpired;
 }

 // 3. Khung "Phiên phát nhạc đã kết thúc": xóa ngay nếu đã hết đếm ngược hoặc bị mồ côi sau khi bot restart.
 if (componentsRaw && ENDED_PANEL_RE.test(componentsRaw)) {
  if (countdownExpired || !isTrackedPending) return true;
  return false;
 }

 // 4. Khung chờ 24/7 hoặc khung Player cũ bị mồ côi từ tiến trình trước (không nằm trong activeMessageIds).
 if (componentsRaw && (IDLE_247_PANEL_RE.test(componentsRaw) || LIVE_PLAYER_PANEL_RE.test(componentsRaw))) {
  if (countdownExpired || !isTrackedPending) return true;
  return false;
 }

 return false;
}

// Quét nhẹ 25 tin nhắn gần nhất trong một kênh văn bản qua REST để tự thu dọn các khung kết thúc / thông báo kick cũ bị sót lại.
export async function sweepChannelStaleNotices({
 rest,
 channelId,
 botId,
 activeMessageIds = new Set(),
 pendingKeys = new Set(),
 clearAllKickAlerts = false,
 limit = 25,
 now = Date.now(),
} = {}) {
 if (!rest?.get || !rest?.delete || !channelId || !botId) return 0;
 let messages;
 try {
  messages = await rest.get(Routes.channelMessages(String(channelId)), {
   query: new URLSearchParams({ limit: String(Math.min(50, Math.max(5, limit))) }),
  });
 } catch {
  return 0;
 }
 if (!Array.isArray(messages) || !messages.length) return 0;

 let deletedCount = 0;
 for (const msg of messages) {
  if (!msg?.id) continue;
  const msgWithChannel = msg.channel_id ? msg : { ...msg, channel_id: String(channelId) };
  if (
   isStaleBotNoticeMessage(msgWithChannel, {
    botId,
    now,
    activeMessageIds,
    pendingKeys,
    clearAllKickAlerts,
   })
  ) {
   const ok = await deleteDiscordMessage(rest, msgWithChannel, channelId);
   if (ok) deletedCount++;
  }
 }
 return deletedCount;
}
