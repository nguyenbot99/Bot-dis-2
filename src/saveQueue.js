import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { cleanText, formatDuration, safeHttpUrl } from './playerGui.js';

export const SAVE_QUEUE_MARKER = 'SaveQueue • Hộp Lưu Phiên Nhạc';
export const MAX_SAVED_QUEUE_TRACKS = 20;

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()]+/gi;
const MARKDOWN_LINK_RE = /\]\((https?:\/\/[^\s<>)]+)\)/gi;

function sanitizeMarkdownLinkTitle(raw, maxLen = 58) {
 const cleaned = cleanText(raw ?? 'Bài hát', maxLen)
  .replace(/[\[\]()]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
 return cleaned || 'Bài hát';
}

// Đóng gói bài đang phát + hàng đợi hiện tại (tối đa 20 bài) thành Thẻ Phiên Nhạc không tốn RAM (dữ liệu nằm ngay trong Embed).
export function buildSaveQueuePayload(
 player,
 {
  customTitle = null,
  requesterId = null,
  botUser = null,
  includeRestoreButton = true,
 } = {},
) {
 const cur = player?.queue?.currentTrack ?? null;
 const upcoming = Array.isArray(player?.upcomingTracks) ? player.upcomingTracks : [];
 const allRaw = [...(cur ? [cur] : []), ...upcoming];

 const validTracks = [];
 for (const t of allRaw) {
  const url = safeHttpUrl(t?.url);
  if (!url) continue;
  validTracks.push({
   title: sanitizeMarkdownLinkTitle(t.title, 56),
   url,
   duration: Number(t.duration) || 0,
   thumbnail: safeHttpUrl(t.thumbnail),
  });
  if (validTracks.length >= MAX_SAVED_QUEUE_TRACKS) break;
 }

 if (validTracks.length === 0) {
  throw new Error('Hiện chưa có bài hát nào đang phát hoặc trong hàng đợi để đóng gói.');
 }

 const lines = [];
 let charBudget = 0;
 for (let idx = 0; idx < validTracks.length; idx++) {
  const item = validTracks[idx];
  const line = `\`${String(idx + 1).padStart(2, '0')}.\` [${item.title}](${item.url}) (\`${formatDuration(item.duration)}\`)`;
  if (charBudget + line.length > 3650) break;
  lines.push(line);
  charBudget += line.length + 1;
 }

 const headerMeta = requesterId ? `📦 Người đóng gói: <@${requesterId}> • Tổng **${lines.length}** bài\n\n` : '';
 const botName = cleanText(botUser?.username ?? 'Music Bot', 32);
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const titleStr = customTitle?.trim()
  ? `💾 ${cleanText(customTitle.trim(), 70)} (${lines.length} bài)`
  : `💾 Hộp Phiên Nhạc Đã Lưu (${lines.length} bài)`;

 const embed = new EmbedBuilder()
  .setColor(0xf59e0b)
  .setAuthor({
   name: `${botName} • ${SAVE_QUEUE_MARKER}`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setTitle(titleStr)
  .setDescription(`${headerMeta}${lines.join('\n')}`)
  .setFooter({
   text: includeRestoreButton
    ? 'Bấm nút bên dưới hoặc Chạm giữ tin nhắn -> Ứng dụng -> ▶️ Phát / Thêm nhạc để mở lại!'
    : 'Chép các link trên hoặc mở thẻ ngoài kênh chat Server để khôi phục nhanh',
  })
  .setTimestamp();

 if (validTracks[0]?.thumbnail) {
  embed.setThumbnail(validTracks[0].thumbnail);
 }

 const payload = {
  embeds: [embed],
  allowedMentions: { parse: [] },
 };

 if (includeRestoreButton) {
  const row = new ActionRowBuilder().addComponents(
   new ButtonBuilder()
    .setCustomId('savequeue_restore')
    .setStyle(ButtonStyle.Success)
    .setLabel(`Khôi phục & Phát (${lines.length} bài)`)
    .setEmoji('▶️'),
  );
  payload.components = [row];
 }

 return { payload, count: lines.length };
}

// Đọc ngược danh sách URL bài hát từ Thẻ Phiên Nhạc (/savequeue) mà không cần cơ sở dữ liệu.
export function extractSaveQueueUrls(rawMessage) {
 const embeds = Array.isArray(rawMessage?.embeds) ? rawMessage.embeds : [];
 for (const rawEmbed of embeds) {
  const data = rawEmbed?.data ?? rawEmbed;
  const authorName = String(data?.author?.name ?? '');
  const title = String(data?.title ?? '');
  if (!authorName.includes('SaveQueue') && !title.startsWith('💾')) continue;
  const desc = String(data?.description ?? '');
  if (!desc) continue;
  const urls = [];
  const seen = new Set();
  for (const m of desc.matchAll(MARKDOWN_LINK_RE)) {
   const clean = safeHttpUrl(m[1]);
   if (clean && !seen.has(clean)) {
    seen.add(clean);
    urls.push(clean);
    if (urls.length >= MAX_SAVED_QUEUE_TRACKS) break;
   }
  }
  if (urls.length > 0) {
   return { urls, title: cleanText(title.replace(/^💾\s*/, ''), 70) };
  }
 }
 return null;
}

// Bóc tách thông minh nội dung từ bất kỳ tin nhắn nào khi người dùng chọn Menu chuột phải / chạm giữ "▶️ Phát / Thêm nhạc".
export function extractPlayableFromMessage(rawMessage) {
 if (!rawMessage || typeof rawMessage !== 'object') {
  throw new Error('Không đọc được nội dung tin nhắn này.');
 }

 // 1. Nếu là Thẻ Phiên Nhạc (/savequeue) -> khôi phục nguyên dàn bài hát!
 const savedQueue = extractSaveQueueUrls(rawMessage);
 if (savedQueue) {
  return {
   kind: 'savequeue',
   urls: savedQueue.urls,
   title: savedQueue.title,
  };
 }

 // 2. Nếu trong nội dung tin nhắn có sẵn link HTTPS -> ưu tiên lấy link nhạc đầu tiên.
 const content = String(rawMessage.content ?? '');
 const contentUrls = content.match(URL_IN_TEXT_RE) ?? [];
 for (const candidate of contentUrls) {
  const cleaned = safeHttpUrl(candidate.replace(/[.,;!?]+$/, ''));
  if (cleaned && /(youtube\.com|youtu\.be|soundcloud\.com|spotify\.com)/i.test(cleaned)) {
   return { kind: 'query', query: cleaned };
  }
 }

 // 3. Kiểm tra thêm Embed đính kèm trên tin nhắn (ví dụ thẻ bài hát của bot khác hoặc link chia sẻ).
 const embeds = Array.isArray(rawMessage.embeds) ? rawMessage.embeds : [];
 for (const rawEmbed of embeds) {
  const data = rawEmbed?.data ?? rawEmbed;
  const directUrl = safeHttpUrl(data?.url);
  if (directUrl && /(youtube\.com|youtu\.be|soundcloud\.com|spotify\.com)/i.test(directUrl)) {
   return { kind: 'query', query: directUrl };
  }
  const descUrls = String(data?.description ?? '').match(URL_IN_TEXT_RE) ?? [];
  for (const u of descUrls) {
   const cleanU = safeHttpUrl(u.replace(/[.,;!?)]+$/, ''));
   if (cleanU && /(youtube\.com|youtu\.be|soundcloud\.com|spotify\.com)/i.test(cleanU)) {
    return { kind: 'query', query: cleanU };
   }
  }
 }

 // 4. Không có link nhạc -> lọc sạch mention / emoji Discord và lấy văn bản làm tên bài hát cần tìm.
 const plainQuery = content
  .replace(/<@!?\d+>/g, ' ')
  .replace(/<#\d+>/g, ' ')
  .replace(/<@&\d+>/g, ' ')
  .replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, ' ')
  .replace(URL_IN_TEXT_RE, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 220);

 if (plainQuery.length >= 2) {
  return { kind: 'query', query: plainQuery };
 }

 // 5. Thử lấy tiêu đề Embed nếu có.
 const fallbackEmbedTitle = cleanText(embeds[0]?.data?.title ?? embeds[0]?.title ?? '', 120);
 if (fallbackEmbedTitle && fallbackEmbedTitle !== 'Không rõ' && fallbackEmbedTitle.length >= 2) {
  return { kind: 'query', query: fallbackEmbedTitle };
 }

 throw new Error('Tin nhắn này không chứa tên bài hát, link nhạc hay hộp phiên nhạc nào để phát.');
}
