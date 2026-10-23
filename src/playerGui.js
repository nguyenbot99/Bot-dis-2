import {
 ActionRowBuilder,
 ButtonBuilder,
 ButtonStyle,
 ContainerBuilder,
 EmbedBuilder,
 MediaGalleryBuilder,
 MediaGalleryItemBuilder,
 MessageFlags,
 ModalBuilder,
 SectionBuilder,
 SeparatorBuilder,
 StringSelectMenuBuilder,
 StringSelectMenuOptionBuilder,
 TextDisplayBuilder,
 TextInputBuilder,
 TextInputStyle,
} from 'discord.js';
import { SOUND_PRESETS } from './audioEnhancer.js';
import { resolveHumanRequester } from './access.js';

export const LOOP_LABELS = {
 off: 'Tắt lặp',
 track: 'Lặp một bài',
 queue: 'Lặp hàng đợi',
};

const SOURCE_LABELS = {
 youtube: 'YouTube',
 ytsr: 'YouTube',
 soundcloud: 'SoundCloud',
};

// Làm sạch tiêu đề/tác giả để tránh chèn định dạng hoặc mention ngoài ý muốn.
export function cleanText(input, maxLen = 110) {
 const raw = String(input ?? 'Không rõ').replace(/[@`*_~|<>[\]()]/g, '').replace(/\s+/g, ' ').trim();
 if (!raw) return 'Không rõ';
 return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
}

// Kiểm tra đường dẫn HTTP/HTTPS hợp lệ trước khi gắn vào nút bấm hoặc ảnh bìa của Discord.
export function safeHttpUrl(url) {
 if (typeof url !== 'string' || !url.trim() || url.length > 512) return null;
 try {
  const parsed = new URL(url.trim());
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
 } catch {
  return null;
 }
}

// Định dạng thời lượng mili-giây sang chuỗi phút:giây ngắn gọn.
export function formatDuration(ms) {
 const num = Number(ms);
 if (!Number.isFinite(num) || num <= 0) return '0:00';
 const totalSec = Math.floor((num > 1000 ? num : num * 1000) / 1000);
 const hours = Math.floor(totalSec / 3600);
 const minutes = Math.floor((totalSec % 3600) / 60);
 const seconds = String(totalSec % 60).padStart(2, '0');
 return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function resolveSourceLabel(source) {
 const key = String(source ?? '').toLowerCase();
 return SOURCE_LABELS[key] ?? (cleanText(source, 24) || 'Nguồn nhạc');
}

function resolveArtworkUrl(thumbnail) {
 const valid = safeHttpUrl(thumbnail);
 if (!valid) return null;
 // Nâng độ phân giải ảnh bìa SoundCloud từ 100x100 (-large) lên 500x500 (-t500x500) để hiển thị sắc nét như Ziji V10.
 return valid.includes('sndcdn.com') ? valid.replace('-large.jpg', '-t500x500.jpg') : valid;
}

function resolveOwnerId(player, track) {
 return resolveHumanRequester(track?.requestedBy)
  || resolveHumanRequester(player?.queue?.currentTrack?.requestedBy)
  || resolveHumanRequester(player?.previousTrack?.requestedBy)
  || resolveHumanRequester(player?.userdata?.ownerId)
  || null;
}

// Tạo khung điều khiển nhạc tương tác theo phong cách Ziji Bot V10 (Components V2).
export function buildPlayerPayload(player, overrides = {}) {
 const track = overrides.track ?? player?.queue?.currentTrack ?? player?.currentTrack ?? player?.previousTrack ?? null;
 const isPaused = overrides.paused ?? Boolean(player?.isPaused);
 const loopMode = overrides.loopMode ?? (typeof player?.loop === 'function' ? player.loop() : 'off') ?? 'off';
 const autoPlay = overrides.autoPlay ?? (typeof player?.autoPlay === 'function' ? Boolean(player.autoPlay()) : false);
 const volume = overrides.volume ?? player?.volume ?? 100;
 const upcoming = player?.upcomingTracks ?? [];
 const stay247 = overrides.stay247 ?? Boolean(player?.userdata?.stay247);
 const soundPreset = overrides.soundPreset ?? player?.userdata?.soundPreset ?? 'hd';
 const soundLabel = SOUND_PRESETS[soundPreset]?.label ?? SOUND_PRESETS.hd.label;
 const ownerId = resolveOwnerId(player, track);
 const voiceChannelId = player?.userdata?.voiceChannelId ?? null;
 const trackUrl = safeHttpUrl(track?.url);
 const artworkUrl = resolveArtworkUrl(track?.thumbnail);
 const title = cleanText(track?.title ?? 'Chưa có bài hát', 95);
 const author = cleanText(track?.metadata?.author ?? 'Nghệ sĩ', 45);
 const sourceName = resolveSourceLabel(track?.source);

 const container = new ContainerBuilder().setAccentColor(isPaused ? 0xfee75c : 0x7c4dff);

 // Phần đầu khung: Tiêu đề bài hát, nghệ sĩ, thông số phát và nút mở bài gốc.
 const titleLine = trackUrl ? `### 🎵 [**${title}**](${trackUrl})` : `### 🎵 **${title}**`;
 const metaLine = `👤 Nghệ sĩ: **${author}** • 📡 Nguồn: **${sourceName}** • 🎧 Chất âm: **${soundLabel}**`;
 const stateLine = `🔊 **${volume}%** • 🔁 **${LOOP_LABELS[loopMode] ?? LOOP_LABELS.off}** • ✨ Tự phát: **${autoPlay ? 'Bật' : 'Tắt'}** • 🌙 24/7: **${stay247 ? 'Bật' : 'Tắt'}** • 📌 Chờ: **${upcoming.length}**`;
 const roomLine = [
  voiceChannelId ? `🎙️ Kênh: <#${voiceChannelId}>` : '🎙️ Kênh thoại đang kết nối',
  ownerId ? `👑 Điều khiển: <@${ownerId}>` : '👑 Điều khiển: Người gọi bài',
 ].join(' • ');

 const headerSection = new SectionBuilder().addTextDisplayComponents(
  new TextDisplayBuilder().setContent(`${titleLine}\n${metaLine}`),
  new TextDisplayBuilder().setContent(stateLine),
  new TextDisplayBuilder().setContent(roomLine),
 );

 if (trackUrl) {
  headerSection.setButtonAccessory(
   new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Mở link gốc').setURL(trackUrl),
  );
 } else {
  headerSection.setButtonAccessory(
   new ButtonBuilder().setCustomId('player_noop').setStyle(ButtonStyle.Secondary).setLabel('Đang phát').setDisabled(true),
  );
 }
 container.addSectionComponents(headerSection);
 container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1));

 // Thanh tiến trình thời gian thực + gợi ý bài kế tiếp.
 const rawBar = typeof player?.getProgressBar === 'function'
  ? player.getProgressBar({ size: 15, barChar: '▬', progressChar: '🔘' })
  : '';
 const progressText = rawBar || `0:00 🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ ${formatDuration(track?.duration)}`;
 const statusBadge = isPaused ? '⏸️ **Đang tạm dừng**' : '▶️ **Đang phát nhạc**';
 const nextLine = upcoming.length > 0
  ? `\n⏭️ Tiếp theo: **${cleanText(upcoming[0].title, 70)}** (\`${formatDuration(upcoming[0].duration)}\`)${upcoming.length > 1 ? ` *(+${upcoming.length - 1} bài chờ)*` : ''}`
  : '\n-# 💡 Hàng đợi trống — chọn **Thêm bài hát mới** ở menu bên dưới hoặc gõ `/play`.';

 container.addTextDisplayComponents(
  new TextDisplayBuilder().setContent(`${statusBadge}\n\`${progressText}\`${nextLine}`),
 );

 // Ảnh bìa lớn ngay trong khung giống Ziji Bot V10.
 if (artworkUrl) {
  container.addMediaGalleryComponents(
   new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(artworkUrl)),
  );
 }

 container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1));

 // Menu chọn nhanh các chức năng điều khiển và tra cứu.
 const selectRow = new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder()
   .setCustomId('player_menu')
   .setPlaceholder('🎛️ Bảng chức năng điều khiển nhanh...')
   .addOptions(
    new StringSelectMenuOptionBuilder()
     .setLabel('Thêm bài hát mới')
     .setDescription('Mở hộp thoại nhập tên bài hoặc link YouTube / SoundCloud / Spotify')
     .setValue('add_song')
     .setEmoji('➕'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Xem hàng đợi')
     .setDescription('Xem danh sách các bài tiếp theo (mọi người đều xem được)')
     .setValue('view_queue')
     .setEmoji('📋'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Xem lời bài hát')
     .setDescription('Tìm và hiển thị lời bài hát đang phát (ai cũng xem được)')
     .setValue('view_lyrics')
     .setEmoji('📝'),
    new StringSelectMenuOptionBuilder()
     .setLabel(autoPlay ? 'Tắt tự động phát (AutoPlay)' : 'Bật tự động phát (AutoPlay)')
     .setDescription(autoPlay ? 'Dừng tự tìm nhạc liên quan khi hết hàng đợi' : 'Tự động tìm & phát nhạc cùng gu khi hết hàng đợi')
     .setValue('toggle_autoplay')
     .setEmoji('✨'),
    new StringSelectMenuOptionBuilder()
     .setLabel(`Đổi chất âm (hiện tại: ${soundLabel})`)
     .setDescription('Chuyển vòng: Rõ nét HD → Rõ lời & Sáng tiếng → Bass ấm → Nguyên bản')
     .setValue('cycle_sound')
     .setEmoji('🎧'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Đổi chế độ lặp')
     .setDescription(`Chuyển vòng: Tắt lặp → Một bài → Hàng đợi (hiện tại: ${LOOP_LABELS[loopMode] ?? 'Tắt lặp'})`)
     .setValue('cycle_loop')
     .setEmoji('🔁'),
    new StringSelectMenuOptionBuilder()
     .setLabel(stay247 ? 'Tắt chế độ 24/7' : 'Bật chế độ 24/7')
     .setDescription(stay247 ? 'Cho phép bot tự rời kênh khi hết nhạc' : 'Giữ bot treo trong kênh thoại 24/7 không tự thoát')
     .setValue('toggle_247')
     .setEmoji('🌙'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Trộn hàng đợi')
     .setDescription('Xáo trộn ngẫu nhiên thứ tự các bài đang chờ')
     .setValue('shuffle_queue')
     .setEmoji('🔀'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Xóa sạch hàng đợi chờ')
     .setDescription('Xóa toàn bộ bài đang chờ mà không dừng bài hiện tại')
     .setValue('clear_queue')
     .setEmoji('🗑️'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Giảm âm lượng (-20%)')
     .setDescription(`Giảm bớt 20% âm lượng (hiện tại: ${volume}%)`)
     .setValue('vol_down')
     .setEmoji('🔉'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Tăng âm lượng (+20%)')
     .setDescription(`Tăng thêm 20% âm lượng (hiện tại: ${volume}%)`)
     .setValue('vol_up')
     .setEmoji('🔊'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Đặt lại âm lượng 100%')
     .setDescription('Đưa mức âm lượng về mặc định 100%')
     .setValue('vol_100')
     .setEmoji('🎚️'),
   ),
 );

 // Hàng 5 nút bấm điều khiển trực tiếp giống Ziji Bot V10.
 const buttonRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
   .setCustomId('player_refresh')
   .setEmoji('🔄')
   .setStyle(ButtonStyle.Secondary),
  new ButtonBuilder()
   .setCustomId('player_prev')
   .setEmoji('⏮️')
   .setStyle(ButtonStyle.Secondary)
   .setDisabled(!player?.previousTrack),
  new ButtonBuilder()
   .setCustomId('player_pause')
   .setEmoji(isPaused ? '▶️' : '⏸️')
   .setLabel(isPaused ? 'Tiếp tục' : 'Tạm dừng')
   .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
  new ButtonBuilder()
   .setCustomId('player_skip')
   .setEmoji('⏭️')
   .setStyle(ButtonStyle.Secondary),
  new ButtonBuilder()
   .setCustomId('player_stop')
   .setEmoji('⏹️')
   .setStyle(ButtonStyle.Danger),
 );

 container.addActionRowComponents(selectRow);
 container.addActionRowComponents(buttonRow);

 return {
  flags: MessageFlags.IsComponentsV2,
  components: [container],
  allowedMentions: { parse: [] },
 };
}

// Khung chờ tương tác khi bot đang treo kênh thoại 24/7 và hiện không phát bài nào.
export function buildIdle247Payload(player, reason = 'Bot đang giữ kết nối 24/7 trong kênh thoại và sẵn sàng phát nhạc.') {
 const voiceChannelId = player?.userdata?.voiceChannelId ?? null;
 const ownerId = player?.userdata?.ownerId ?? null;
 const roomLine = [
  voiceChannelId ? `🎙️ Kênh thoại: <#${voiceChannelId}>` : '🎙️ Kênh thoại đang kết nối',
  ownerId ? `👑 Chủ phiên 24/7: <@${ownerId}>` : null,
 ].filter(Boolean).join(' • ');

 const buttonRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
   .setCustomId('player_open_add')
   .setEmoji('➕')
   .setLabel('Thêm bài hát')
   .setStyle(ButtonStyle.Success),
  new ButtonBuilder()
   .setCustomId('player_leave')
   .setEmoji('👋')
   .setLabel('Rời kênh thoại')
   .setStyle(ButtonStyle.Danger),
 );

 const container = new ContainerBuilder()
  .setAccentColor(0x57f287)
  .addTextDisplayComponents(
   new TextDisplayBuilder().setContent([
    '### 🌙 Chế độ 24/7 đang hoạt động',
    reason,
    roomLine,
    '-# Bấm **Thêm bài hát** bên dưới hoặc gõ `/play` để mở nhạc • dùng `/247 mode:Tắt 24/7` hoặc `/leave` nếu muốn bot rời kênh.',
   ].join('\n')),
  )
  .addActionRowComponents(buttonRow);

 return {
  flags: MessageFlags.IsComponentsV2,
  components: [container],
  allowedMentions: { parse: [] },
 };
}

// Khung trạng thái gọn gàng khi phiên phát nhạc kết thúc hoặc bị dừng (vô hiệu hóa các nút cũ).
export function buildEndedPayload(reason = 'Hàng đợi đã phát hết, bot đã rời kênh thoại.') {
 const container = new ContainerBuilder()
  .setAccentColor(0x4e5058)
  .addTextDisplayComponents(
   new TextDisplayBuilder().setContent(`### ⏹️ Phiên phát nhạc đã kết thúc\n${reason}\n-# Dùng lệnh \`/play\` trong kênh thoại bất kỳ lúc nào để mở phiên nghe nhạc mới.`),
  );

 return {
  flags: MessageFlags.IsComponentsV2,
  components: [container],
  allowedMentions: { parse: [] },
 };
}

// Hộp thoại nhập bài hát mới ngay từ khung điều khiển.
export function buildAddSongModal() {
 return new ModalBuilder()
  .setCustomId('player_add_modal')
  .setTitle('Thêm bài hát vào hàng đợi')
  .addComponents(
   new ActionRowBuilder().addComponents(
    new TextInputBuilder()
     .setCustomId('query')
     .setLabel('Tên bài hoặc link YouTube/SoundCloud/Spotify')
     .setStyle(TextInputStyle.Short)
     .setPlaceholder('Nhập tên bài hát hoặc dán link bài lẻ HTTPS...')
     .setRequired(true)
     .setMaxLength(400),
   ),
  );
}

// Khung Embed hiển thị danh sách hàng đợi cho lệnh /queue và mục "Xem hàng đợi".
export function buildQueueEmbed(player, botUser) {
 const current = player?.queue?.currentTrack ?? player?.currentTrack;
 const upcoming = player?.upcomingTracks ?? [];
 const loopMode = (typeof player?.loop === 'function' ? player.loop() : 'off') ?? 'off';
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;

 const rows = upcoming.slice(0, 10).map((t, idx) => {
  const who = t.requestedBy ? ` • <@${t.requestedBy}>` : '';
  return `\`${String(idx + 1).padStart(2, '0')}.\` **${cleanText(t.title, 65)}** (\`${formatDuration(t.duration)}\`)${who}`;
 });

 const embed = new EmbedBuilder()
  .setColor(0x7c4dff)
  .setAuthor({
   name: `${botUser?.username ?? 'Music Bot'} • Hàng đợi phát nhạc`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setDescription([
   current
    ? `▶️ **Đang phát:** **${cleanText(current.title, 80)}** (\`${formatDuration(current.duration)}\`)${current.requestedBy ? ` • <@${current.requestedBy}>` : ''}`
    : '⏸️ *Hiện chưa phát bài nào.*',
   '',
   rows.length > 0 ? `**Danh sách chờ (${upcoming.length}/20 bài):**\n${rows.join('\n')}` : '*Hàng đợi tiếp theo đang trống.*',
   upcoming.length > 10 ? `\n*...và còn ${upcoming.length - 10} bài khác trong hàng đợi.*` : '',
  ].filter(Boolean).join('\n'))
  .setFooter({ text: `Âm lượng: ${player?.volume ?? 100}% • Chế độ lặp: ${LOOP_LABELS[loopMode] ?? 'Tắt lặp'}` })
  .setTimestamp();

 return embed;
}

// Khung Embed hiển thị chi tiết bài đang phát cho lệnh /nowplaying.
export function buildNowPlayingEmbed(player, botUser) {
 const current = player?.queue?.currentTrack ?? player?.currentTrack;
 const loopMode = (typeof player?.loop === 'function' ? player.loop() : 'off') ?? 'off';
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const thumbUrl = resolveArtworkUrl(current?.thumbnail);
 const trackUrl = safeHttpUrl(current?.url);
 const bar = typeof player?.getProgressBar === 'function'
  ? player.getProgressBar({ size: 15, barChar: '▬', progressChar: '🔘' })
  : '';

 const embed = new EmbedBuilder()
  .setColor(player?.isPaused ? 0xfee75c : 0x7c4dff)
  .setAuthor({
   name: `${botUser?.username ?? 'Music Bot'} • Bài hát hiện tại`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setTitle(`🎵 ${cleanText(current?.title ?? 'Chưa phát bài nào', 95)}`)
  .setDescription([
   `👤 **Nghệ sĩ:** ${cleanText(current?.metadata?.author ?? 'Không rõ', 50)} • **Nguồn:** ${resolveSourceLabel(current?.source)}`,
   current?.requestedBy ? `👑 **Người điều khiển:** <@${current.requestedBy}>` : '',
   '',
   `${player?.isPaused ? '⏸️ **Tạm dừng**' : '▶️ **Đang phát**'}`,
   `\`${bar || `0:00 🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ ${formatDuration(current?.duration)}`}\``,
  ].filter(Boolean).join('\n'))
  .setFooter({ text: `Âm lượng: ${player?.volume ?? 100}% • Lặp: ${LOOP_LABELS[loopMode] ?? 'Tắt lặp'} • Chờ: ${(player?.upcomingTracks ?? []).length} bài` })
  .setTimestamp();

 if (trackUrl) embed.setURL(trackUrl);
 if (thumbUrl) embed.setThumbnail(thumbUrl);
 return embed;
}

// Khung Embed hiển thị danh sách 10 bài hát đã phát gần đây cho lệnh /history.
export function buildHistoryEmbed(player, botUser) {
 const past = [...(player?.previousTracks ?? [])].reverse().slice(0, 10);
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const rows = past.map((t, idx) => {
  const whoId = resolveHumanRequester(t.requestedBy);
  const who = whoId ? ` • <@${whoId}>` : ' • *AutoPlay*';
  return `\`${String(idx + 1).padStart(2, '0')}.\` **${cleanText(t.title, 65)}** (\`${formatDuration(t.duration)}\`)${who}`;
 });

 return new EmbedBuilder()
  .setColor(0x5865f2)
  .setAuthor({
   name: `${botUser?.username ?? 'Music Bot'} • Lịch sử phát nhạc`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setDescription(rows.length > 0 ? rows.join('\n') : '*Chưa có bài hát nào trong lịch sử của phiên này.*')
  .setFooter({ text: 'Dùng /previous hoặc nút ⏮️ trên khung để quay lại bài vừa phát' })
  .setTimestamp();
}

// Khung Embed hiển thị lời bài hát gọn gàng (tự cắt an toàn dưới giới hạn 4096 ký tự của Discord).
export function buildLyricsEmbed(lyricsData, botUser) {
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const rawText = String(lyricsData?.text ?? '').trim();
 const safeLyrics = rawText.length > 3800 ? `${rawText.slice(0, 3800).trimEnd()}\n\n*... (đã rút gọn cho vừa khung Discord)*` : rawText;

 return new EmbedBuilder()
  .setColor(0xeb459e)
  .setAuthor({
   name: `${botUser?.username ?? 'Music Bot'} • Lời bài hát`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setTitle(`📝 ${cleanText(lyricsData?.title ?? 'Bài hát', 90)} — ${cleanText(lyricsData?.artist ?? 'Không rõ', 60)}`)
  .setDescription(safeLyrics || '*Không có dữ liệu lời bài hát.*')
  .setFooter({ text: `Nguồn lời bài hát: ${lyricsData?.source ?? 'LRCLIB'}` })
  .setTimestamp();
}

