import { SlashCommandBuilder } from 'discord.js';

// Giữ nguyên tên lệnh và tên tham số bằng tiếng Anh; Việt hóa toàn bộ phần chú thích hiển thị trên Discord.
const definitions = [
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
