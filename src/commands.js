import { SlashCommandBuilder } from 'discord.js';
const definitions = [
 ['play','Phát một bài nhạc (không nhận playlist)'], ['pause','Tạm dừng'],
 ['resume','Tiếp tục'], ['skip','Bỏ qua bài'], ['stop','Xóa hàng đợi và rời kênh'],
 ['queue','Xem tối đa 10 bài tiếp theo'], ['nowplaying','Bài đang phát'], ['ping','Kiểm tra bot'],
];
export const commands = definitions.map(([name, description]) => {
 const c = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
 if(name === 'play') c.addStringOption(o => o.setName('query').setDescription('Tên bài hoặc URL YouTube/SoundCloud').setRequired(true).setMaxLength(200));
 return c.toJSON();
});
