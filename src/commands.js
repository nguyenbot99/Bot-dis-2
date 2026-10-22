import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

// Giữ nguyên tên lệnh và tên tham số bằng tiếng Anh; Việt hóa toàn bộ phần chú thích hiển thị trên Discord.
const definitions = [
 ['help', 'Xem danh sách toàn bộ lệnh và hướng dẫn sử dụng bot'],
 ['play', 'Phát nhạc từ tên bài hát hoặc link YouTube/SoundCloud (không nhận danh sách phát)'],
 ['pause', 'Tạm dừng bài hát đang phát'],
 ['resume', 'Tiếp tục phát bài hát đang tạm dừng'],
 ['skip', 'Bỏ qua bài hát hiện tại để sang bài tiếp theo'],
 ['stop', 'Dừng phát nhạc, xóa toàn bộ hàng đợi và rời kênh thoại'],
 ['loop', 'Chỉnh chế độ lặp nhạc (tắt, lặp một bài hoặc lặp hàng đợi)'],
 ['shuffle', 'Trộn ngẫu nhiên thứ tự các bài đang chờ trong hàng đợi'],
 ['volume', 'Điều chỉnh âm lượng phát nhạc từ 0% đến 100%'],
 ['remove', 'Xóa một bài hát khỏi hàng đợi theo số thứ tự trong /queue'],
 ['queue', 'Xem danh sách tối đa 10 bài hát tiếp theo trong hàng đợi'],
 ['nowplaying', 'Xem tên bài hát đang được phát hiện tại'],
 ['ping', 'Kiểm tra độ trễ kết nối và mức bộ nhớ Node của bot'],
];

// Tạo khung Embed hiển thị đẹp mắt cho lệnh /help (tên lệnh giữ tiếng Anh, chú thích tiếng Việt).
export function buildHelpEmbed(botUser) {
 const botName = botUser?.username ?? 'Music Bot';
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;

 const embed = new EmbedBuilder()
  .setColor(0x5865f2)
  .setAuthor({
   name: `${botName} • Trung tâm trợ giúp`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setTitle('🎵 Bảng Lệnh & Hướng Dẫn Sử Dụng')
  .setDescription([
   'Hãy vào một **kênh thoại thường** rồi nhập `/play` để bắt đầu nghe nhạc.',
   '> 🔒 *Chỉ **người yêu cầu bài đang phát** (cùng kênh thoại) mới dùng được nhóm lệnh điều khiển nhạc.*',
  ].join('\n'))
  .addFields(
   {
    name: '▶️ Phát & Điều khiển chính',
    value: [
     '`/play` `query` — Phát nhạc từ tên bài hoặc link YouTube / SoundCloud',
     '`/pause` — Tạm dừng bài hát đang phát',
     '`/resume` — Tiếp tục phát bài đang tạm dừng',
     '`/skip` — Bỏ qua bài hiện tại để sang bài kế tiếp',
     '`/stop` — Dừng nhạc, xóa toàn bộ hàng đợi và rời kênh thoại',
    ].join('\n'),
   },
   {
    name: '🎛️ Hàng đợi & Âm thanh',
    value: [
     '`/loop` `mode` — Lặp nhạc: `off` (Tắt) • `track` (Một bài) • `queue` (Hàng đợi)',
     '`/shuffle` — Trộn ngẫu nhiên thứ tự các bài đang chờ',
     '`/volume` `percent` — Chỉnh mức âm lượng phát (`0%` – `100%`)',
     '`/remove` `position` — Xóa bài chờ theo số thứ tự trong `/queue` (`1` – `20`)',
    ].join('\n'),
   },
   {
    name: '📋 Xem thông tin (Mọi người đều dùng được)',
    value: [
     '`/nowplaying` — Xem tên bài hát đang phát hiện tại',
     '`/queue` — Xem danh sách tối đa 10 bài tiếp theo',
     '`/ping` — Kiểm tra độ trễ mạng và bộ nhớ Node hiện tại',
     '`/help` — Mở khung hướng dẫn sử dụng này',
    ].join('\n'),
   },
   {
    name: '🎧 Nguồn nhạc',
    value: 'YouTube & SoundCloud\n*(Không nhận playlist / live)*',
    inline: true,
   },
   {
    name: '⚙️ Giới hạn phiên',
    value: 'Tối đa **20 bài** chờ\nThời lượng **≤ 10 phút/bài**',
    inline: true,
   },
  )
  .setFooter({ text: 'Quyền điều khiển tự chuyển cho người gọi bài kế tiếp • Chỉ hiển thị với bạn' })
  .setTimestamp();

 if (avatarUrl) embed.setThumbnail(avatarUrl);
 return embed;
}

export const commands = definitions.map(([name, description]) => {
 const c = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
 if (name === 'play') {
  c.addStringOption(o => o
   .setName('query')
   .setDescription('Nhập tên bài hát hoặc đường dẫn HTTPS của YouTube / SoundCloud')
   .setRequired(true)
   .setMaxLength(200));
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
 if (name === 'volume') {
  c.addIntegerOption(o => o
   .setName('percent')
   .setDescription('Mức âm lượng mong muốn (từ 0 đến 100)')
   .setRequired(true)
   .setMinValue(0)
   .setMaxValue(100));
 }
 if (name === 'remove') {
  c.addIntegerOption(o => o
   .setName('position')
   .setDescription('Số thứ tự bài chờ xem trong /queue (bắt đầu từ 1)')
   .setRequired(true)
   .setMinValue(1)
   .setMaxValue(20));
 }
 return c.toJSON();
});
