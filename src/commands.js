import { SlashCommandBuilder } from 'discord.js';

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

// Nội dung trả về cho lệnh /help (ngắn gọn dưới 2000 ký tự của Discord, giữ tên lệnh tiếng Anh kèm chú thích tiếng Việt).
export const helpMessage = [
 '**Hướng dẫn sử dụng Bot Nhạc**',
 '',
 '**Điều khiển nhạc** *(chỉ người yêu cầu bài đang phát mới dùng được)*:',
 '• `/play query:<tên bài hoặc link>` — Phát hoặc thêm một bài từ YouTube/SoundCloud',
 '• `/pause` — Tạm dừng bài hát đang phát',
 '• `/resume` — Tiếp tục phát bài hát đang tạm dừng',
 '• `/skip` — Bỏ qua bài hiện tại để sang bài kế tiếp',
 '• `/stop` — Dừng nhạc, xóa toàn bộ hàng đợi và rời kênh thoại',
 '• `/loop mode:<off|track|queue>` — Tắt lặp / Lặp một bài / Lặp hàng đợi',
 '• `/shuffle` — Trộn ngẫu nhiên các bài đang chờ trong hàng đợi',
 '• `/volume percent:<0-100>` — Chỉnh mức âm lượng phát nhạc',
 '• `/remove position:<1-20>` — Xóa một bài chờ theo số thứ tự trong `/queue`',
 '',
 '**Xem thông tin** *(mọi người trong máy chủ đều dùng được)*:',
 '• `/nowplaying` — Xem tên bài hát đang phát',
 '• `/queue` — Xem tối đa 10 bài tiếp theo trong hàng đợi',
 '• `/ping` — Kiểm tra độ trễ mạng và bộ nhớ Node hiện tại',
 '• `/help` — Mở bảng hướng dẫn này',
 '',
 '*Lưu ý: Vào kênh thoại thường trước khi gọi `/play`. Tối đa 20 bài chờ, mỗi bài tối đa 10 phút, không nhận playlist hoặc livestream.*',
].join('\n');

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
