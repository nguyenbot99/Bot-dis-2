import {
 ActionRowBuilder,
 ApplicationCommandType,
 ChannelType,
 ContextMenuCommandBuilder,
 EmbedBuilder,
 InteractionContextType,
 SlashCommandBuilder,
 StringSelectMenuBuilder,
 StringSelectMenuOptionBuilder,
} from 'discord.js';
import { resolveNowPlayingWebUrl } from './playerGui.js';
import { CONTEXT_GIF_NAME } from './videoToGif.js';

export { CONTEXT_GIF_NAME };
export const CONTEXT_PLAY_NAME = '▶️ Phát / Thêm nhạc';
export const CONTEXT_AVATAR_NAME = '🖼️ Soi Avatar 4K';

// Giữ nguyên tên lệnh và tên tham số bằng tiếng Anh/số chuẩn Discord (lưu ý Discord không cho dấu "/" trong tên lệnh nên 24/7 viết là /247);
// Việt hóa toàn bộ phần chú thích hiển thị trên Discord.
const definitions = [
 ['help', 'Xem danh sách toàn bộ lệnh và hướng dẫn sử dụng bot'],
 ['join', 'Gọi bot tham gia vào kênh thoại hiện tại của bạn'],
 ['leave', 'Cho bot dừng nhạc, tắt chế độ 24/7 và rời khỏi kênh thoại'],
 ['247', 'Bật hoặc tắt chế độ treo kênh thoại 24/7 (không tự rời khi hết nhạc)'],
 ['tts', 'Đọc văn bản bằng giọng chị Google hoặc giọng biến hình tấu hài trong kênh thoại'],
 ['sfx', 'Phát tiếng động Meme tấu hài trong kênh thoại (tự dừng & phát tiếp nhạc)'],
 ['fav', 'Quản lý & phát Tủ nhạc Yêu thích cá nhân của riêng bạn'],
 ['mixtape', 'Quản lý & phát Tủ nhạc Chung theo chủ đề của cả máy chủ'],
 ['sleeptimer', 'Hẹn giờ tự động giảm nhỏ âm lượng rồi tắt nhạc êm ái khi đi ngủ'],
 ['radio', 'Mở Đài Radio Không Ngủ theo tâm trạng (tự lên danh sách & phát xuyên đêm)'],
 ['vibe', 'Biến đổi Vibe bài hát trực tiếp: Chuẩn Gốc / Nightcore / Slowed + Echo / Lo-Fi'],
 ['ambient', 'Trộn âm thanh thiên nhiên nền (Mưa đêm, Lửa trại, Sóng biển, Gió đêm) vào nhạc'],
 ['play', 'Phát nhạc từ tên bài, link lẻ hoặc nguyên Playlist / Album Spotify & SoundCloud'],
 ['search', 'Tìm bài hát và tự tay chọn đúng phiên bản ưng ý nhất trong Top 5 kết quả'],
 ['dedicate', 'Gửi tặng bài hát kèm lời nhắn vinh danh lên khung nhạc Discord & Website'],
 ['similar', 'Bơm ngay 5 bài hát cùng Vibe & cùng gu với bài đang phát vào hàng đợi'],
 ['replay', 'Tua nhanh bài hát đang phát về lại từ đầu (0:00)'],
 ['grab', 'Bỏ túi thông tin, ảnh bìa & link bài đang nghe về Tin nhắn riêng (DM) của bạn'],
 ['savequeue', 'Đóng gói bài đang phát & toàn bộ hàng đợi thành Thẻ Phiên Nhạc để hôm sau mở lại 1 chạm'],
 ['webkey', 'Lấy mã PIN 6 số để điều khiển nhạc 2 chiều trực tiếp từ trên Website'],
 ['avatar', 'Soi ảnh đại diện gốc / Server / Banner 4K chống tự xóa & tự đăng lại nếu bị xóa'],
 ['gif', 'Chuyển đổi Video sang ảnh động GIF nét cao (cắt giây, tốc độ, chèn chữ Meme)'],
 ['spamtag', 'Réo tên (@tag) gọi bạn bè liên tục kèm nút Dừng ngay & Xóa sạch dấu vết (chỉ Chủ Bot)'],
 ['lock', 'Khóa kênh chat (hỗ trợ chế độ 📢 Kênh Thông Báo hiện nút Theo dõi y hệt mẫu, chỉ Chủ Bot)'],
 ['unlock', 'Mở khóa lại kênh chat đã khóa về trạng thái bình thường (chỉ Chủ Bot)'],
 ['announce', 'Cho Bot đăng thông báo / bài viết vào kênh đã khóa kèm thả sẵn ❤️ 🔥 (chỉ Chủ Bot)'],
 ['pause', 'Tạm dừng bài hát đang phát'],
 ['resume', 'Tiếp tục phát bài hát đang tạm dừng'],
 ['skip', 'Bỏ qua bài hiện tại (hoặc nhảy thẳng tới bài ở vị trí chọn trong hàng đợi)'],
 ['previous', 'Quay lại bài hát vừa phát trước đó'],
 ['seek', 'Tua bài hát đang phát tới mốc thời gian mong muốn (ví dụ 1:30 hoặc 90)'],
 ['stop', 'Dừng phát nhạc và xóa toàn bộ hàng đợi'],
 ['autoplay', 'Bật hoặc tắt tự động phát nhạc liên quan khi hết hàng đợi'],
 ['loop', 'Chỉnh chế độ lặp nhạc (tắt, lặp một bài hoặc lặp hàng đợi)'],
 ['shuffle', 'Trộn ngẫu nhiên thứ tự các bài đang chờ trong hàng đợi'],
 ['move', 'Đổi vị trí một bài hát đang chờ trong hàng đợi'],
 ['remove', 'Xóa một bài hát khỏi hàng đợi theo số thứ tự trong /queue'],
 ['clear', 'Xóa toàn bộ các bài đang chờ mà không dừng bài hiện tại'],
 ['volume', 'Điều chỉnh âm lượng phát nhạc tùy thích từ 0% đến 200%'],
 ['queue', 'Xem danh sách tối đa 10 bài hát tiếp theo trong hàng đợi'],
 ['history', 'Xem danh sách tối đa 10 bài hát vừa phát gần đây'],
 ['nowplaying', 'Xem thông tin chi tiết bài hát đang được phát'],
 ['lyrics', 'Tìm và xem lời bài hát đang phát hoặc theo tên bài nhập vào'],
 ['stats', 'Xem Bảng Vàng Âm Nhạc Server (Top bài, Top DJ) hoặc hồ sơ gu nhạc của bạn'],
 ['ping', 'Kiểm tra độ trễ kết nối và mức bộ nhớ Node của bot'],
];

// Danh mục phân trang gọn gàng cho lệnh /help (chọn danh mục qua menu thả xuống giống giao diện mẫu trên điện thoại & PC).
export const HELP_CATEGORIES = Object.freeze([
 {
  key: 'music_search',
  label: 'Phát nhạc & Tìm kiếm',
  description: 'Xem các lệnh thuộc danh mục Phát nhạc & Tìm kiếm',
  color: 0xc084fc,
  items: [
   ['`/play` `query` `[next]`', 'Phát nhạc ngay từ tên bài, link lẻ hoặc trọn bộ Playlist / Album Spotify & SoundCloud'],
   ['`/search` `query` `[next]`', 'Tìm Top 5 phiên bản khớp nhất và tự tay chọn đúng bản muốn nghe'],
   ['`/dedicate` `query` `to` `message`', 'Gửi tặng bài hát kèm lời chúc hiện lên Khung Nhạc Discord & Website Karaoke'],
   ['`/similar`', 'Dò sóng từ bài đang nghe và bơm tiếp 5 bài hát cùng gu vào hàng đợi'],
   ['`/radio` `station`', 'Mở Đài Radio Không Ngủ theo tâm trạng (Lo-Fi, V-Pop, EDM, Piano, US-UK, Ngủ ngon)'],
   ['`/replay`', 'Tua nhanh bài hát đang phát quay lại từ đầu (`0:00`)'],
  ],
  extraNote: '🖱️ **Mẹo cực nhanh:** Chạm giữ (hoặc chuột phải) vào bất kỳ tin nhắn nào trong chat -> chọn **Ứng dụng (Apps) -> ▶️ Phát / Thêm nhạc** để bắt bài ngay không cần gõ lệnh!',
 },
 {
  key: 'playback_ctrl',
  label: 'Điều khiển nhạc',
  description: 'Xem các lệnh thuộc danh mục Điều khiển nhạc',
  color: 0xa855f7,
  items: [
   ['`/pause`', 'Tạm dừng bài hát đang phát (giữ nguyên mốc giây kể cả khi dừng lâu)'],
   ['`/resume`', 'Tiếp tục phát bài hát đang tạm dừng'],
   ['`/skip` `[to]`', 'Bỏ qua bài hiện tại hoặc nhảy thẳng tới bài thứ `#to` trong hàng đợi'],
   ['`/previous`', 'Quay lại bài hát vừa phát liền trước đó'],
   ['`/seek` `time`', 'Tua bài đang phát tới mốc bất kỳ (ví dụ: `1:30` hoặc `90`)'],
   ['`/stop`', 'Dừng phát nhạc và dọn sạch hàng đợi (vẫn giữ phòng nếu đang bật 24/7)'],
   ['`/volume` `percent`', 'Chỉnh âm lượng phát nhạc tùy ý từ `0%` đến `200%`'],
   ['`/webkey` `[action]`', 'Lấy mã PIN 6 số mở khóa **Điều khiển nhạc 2 chiều từ Website**'],
  ],
 },
 {
  key: 'studio_dsp',
  label: 'Chất âm & Không gian',
  description: 'Xem các lệnh thuộc danh mục Chất âm & Không gian',
  color: 0xe879f9,
  items: [
   ['`/vibe` `mode`', 'Biến đổi trực tiếp bài đang phát: `Chuẩn Gốc` • `Nightcore` • `Slowed + Echo` • `Lo-Fi Đĩa Than`'],
   ['`/ambient` `mode` `[level]`', 'Hòa trộn tiếng thiên nhiên nền (`Mưa đêm`, `Lửa trại`, `Sóng biển`, `Gió đêm`) từ `10%–85%`'],
  ],
  extraNote: '💡 **Mẹo:** Bạn có thể đổi nhanh 5 chế độ **Studio EQ** (`Rõ nét HD`, `Rõ lời Vocal`, `Siêu Trầm Bass`, `8D Vòm`, `Mộc Flat`) ngay trên menu của Khung Nhạc!',
 },
 {
  key: 'queue_room',
  label: 'Hàng đợi & Phòng thoại',
  description: 'Xem các lệnh thuộc danh mục Hàng đợi & Phòng thoại',
  color: 0x818cf8,
  items: [
   ['`/join`', 'Gọi bot vào kênh thoại hiện tại của bạn (tự khôi phục bài dở nếu vừa bị kick)'],
   ['`/leave`', 'Tắt chế độ 24/7, xóa hàng đợi và cho bot rời khỏi phòng thoại'],
   ['`/247` `[mode]`', 'Bật hoặc tắt chế độ treo phòng thoại 24/7 xuyên ngày đêm'],
   ['`/sleeptimer` `[minutes]` `[after_track]`', 'Hẹn giờ tự giảm nhỏ âm lượng rồi tắt nhạc êm ái khi đi ngủ'],
   ['`/autoplay` `[mode]`', 'Tự động tìm và phát tiếp nhạc liên quan khi hết hàng đợi'],
   ['`/loop` `mode`', 'Chỉnh chế độ lặp: `off` (Tắt), `track` (Lặp 1 bài), `queue` (Lặp cả danh sách)'],
   ['`/shuffle`', 'Trộn ngẫu nhiên thứ tự các bài đang chờ trong hàng đợi'],
   ['`/move` `from` `to`', 'Đổi vị trí một bài hát trong danh sách chờ `/queue`'],
   ['`/remove` `position`', 'Xóa một bài khỏi hàng đợi theo số thứ tự trong `/queue`'],
   ['`/clear`', 'Xóa toàn bộ các bài đang chờ mà không làm đứt bài đang hát'],
  ],
 },
 {
  key: 'cabinet',
  label: 'Tủ nhạc & Mixtape',
  description: 'Xem các lệnh thuộc danh mục Tủ nhạc & Mixtape',
  color: 0xf472b6,
  items: [
   ['`/fav` `action` `[query]` `[position]`', 'Quản lý & phát **Tủ nhạc Yêu thích cá nhân** của riêng bạn (tối đa 25 bài/người)'],
   ['`/mixtape` `action` `[name]` `[query]`', 'Cùng anh em lập & phát **Tủ đĩa Mixtape chung của cả hội** (5 chủ đề × 20 bài)'],
   ['`/savequeue` `[destination]` `[title]`', 'Đóng gói nguyên dàn bài đang nghe thành **Thẻ Phiên Nhạc** để hôm sau mở lại 1 chạm'],
   ['`/grab`', 'Bỏ túi thẻ bài hát đang nghe kèm link gốc về **Tin nhắn riêng (DM)** của bạn'],
  ],
 },
 {
  key: 'voice_fun',
  label: 'Giải trí phòng thoại',
  description: 'Xem các lệnh thuộc danh mục Giải trí phòng thoại',
  color: 0x38bdf8,
  items: [
   ['`/tts` `text` `[lang]` `[voice]` `[slow]`', 'Đọc văn bản trong kênh thoại với 5 giọng: `Chị Google`, `Loa Phường`, `Minion`, `Boss`, `Hang Động`'],
   ['`/sfx` `effect`', 'Thả 8 hiệu ứng âm thanh Meme (`Ba-dum-tss`, `Dế kêu`, `Airhorn`, `Bass Drop`, `WinXP`...)'],
  ],
  extraNote: '✨ *Ai đang ngồi cùng kênh thoại cũng dùng được `/tts` và `/sfx` — nhạc đang phát sẽ tự tạm dừng rồi nối lại mượt mà!*',
 },
 {
  key: 'utility',
  label: 'Tra cứu & Tiện ích',
  description: 'Xem các lệnh thuộc danh mục Tra cứu & Tiện ích',
  color: 0x34d399,
  items: [
   ['`/gif` `[video]` `[url]` `[caption]` `[speed]`', 'Đổi Video sang ảnh động **GIF nét cao** (cắt giây, tốc độ `0.25x–3x`, chèn chữ Meme — dùng cả trong DM!)'],
   ['`/avatar` `[user]` `[type]`', 'Soi Avatar gốc / Avatar Server / Banner **4K** đóng băng file thật & **chống xóa tự động**'],
   ['`/nowplaying`', 'Xem thẻ thông tin chi tiết bài hát đang phát hiện tại'],
   ['`/lyrics` `[query]`', 'Tìm lời bài hát đang phát hoặc tra lời theo tên bài bất kỳ'],
   ['`/queue`', 'Xem danh sách các bài hát sắp phát tiếp theo'],
   ['`/history`', 'Xem danh sách 10 bài hát vừa phát gần đây nhất'],
   ['`/stats` `[scope]`', 'Xem **Bảng Vàng Âm Nhạc** toàn máy chủ (Top Bài & Top DJ) hoặc hồ sơ cá nhân'],
   ['`/ping`', 'Kiểm tra độ trễ mạng Discord và mức tiêu thụ RAM hiện tại của bot'],
   ['`/help` `[category]`', 'Mở bảng danh mục lệnh rút gọn này'],
  ],
  extraNote: '🎞️ **Mẹo cực nhanh:** Chạm giữ (hoặc chuột phải) vào tin nhắn có video -> **Ứng dụng (Apps) -> 🎞️ Đổi video sang GIF** (hoặc chọn thành viên -> **🖼️ Soi Avatar 4K**) không cần gõ lệnh!',
 },
 {
  key: 'owner_tools',
  label: 'Quản trị Kênh & Chủ Bot',
  description: 'Các lệnh khóa kênh 📢 Theo dõi, đăng thông báo & réo tên riêng cho Chủ Bot',
  color: 0xef4444,
  items: [
   ['`/lock` `[channel]` `[mode]` `[reactions]` `[role]`', 'Khóa kênh chat — hỗ trợ **Kênh 📢 Thông Báo hiện nút xanh `[Theo dõi]`** + giữ thả tim `❤️🔥` *(chỉ Chủ Bot)*'],
   ['`/unlock` `[channel]` `[revert_normal]` `[role]`', 'Mở khóa lại kênh chat đã khóa về bình thường *(chỉ Chủ Bot)*'],
   ['`/announce` `[channel]` `[message]` `[ping_role]` `[style]`', 'Cho Bot đăng bài / thông báo vào kênh đã khóa (bỏ trống `message` sẽ mở bảng gõ nhiều dòng) *(chỉ Chủ Bot)*'],
   ['`/spamtag` `[user]` `[action]` `[count]` `[message]`', 'Réo tên (`@tag`) gọi bạn bè liên tục (1–100 lần) kèm nút **🛑 Dừng** & **🧹 Xóa sạch** *(chỉ Chủ Bot)*'],
  ],
 },
]);

// Dựng giao diện /help gọn gàng theo danh mục (Trang bìa tổng quan + Menu "Chọn danh mục" giống ảnh mẫu).
export function buildHelpPayload({ botUser = null, guild = null, category = 'overview' } = {}) {
 const botName = botUser?.username ?? 'Music Bot';
 const botAvatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const guildName = guild?.name ?? botName;
 const guildIconUrl = guild?.iconURL?.({ size: 128 }) ?? botAvatarUrl;
 const webUrl = resolveNowPlayingWebUrl();
 const totalCategories = HELP_CATEGORIES.length;
 const totalCommands = definitions.length;

 const selectedCat = HELP_CATEGORIES.find(c => c.key === category) ?? null;
 let embed;

 if (!selectedCat) {
  const descLines = [
   '🌸 **Tiền tố (lệnh) :** `/` *(Slash Commands)* + **Chạm giữ tin nhắn (Apps)**',
   `💿 **Tổng số lệnh :** **${totalCommands}** lệnh \`/\` chia làm **${totalCategories}** danh mục`,
   webUrl ? `🌐 **Phòng nghe & Điều khiển Web :** [Mở Live Radio, Karaoke & Web Remote](${webUrl})` : null,
  ].filter(Boolean);

  embed = new EmbedBuilder()
   .setColor(0xc084fc)
   .setAuthor({
    name: guildName,
    ...(guildIconUrl ? { iconURL: guildIconUrl } : {}),
   })
   .setTitle(`Danh sách các lệnh của ${botName}`)
   .setDescription(descLines.join('\n'))
   .setFooter({
    text: `Tổng ${totalCategories} danh mục lệnh`,
    ...(botAvatarUrl ? { iconURL: botAvatarUrl } : {}),
   })
   .setTimestamp();
 } else {
  const cmdLines = selectedCat.items.map(
   ([syntax, desc]) => `• ${syntax}\n  ╰ *${desc}*`,
  );
  if (selectedCat.extraNote) {
   cmdLines.push('', selectedCat.extraNote);
  }

  embed = new EmbedBuilder()
   .setColor(selectedCat.color)
   .setAuthor({
    name: `${guildName} • Danh mục lệnh`,
    ...(guildIconUrl ? { iconURL: guildIconUrl } : {}),
   })
   .setTitle(`${selectedCat.label} (${selectedCat.items.length} lệnh)`)
   .setDescription(cmdLines.join('\n'))
   .setFooter({
    text: `Danh mục: ${selectedCat.label} • Tổng ${totalCategories} danh mục lệnh`,
    ...(botAvatarUrl ? { iconURL: botAvatarUrl } : {}),
   })
   .setTimestamp();
 }

 const menuOptions = [];
 if (selectedCat) {
  menuOptions.push(
   new StringSelectMenuOptionBuilder()
    .setLabel('Tổng quan')
    .setDescription('Quay về trang chính danh sách các danh mục lệnh')
    .setValue('overview'),
  );
 }
 for (const cat of HELP_CATEGORIES) {
  menuOptions.push(
   new StringSelectMenuOptionBuilder()
    .setLabel(cat.label)
    .setDescription(cat.description)
    .setValue(cat.key),
  );
 }

 const select = new StringSelectMenuBuilder()
  .setCustomId('help_category')
  .setPlaceholder(selectedCat ? `Đang xem: ${selectedCat.label} • Chọn danh mục` : 'Chọn danh mục')
  .addOptions(menuOptions);

 return {
  embeds: [embed],
  components: [new ActionRowBuilder().addComponents(select)],
  allowedMentions: { parse: [] },
 };
}

// Tạo khung Embed tổng hợp đầy đủ (giữ tương thích cho các bài test kiểm tra toàn bộ lệnh).
export function buildHelpEmbed(botUser) {
 const botName = botUser?.username ?? 'Music Bot';
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const webUrl = resolveNowPlayingWebUrl();

 const embed = new EmbedBuilder()
  .setColor(0x5865f2)
  .setAuthor({
   name: `${botName} • Trung tâm trợ giúp`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setTitle('🎵 Bảng Lệnh & Hướng Dẫn Sử Dụng')
  .setDescription([
   'Hãy vào một **kênh thoại thường** rồi nhập `/play` — bot sẽ hiện **khung Music Player tương tác HD** kèm nút bấm & menu ngay tại kênh chat!',
   webUrl ? `🌐 **Theo dõi bài đang phát trực tuyến:** [Mở Website Now Playing](${webUrl})` : null,
   '> 🔒 *Chỉ **người yêu cầu bài đang phát** (cùng kênh thoại) mới bấm hoặc gõ lệnh thay đổi nhạc được.*',
  ].filter(Boolean).join('\n'))
  .addFields(
   {
    name: '🎙️ Kết nối, Đài Radio & Giải trí',
    value: [
     '`/join` • `/leave` • `/247` — Vào/rời kênh thoại hoặc giữ kết nối 24/7',
     '`/radio` `station` — Mở Đài Radio Không Ngủ (Lofi, V-Pop, EDM, Piano...)',
     '`/tts` `text` `[voice]` — Chị Google / Loa Phường / Minion / Boss / Hang Động',
     '`/sfx` `effect` — Thả tiếng động Meme tấu hài trong phòng thoại',
     '`/autoplay` `[mode]` • `/similar` — Tự phát nhạc liên quan hoặc bơm ngay 5 bài cùng gu',
    ].join('\n'),
   },
   {
    name: '▶️ Phát, Chọn bản, Tặng nhạc & Tủ chung',
    value: [
     '`/play` `query` • `/search` `query` — Phát ngay (hỗ trợ Playlist) hoặc chọn từ Top 5',
     '`/dedicate` `query` `to` `message` — Tặng bài hát kèm lời nhắn lên Discord & Web',
     '`/fav` `action` • `/mixtape` `action` • `/savequeue` — Tủ cá nhân, Tủ hội & Lưu hàng đợi',
     '`/sleeptimer` • `/webkey` — Hẹn giờ đi ngủ & Mã PIN điều khiển nhạc trên Website',
     '`/pause` • `/resume` • `/stop` — Tạm dừng, tiếp tục hoặc dừng hẳn nhạc',
     '`/skip` • `/previous` • `/replay` • `/seek` — Qua bài, bài trước, từ `0:00` hoặc tua giây',
    ].join('\n'),
   },
   {
    name: '🎛️ Hàng đợi, Vibe, Tiếng Mưa & Âm thanh',
    value: [
     '`/vibe` `mode` — Biến đổi trực tiếp: `normal` • `nightcore` • `slowed` • `lofi`',
     '`/ambient` `mode` `[level]` — Trộn nền **Mưa đêm / Lửa trại / Sóng biển / Gió**',
     '`/volume` `percent` — Tùy chỉnh mức âm lượng phát bất kỳ (`0%` – `200%`)',
     '`/loop` `mode` • `/shuffle` • `/clear` — Lặp nhạc, trộn hoặc xóa sạch danh sách chờ',
     '`/move` `from` `to` • `/remove` `position` — Đổi chỗ / xóa bài trong `/queue`',
    ].join('\n'),
   },
   {
    name: '📋 Tiện ích, Quản trị Kênh & Bảng Vàng',
    value: [
     '`/gif` `[video]` `[caption]` — Chuyển Video sang **GIF nét cao** + chèn chữ Meme (Server & DM)',
     '`/avatar` `[user]` `[type]` — Soi Avatar/Banner 4K (đóng băng ảnh & chống xóa tự động)',
     '`/lock` • `/unlock` • `/announce` — Khóa kênh kiểu 📢 Theo dõi & Đăng bài bằng Bot *(Chủ Bot)*',
     '`/spamtag` `[user]` `[action]` — Réo tên `@tag` (1–100 lần) kèm nút Dừng & Xóa sạch *(Chủ Bot)*',
     '`/nowplaying` • `/grab` — Xem chi tiết bài hát hoặc bỏ túi về Tin nhắn riêng (DM)',
     '`/lyrics` `[query]` • `/stats` `[scope]` — Xem lời bài hát & **Bảng Vàng Top Nhạc/DJ**',
     '`/queue` • `/history` • `/ping` • `/help` — Hàng đợi, lịch sử, kiểm tra RAM & hướng dẫn',
    ].join('\n'),
   },
   {
    name: '🎧 Nguồn, Chất âm & Vibe',
    value: 'YT, SC & Playlist Spotify\n**HD • Vocal • Bass • 8D • Nightcore • Slowed**',
    inline: true,
   },
   {
    name: '⚙️ Giới hạn phiên',
    value: 'Tối đa **20 bài** chờ\nThời lượng **≤ 180 phút/bài**',
    inline: true,
   },
  )
  .setFooter({ text: 'Đổi chế độ Chất âm, AutoPlay, 24/7 & Lời bài hát ngay trên menu của khung Music Player!' })
  .setTimestamp();

 if (avatarUrl) embed.setThumbnail(avatarUrl);
 return embed;
}

export const slashCommands = definitions.map(([name, description]) => {
 const c = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
 if (name === 'help') {
  c.addStringOption(o => o
   .setName('category')
   .setDescription('Mở thẳng một danh mục lệnh cụ thể (để trống để mở menu Chọn danh mục gọn gàng)')
   .setRequired(false)
   .addChoices(
    ...HELP_CATEGORIES.map(cat => ({ name: cat.label, value: cat.key })),
   ));
 }
 if (name === 'play') {
  c.addStringOption(o => o
   .setName('query')
   .setDescription('Tên bài hát hoặc link HTTPS bài lẻ YouTube / SoundCloud / Spotify')
   .setRequired(true)
   .setMaxLength(400));
  c.addBooleanOption(o => o
   .setName('next')
   .setDescription('Đặt true để chèn bài này lên đầu hàng đợi (phát ngay sau bài hiện tại)')
   .setRequired(false));
 }
 if (name === 'skip') {
  c.addIntegerOption(o => o
   .setName('to')
   .setDescription('Nhảy cóc thẳng tới số thứ tự bài trong /queue (để trống nếu chỉ qua 1 bài)')
   .setRequired(false)
   .setMinValue(1)
   .setMaxValue(20));
 }
 if (name === 'seek') {
  c.addStringOption(o => o
   .setName('time')
   .setDescription('Mốc thời gian muốn tua tới (ví dụ: 1:30 hoặc 90)')
   .setRequired(true)
   .setMaxLength(12));
 }
 if (name === '247') {
  c.addStringOption(o => o
   .setName('mode')
   .setDescription('Chọn bật hoặc tắt 24/7 (để trống để tự đảo trạng thái)')
   .setRequired(false)
   .addChoices(
    { name: 'Bật 24/7', value: 'on' },
    { name: 'Tắt 24/7', value: 'off' },
   ));
 }
 if (name === 'autoplay') {
  c.addStringOption(o => o
   .setName('mode')
   .setDescription('Chọn bật hoặc tắt tự động phát nhạc liên quan (để trống để tự đảo)')
   .setRequired(false)
   .addChoices(
    { name: 'Bật AutoPlay', value: 'on' },
    { name: 'Tắt AutoPlay', value: 'off' },
   ));
 }
 if (name === 'loop') {
  c.addStringOption(o => o
   .setName('mode')
   .setDescription('Chọn chế độ lặp muốn áp dụng')
   .setRequired(true)
   .addChoices(
    { name: 'Tắt lặp', value: 'off' },
    { name: 'Lặp một bài', value: 'track' },
    { name: 'Lặp hàng đợi', value: 'queue' },
   ));
 }
 if (name === 'move') {
  c.addIntegerOption(o => o
   .setName('from')
   .setDescription('Vị trí hiện tại của bài hát trong /queue (1–20)')
   .setRequired(true)
   .setMinValue(1)
   .setMaxValue(20));
  c.addIntegerOption(o => o
   .setName('to')
   .setDescription('Vị trí mới muốn chuyển tới trong /queue (1–20)')
   .setRequired(true)
   .setMinValue(1)
   .setMaxValue(20));
 }
 if (name === 'volume') {
  c.addIntegerOption(o => o
   .setName('percent')
   .setDescription('Mức âm lượng mong muốn (nhập số bất kỳ từ 0 đến 200)')
   .setRequired(true)
   .setMinValue(0)
   .setMaxValue(200));
 }
 if (name === 'remove') {
  c.addIntegerOption(o => o
   .setName('position')
   .setDescription('Số thứ tự bài chờ xem trong /queue (bắt đầu từ 1)')
   .setRequired(true)
   .setMinValue(1)
   .setMaxValue(20));
 }
 if (name === 'lyrics') {
  c.addStringOption(o => o
   .setName('query')
   .setDescription('Tên bài hát muốn tìm lời (để trống để lấy lời bài đang phát)')
   .setRequired(false)
   .setMaxLength(150));
 }
 if (name === 'tts') {
  c.addStringOption(o => o
   .setName('text')
   .setDescription('Nội dung văn bản muốn chị Google đọc trong kênh thoại (tối đa 500 ký tự)')
   .setRequired(true)
   .setMaxLength(500));
  c.addStringOption(o => o
   .setName('lang')
   .setDescription('Ngôn ngữ giọng đọc (mặc định: Tiếng Việt)')
   .setRequired(false)
   .addChoices(
    { name: '🇻🇳 Tiếng Việt (Chị Google)', value: 'vi' },
    { name: '🇺🇸 Tiếng Anh (English)', value: 'en' },
    { name: '🇯🇵 Tiếng Nhật (日本語)', value: 'ja' },
    { name: '🇰🇷 Tiếng Hàn (한국어)', value: 'ko' },
    { name: '🇨🇳 Tiếng Trung (中文)', value: 'zh-CN' },
    { name: '🇫🇷 Tiếng Pháp (Français)', value: 'fr' },
    { name: '🇹🇭 Tiếng Thái (ไทย)', value: 'th' },
   ));
  c.addBooleanOption(o => o
   .setName('slow')
   .setDescription('Đọc chậm rãi từng chữ kiểu tấu hài (mặc định: tắt)')
   .setRequired(false));
  c.addStringOption(o => o
   .setName('voice')
   .setDescription('Biến hình giọng đọc tấu hài theo thời gian thực (mặc định: Chị Google Chuẩn)')
   .setRequired(false)
   .addChoices(
    { name: '👩 Chị Google Chuẩn', value: 'normal' },
    { name: '📻 Loa Phường Đầu Ngõ', value: 'loaphuong' },
    { name: '🐿️ Minion Nhí Nhố (Tua cao)', value: 'minion' },
    { name: '👹 Boss Cuối Trầm Ngầu', value: 'boss' },
    { name: '🕳️ Vang Vọng Hang Động', value: 'cave' },
   ));
 }
 if (name === 'sfx') {
  c.addStringOption(o => o
   .setName('effect')
   .setDescription('Chọn hiệu ứng tiếng động Meme muốn phát trong phòng thoại')
   .setRequired(true)
   .addChoices(
    { name: '🥁 Trống Ba-dum-tss (Chốt câu tấu hài)', value: 'badumtss' },
    { name: '🦗 Tiếng dế kêu (Quê độ / Im phăng phắc)', value: 'crickets' },
    { name: '📯 Còi hơi Airhorn (Khuấy động phòng)', value: 'airhorn' },
    { name: '💥 Bass Drop Cực Căng (Sub-bass chấn động)', value: 'bassdrop' },
    { name: '🎺 Kèn quê độ Wah-Wah-Waaah (Thất bại)', value: 'sadtrombone' },
    { name: '💻 Windows XP Tắt máy (Tạm biệt đi ngủ)', value: 'winxp' },
    { name: '🎉 Kèn Fanfare & Pháo tay chúc mừng', value: 'applause' },
    { name: '🤬 Tiếng Bíp che từ nhạy cảm (Censor 1kHz)', value: 'beep' },
   ));
 }
 if (name === 'fav') {
  c.addStringOption(o => o
   .setName('action')
   .setDescription('Thao tác với Tủ nhạc Yêu thích cá nhân của bạn')
   .setRequired(true)
   .addChoices(
    { name: '❤️ Lưu bài đang phát (hoặc theo tên/link)', value: 'add' },
    { name: '▶️ Phát toàn bộ Tủ nhạc Yêu thích', value: 'play' },
    { name: '🔀 Trộn ngẫu nhiên & phát Tủ nhạc Yêu thích', value: 'shuffle' },
    { name: '📋 Xem danh sách Tủ nhạc Yêu thích của bạn', value: 'list' },
    { name: '➖ Xóa 1 bài khỏi Tủ nhạc theo số thứ tự', value: 'remove' },
    { name: '🗑️ Xóa sạch toàn bộ Tủ nhạc của bạn', value: 'clear' },
   ));
  c.addStringOption(o => o
   .setName('query')
   .setDescription('Tên bài hoặc link muốn lưu (chỉ dùng cho action=add khi muốn lưu bài bất kỳ)')
   .setRequired(false)
   .setMaxLength(400));
  c.addIntegerOption(o => o
   .setName('position')
   .setDescription('Số thứ tự bài muốn xóa trong danh sách /fav list (1–25)')
   .setRequired(false)
   .setMinValue(1)
   .setMaxValue(25));
 }
 if (name === 'sleeptimer') {
  c.addIntegerOption(o => o
   .setName('minutes')
   .setDescription('Số phút hẹn giờ tắt nhạc (nhập 0 để hủy hẹn giờ, 1–180 phút)')
   .setRequired(false)
   .setMinValue(0)
   .setMaxValue(180));
  c.addBooleanOption(o => o
   .setName('after_track')
   .setDescription('Đặt True để tự tắt nhạc ngay khi phát xong bài hiện tại')
   .setRequired(false));
  c.addBooleanOption(o => o
   .setName('leave_voice')
   .setDescription('Đặt True để tự rời phòng thoại luôn sau khi tắt nhạc (kể cả đang bật 24/7)')
   .setRequired(false));
 }
 if (name === 'vibe') {
  c.addStringOption(o => o
   .setName('mode')
   .setDescription('Chọn phong cách Vibe muốn biến đổi ngay trên bài đang phát')
   .setRequired(true)
   .addChoices(
    { name: '🎵 Chuẩn Gốc (1.0x tự nhiên)', value: 'normal' },
    { name: '⚡ Nightcore Sôi Động (1.20x tăng tốc & nâng tông)', value: 'nightcore' },
    { name: '🌧️ Slowed + Echo Đêm Muộn (0.86x chậm sâu lắng)', value: 'slowed' },
    { name: '☕ Lo-Fi Đĩa Than (Lọc ấm băng từ + tiếng đĩa vinyl)', value: 'lofi' },
   ));
 }
 if (name === 'radio') {
  c.addStringOption(o => o
   .setName('station')
   .setDescription('Chọn Đài Radio tâm trạng muốn phát tự động xuyên suốt')
   .setRequired(true)
   .addChoices(
    { name: '☕ Lo-Fi Chill Học Bài & Code Đêm', value: 'lofi' },
    { name: '🇻🇳 V-Pop Ballad & Indie Tâm Trạng', value: 'vpop' },
    { name: '🔥 EDM & Remix Khuấy Động Phòng', value: 'edm' },
    { name: '🎹 Piano & Anime Ghibli Không Lời', value: 'piano' },
    { name: '🌎 US-UK Pop & Chill Hits', value: 'usuk' },
    { name: '🌧️ Acoustic & Ambient Dịu Êm Dễ Ngủ', value: 'sleep' },
   ));
 }
 if (name === 'stats') {
  c.addStringOption(o => o
   .setName('scope')
   .setDescription('Xem Bảng Vàng toàn máy chủ hoặc hồ sơ DJ của riêng bạn')
   .setRequired(false)
   .addChoices(
    { name: '🏆 Toàn máy chủ (Top Bài Hát & Top DJ)', value: 'server' },
    { name: '🎧 Cá nhân (Hạng DJ & số giờ nhạc của bạn)', value: 'me' },
   ));
 }
 if (name === 'ambient') {
  c.addStringOption(o => o
   .setName('mode')
   .setDescription('Chọn tiếng thiên nhiên nền trộn êm bên dưới nhạc đang phát')
   .setRequired(true)
   .addChoices(
    { name: '🔇 Tắt âm thanh nền', value: 'off' },
    { name: '🌧️ Mưa Đêm Ngoài Hiên', value: 'rain' },
    { name: '🔥 Lửa Trại Tí Tách', value: 'fire' },
    { name: '🌊 Sóng Biển Rì Rào', value: 'ocean' },
    { name: '🍃 Gió Đêm Cao Nguyên', value: 'wind' },
   ));
  c.addIntegerOption(o => o
   .setName('level')
   .setDescription('Độ lớn tiếng nền thiên nhiên từ 10% đến 85% (mặc định: 35%)')
   .setRequired(false)
   .setMinValue(10)
   .setMaxValue(85));
 }
 if (name === 'search') {
  c.addStringOption(o => o
   .setName('query')
   .setDescription('Tên bài hát muốn tìm để tự chọn đúng phiên bản trong Top 5 kết quả')
   .setRequired(true)
   .setMaxLength(400));
  c.addBooleanOption(o => o
   .setName('next')
   .setDescription('Đặt True để chèn bài bạn chọn lên đầu hàng đợi (phát ngay kế tiếp)')
   .setRequired(false));
 }
 if (name === 'dedicate') {
  c.addStringOption(o => o
   .setName('query')
   .setDescription('Tên bài hát hoặc link lẻ muốn gửi tặng')
   .setRequired(true)
   .setMaxLength(400));
  c.addUserOption(o => o
   .setName('to')
   .setDescription('Thành viên nhận món quà âm nhạc này')
   .setRequired(true));
  c.addStringOption(o => o
   .setName('message')
   .setDescription('Lời nhắn gửi tặng hiển thị trên khung nhạc Discord & Website (tối đa 160 ký tự)')
   .setRequired(true)
   .setMaxLength(160));
 }
 if (name === 'mixtape') {
  c.addStringOption(o => o
   .setName('action')
   .setDescription('Thao tác với Tủ nhạc chung của cả hội')
   .setRequired(true)
   .addChoices(
    { name: '📂 Xem danh sách các Tủ nhạc chung của server', value: 'list' },
    { name: '📋 Xem chi tiết các bài trong 1 Tủ nhạc chung', value: 'view' },
    { name: '➕ Góp bài đang phát (hoặc theo tên/link) vào Tủ chung', value: 'add' },
    { name: '▶️ Phát toàn bộ 1 Tủ nhạc chung', value: 'play' },
    { name: '🔀 Trộn ngẫu nhiên & phát 1 Tủ nhạc chung', value: 'shuffle' },
    { name: '➖ Xóa 1 bài khỏi Tủ chung theo số thứ tự', value: 'remove' },
    { name: '🗑️ Xóa hẳn 1 Tủ nhạc chung', value: 'delete' },
   ));
  c.addStringOption(o => o
   .setName('name')
   .setDescription('Tên Tủ nhạc chung (ví dụ: Nhạc Chiến Rank, Nhạc Suy Đêm Khuya)')
   .setRequired(false)
   .setMaxLength(45));
  c.addStringOption(o => o
   .setName('query')
   .setDescription('Tên bài hoặc link muốn góp vào tủ (để trống khi muốn góp bài đang phát)')
   .setRequired(false)
   .setMaxLength(400));
  c.addIntegerOption(o => o
   .setName('position')
   .setDescription('Số thứ tự bài cần xóa trong Tủ nhạc chung (1–20)')
   .setRequired(false)
   .setMinValue(1)
   .setMaxValue(20));
 }
 if (name === 'avatar') {
  c.addUserOption(o => o
   .setName('user')
   .setDescription('Chọn thành viên muốn soi ảnh đại diện (để trống để xem của chính bạn)')
   .setRequired(false));
  c.addStringOption(o => o
   .setName('type')
   .setDescription('Loại ảnh muốn lấy ở độ phân giải 4K gốc')
   .setRequired(false)
   .addChoices(
    { name: '✨ Tự động (Ưu tiên Avatar riêng Server + kèm link đủ bộ)', value: 'auto' },
    { name: '🖼️ Ảnh đại diện chính toàn Discord (Global Avatar 4K)', value: 'global' },
    { name: '🏠 Ảnh đại diện riêng trong Server này (Server Avatar 4K)', value: 'server' },
    { name: '🎨 Ảnh bìa hồ sơ cá nhân (Profile Banner 4K)', value: 'banner' },
   ));
 }
 if (name === 'savequeue') {
  c.addStringOption(o => o
   .setName('destination')
   .setDescription('Nơi lưu Thẻ Phiên Nhạc (mặc định gửi ra kênh chat để bấm Khôi phục 1 chạm)')
   .setRequired(false)
   .addChoices(
    { name: '💬 Gửi ra Kênh Chat hiện tại (Hỗ trợ nút Khôi phục 1 chạm)', value: 'channel' },
    { name: '📩 Gửi riêng về Hộp thư DM cá nhân', value: 'dm' },
   ));
  c.addStringOption(o => o
   .setName('title')
   .setDescription('Đặt tên cho hộp phiên nhạc này (ví dụ: Đêm Mưa Chill Cùng Hội)')
   .setRequired(false)
   .setMaxLength(70));
 }
 if (name === 'webkey') {
  c.addStringOption(o => o
   .setName('action')
   .setDescription('Xem mã PIN hiện tại, đổi mã PIN mới hoặc khóa lại quyền điều khiển từ Website')
   .setRequired(false)
   .addChoices(
    { name: '🔑 Xem / Cấp mã PIN 6 số điều khiển Website', value: 'show' },
    { name: '🔄 Đổi mã PIN 6 số mới (vô hiệu mã cũ)', value: 'rotate' },
    { name: '🔒 Thu hồi / Tắt điều khiển từ xa trên Website', value: 'revoke' },
   ));
 }
 if (name === 'spamtag') {
  c.addUserOption(o => o
   .setName('user')
   .setDescription('Chọn người cần réo tên @tag liên tục (để trống khi dùng action dừng hoặc xóa)')
   .setRequired(false));
  c.addStringOption(o => o
   .setName('action')
   .setDescription('Bắt đầu réo, dừng ngay lập tức hoặc xóa sạch các tin @tag vừa gửi')
   .setRequired(false)
   .addChoices(
    { name: '🔔 Bắt đầu réo @tag liên tục', value: 'start' },
    { name: '🛑 Tắt / Dừng réo ngay lập tức (giữ lại tin đã gửi)', value: 'stop' },
    { name: '🧹 Tắt réo & Xóa sạch toàn bộ tin nhắn spam vừa gửi', value: 'clear' },
   ));
  c.addIntegerOption(o => o
   .setName('count')
   .setDescription('Số lần @tag liên tiếp (từ 1 đến 100 lần, mặc định: 10 lần)')
   .setRequired(false)
   .setMinValue(1)
   .setMaxValue(100));
  c.addStringOption(o => o
   .setName('message')
   .setDescription('Lời nhắn réo kèm theo (bỏ trống bot sẽ tự tung câu gọi hồn hài hước)')
   .setRequired(false)
   .setMaxLength(180));
  c.addIntegerOption(o => o
   .setName('interval')
   .setDescription('Khoảng nghỉ giữa mỗi lần @tag tính bằng giây (2–10s, mặc định: 2.3s an toàn)')
   .setRequired(false)
   .setMinValue(2)
   .setMaxValue(10));
 }
 if (name === 'lock') {
  c.addChannelOption(o => o
   .setName('channel')
   .setDescription('Kênh muốn khóa (bỏ trống để khóa ngay kênh hiện tại)')
   .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
   .setRequired(false));
  c.addStringOption(o => o
   .setName('mode')
   .setDescription('Kiểu giao diện khóa kênh (mặc định: Kiểu Kênh 📢 Thông Báo hiện nút xanh Theo dõi)')
   .setRequired(false)
   .addChoices(
    { name: '📢 Kênh Thông Báo — Hiện nút xanh [Theo dõi] ở đáy y hệt mẫu', value: 'announcement' },
    { name: '🔒 Kênh Chữ Thường — Chỉ khóa ô chat, giữ nguyên loại kênh #', value: 'normal' },
   ));
  c.addBooleanOption(o => o
   .setName('reactions')
   .setDescription('Cho phép thành viên thả biểu cảm ❤️ 🔥 dưới bài viết (mặc định: True giống ảnh mẫu)')
   .setRequired(false));
  c.addRoleOption(o => o
   .setName('role')
   .setDescription('Khóa kèm thêm một Role cụ thể nếu muốn (mặc định bot đã tự khóa @everyone & Role mở chat)')
   .setRequired(false));
 }
 if (name === 'unlock') {
  c.addChannelOption(o => o
   .setName('channel')
   .setDescription('Kênh muốn mở khóa (bỏ trống để mở ngay kênh hiện tại)')
   .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
   .setRequired(false));
  c.addBooleanOption(o => o
   .setName('revert_normal')
   .setDescription('Đặt True nếu muốn đổi kênh 📢 Thông báo về lại kênh chữ # bình thường')
   .setRequired(false));
  c.addRoleOption(o => o
   .setName('role')
   .setDescription('Mở khóa kèm thêm một Role cụ thể (tùy chọn)')
   .setRequired(false));
 }
 if (name === 'announce') {
  c.addChannelOption(o => o
   .setName('channel')
   .setDescription('Kênh muốn đăng bài (bỏ trống sẽ đăng ngay vào kênh hiện tại)')
   .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
   .setRequired(false));
  c.addStringOption(o => o
   .setName('message')
   .setDescription('Nội dung thông báo (Dùng \\n để xuống dòng, hoặc ĐỂ TRỐNG để mở bảng gõ nhiều dòng tiện lợi!)')
   .setRequired(false)
   .setMaxLength(1900));
  c.addRoleOption(o => o
   .setName('ping_role')
   .setDescription('Tag đính kèm một vai trò ở đầu bài giống ảnh mẫu (ví dụ: @Member)')
   .setRequired(false));
  c.addBooleanOption(o => o
   .setName('ping_everyone')
   .setDescription('Đặt True nếu muốn tag @everyone ở đầu bài thông báo')
   .setRequired(false));
  c.addStringOption(o => o
   .setName('font')
   .setDescription('Chỉnh cỡ chữ / kiểu chữ bài đăng (VD: # Chữ siêu to, ## To vừa, > Trích dẫn...)')
   .setRequired(false)
   .addChoices(
    { name: '💬 Tự do (Giữ nguyên # , ## , ** bạn tự gõ)', value: 'normal' },
    { name: '📢 # Dòng đầu Siêu To + Thân bài thường (Chuẩn Thông Báo)', value: 'h1_title' },
    { name: '🔥 # Chữ Siêu To Đậm toàn bài (# hello)', value: 'h1_all' },
    { name: '✨ ## Chữ To Vừa toàn bài (## hello)', value: 'h2_all' },
    { name: '📌 ### Cỡ Tiêu Đề Gọn (### hello)', value: 'h3_bold' },
    { name: '💎 >>> Thanh Trích Dẫn Dọc + In Đậm', value: 'quote_bold' },
    { name: '🪶 -# Chữ Nhỏ Chú Thích Tinh Tế', value: 'subtext' },
   ));
  c.addStringOption(o => o
   .setName('style')
   .setDescription('Kiểu hiển thị bài đăng của Bot (mặc định: Tin nhắn chữ tự nhiên giống Meow Bot)')
   .setRequired(false)
   .addChoices(
    { name: '💬 Tin nhắn chữ tự nhiên (Giống hệt Meow Bot trong ảnh)', value: 'text' },
    { name: '📋 Khung thẻ Embed đóng viền màu nổi bật', value: 'embed' },
   ));
  c.addBooleanOption(o => o
   .setName('auto_react')
   .setDescription('Tự gắn sẵn biểu cảm ❤️ 🔥 bên dưới bài vừa đăng (mặc định: True)')
   .setRequired(false));
 }
 if (name === 'gif') {
  applyGifCommandOptions(c, { includePrivate: true });
 }
 return c.toJSON();
});

function applyGifCommandOptions(c, { includePrivate = true } = {}) {
 c.addAttachmentOption(o => o
  .setName('video')
  .setDescription('Tải file video lên (.mp4, .mov, .webm, .mkv...) — tối đa 45MB')
  .setRequired(false));
 c.addStringOption(o => o
  .setName('url')
  .setDescription('Hoặc dán link trực tiếp tới file video (.mp4, .webm, .mov, Discord CDN)')
  .setRequired(false)
  .setMaxLength(600));
 c.addStringOption(o => o
  .setName('caption')
  .setDescription('Chèn chữ Meme tiếng Việt lên GIF (dùng dấu | nếu muốn chia Trên | Dưới)')
  .setRequired(false)
  .setMaxLength(140));
 c.addStringOption(o => o
  .setName('caption_style')
  .setDescription('Kiểu hiển thị chữ Meme trên ảnh GIF (mặc định: Thanh trắng Meme đầu ảnh)')
  .setRequired(false)
  .addChoices(
   { name: '⬜ Thanh trắng Meme đầu ảnh (Chuẩn Meme Facebook/Discord)', value: 'bar' },
   { name: '💬 Phụ đề chữ trắng viền đen ở đáy ảnh', value: 'bottom' },
   { name: '🔝 Chữ trắng viền đen ở đỉnh ảnh', value: 'top' },
  ));
 c.addStringOption(o => o
  .setName('start')
  .setDescription('Mốc thời gian bắt đầu cắt (ví dụ: 0, 3.5 hoặc 01:15)')
  .setRequired(false)
  .setMaxLength(20));
 c.addNumberOption(o => o
  .setName('duration')
  .setDescription('Độ dài đoạn video lấy làm GIF tính bằng giây (0.5–15s, mặc định: 6s)')
  .setRequired(false)
  .setMinValue(0.5)
  .setMaxValue(15));
 c.addNumberOption(o => o
  .setName('speed')
  .setDescription('Tốc độ chạy GIF (VD: 0.5 quay chậm, 1.0 chuẩn, 1.5 hoặc 2.0 tua nhanh)')
  .setRequired(false)
  .setMinValue(0.25)
  .setMaxValue(3));
 c.addStringOption(o => o
  .setName('quality')
  .setDescription('Độ nét ảnh GIF (mặc định tự kích 720p/600p HD cao nhất vừa trần Discord)')
  .setRequired(false)
  .addChoices(
   { name: '🔥 Siêu Cấp Ultra — 720p • 33 FPS (Nét căng như video gốc)', value: 'ultra' },
   { name: '💎 Chuẩn Nét Cao HD — 600p • 25 FPS (Mặc định khuyên dùng)', value: 'hd' },
   { name: '✨ Cân Bằng Mượt — 480p • 20 FPS (Hợp clip vừa 6–10s)', value: 'balanced' },
   { name: '🪶 Nén Gọn Nhẹ — 360p • 17 FPS (Hợp clip dài 10–15s)', value: 'compact' },
  ));
 c.addIntegerOption(o => o
  .setName('fps')
  .setDescription('Tốc độ khung hình FPS (mặc định theo Độ nét, tối đa 50 FPS kịch trần GIF)')
  .setRequired(false)
  .addChoices(
   { name: '⚡ 50 FPS — Siêu mượt kịch trần chuẩn GIF (20ms/khung)', value: 50 },
   { name: '🔥 33 FPS — Mượt cao cấp như video (30ms/khung)', value: 33 },
   { name: '💎 25 FPS — Mượt chuẩn HD không khựng (40ms/khung)', value: 25 },
   { name: '✨ 20 FPS — Mượt cân bằng, nhẹ file (50ms/khung)', value: 20 },
   { name: '🪶 12 FPS — Cổ điển siêu tiết kiệm dung lượng', value: 12 },
  ));
 if (includePrivate) {
  c.addBooleanOption(o => o
   .setName('private')
   .setDescription('Đặt True nếu chỉ muốn một mình bạn nhìn thấy ảnh GIF vừa tạo')
   .setRequired(false));
 }
 return c;
}

// Ba lệnh Menu ngữ cảnh (Chạm giữ trên Điện thoại / Chuột phải trên PC -> Ứng dụng) — tốn 0 MB RAM.
export const contextCommands = [
 new ContextMenuCommandBuilder()
  .setName(CONTEXT_PLAY_NAME)
  .setType(ApplicationCommandType.Message)
  .setDMPermission(false)
  .toJSON(),
 new ContextMenuCommandBuilder()
  .setName(CONTEXT_GIF_NAME)
  .setType(ApplicationCommandType.Message)
  .setDMPermission(false)
  .toJSON(),
 new ContextMenuCommandBuilder()
  .setName(CONTEXT_AVATAR_NAME)
  .setType(ApplicationCommandType.User)
  .setDMPermission(false)
  .toJSON(),
];

export const commands = [...slashCommands, ...contextCommands];

// Các lệnh riêng trong hộp thư Tin nhắn riêng (DM) với Bot (contexts: [BotDM] -> KHÔNG bao giờ bị trùng lệnh ngoài Server, không ép integration_types để tương thích 100% cả app cũ lẫn mới!).
export const dmCommands = [
 new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Mở Trạm Đăng Thông Báo & Khóa Kênh từ xa lên Server ngay trong DM (chỉ Chủ Bot)')
  .setContexts(InteractionContextType.BotDM)
  .addStringOption(o => o
   .setName('message')
   .setDescription('Nội dung nháp (bỏ trống để chọn Kênh & Tag trên menu rồi mở bảng gõ nhiều dòng!)')
   .setRequired(false)
   .setMaxLength(1900))
  .addStringOption(o => o
   .setName('ping_users')
   .setDescription('Tag người dùng theo Tên/Biệt danh Server hoặc ID số (ngăn cách bằng dấu phẩy)')
   .setRequired(false)
   .setMaxLength(400))
  .addStringOption(o => o
   .setName('font')
   .setDescription('Chỉnh cỡ chữ / kiểu chữ bài đăng (VD: # Chữ siêu to, ## To vừa, > Trích dẫn...)')
   .setRequired(false)
   .addChoices(
    { name: '💬 Tự do (Giữ nguyên # , ## , ** bạn tự gõ)', value: 'normal' },
    { name: '📢 # Dòng đầu Siêu To + Thân bài thường (Chuẩn Thông Báo)', value: 'h1_title' },
    { name: '🔥 # Chữ Siêu To Đậm toàn bài (# hello)', value: 'h1_all' },
    { name: '✨ ## Chữ To Vừa toàn bài (## hello)', value: 'h2_all' },
    { name: '📌 ### Cỡ Tiêu Đề Gọn (### hello)', value: 'h3_bold' },
    { name: '💎 >>> Thanh Trích Dẫn Dọc + In Đậm', value: 'quote_bold' },
    { name: '🪶 -# Chữ Nhỏ Chú Thích Tinh Tế', value: 'subtext' },
   ))
  .addStringOption(o => o
   .setName('style')
   .setDescription('Kiểu hiển thị bài đăng (mặc định: Tin nhắn chữ tự nhiên giống Meow Bot)')
   .setRequired(false)
   .addChoices(
    { name: '💬 Tin nhắn chữ tự nhiên (Giống hệt Meow Bot)', value: 'text' },
    { name: '📋 Khung thẻ Embed đóng viền màu nổi bật', value: 'embed' },
   ))
  .addBooleanOption(o => o
   .setName('auto_react')
   .setDescription('Tự gắn sẵn biểu cảm ❤️ 🔥 bên dưới bài vừa đăng (mặc định: True)')
   .setRequired(false))
  .toJSON(),
 applyGifCommandOptions(
  new SlashCommandBuilder()
   .setName('gif')
   .setDescription('Chuyển đổi Video sang ảnh động GIF nét cao ngay trong DM (cắt giây, tốc độ, chữ Meme)')
   .setContexts(InteractionContextType.BotDM),
  { includePrivate: false },
 ).toJSON(),
 new ContextMenuCommandBuilder()
  .setName(CONTEXT_GIF_NAME)
  .setType(ApplicationCommandType.Message)
  .setContexts(InteractionContextType.BotDM)
  .toJSON(),
];
