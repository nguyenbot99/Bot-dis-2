import 'dotenv/config';
import express from 'express';
import { Client, Events, GatewayIntentBits, Options, PermissionFlagsBits, Routes } from 'discord.js';
import { PlayerManager } from 'ziplayer';
import ffmpeg from 'ffmpeg-static';
import { resolveConfig, validateQuery } from './src/policy.js';
import { assertMusicAccess } from './src/access.js';
import { commands } from './src/commands.js';

// Kiểm tra phiên bản Node tối thiểu do thư viện voice yêu cầu Node >= 22.12.0.
const [major, minor] = process.versions.node.split('.').map(Number);
if(major < 22 || (major === 22 && minor < 12)) throw new Error('Cần Node >=22.12.0');
const { token: DISCORD_TOKEN, guildId: GUILD_ID, autoRegister } = resolveConfig(process.env);

// Chỉ nạp trực tiếp 2 plugin nguồn nhạc cần dùng để tiết kiệm RAM, không nạp Spotify, TTS hay extension phụ.
const pluginRoot = new URL('./node_modules/@ziplayer/plugin/dist/', import.meta.url);
const { YouTubePlugin } = await import(new URL('YouTubePlugin.js',pluginRoot));
const { SoundCloudPlugin } = await import(new URL('SoundCloudPlugin.js',pluginRoot));

// Khởi tạo Discord client với bộ nhớ đệm tối thiểu để giảm mức tiêu thụ RAM.
const client = new Client({
 intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates],
 allowedMentions:{parse:[]},
 makeCache:Options.cacheWithLimits({...Options.DefaultMakeCacheSettings,
  MessageManager:0,PresenceManager:0,ReactionManager:0,UserManager:0,
  GuildMemberManager:{maxSize:1,keepOverLimit:m=>m.id===m.client.user?.id}}),
});

// Khởi tạo trình quản lý phát nhạc ZiPlayer ở cấu hình nhẹ, tắt bộ đệm tìm kiếm và thống kê.
const manager = new PlayerManager({plugins:[new YouTubePlugin(),new SoundCloudPlugin()],
 enableSearchCache:false,enableStatsCollection:false,autoCleanup:true,cleanupInterval:60000,extractorTimeout:15000});

// Máy chủ HTTP nhẹ phục vụ kiểm tra trạng thái hoạt động (/healthz).
const app = express();
app.disable('x-powered-by');
app.get('/healthz',(_req,res)=>res.status(client.isReady()?200:503).json({ready:client.isReady(),uptime:Math.floor(process.uptime())}));
app.get('/',(_req,res)=>res.type('text').send('Bot nhạc tiếng Việt đang hoạt động — /healthz'));
const explicitPort = process.env.PORT || process.env.SERVER_PORT;
let server = app.listen(Number(explicitPort || 3000),'0.0.0.0');
server.on('error',e=>{
 if(!explicitPort && e?.code==='EADDRINUSE') {
  console.warn('[http] Cổng 3000 đang bận, tự chuyển sang cổng trống.');
  server = app.listen(0,'0.0.0.0');
  server.on('error',e2=>console.warn('[http]',e2?.code ?? e2?.name ?? 'Lỗi'));
  return;
 }
 fatal(e);
});

let busy=false, closing=false;
const cooldown=new Map();
const loopLabels={off:'Tắt lặp',track:'Lặp bài hiện tại',queue:'Lặp toàn bộ hàng đợi'};
// Làm sạch ký tự định dạng/mention trong tiêu đề bài hát trước khi gửi lên Discord.
const clean=s=>String(s??'Không rõ').replace(/[@`*_~|<>]/g,'').slice(0,130);

// Đồng bộ danh sách lệnh (tên lệnh giữ tiếng Anh, chú thích bằng tiếng Việt) cho một máy chủ cụ thể.
async function syncGuildCommands(appId, targetGuildId) {
 await client.rest.put(Routes.applicationGuildCommands(appId, targetGuildId), { body: commands });
}

manager.on('playerError',(player,error)=>{
 console.error('[lỗi-phát-nhạc]',error?.name ?? 'Error');
 // Hủy phiên phát lỗi ngay thay vì thử tải lại liên tục gây tốn RAM/CPU.
 manager.delete(player.guildId);
});
manager.on('error',()=>console.error('[quản-lý-nhạc] lỗi'));

client.once(Events.ClientReady,async c=>{
 console.log(`[khởi-động] Đã đăng nhập: ${c.user.tag}`);
 const appInfo = await c.application.fetch().catch(()=>null);
 if(appInfo?.interactionsEndpointURL) {
  console.error(`[CẢNH BÁO] Discord Developer Portal đang đặt Interactions Endpoint URL (${appInfo.interactionsEndpointURL}). Mọi lệnh slash đang bị chuyển sang dịch vụ cũ (như BMH) thay vì bot này! Hãy xóa trống ô Interactions Endpoint URL rồi bấm Save Changes.`);
 }
 if(!autoRegister) return;
 try {
  // Xóa các lệnh global tiếng Anh cũ còn sót lại (ví dụ từ BMH) để tránh bị trùng lệnh trên Discord.
  await client.rest.put(Routes.applicationCommands(c.application.id), { body: [] });
  const targets = GUILD_ID ? [GUILD_ID] : [...c.guilds.cache.keys()].slice(0,5);
  await Promise.all(targets.map(gid=>syncGuildCommands(c.application.id,gid)));
  console.log(`[đồng-bộ] Đã cập nhật ${commands.length} lệnh (chú thích tiếng Việt) cho ${targets.length} máy chủ.`);
 } catch(e) {
  console.error('[đồng-bộ-lỗi]',e?.name ?? 'Error',e?.message ?? '');
 }
});

client.on(Events.GuildCreate,guild=>{
 if(!autoRegister || !client.application?.id) return;
 if(GUILD_ID ? guild.id!==GUILD_ID : client.guilds.cache.size>5) return;
 syncGuildCommands(client.application.id,guild.id)
  .then(()=>console.log(`[đồng-bộ] Đã đăng ký ${commands.length} lệnh cho máy chủ mới ${guild.id}.`))
  .catch(e=>console.error('[đồng-bộ-lỗi]',e?.name ?? 'Error'));
});

client.on(Events.Error,e=>console.error('[discord]',e.name));

// Xử lý các lệnh slash (tên lệnh tiếng Anh: /play, /pause, /skip..., phản hồi tiếng Việt).
client.on(Events.InteractionCreate,async i=>{
 if(!i.isChatInputCommand() || !i.guild) return;
 if(GUILD_ID && i.guildId!==GUILD_ID) return void i.reply({content:'Bot chỉ phục vụ máy chủ đã cấu hình.',ephemeral:true}).catch(()=>{});
 const reply=content=>i.editReply({content,allowedMentions:{parse:[]}});
 let ownsLock=false, created=false;
 try {
  await i.deferReply({ephemeral:true});
  if(i.commandName==='ping') return await reply(`Độ trễ: ${client.ws.ping} ms • Bộ nhớ Node: ${Math.round(process.memoryUsage().rss/1048576)} MiB (chưa tính tiến trình FFmpeg).`);
  if(busy) return await reply('Đang xử lý lệnh khác, vui lòng thử lại.');
  busy=true; ownsLock=true;
  let p=manager.get(i.guildId);
  if(['queue','nowplaying'].includes(i.commandName)) {
   if(!p) return await reply('Chưa có phiên phát nhạc nào.');
   const current=p.queue.currentTrack;
   if(i.commandName==='nowplaying') return await reply(current?`Đang phát: ${clean(current.title)}`:'Chưa phát bài nào.');
   const rows=p.upcomingTracks.slice(0,10).map((t,n)=>`${n+1}. ${clean(t.title)}`);
   return await reply(rows.join('\n') || 'Hàng đợi đang trống.');
  }
  const member=await i.guild.members.fetch(i.user.id);
  const channel=member.voice.channel;
  if(!channel || channel.type!==2) throw new Error('Hãy vào một kênh thoại thường trước.');
  const botChannel=i.guild.members.me?.voice.channelId;
  if(botChannel && botChannel!==channel.id) throw new Error('Bạn phải ở cùng kênh thoại với bot.');
  // Kiểm tra quyền điều khiển: chỉ người yêu cầu bài đang phát mới được tác động vào nhạc.
  assertMusicAccess(i.commandName,i.user.id,p);
  if(i.commandName==='play') {
   const q=validateQuery(i.options.getString('query',true));
   const now=Date.now();
   if(now-(cooldown.get(i.user.id)??0)<5000) throw new Error('Chờ 5 giây giữa hai lệnh /play.');
   if(cooldown.size>=100) cooldown.clear();
   cooldown.set(i.user.id,now);
   const perms=channel.permissionsFor(i.guild.members.me);
   if(!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak])) throw new Error('Bot thiếu quyền Xem kênh, Kết nối hoặc Nói trong kênh thoại này.');
   if(!p) {
    if(manager.getAll().length) throw new Error('Chỉ cho phép một phiên phát đồng thời.');
    p=await manager.create(i.guildId,{leaveOnEnd:true,leaveOnEmpty:true,leaveTimeout:30000,
     userdata:{ownerId:i.user.id},selfDeaf:true,volume:100,quality:'low',ffmpegPath:ffmpeg,lowPerformance:true,
     preload:{enabled:false},crossfade:{enabled:false,autoEnable:false},
     smartTransition:{enabled:false},loudnessNormalization:{enabled:false},
     maxStreamStore:1,extractorTimeout:15000,antiStuck:{enabled:false}});
    created=true;
   }
   if(p.queue.size>=20) throw new Error('Hàng đợi đã đủ 20 bài.');
   if(!p.connection) await p.connect(channel);
   const result=await p.search(q,i.user.id);
   const track=result.tracks?.[0];
   if(!track) throw new Error('Không tìm thấy bài hát phù hợp.');
   if(track.isLive || track.duration>600000) throw new Error('Chỉ nhận bài tối đa 10 phút, không nhận phát trực tiếp (livestream).');
   if(!(await p.play(track,i.user.id))) throw new Error('Không thể phát bài hát này.');
   return await reply(`Đã thêm vào phát: ${clean(track.title)}`);
  }
  if(!p) throw new Error('Chưa có phiên phát nhạc nào.');
  switch(i.commandName) {
   case 'loop': {
    const mode=i.options.getString('mode',true);
    if(!loopLabels[mode]) throw new Error('Lệnh lặp không hợp lệ.');
    p.loop(mode);
    return await reply(`Chế độ lặp: ${loopLabels[mode]}.`);
   }
   case 'shuffle':
    if(p.upcomingTracks.length<2) throw new Error('Hàng đợi cần ít nhất 2 bài để trộn.');
    p.shuffle();
    return await reply('Đã trộn ngẫu nhiên các bài đang chờ.');
   case 'volume': {
    const percent=i.options.getInteger('percent',true);
    if(percent<0 || percent>100) throw new Error('Lệnh âm lượng chỉ nhận 0–100.');
    if(!p.setVolume(percent)) throw new Error('Không thể chỉnh âm lượng lúc này.');
    return await reply(`Đã đặt âm lượng: ${percent}%.`);
   }
   case 'remove': {
    const position=i.options.getInteger('position',true);
    if(position<1 || position>p.upcomingTracks.length) throw new Error('Hàng đợi không có vị trí này.');
    const removed=p.queue.remove(position-1);
    if(!removed) throw new Error('Không thể xóa bài ở vị trí này.');
    return await reply(`Đã xóa khỏi hàng đợi: ${clean(removed.title)}`);
   }
   case 'pause': p.pause(); return await reply('Đã tạm dừng phát nhạc.');
   case 'resume': p.resume(); return await reply('Đã tiếp tục phát nhạc.');
   case 'skip': p.skip(); return await reply('Đã bỏ qua bài hiện tại.');
   case 'stop': manager.delete(i.guildId); return await reply('Đã dừng nhạc, xóa hàng đợi và rời kênh thoại.');
   default: throw new Error('Lệnh không hợp lệ.');
  }
 } catch(e) {
  if(created) manager.delete(i.guildId);
  if(e?.code===40060) {
   console.error('[CẢNH BÁO] Lệnh đã bị một nơi khác (ví dụ BMH) phản hồi trước! Token bot đang bị dùng trùng — hãy vào Discord Developer Portal bấm Reset Token rồi cập nhật lại trên Botkeep.');
   return;
  }
  console.error('[lỗi-lệnh]',i.commandName,e?.name);
  const known=/^(Hãy|Bạn|Bot|Chờ|Chỉ|Hàng|Không|Chưa|Tên|URL|Lệnh|Bản)/.test(e.message??'');
  await (i.deferred?reply(known?e.message:'Nguồn nhạc hoặc kết nối gặp lỗi. Vui lòng thử lại sau.'):i.reply({content:'Không thể xử lý lệnh lúc này.',ephemeral:true})).catch(()=>{});
 } finally {if(ownsLock) busy=false;}
});

// Dọn dẹp tài nguyên phát nhạc, kết nối Discord và cổng HTTP khi tắt tiến trình.
async function shutdown(code=0) {
 if(closing) return; closing=true;
 const timer=setTimeout(()=>process.exit(code || 1),5000);timer.unref();
 try {manager.destroy();client.destroy();server.close(()=>process.exit(code));}
 catch {process.exit(1);}
}
function fatal(e){console.error('[lỗi-nghiêm-trọng]',e?.name??'Error');void shutdown(1);}
process.once('SIGTERM',()=>shutdown());process.once('SIGINT',()=>shutdown());
process.on('unhandledRejection',fatal);process.on('uncaughtException',fatal);
await client.login(DISCORD_TOKEN).catch(fatal);
