import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { resolveNowPlayingWebUrl } from './playerGui.js';

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
 ['avatar', 'Soi ảnh đại diện gốc / Server / Banner 4K chống tự xóa & tự đăng lại nếu bị xóa'],
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

// Tạo khung Embed hiển thị đẹp mắt cho lệnh /help (tên lệnh giữ chuẩn quốc tế, chú thích tiếng Việt).
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
     '`/fav` `action` • `/mixtape` `action` — Tủ nhạc cá nhân & Tủ nhạc chung cả hội',
     '`/sleeptimer` — Hẹn giờ giảm dần âm lượng tắt nhạc êm ái khi đi ngủ',
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
    name: '📋 Tiện ích, Soi Avatar 4K & Bảng Vàng (Ai cũng dùng được)',
    value: [
     '`/avatar` `[user]` `[type]` — Soi Avatar/Banner 4K (đóng băng ảnh & chống xóa tự động)',
     '`/nowplaying` • `/grab` — Xem chi tiết bài hát hoặc bỏ túi về Tin nhắn riêng (DM)',
     '`/lyrics` `[query]` • `/stats` `[scope]` — Xem lời bài hát & **Bảng Vàng Top Nhạc/DJ**',
     '`/queue` • `/history` — Xem 10 bài sắp phát hoặc 10 bài vừa phát gần đây',
     '`/ping` • `/help` — Kiểm tra độ trễ/RAM hoặc mở bảng hướng dẫn này',
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

export const commands = definitions.map(([name, description]) => {
 const c = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
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
 return c.toJSON();
});
