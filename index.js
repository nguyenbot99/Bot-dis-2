import 'dotenv/config';
import express from 'express';
import { Client, Events, GatewayIntentBits, Options, PermissionFlagsBits } from 'discord.js';
import { PlayerManager } from 'ziplayer';
import ffmpeg from 'ffmpeg-static';
import { validateQuery } from './src/policy.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if(major < 22 || (major === 22 && minor < 12)) throw new Error('Cần Node >=22.12.0');
const { DISCORD_TOKEN, GUILD_ID } = process.env;
if(!DISCORD_TOKEN || !/^\d{17,20}$/.test(GUILD_ID ?? '')) throw new Error('Thiếu DISCORD_TOKEN hoặc GUILD_ID không hợp lệ.');
// Lazy-load only the two enabled source modules; no Spotify, TTS or extensions.
const pluginRoot = new URL('./node_modules/@ziplayer/plugin/dist/', import.meta.url);
const { YouTubePlugin } = await import(new URL('YouTubePlugin.js',pluginRoot));
const { SoundCloudPlugin } = await import(new URL('SoundCloudPlugin.js',pluginRoot));
const client = new Client({
 intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates],
 allowedMentions:{parse:[]},
 makeCache:Options.cacheWithLimits({...Options.DefaultMakeCacheSettings,
  MessageManager:0,PresenceManager:0,ReactionManager:0,UserManager:0,
  GuildMemberManager:{maxSize:1,keepOverLimit:m=>m.id===m.client.user?.id}}),
});
const manager = new PlayerManager({plugins:[new YouTubePlugin(),new SoundCloudPlugin()],
 enableSearchCache:false,enableStatsCollection:false,autoCleanup:true,cleanupInterval:60000,extractorTimeout:15000});
const app = express();
app.disable('x-powered-by');
app.get('/healthz',(_req,res)=>res.status(client.isReady()?200:503).json({ready:client.isReady(),uptime:Math.floor(process.uptime())}));
app.get('/',(_req,res)=>res.type('text').send('Zi Light Music Bot — /healthz'));
const server=app.listen(Number(process.env.PORT || process.env.SERVER_PORT || 3000),'0.0.0.0');
server.on('error',fatal);
let busy=false, closing=false;
const cooldown=new Map();
const clean=s=>String(s??'Không rõ').replace(/[@`*_~|<>]/g,'').slice(0,130);
manager.on('playerError',(player,error)=>{
 console.error('[playerError]',error?.name ?? 'Error');
 // Destroy rather than repeatedly extract a broken stream.
 manager.delete(player.guildId);
});
manager.on('error',()=>console.error('[manager] error'));
client.once(Events.ClientReady,c=>console.log(`Ready: ${c.user.tag}`));
client.on(Events.Error,e=>console.error('[discord]',e.name));
client.on(Events.InteractionCreate,async i=>{
 if(!i.isChatInputCommand()) return;
 if(i.guildId!==GUILD_ID) return void i.reply({content:'Bot chỉ phục vụ máy chủ đã cấu hình.',ephemeral:true}).catch(()=>{});
 const reply=content=>i.editReply({content,allowedMentions:{parse:[]}});
 let ownsLock=false, created=false;
 try {
  await i.deferReply({ephemeral:true});
  if(i.commandName==='ping') return await reply(`Pong • ${client.ws.ping} ms • RSS ${Math.round(process.memoryUsage().rss/1048576)} MiB (chỉ Node, chưa tính FFmpeg).`);
  if(busy) return await reply('Đang xử lý lệnh khác, vui lòng thử lại.');
  busy=true; ownsLock=true;
  let p=manager.get(i.guildId);
  if(['queue','nowplaying'].includes(i.commandName)) {
   if(!p) return await reply('Chưa có phiên phát.');
   const current=p.queue.currentTrack;
   if(i.commandName==='nowplaying') return await reply(current?`Đang phát: ${clean(current.title)}`:'Chưa phát bài nào.');
   const rows=p.upcomingTracks.slice(0,10).map((t,n)=>`${n+1}. ${clean(t.title)}`);
   return await reply(rows.join('\n') || 'Hàng đợi trống.');
  }
  const member=await i.guild.members.fetch(i.user.id);
  const channel=member.voice.channel;
  if(!channel || channel.type!==2) throw new Error('Hãy vào một kênh thoại thường trước.');
  const botChannel=i.guild.members.me?.voice.channelId;
  if(botChannel && botChannel!==channel.id) throw new Error('Bạn phải ở cùng kênh thoại với bot.');
  if(i.commandName==='play') {
   const q=validateQuery(i.options.getString('query',true));
   const now=Date.now();
   if(now-(cooldown.get(i.user.id)??0)<5000) throw new Error('Chờ 5 giây giữa hai lệnh /play.');
   if(cooldown.size>=100) cooldown.clear();
   cooldown.set(i.user.id,now);
   const perms=channel.permissionsFor(i.guild.members.me);
   if(!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak])) throw new Error('Bot cần View Channel, Connect và Speak.');
   if(!p) {
    if(manager.getAll().length) throw new Error('Chỉ cho phép một phiên phát đồng thời.');
    p=await manager.create(i.guildId,{leaveOnEnd:true,leaveOnEmpty:true,leaveTimeout:30000,
     selfDeaf:true,volume:100,quality:'low',ffmpegPath:ffmpeg,lowPerformance:true,
     preload:{enabled:false},crossfade:{enabled:false,autoEnable:false},
     smartTransition:{enabled:false},loudnessNormalization:{enabled:false},
     maxStreamStore:1,extractorTimeout:15000,antiStuck:{enabled:false}});
    created=true;
   }
   if(p.queue.size>=20) throw new Error('Hàng đợi đã đủ 20 bài.');
   if(!p.connection) await p.connect(channel);
   const result=await p.search(q,i.user.id);
   const track=result.tracks?.[0];
   if(!track) throw new Error('Không tìm thấy bài phù hợp.');
   if(track.isLive || track.duration>600000) throw new Error('Chỉ nhận bài tối đa 10 phút, không nhận livestream.');
   if(!(await p.play(track,i.user.id))) throw new Error('Không thể phát bài này.');
   return await reply(`Đã nhận: ${clean(track.title)}`);
  }
  if(!p) throw new Error('Chưa có phiên phát.');
  switch(i.commandName) {
   case 'pause': p.pause(); break;
   case 'resume': p.resume(); break;
   case 'skip': p.skip(); break;
   case 'stop': manager.delete(i.guildId); break;
   default: throw new Error('Lệnh không hợp lệ.');
  }
  await reply('Đã thực hiện.');
 } catch(e) {
  if(created) manager.delete(i.guildId);
  console.error('[command]',i.commandName,e?.name);
  const known=/^(Hãy|Bạn|Bot|Chờ|Chỉ|Hàng|Không|Chưa|Tên|URL|Lệnh)/.test(e.message??'');
  await (i.deferred?reply(known?e.message:'Nguồn nhạc hoặc kết nối gặp lỗi. Thử lại sau.'):i.reply({content:'Không thể xử lý lệnh.',ephemeral:true})).catch(()=>{});
 } finally {if(ownsLock) busy=false;}
});
async function shutdown(code=0) {
 if(closing) return; closing=true;
 const timer=setTimeout(()=>process.exit(code || 1),5000);timer.unref();
 try {manager.destroy();client.destroy();server.close(()=>process.exit(code));}
 catch {process.exit(1);}
}
function fatal(e){console.error('[fatal]',e?.name??'Error');void shutdown(1);}
process.once('SIGTERM',()=>shutdown());process.once('SIGINT',()=>shutdown());
process.on('unhandledRejection',fatal);process.on('uncaughtException',fatal);
await client.login(DISCORD_TOKEN).catch(fatal);
