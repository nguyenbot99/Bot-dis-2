import { SlashCommandBuilder } from 'discord.js';
const definitions = [
 ['loop','Chọn chế độ lặp'], ['shuffle','Trộn hàng đợi'],
 ['volume','Chỉnh âm lượng 0–100%'], ['remove','Xóa một bài chờ theo vị trí'],
 ['play','Phát một bài nhạc (không nhận playlist)'], ['pause','Tạm dừng'],
 ['resume','Tiếp tục'], ['skip','Bỏ qua bài'], ['stop','Xóa hàng đợi và rời kênh'],
 ['queue','Xem tối đa 10 bài tiếp theo'], ['nowplaying','Bài đang phát'], ['ping','Kiểm tra bot'],
];
export const commands = definitions.map(([name, description]) => {
 const c = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
 if(name === 'play') c.addStringOption(o => o.setName('query').setDescription('Tên bài hoặc URL YouTube/SoundCloud').setRequired(true).setMaxLength(200));
 if(name === 'loop') c.addStringOption(o => o.setName('mode').setDescription('Chế độ lặp').setRequired(true).addChoices({name:'Tắt',value:'off'},{name:'Một bài',value:'track'},{name:'Hàng đợi',value:'queue'}));
 if(name === 'volume') c.addIntegerOption(o => o.setName('percent').setDescription('Âm lượng từ 0 đến 100').setRequired(true).setMinValue(0).setMaxValue(100));
 if(name === 'remove') c.addIntegerOption(o => o.setName('position').setDescription('Vị trí bài chờ trong /queue, bắt đầu từ 1').setRequired(true).setMinValue(1).setMaxValue(20));
 return c.toJSON();
});
