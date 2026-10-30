import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Routes } from 'discord.js';
import { isBotOwner } from './access.js';
import { cleanText } from './playerGui.js';

export const MIN_SPAM_COUNT = 1;
export const MAX_SPAM_COUNT = 30;
export const DEFAULT_SPAM_COUNT = 10;
export const MIN_SPAM_INTERVAL_SEC = 2;
export const MAX_SPAM_INTERVAL_SEC = 10;
export const DEFAULT_SPAM_INTERVAL_MS = 2300; // Nhịp 2.3s/tin: nhảy thông báo đỏ liên tục mà an toàn 100% trước giới hạn 5 tin/5s của Discord
const MAX_HISTORY_IDS_PER_CHANNEL = 150;

const FUNNY_WAKEUP_TEMPLATES = [
 '🔔 Ê {mention} dậy lẹ vào kênh thoại anh em đang chờ kìa!',
 '📢 Alo alo {mention} nghe rõ trả lời!!',
 '🚨 Triệu hồi khẩn cấp {mention} hiện hồn ngay!',
 '🥁 {mention} ơiii vào phòng lẹ kẻo lỡ kèo bây giờ!',
 '⚡ Tìm đồng đội lạc {mention}, có mặt gấp nhé!',
];

export function buildSpamControlRow(channelId, { running = true, trackedCount = 0 } = {}) {
 const ch = String(channelId);
 const buttons = [];
 if (running) {
  buttons.push(
   new ButtonBuilder()
    .setCustomId(`spamtag_stop:${ch}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Dừng réo')
    .setEmoji('🛑'),
  );
 }
 const cleanLabel = running
  ? 'Dừng & Xóa sạch'
  : (trackedCount > 0 ? `Xóa sạch dấu vết (${trackedCount} tin)` : 'Xóa sạch dấu vết');
 buttons.push(
  new ButtonBuilder()
   .setCustomId(`spamtag_clean:${ch}`)
   .setStyle(ButtonStyle.Danger)
   .setLabel(cleanLabel)
   .setEmoji('🧹'),
 );
 return new ActionRowBuilder().addComponents(buttons);
}

// Bộ quản lý Réo tên (@tag liên tục) siêu nhẹ (~0 MB RAM), chỉ dành riêng cho Chủ Bot, hỗ trợ Dừng tức thì & Xóa sạch dấu vết.
export function createSpamTagManager({
 rest,
 env = process.env,
 intervalOverrideMs = null,
} = {}) {
 const activeLoops = new Map(); // channelId -> { timer, targetUserId, customMessage, total, sent, running, cancelled }
 const sentHistory = new Map(); // channelId -> string[] (danh sách messageId đã gửi để xóa sạch bất cứ lúc nào)

 function recordMessageId(channelId, msgId) {
  if (!channelId || !msgId) return;
  const ch = String(channelId);
  let list = sentHistory.get(ch);
  if (!list) {
   list = [];
   if (sentHistory.size >= 20) {
    const oldestKey = sentHistory.keys().next().value;
    if (oldestKey) sentHistory.delete(oldestKey);
   }
   sentHistory.set(ch, list);
  }
  list.push(String(msgId));
  if (list.length > MAX_HISTORY_IDS_PER_CHANNEL) {
   list.splice(0, list.length - MAX_HISTORY_IDS_PER_CHANNEL);
  }
 }

 function getTrackedCount(channelId) {
  return sentHistory.get(String(channelId))?.length ?? 0;
 }

 function isRunning(channelId) {
  return Boolean(activeLoops.get(String(channelId))?.running);
 }

 function assertOwner(userId) {
  if (!isBotOwner(userId, env)) {
   throw new Error('Chỉ Chủ Bot mới có quyền bật, tắt hoặc xóa tin nhắn réo tên (@tag).');
  }
 }

 function stopChannel(channelId) {
  const ch = String(channelId);
  const state = activeLoops.get(ch);
  if (!state) return { wasRunning: false, sent: 0, trackedCount: getTrackedCount(ch) };
  state.cancelled = true;
  state.running = false;
  if (state.timer) {
   clearTimeout(state.timer);
   state.timer = null;
  }
  activeLoops.delete(ch);
  return {
   wasRunning: true,
   sent: state.sent,
   total: state.total,
   targetUserId: state.targetUserId,
   trackedCount: getTrackedCount(ch),
  };
 }

 async function deleteSingleMessageSafe(channelId, messageId) {
  try {
   await rest.delete(Routes.channelMessage(String(channelId), String(messageId)));
   return true;
  } catch (err) {
   if (err?.status === 404 || err?.code === 10008) return true;
   return false;
  }
 }

 // Dừng ngay lập tức (nếu đang chạy) và xóa sạch toàn bộ các tin nhắn @tag đã gửi trong kênh (ưu tiên BulkDelete 1 chạm, tự lùi về xóa lẻ nếu thiếu quyền ManageMessages).
 async function stopAndCleanChannel(channelId) {
  const ch = String(channelId);
  const stopInfo = stopChannel(ch);
  const ids = [...new Set(sentHistory.get(ch) ?? [])];
  sentHistory.delete(ch);
  if (ids.length === 0 || !rest) {
   return { ...stopInfo, deletedCount: 0 };
  }

  let deletedCount = 0;
  for (let offset = 0; offset < ids.length; offset += 100) {
   const chunk = ids.slice(offset, offset + 100);
   if (chunk.length >= 2 && typeof rest.post === 'function') {
    try {
     await rest.post(Routes.channelBulkDelete(ch), {
      body: { messages: chunk },
     });
     deletedCount += chunk.length;
     continue;
    } catch {
     // Nếu kênh chưa cấp quyền ManageMessages cho bot, bot vẫn tự xóa sạch từng tin nhắn của chính mình bên dưới!
    }
   }
   for (let i = 0; i < chunk.length; i++) {
    const ok = await deleteSingleMessageSafe(ch, chunk[i]);
    if (ok) deletedCount++;
    if (i < chunk.length - 1 && chunk.length > 4 && !intervalOverrideMs) {
     await new Promise(r => setTimeout(r, 320));
    }
   }
  }
  return { ...stopInfo, deletedCount };
 }

 async function startSpam({
  channelId,
  requesterId,
  targetUserId,
  count = DEFAULT_SPAM_COUNT,
  intervalSec = null,
  customMessage = null,
 } = {}) {
  assertOwner(requesterId);
  const ch = String(channelId ?? '').trim();
  const targetId = String(targetUserId ?? '').trim();
  if (!/^\d{15,22}$/.test(ch) || !/^\d{15,22}$/.test(targetId)) {
   throw new Error('Hãy chọn thành viên hợp lệ cần réo tên (@user).');
  }

  // Nếu kênh này đang có đợt réo cũ, dừng đợt cũ trước khi mở đợt mới (vẫn giữ danh sách ID cũ để xóa gộp được cả 2 đợt).
  stopChannel(ch);

  const clampedCount = Math.min(MAX_SPAM_COUNT, Math.max(MIN_SPAM_COUNT, Math.round(Number(count) || DEFAULT_SPAM_COUNT)));
  const stepMs = intervalOverrideMs !== null
   ? Math.max(5, Number(intervalOverrideMs))
   : (intervalSec !== null && intervalSec !== undefined
      ? Math.min(MAX_SPAM_INTERVAL_SEC, Math.max(MIN_SPAM_INTERVAL_SEC, Number(intervalSec))) * 1000
      : DEFAULT_SPAM_INTERVAL_MS);

  const cleanCustom = customMessage?.trim()
   ? cleanText(customMessage.trim(), 180)
   : null;

  const loopState = {
   channelId: ch,
   targetUserId: targetId,
   customMessage: cleanCustom,
   total: clampedCount,
   sent: 0,
   running: true,
   cancelled: false,
   timer: null,
  };
  activeLoops.set(ch, loopState);

  const sendTick = async () => {
   if (loopState.cancelled || !loopState.running) return;
   const nextIndex = loopState.sent + 1;
   const isFirst = nextIndex === 1;
   const isLast = nextIndex >= loopState.total;
   const mention = `<@${targetId}>`;
   const lineBody = cleanCustom
    ? `🔔 ${mention} — ${cleanCustom} *(${nextIndex}/${loopState.total})*`
    : `${FUNNY_WAKEUP_TEMPLATES[(nextIndex - 1) % FUNNY_WAKEUP_TEMPLATES.length].replace('{mention}', mention)} *(${nextIndex}/${loopState.total})*`;

   // Gắn nút điều khiển ngay ở tin đầu tiên và tin cuối cùng để Chủ Bot tiện tay bấm Dừng / Xóa sạch mà không tốn thêm request sửa tin.
   const includeButtons = isFirst || isLast;
   const row = includeButtons
    ? buildSpamControlRow(ch, {
       running: !isLast,
       trackedCount: getTrackedCount(ch) + 1,
      }).toJSON()
    : null;

   try {
    const sentMsg = await rest.post(Routes.channelMessages(ch), {
     body: {
      content: lineBody,
      ...(row ? { components: [row] } : {}),
      // Chỉ bật thông báo đỏ cho đúng người bị chọn; chặn tuyệt đối @everyone/@here/role!
      allowed_mentions: {
       parse: [],
       users: [targetId],
      },
     },
    });
    if (sentMsg?.id) {
     recordMessageId(ch, sentMsg.id);
    }
    loopState.sent = nextIndex;
   } catch (err) {
    // Nếu kênh bị xóa hoặc bot mất quyền gửi tin giữa chừng -> dừng vòng lặp êm ái.
    if (err?.status === 403 || err?.status === 404) {
     stopChannel(ch);
     return;
    }
   }

   if (loopState.cancelled || loopState.sent >= loopState.total) {
    loopState.running = false;
    loopState.timer = null;
    activeLoops.delete(ch);
    return;
   }

   loopState.timer = setTimeout(() => {
    void sendTick();
   }, stepMs);
   loopState.timer.unref?.();
  };

  // Bắn ngay phát đầu tiên tức thì để người bị gọi nảy thông báo liền!
  await sendTick();

  return {
   channelId: ch,
   targetUserId: targetId,
   total: clampedCount,
   stepMs,
   running: loopState.running,
   trackedCount: getTrackedCount(ch),
  };
 }

 function stopAll() {
  for (const ch of [...activeLoops.keys()]) {
   stopChannel(ch);
  }
 }

 return {
  assertOwner,
  startSpam,
  stopChannel,
  stopAndCleanChannel,
  getTrackedCount,
  isRunning,
  stopAll,
 };
}
