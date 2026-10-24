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

export const DEFAULT_NOW_PLAYING_WEB_URL = 'https://bot-dis-2.botmusicvip.workers.dev/';
export const IDLE_PANEL_AUTO_DELETE_MS = 270000; // Tự xóa khung chờ 24/7 & khung kết thúc sau 4 phút 30 giây để giữ kênh chat sạch sẽ.

// Tự động xác định link Website Now Playing công khai để gắn nút mở nhanh trên khung Discord.
export function resolveNowPlayingWebUrl(env = process.env) {
 const explicit = safeHttpUrl(env?.NOW_PLAYING_WEB_URL ?? '');
 if (explicit) return explicit;
 const pushUrl = safeHttpUrl(env?.NOW_PLAYING_PUSH_URL ?? '');
 if (pushUrl) {
  try {
   const u = new URL(pushUrl);
   u.pathname = '/';
   u.search = '';
   u.hash = '';
   return u.toString();
  } catch {}
 }
 return DEFAULT_NOW_PLAYING_WEB_URL;
}

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

// Dựng thanh tiến trình chuẩn xác 100%: chặn hiện tượng số giây hiện tại vượt quá tổng thời lượng bài hát (như 5:40 / 4:21).
export function renderSyncedProgress(player, track = player?.queue?.currentTrack ?? player?.currentTrack, isPaused = Boolean(player?.isPaused)) {
 const size = 15;
 const timeInfo = typeof player?.getTime === 'function' ? player.getTime() : null;
 const rawTrackDur = Number(track?.duration ?? 0);
 const fallbackTotal = rawTrackDur > 0 ? (rawTrackDur > 1000 ? rawTrackDur : rawTrackDur * 1000) : 0;

 if (!timeInfo && typeof player?.getProgressBar === 'function') {
  const customBar = player.getProgressBar({ size, barChar: '▬', progressChar: '🔘' });
  if (customBar) return { barText: customBar, endUnix: null };
 }

 let totalMs = Math.max(0, Number(timeInfo?.total ?? fallbackTotal) || fallbackTotal);
 let currentMs = Math.max(0, Number(timeInfo?.current ?? 0) || 0);

 if (totalMs > 0 && currentMs > totalMs) {
  // Nếu lệch vài giây cuối bài do đuôi khoảng lặng của file âm thanh -> kẹp gọn về đúng độ dài bài;
  // nếu luồng phát thực tế dài hơn hẳn metadata -> tự nới tổng thời lượng theo luồng thật để không bao giờ in 5:40 > 4:21.
  if (currentMs - totalMs <= 4000) {
   currentMs = totalMs;
  } else {
   totalMs = currentMs;
   if (track && typeof track === 'object') track.duration = totalMs;
  }
 }

 const ratio = totalMs > 0 ? Math.min(1, Math.max(0, currentMs / totalMs)) : 0;
 const filledCount = Math.round(ratio * size);
 const bar = `${'▬'.repeat(filledCount)}🔘${'▬'.repeat(Math.max(0, size - filledCount))}`;
 const barText = totalMs > 0
  ? `${formatDuration(currentMs)} ${bar} ${formatDuration(totalMs)}`
  : `${formatDuration(currentMs)} 🔘${'▬'.repeat(size)} 0:00`;

 const remainingMs = totalMs - currentMs;
 const endUnix = !isPaused && totalMs > 0 && remainingMs > 1500
  ? Math.floor((Date.now() + remainingMs) / 1000)
  : null;

 return { barText, endUnix, currentMs, totalMs };
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
 const voiceMuted = overrides.voiceMuted ?? Boolean(player?.userdata?.voiceMuted);
 const muteReason = overrides.muteReason ?? player?.userdata?.muteReason ?? null;
 const soundPreset = overrides.soundPreset ?? player?.userdata?.soundPreset ?? 'hd';
 const soundLabel = SOUND_PRESETS[soundPreset]?.label ?? SOUND_PRESETS.hd.label;
 const ownerId = resolveOwnerId(player, track);
 const voiceChannelId = player?.userdata?.voiceChannelId ?? null;
 const trackUrl = safeHttpUrl(track?.url);
 const artworkUrl = resolveArtworkUrl(track?.thumbnail);
 const title = cleanText(track?.title ?? 'Chưa có bài hát', 95);
 const author = cleanText(track?.metadata?.author ?? 'Nghệ sĩ', 45);
 const sourceName = resolveSourceLabel(track?.source);

 const accentColor = voiceMuted ? 0xed4245 : (isPaused ? 0xfee75c : 0x7c4dff);
 const container = new ContainerBuilder().setAccentColor(accentColor);

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

 // Thanh tiến trình thời gian thực (tự đồng bộ theo từng khung âm thanh Opus của @discordjs/voice) + đồng hồ đếm ngược trực tiếp của Discord.
 const { barText: progressText, endUnix } = renderSyncedProgress(player, track, isPaused);
 let statusBadge;
 if (voiceMuted) {
  statusBadge = muteReason === 'stage_suppress'
   ? '🔇 **Đang bị khóa mic Sân khấu (Stage) — hãy mời bot lên phát biểu!**'
   : `🔇 **Bot đang bị tắt mic máy chủ (Server Mute)${isPaused ? ' — đã tự tạm dừng' : ''}!**`;
 } else if (isPaused) {
  statusBadge = '⏸️ **Đang tạm dừng**';
 } else {
  statusBadge = endUnix ? `▶️ **Đang phát nhạc** • ⏳ hết bài <t:${endUnix}:R>` : '▶️ **Đang phát nhạc**';
 }
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

 // Menu chọn nhanh các chức năng điều khiển, âm lượng tùy chỉnh (0–200%) và đổi chất âm trực tiếp.
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
     .setLabel('Tùy chỉnh âm lượng (0% – 200%)')
     .setDescription(`Nhập số phần trăm bất kỳ từ 0 đến 200 (hiện tại: ${volume}%)`)
     .setValue('custom_volume')
     .setEmoji('🎚️'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Giảm âm lượng (-20%)')
     .setDescription(`Giảm ngay 20% âm lượng (hiện tại: ${volume}%)`)
     .setValue('vol_down')
     .setEmoji('🔉'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Tăng âm lượng (+20%)')
     .setDescription(`Tăng thêm 20% âm lượng, tối đa 200% (hiện tại: ${volume}%)`)
     .setValue('vol_up')
     .setEmoji('🔊'),
    new StringSelectMenuOptionBuilder()
     .setLabel('Đặt lại âm lượng 100%')
     .setDescription('Đưa mức âm lượng về chuẩn mặc định 100%')
     .setValue('vol_100')
     .setEmoji('🔄'),
    new StringSelectMenuOptionBuilder()
     .setLabel(`Đổi chất âm nhanh (hiện tại: ${soundLabel})`)
     .setDescription('Chuyển vòng chất âm trực tiếp ngay trên bài đang phát')
     .setValue('cycle_sound')
     .setEmoji('🎧'),
    new StringSelectMenuOptionBuilder()
     .setLabel(`Chất âm: Rõ nét HD${soundPreset === 'hd' ? ' (Đang bật)' : ''}`)
     .setDescription('Âm hình 3D rộng, dải cao sáng trong & trầm gọn chắc')
     .setValue('preset_hd')
     .setEmoji('💎'),
    new StringSelectMenuOptionBuilder()
     .setLabel(`Chất âm: Rõ lời & Sáng tiếng${soundPreset === 'vocal' ? ' (Đang bật)' : ''}`)
     .setDescription('Tôn giọng ca sĩ nổi bật phía trước, giảm trầm lấn lời')
     .setValue('preset_vocal')
     .setEmoji('🎤'),
    new StringSelectMenuOptionBuilder()
     .setLabel(`Chất âm: Bass Ấm & Căng${soundPreset === 'bass' ? ' (Đang bật)' : ''}`)
     .setDescription('Tăng mạnh lực sub-bass & trống trầm đập chắc, chống rè')
     .setValue('preset_bass')
     .setEmoji('🔥'),
    new StringSelectMenuOptionBuilder()
     .setLabel(`Chất âm: Nguyên bản${soundPreset === 'flat' ? ' (Đang bật)' : ''}`)
     .setDescription('Giữ nguyên EQ gốc tự nhiên 100% của bản thu')
     .setValue('preset_flat')
     .setEmoji('🎵'),
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

 const webUrl = resolveNowPlayingWebUrl();
 if (webUrl) {
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1));
  container.addSectionComponents(
   new SectionBuilder()
    .addTextDisplayComponents(
     new TextDisplayBuilder().setContent('🌐 **Website Now Playing trực tuyến**\n-# Theo dõi bài đang phát & danh sách chờ trên trình duyệt'),
    )
    .setButtonAccessory(
     new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setEmoji('🌐')
      .setLabel('Mở Web Now Playing')
      .setURL(webUrl),
    ),
  );
 }

 return {
  flags: MessageFlags.IsComponentsV2,
  components: [container],
  allowedMentions: { parse: [] },
 };
}

// Khung chờ tương tác khi bot đang treo kênh thoại 24/7 và hiện không phát bài nào.
export function buildIdle247Payload(
 player,
 reason = 'Bot đang giữ kết nối 24/7 trong kênh thoại và sẵn sàng phát nhạc.',
 { autoDeleteMs = IDLE_PANEL_AUTO_DELETE_MS } = {},
) {
 const voiceChannelId = player?.userdata?.voiceChannelId ?? null;
 const ownerId = player?.userdata?.ownerId ?? null;
 const roomLine = [
  voiceChannelId ? `🎙️ Kênh thoại: <#${voiceChannelId}>` : '🎙️ Kênh thoại đang kết nối',
  ownerId ? `👑 Chủ phiên 24/7: <@${ownerId}>` : null,
 ].filter(Boolean).join(' • ');

 const webUrl = resolveNowPlayingWebUrl();
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
 if (webUrl) {
  buttonRow.addComponents(
   new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setEmoji('🌐')
    .setLabel('Web Now Playing')
    .setURL(webUrl),
  );
 }

 const voiceMuted = Boolean(player?.userdata?.voiceMuted);
 const muteNotice = voiceMuted
  ? '🔇 **Cảnh báo:** Bot hiện đang bị **Tắt mic máy chủ (Server Mute)** — hãy mở lại mic cho bot để nghe được nhạc.'
  : null;
 const deleteAtUnix = autoDeleteMs > 0 ? Math.floor((Date.now() + autoDeleteMs) / 1000) : null;
 const autoCleanLine = deleteAtUnix
  ? `-# 🧹 Khung thông báo này sẽ tự thu dọn <t:${deleteAtUnix}:R> cho gọn kênh chat (bot vẫn treo trong kênh thoại 24/7).`
  : null;

 const container = new ContainerBuilder()
  .setAccentColor(voiceMuted ? 0xed4245 : 0x57f287)
  .addTextDisplayComponents(
   new TextDisplayBuilder().setContent([
    '### 🌙 Chế độ 24/7 đang hoạt động',
    reason,
    muteNotice,
    roomLine,
    '-# Bấm **Thêm bài hát** bên dưới hoặc gõ `/play` để mở nhạc • dùng `/247 mode:Tắt 24/7` hoặc `/leave` nếu muốn bot rời kênh.',
    autoCleanLine,
   ].filter(Boolean).join('\n')),
  )
  .addActionRowComponents(buttonRow);

 return {
  flags: MessageFlags.IsComponentsV2,
  components: [container],
  allowedMentions: { parse: [] },
 };
}

// Khung trạng thái gọn gàng khi phiên phát nhạc kết thúc hoặc bị dừng (vô hiệu hóa các nút cũ).
export function buildEndedPayload(
 reason = 'Hàng đợi đã phát hết, bot đã rời kênh thoại.',
 { autoDeleteMs = IDLE_PANEL_AUTO_DELETE_MS } = {},
) {
 const deleteAtUnix = autoDeleteMs > 0 ? Math.floor((Date.now() + autoDeleteMs) / 1000) : null;
 const autoCleanLine = deleteAtUnix ? `\n-# 🧹 Thông báo này sẽ tự xóa <t:${deleteAtUnix}:R>.` : '';
 const container = new ContainerBuilder()
  .setAccentColor(0x4e5058)
  .addTextDisplayComponents(
   new TextDisplayBuilder().setContent(`### ⏹️ Phiên phát nhạc đã kết thúc\n${reason}\n-# Dùng lệnh \`/play\` trong kênh thoại bất kỳ lúc nào để mở phiên nghe nhạc mới.${autoCleanLine}`),
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

// Hộp thoại tùy chỉnh mức âm lượng bất kỳ từ 0% đến 200% ngay trên khung điều khiển.
export function buildVolumeModal(currentVolume = 100) {
 const safeCurrent = Math.min(200, Math.max(0, Math.round(Number(currentVolume) || 100)));
 return new ModalBuilder()
  .setCustomId('player_volume_modal')
  .setTitle('Tùy chỉnh âm lượng (0% – 200%)')
  .addComponents(
   new ActionRowBuilder().addComponents(
    new TextInputBuilder()
     .setCustomId('volume')
     .setLabel('Nhập mức âm lượng mong muốn (0 – 200)')
     .setStyle(TextInputStyle.Short)
     .setPlaceholder('Nhập số bất kỳ từ 0 đến 200 (ví dụ: 20, 75, 150, 200)')
     .setValue(String(safeCurrent))
     .setRequired(true)
     .setMinLength(1)
     .setMaxLength(5),
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
  const whoId = resolveHumanRequester(t.requestedBy);
  const who = whoId ? ` • <@${whoId}>` : (t.requestedBy ? ' • *AutoPlay*' : '');
  return `\`${String(idx + 1).padStart(2, '0')}.\` **${cleanText(t.title, 65)}** (\`${formatDuration(t.duration)}\`)${who}`;
 });

 const curWhoId = resolveHumanRequester(current?.requestedBy);
 const curWho = curWhoId ? ` • <@${curWhoId}>` : (current?.requestedBy ? ' • *AutoPlay*' : '');

 const embed = new EmbedBuilder()
  .setColor(0x7c4dff)
  .setAuthor({
   name: `${botUser?.username ?? 'Music Bot'} • Hàng đợi phát nhạc`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setDescription([
   current
    ? `▶️ **Đang phát:** **${cleanText(current.title, 80)}** (\`${formatDuration(current.duration)}\`)${curWho}`
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
 const ownerId = resolveOwnerId(player, current);
 const { barText, endUnix } = renderSyncedProgress(player, current, Boolean(player?.isPaused));
 const webUrl = resolveNowPlayingWebUrl();

 const embed = new EmbedBuilder()
  .setColor(player?.isPaused ? 0xfee75c : 0x7c4dff)
  .setAuthor({
   name: `${botUser?.username ?? 'Music Bot'} • Bài hát hiện tại`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setTitle(`🎵 ${cleanText(current?.title ?? 'Chưa phát bài nào', 95)}`)
  .setDescription([
   `👤 **Nghệ sĩ:** ${cleanText(current?.metadata?.author ?? 'Không rõ', 50)} • **Nguồn:** ${resolveSourceLabel(current?.source)}`,
   ownerId ? `👑 **Người điều khiển:** <@${ownerId}>` : '',
   webUrl ? `🌐 **Web trực tuyến:** [Mở Now Playing](${webUrl})` : '',
   '',
   player?.isPaused
    ? '⏸️ **Tạm dừng**'
    : (endUnix ? `▶️ **Đang phát** • ⏳ hết bài <t:${endUnix}:R>` : '▶️ **Đang phát**'),
   `\`${barText}\``,
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

