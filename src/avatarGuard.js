import {
 ActionRowBuilder,
 AttachmentBuilder,
 ButtonBuilder,
 ButtonStyle,
 EmbedBuilder,
} from 'discord.js';
import { isBotOwner } from './access.js';
import { deleteDiscordMessage } from './messageCleaner.js';
import { cleanText, safeHttpUrl } from './playerGui.js';

export const MAX_PROTECTED_AVATARS = 25;
const MAX_SINGLE_CACHED_BUFFER_BYTES = 220 * 1024; // Chỉ giữ buffer nhỏ <= 220 KB trong RAM
const MAX_TOTAL_CACHED_BUFFER_BYTES = 1536 * 1024; // Trần cứng tổng bộ đệm chống xóa <= 1.5 MB RAM

function buildDiscordAssetUrls(makeUrlFn, hash) {
 if (typeof makeUrlFn !== 'function') return { hdUrl: null, attachUrl: null, ext: 'png' };
 const isGif = typeof hash === 'string' && hash.startsWith('a_');
 const ext = isGif ? 'gif' : 'png';
 const hdUrl = safeHttpUrl(makeUrlFn({ size: 4096, extension: ext, forceStatic: false }));
 const attachUrl = safeHttpUrl(makeUrlFn({ size: 1024, extension: ext, forceStatic: false })) || hdUrl;
 return { hdUrl, attachUrl, ext };
}

// Trích xuất toàn bộ link ảnh đại diện gốc, ảnh riêng theo máy chủ và ảnh bìa Banner ở độ phân giải 4096px.
export function resolveAvatarTargetInfo(targetUser, targetMember = null, requestedType = 'auto') {
 if (!targetUser?.id) {
  throw new Error('Không tìm thấy thông tin người dùng cần xem ảnh đại diện.');
 }

 const globalAsset = buildDiscordAssetUrls(
  opts => targetUser.displayAvatarURL?.(opts),
  targetUser.avatar,
 );
 const serverAsset = targetMember?.avatar
  ? buildDiscordAssetUrls(opts => targetMember.avatarURL?.(opts), targetMember.avatar)
  : { hdUrl: null, attachUrl: null, ext: 'png' };
 const bannerAsset = targetUser.banner
  ? buildDiscordAssetUrls(opts => targetUser.bannerURL?.(opts), targetUser.banner)
  : { hdUrl: null, attachUrl: null, ext: 'png' };

 let resolvedType = requestedType;
 let activeAsset = globalAsset;
 let typeLabel = 'Ảnh đại diện chính';
 let fallbackNote = null;

 if (requestedType === 'banner') {
  if (!bannerAsset.hdUrl) {
   throw new Error('Người dùng này hiện chưa cài đặt Ảnh bìa hồ sơ (Banner) trên Discord.');
  }
  activeAsset = bannerAsset;
  typeLabel = 'Ảnh bìa hồ sơ (Banner)';
 } else if (requestedType === 'server') {
  if (serverAsset.hdUrl) {
   activeAsset = serverAsset;
   typeLabel = 'Ảnh đại diện riêng trong Server';
  } else {
   resolvedType = 'global';
   activeAsset = globalAsset;
   typeLabel = 'Ảnh đại diện chính';
   fallbackNote = '*(Người này không đặt avatar riêng cho server nên đang hiển thị avatar chính)*';
  }
 } else if (requestedType === 'global') {
  activeAsset = globalAsset;
  typeLabel = 'Ảnh đại diện chính';
 } else {
  // auto: ưu tiên avatar riêng trong server nếu có, kèm link mở nhanh cả hai
  if (serverAsset.hdUrl) {
   resolvedType = 'server';
   activeAsset = serverAsset;
   typeLabel = 'Ảnh đại diện riêng trong Server';
  } else {
   resolvedType = 'global';
   activeAsset = globalAsset;
   typeLabel = 'Ảnh đại diện chính';
  }
 }

 if (!activeAsset.hdUrl) {
  throw new Error('Không lấy được đường dẫn ảnh đại diện hợp lệ từ Discord.');
 }

 const displayName = cleanText(
  targetMember?.displayName || targetUser.globalName || targetUser.username || 'Thành viên',
  55,
 );
 const username = cleanText(targetUser.username || targetUser.id, 40);
 const accentColor = typeof targetUser.accentColor === 'number' ? targetUser.accentColor : 0x8b5cf6;

 return {
  userId: String(targetUser.id),
  displayName,
  username,
  accentColor,
  resolvedType,
  typeLabel,
  fallbackNote,
  hdUrl: activeAsset.hdUrl,
  attachUrl: activeAsset.attachUrl || activeAsset.hdUrl,
  ext: activeAsset.ext,
  globalHdUrl: globalAsset.hdUrl,
  serverHdUrl: serverAsset.hdUrl,
  bannerHdUrl: bannerAsset.hdUrl,
 };
}

// Tải nhẹ file ảnh từ CDN Discord để đóng băng thành tệp đính kèm thật (người kia đổi avt sau đó cũng không bị mất ảnh).
export async function downloadAvatarBuffer(url, fetchImpl = fetch, maxBytes = 6 * 1024 * 1024) {
 const safe = safeHttpUrl(url);
 if (!safe) return null;
 try {
  const res = await fetchImpl(safe, { signal: AbortSignal.timeout(6500) });
  if (!res?.ok) return null;
  const lenHeader = Number(res.headers?.get?.('content-length') ?? 0);
  if (lenHeader > maxBytes) return null;
  const ab = await res.arrayBuffer();
  if (!ab || ab.byteLength === 0 || ab.byteLength > maxBytes) return null;
  return Buffer.from(ab);
 } catch {
  return null;
 }
}

// Dựng khung Embed soi Avatar kèm tệp ảnh thật & hàng nút bấm tiện ích.
export function buildAvatarMessagePayload(
 info,
 {
  requesterId = null,
  repostCount = 0,
  imageBuffer = null,
  includeGuardButtons = true,
 } = {},
) {
 const fileName = `avatar-${info.userId}-${info.resolvedType}.${info.ext || 'png'}`;
 const links = [];
 if (info.globalHdUrl) links.push(`[🖼️ Avatar gốc 4K](${info.globalHdUrl})`);
 if (info.serverHdUrl) links.push(`[🏠 Avatar Server 4K](${info.serverHdUrl})`);
 if (info.bannerHdUrl) links.push(`[🎨 Ảnh bìa Banner 4K](${info.bannerHdUrl})`);

 const statusLine = repostCount > 0
  ? `🛡️ **Chống xóa tự động:** Đã tự khôi phục lại ảnh (lần **#${repostCount}**) sau khi bị xóa trên kênh!`
  : '🛡️ **Bảo vệ vĩnh viễn:** Không tự xóa • Đã đóng băng file gốc • Tự đăng lại nếu bị xóa';

 const descLines = [
  `📌 **Loại ảnh:** ${info.typeLabel}`,
  info.fallbackNote,
  links.length ? `🔗 **Tải nét căng:** ${links.join(' • ')}` : null,
  requesterId ? `👁️ **Người soi:** <@${requesterId}>` : null,
  includeGuardButtons ? statusLine : null,
 ].filter(Boolean);

 const embed = new EmbedBuilder()
  .setColor(info.accentColor ?? 0x8b5cf6)
  .setAuthor({ name: `${info.displayName} (@${info.username}) • Soi Ảnh HD` })
  .setDescription(descLines.join('\n'))
  .setImage(imageBuffer ? `attachment://${fileName}` : info.hdUrl)
  .setFooter({
   text: includeGuardButtons
    ? 'Bấm "Lưu về DM" để giữ bản riêng • Chỉ Chủ Bot mới có quyền gỡ khung này'
    : 'Đã lưu bản sao vĩnh viễn vào hộp thư riêng của bạn',
  })
  .setTimestamp();

 const payload = {
  embeds: [embed],
  allowedMentions: { parse: [] },
 };

 if (imageBuffer) {
  payload.files = [new AttachmentBuilder(imageBuffer, { name: fileName })];
 }

 if (includeGuardButtons) {
  const row = new ActionRowBuilder().addComponents(
   new ButtonBuilder()
    .setCustomId(`avatar_dm:${info.userId}:${info.resolvedType}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Lưu về DM riêng')
    .setEmoji('📩'),
   new ButtonBuilder()
    .setCustomId(`avatar_unpin:${info.userId}`)
    .setStyle(ButtonStyle.Danger)
    .setLabel('Gỡ bảo vệ & Xóa')
    .setEmoji('🔒'),
  );
  payload.components = [row];
 }

 return payload;
}

// Bộ bảo vệ chống xóa cho tin nhắn /avatar: nếu bị Admin/Mod hoặc bot dọn chat xóa trên kênh, tự động đăng lại ngay lập tức.
export function createAvatarGuardManager({
 rest,
 getChannel,
 fetchImpl = fetch,
 maxEntries = MAX_PROTECTED_AVATARS,
 maxRepostsPerMinute = 6,
 repostDelayMs = 850,
} = {}) {
 const entries = new Map(); // messageId -> { channelId, guildId, info, requesterId, repostCount, repostTimestamps, cachedBuffer }
 const intentionallyRemoved = new Set();

 function totalCachedBytes() {
  let sum = 0;
  for (const item of entries.values()) {
   if (item.cachedBuffer) sum += item.cachedBuffer.length;
  }
  return sum;
 }

 function pruneEntries() {
  while (entries.size > maxEntries) {
   const oldestKey = entries.keys().next().value;
   if (!oldestKey) break;
   entries.delete(oldestKey);
  }
 }

 function registerProtectedMessage(msg, { info, requesterId, imageBuffer = null, repostCount = 0, repostTimestamps = [] }) {
  const messageId = msg?.id ? String(msg.id) : null;
  const channelId = msg?.channelId ?? msg?.channel_id ?? msg?.channel?.id ?? null;
  if (!messageId || !channelId || !info) return false;

  let cachedBuffer = null;
  if (
   Buffer.isBuffer(imageBuffer) &&
   imageBuffer.length <= MAX_SINGLE_CACHED_BUFFER_BYTES &&
   totalCachedBytes() + imageBuffer.length <= MAX_TOTAL_CACHED_BUFFER_BYTES
  ) {
   cachedBuffer = imageBuffer;
  }

  entries.set(messageId, {
   messageId,
   channelId: String(channelId),
   info,
   requesterId: requesterId ? String(requesterId) : null,
   repostCount,
   repostTimestamps,
   cachedBuffer,
  });
  pruneEntries();
  return true;
 }

 async function unpinAndDelete(messageId, channelId, actorUserId, env = process.env) {
  if (!isBotOwner(actorUserId, env)) {
   return { allowed: false };
  }
  const idStr = String(messageId ?? '');
  intentionallyRemoved.add(idStr);
  entries.delete(idStr);
  setTimeout(() => intentionallyRemoved.delete(idStr), 30000).unref?.();
  await deleteDiscordMessage(rest, { id: idStr, channelId: String(channelId ?? '') }, channelId);
  return { allowed: true };
 }

 async function triggerRepost(deletedId) {
  const idStr = String(deletedId ?? '');
  if (!idStr || intentionallyRemoved.has(idStr)) return false;
  const record = entries.get(idStr);
  if (!record) return false;
  entries.delete(idStr);

  const now = Date.now();
  const recent = record.repostTimestamps.filter(ts => now - ts < 60000);
  if (recent.length >= maxRepostsPerMinute) {
   return false; // Ngắt an toàn nếu kênh đang bị bot khác quét xóa hàng loạt liên tục mỗi giây
  }
  recent.push(now);

  if (repostDelayMs > 0) {
   await new Promise(r => setTimeout(r, repostDelayMs));
  }

  const channel = typeof getChannel === 'function' ? await getChannel(record.channelId) : null;
  if (!channel || typeof channel.send !== 'function') return false;

  const buf = record.cachedBuffer ?? await downloadAvatarBuffer(record.info.attachUrl, fetchImpl);
  const nextCount = record.repostCount + 1;
  const payload = buildAvatarMessagePayload(record.info, {
   requesterId: record.requesterId,
   repostCount: nextCount,
   imageBuffer: buf,
   includeGuardButtons: true,
  });

  const sent = await channel.send(payload).catch(() => null);
  if (!sent?.id) return false;

  registerProtectedMessage(sent, {
   info: record.info,
   requesterId: record.requesterId,
   imageBuffer: record.cachedBuffer ?? buf,
   repostCount: nextCount,
   repostTimestamps: recent,
  });
  return true;
 }

 function handleRawGatewayPacket(packet) {
  if (!packet || typeof packet !== 'object') return;
  if (packet.t === 'MESSAGE_DELETE' && packet.d?.id) {
   void triggerRepost(packet.d.id);
  } else if (packet.t === 'MESSAGE_DELETE_BULK' && Array.isArray(packet.d?.ids)) {
   for (const id of packet.d.ids) {
    void triggerRepost(id);
   }
  }
 }

 return {
  registerProtectedMessage,
  unpinAndDelete,
  handleRawGatewayPacket,
  getProtectedEntry: id => entries.get(String(id ?? '')) ?? null,
  size: () => entries.size,
 };
}
