import 'dotenv/config';
import express from 'express';
import { Client, Events, GatewayIntentBits, MessageFlags, Options, PermissionFlagsBits, Routes } from 'discord.js';
import { PlayerManager } from 'ziplayer';
import ffmpeg from 'ffmpeg-static';
import { resolveConfig, validateQuery } from './src/policy.js';
import { assertMusicAccess } from './src/access.js';
import { buildHelpEmbed, commands } from './src/commands.js';
import {
 buildAddSongModal,
 buildEndedPayload,
 buildIdle247Payload,
 buildNowPlayingEmbed,
 buildPlayerPayload,
 buildQueueEmbed,
 cleanText,
 LOOP_LABELS,
} from './src/playerGui.js';

// Kiểm tra phiên bản Node tối thiểu do thư viện voice yêu cầu Node >= 22.12.0.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw new Error('Cần Node >=22.12.0');
const { token: DISCORD_TOKEN, guildId: GUILD_ID, autoRegister } = resolveConfig(process.env);

// Chỉ nạp trực tiếp 2 plugin nguồn nhạc cần dùng để tiết kiệm RAM, không nạp Spotify, TTS hay extension phụ.
const pluginRoot = new URL('./node_modules/@ziplayer/plugin/dist/', import.meta.url);
const { YouTubePlugin } = await import(new URL('YouTubePlugin.js', pluginRoot));
const { SoundCloudPlugin } = await import(new URL('SoundCloudPlugin.js', pluginRoot));

// Khởi tạo Discord client với bộ nhớ đệm tối thiểu để giảm mức tiêu thụ RAM.
const client = new Client({
 intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
 allowedMentions: { parse: [] },
 makeCache: Options.cacheWithLimits({
  ...Options.DefaultMakeCacheSettings,
  MessageManager: 0,
  PresenceManager: 0,
  ReactionManager: 0,
  UserManager: 0,
  GuildMemberManager: { maxSize: 1, keepOverLimit: m => m.id === m.client.user?.id },
 }),
});

// Khởi tạo trình quản lý phát nhạc ZiPlayer ở cấu hình nhẹ, tắt bộ đệm tìm kiếm và thống kê.
const manager = new PlayerManager({
 plugins: [new YouTubePlugin(), new SoundCloudPlugin()],
 enableSearchCache: false,
 enableStatsCollection: false,
 autoCleanup: true,
 cleanupInterval: 60000,
 extractorTimeout: 15000,
});

// Máy chủ HTTP nhẹ phục vụ kiểm tra trạng thái hoạt động (/healthz).
const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.status(client.isReady() ? 200 : 503).json({ ready: client.isReady(), uptime: Math.floor(process.uptime()) }));
app.get('/', (_req, res) => res.type('text').send('Bot nhạc tiếng Việt đang hoạt động — /healthz'));
const explicitPort = process.env.PORT || process.env.SERVER_PORT;
let server = app.listen(Number(explicitPort || 3000), '0.0.0.0');
server.on('error', e => {
 if (!explicitPort && e?.code === 'EADDRINUSE') {
  console.warn('[http] Cổng 3000 đang bận, tự chuyển sang cổng trống.');
  server = app.listen(0, '0.0.0.0');
  server.on('error', e2 => console.warn('[http]', e2?.code ?? e2?.name ?? 'Lỗi'));
  return;
 }
 fatal(e);
});

let busy = false, closing = false;
const cooldown = new Map();
const refreshCooldown = new Map();
const KNOWN_ERROR_RE = /^(Hãy|Bạn|Bot|Chờ|Chỉ|Hàng|Không|Chưa|Tên|URL|Lệnh|Bản)/;

function clearPanelTimer(player) {
 if (player?.userdata?.panelTimer) {
  clearTimeout(player.userdata.panelTimer);
  player.userdata.panelTimer = null;
 }
}

function clearEmptyTimer(player) {
 if (player?.userdata?.emptyTimer) {
  clearTimeout(player.userdata.emptyTimer);
  player.userdata.emptyTimer = null;
 }
}

// Áp dụng trạng thái 24/7 trực tiếp lên cả Player options lẫn LifecycleController bên trong ZiPlayer.
function apply247State(player, enabled) {
 if (!player?.userdata) return;
 player.userdata.stay247 = enabled;
 player.options.leaveOnEnd = !enabled;
 player.options.leaveOnEmpty = !enabled;
 if (player.runtimeGraph?.lifecycleController) {
  player.runtimeGraph.lifecycleController.leaveOnEnd = !enabled;
  player.runtimeGraph.lifecycleController.leaveOnEmpty = !enabled;
 }
 if (enabled) {
  if (!player.queue?.currentTrack && (player.upcomingTracks?.length ?? 0) === 0) {
   player.userdata.idleOpen = true;
  }
  player.clearLeaveTimeout?.();
  clearEmptyTimer(player);
 } else {
  player.userdata.idleOpen = false;
  if (!player.queue?.currentTrack && (player.upcomingTracks?.length ?? 0) === 0) {
   player.scheduleLeave?.();
  }
 }
}

// Gửi khung điều khiển nhạc mới tinh xuống cuối kênh chat mỗi khi bắt đầu bài mới (xóa khung cũ để tránh rác kênh).
async function postFreshPanel(player, track) {
 const ud = player?.userdata;
 if (!ud || player.destroyed || ud.manualDisconnect) return;
 ud.ending = false;
 ud.idleOpen = false;
 clearPanelTimer(player);
 const oldMsg = ud.panelMessage;
 ud.panelMessage = null;
 if (oldMsg) oldMsg.delete().catch(() => {});
 if (!ud.textChannel?.send) return;
 try {
  const sent = await ud.textChannel.send(buildPlayerPayload(player, { track }));
  if (player.destroyed || ud.ending || ud.manualDisconnect) {
   sent.edit(buildEndedPayload()).catch(() => {});
   return;
  }
  ud.panelMessage = sent;
 } catch (e) {
  console.warn('[khung-nhạc] Không thể gửi khung điều khiển vào kênh chat (kiểm tra quyền Gửi tin nhắn):', e?.code ?? e?.name ?? 'Lỗi');
 }
}

// Gom các thay đổi liên tiếp (âm lượng, lặp, 24/7, hàng đợi, tạm dừng) để cập nhật khung điều khiển mượt mà.
function schedulePanelUpdate(player, overrides = {}) {
 const ud = player?.userdata;
 if (!ud || player.destroyed || ud.ending || !ud.panelMessage) return;
 clearPanelTimer(player);
 ud.panelTimer = setTimeout(() => {
  ud.panelTimer = null;
  if (!player.destroyed && !ud.ending && ud.panelMessage) {
   ud.panelMessage.edit(buildPlayerPayload(player, overrides)).catch(() => {});
  }
 }, 250);
 ud.panelTimer.unref?.();
}

// Đóng khung điều khiển của bài hiện tại (hoặc chuyển sang khung chờ 24/7 nếu đang bật 24/7).
async function closeCurrentPanel(player, reason, { keepIdle247 = false } = {}) {
 const ud = player?.userdata;
 if (!ud) return;
 ud.ending = true;
 clearPanelTimer(player);
 const payload = keepIdle247 && ud.stay247 && !ud.manualDisconnect
  ? buildIdle247Payload(player, reason)
  : buildEndedPayload(reason);
 const msg = ud.panelMessage;
 if (keepIdle247 && ud.stay247 && !ud.manualDisconnect) {
  if (msg) {
   await msg.edit(payload).catch(() => {});
   return;
  }
  if (ud.textChannel?.send) {
   ud.panelMessage = await ud.textChannel.send(payload).catch(() => null);
  }
  return;
 }
 ud.panelMessage = null;
 if (msg) await msg.edit(payload).catch(() => {});
}

// Đóng toàn bộ phiên phát, xóa mọi bộ hẹn giờ/tham chiếu và cho bot rời khỏi kênh thoại.
async function destroyPlayerSession(guildId, reason) {
 const p = manager.get(guildId);
 if (!p) return;
 const ud = p.userdata;
 if (ud) {
  ud.manualDisconnect = true;
  ud.stay247 = false;
  clearEmptyTimer(p);
  await closeCurrentPanel(p, reason);
  ud.textChannel = null;
 }
 manager.delete(guildId);
}

// Gắn sự kiện vòng đời từ ZiPlayer để tự động đồng bộ khung điều khiển nhạc trên kênh chat.
manager.on('trackStart', (player, track) => { void postFreshPanel(player, track); });
manager.on('playerPause', player => schedulePanelUpdate(player, { paused: true }));
manager.on('playerResume', player => schedulePanelUpdate(player, { paused: false }));
manager.on('volumeChange', player => schedulePanelUpdate(player));
manager.on('queueAdd', player => schedulePanelUpdate(player));
manager.on('queueRemove', player => schedulePanelUpdate(player));
manager.on('queueEnd', player => {
 if (player.userdata?.stay247) {
  player.userdata.idleOpen = true;
  player.clearLeaveTimeout?.();
  void closeCurrentPanel(player, 'Đã phát hết hàng đợi — Bot vẫn đang treo trong kênh thoại 24/7.', { keepIdle247: true });
  return;
 }
 void closeCurrentPanel(player, 'Đã phát hết toàn bộ danh sách nhạc.');
});
manager.on('playerStop', player => {
 if (player.userdata?.skipNextStopEvent) {
  player.userdata.skipNextStopEvent = false;
  return;
 }
 if (player.userdata?.stay247) {
  player.userdata.idleOpen = true;
  player.clearLeaveTimeout?.();
  void closeCurrentPanel(player, 'Đã dừng phát nhạc — Bot vẫn đang giữ kết nối kênh thoại 24/7.', { keepIdle247: true });
  return;
 }
 void closeCurrentPanel(player, 'Đã dừng phát nhạc.');
});
manager.on('playerDestroy', player => {
 clearEmptyTimer(player);
 void closeCurrentPanel(player, 'Phiên phát nhạc đã kết thúc, bot đã rời kênh thoại.');
 if (player.userdata) player.userdata.textChannel = null;
});
manager.on('playerError', (player, error) => {
 console.error('[lỗi-phát-nhạc]', error?.name ?? 'Error');
 if (player.userdata?.stay247) {
  player.userdata.idleOpen = true;
  player.userdata.skipNextStopEvent = true;
  player.stop();
  player.clearLeaveTimeout?.();
  void closeCurrentPanel(player, 'Nguồn bài hát gặp sự cố — Bot vẫn giữ kết nối kênh thoại 24/7.', { keepIdle247: true });
  return;
 }
 void destroyPlayerSession(player.guildId, 'Nguồn nhạc gặp sự cố nên phiên phát đã tự đóng để bảo vệ tài nguyên.');
});
manager.on('error', () => console.error('[quản-lý-nhạc] lỗi'));

// Kiểm tra người dùng đang ở kênh thoại thường và cùng kênh thoại với bot.
async function requireSameVoiceChannel(guild, userId) {
 const cachedChannel = guild.voiceStates.cache.get(userId)?.channel;
 const channel = cachedChannel ?? (await guild.members.fetch(userId)).voice.channel;
 if (!channel || channel.type !== 2) throw new Error('Hãy vào một kênh thoại thường trước.');
 const botChannel = guild.members.me?.voice.channelId ?? guild.voiceStates.cache.get(client.user?.id)?.channelId;
 if (botChannel && botChannel !== channel.id) throw new Error('Bạn phải ở cùng kênh thoại với bot.');
 return channel;
}

// Tạo mới hoặc lấy phiên kết nối kênh thoại hiện tại của máy chủ.
async function ensureVoiceSession({ guild, voiceChannel, textChannel, userId, initial247 = false }) {
 const me = guild.members.me ?? await guild.members.fetchMe();
 const perms = voiceChannel.permissionsFor(me);
 if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
  throw new Error('Bot thiếu quyền Xem kênh, Kết nối hoặc Nói trong kênh thoại này.');
 }

 let p = manager.get(guild.id);
 let created = false;
 if (!p) {
  if (manager.getAll().length) throw new Error('Chỉ cho phép một phiên phát đồng thời.');
  p = await manager.create(guild.id, {
   leaveOnEnd: !initial247,
   leaveOnEmpty: !initial247,
   leaveTimeout: 30000,
   userdata: {
    ownerId: userId,
    textChannel,
    voiceChannelId: voiceChannel.id,
    stay247: initial247,
    idleOpen: Boolean(initial247),
    panelMessage: null,
    panelTimer: null,
    emptyTimer: null,
    ending: false,
    manualDisconnect: false,
    lastReconnectAt: 0,
   },
   selfDeaf: true,
   volume: 100,
   quality: 'low',
   ffmpegPath: ffmpeg,
   lowPerformance: true,
   preload: { enabled: false },
   crossfade: { enabled: false, autoEnable: false },
   smartTransition: { enabled: false },
   loudnessNormalization: { enabled: false },
   maxStreamStore: 1,
   extractorTimeout: 15000,
   antiStuck: { enabled: false },
  });
  created = true;
 } else if (p.userdata) {
  if (textChannel) p.userdata.textChannel = textChannel;
  p.userdata.voiceChannelId = voiceChannel.id;
 }

 try {
  if (!p.connection) await p.connect(voiceChannel);
  return { player: p, created };
 } catch (e) {
  if (created) manager.delete(guild.id);
  throw e;
 }
}

// Dùng chung logic kiểm tra, tìm kiếm và thêm bài hát cho cả lệnh /play lẫn hộp thoại "Thêm bài hát mới".
async function enqueueAndPlay({ guild, voiceChannel, textChannel, rawQuery, userId }) {
 const q = validateQuery(rawQuery);
 const now = Date.now();
 if (now - (cooldown.get(userId) ?? 0) < 5000) throw new Error('Chờ 5 giây giữa hai lần thêm nhạc.');
 if (cooldown.size >= 100) cooldown.clear();
 cooldown.set(userId, now);

 const { player: p, created } = await ensureVoiceSession({ guild, voiceChannel, textChannel, userId });
 try {
  if (p.queue.size >= 20) throw new Error('Hàng đợi đã đủ 20 bài.');
  const result = await p.search(q, userId);
  const track = result.tracks?.[0];
  if (!track) throw new Error('Không tìm thấy bài hát phù hợp.');
  if (track.isLive || track.duration > 600000) {
   throw new Error('Chỉ nhận bài tối đa 10 phút, không nhận phát trực tiếp (livestream).');
  }
  const hadCurrent = Boolean(p.queue.currentTrack);
  if (!hadCurrent && p.userdata) {
   p.userdata.ownerId = userId;
   p.userdata.idleOpen = false;
  }
  if (!(await p.play(track, userId))) throw new Error('Không thể phát bài hát này.');
  if (hadCurrent) schedulePanelUpdate(p);
  return { track, queued: hadCurrent };
 } catch (e) {
  if (created && !p.userdata?.stay247) manager.delete(guild.id);
  throw e;
 }
}

// Theo dõi biến động kênh thoại để tự rời khi kênh trống (nếu tắt 24/7) hoặc tự giữ kết nối khi bật 24/7.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
 const guild = newState.guild ?? oldState.guild;
 const p = manager.get(guild.id);
 if (!p || p.destroyed || !p.userdata) return;

 // Trường hợp trạng thái thoại của chính bot thay đổi.
 if (oldState.id === client.user?.id) {
  if (newState.channelId) {
   p.userdata.voiceChannelId = newState.channelId;
   schedulePanelUpdate(p);
   return;
  }
  if (oldState.channelId && !newState.channelId) {
   if (p.userdata.stay247 && !p.userdata.manualDisconnect && Date.now() - p.userdata.lastReconnectAt > 15000) {
    p.userdata.lastReconnectAt = Date.now();
    const target = guild.channels.cache.get(p.userdata.voiceChannelId);
    const timer = setTimeout(() => {
     if (!p.destroyed && p.userdata?.stay247 && !p.userdata.manualDisconnect && target) {
      p.connect(target).catch(() => {});
     }
    }, 3000);
    timer.unref?.();
    return;
   }
   if (!p.userdata.stay247 && !p.userdata.manualDisconnect) {
    void destroyPlayerSession(guild.id, 'Bot đã ngắt kết nối khỏi kênh thoại.');
   }
  }
  return;
 }

 // Trường hợp người nghe vào/ra kênh thoại của bot.
 const vcId = p.userdata.voiceChannelId;
 if (!vcId || (oldState.channelId !== vcId && newState.channelId !== vcId)) return;
 if (p.userdata.stay247) {
  clearEmptyTimer(p);
  return;
 }
 const listeners = guild.voiceStates.cache.filter(vs => vs.channelId === vcId && vs.id !== client.user?.id).size;
 if (listeners === 0 && !p.userdata.emptyTimer) {
  p.userdata.emptyTimer = setTimeout(() => {
   p.userdata.emptyTimer = null;
   const remain = guild.voiceStates.cache.filter(vs => vs.channelId === vcId && vs.id !== client.user?.id).size;
   if (!p.destroyed && !p.userdata?.stay247 && remain === 0) {
    void destroyPlayerSession(guild.id, 'Kênh thoại không còn người nghe nên bot đã tự rời kênh.');
   }
  }, 30000);
  p.userdata.emptyTimer.unref?.();
 } else if (listeners > 0) {
  clearEmptyTimer(p);
 }
});

// Đồng bộ danh sách lệnh (tên lệnh giữ chuẩn quốc tế, chú thích bằng tiếng Việt) cho một máy chủ cụ thể.
async function syncGuildCommands(appId, targetGuildId) {
 await client.rest.put(Routes.applicationGuildCommands(appId, targetGuildId), { body: commands });
}

client.once(Events.ClientReady, async c => {
 console.log(`[khởi-động] Đã đăng nhập: ${c.user.tag}`);
 const appInfo = await c.application.fetch().catch(() => null);
 if (appInfo?.interactionsEndpointURL) {
  console.warn(`[cảnh-báo] Phát hiện Interactions Endpoint URL cũ (${appInfo.interactionsEndpointURL}), đang tự động gỡ bỏ...`);
  await client.rest.patch(Routes.currentApplication(), { body: { interactions_endpoint_url: null } })
   .then(() => console.log('[khởi-động] Đã tự động xóa Interactions Endpoint URL cũ thành công.'))
   .catch(() => console.error('[CẢNH BÁO] Không thể tự xóa Interactions Endpoint URL. Hãy vào Discord Developer Portal -> General Information xóa trắng ô Interactions Endpoint URL rồi bấm Save Changes.'));
 }
 if (!autoRegister) return;
 try {
  // Xóa các lệnh global tiếng Anh cũ còn sót lại (ví dụ từ BMH) để tránh bị trùng lệnh trên Discord.
  await client.rest.put(Routes.applicationCommands(c.application.id), { body: [] });
  const targets = GUILD_ID ? [GUILD_ID] : [...c.guilds.cache.keys()].slice(0, 5);
  await Promise.all(targets.map(gid => syncGuildCommands(c.application.id, gid)));
  console.log(`[đồng-bộ] Đã cập nhật ${commands.length} lệnh (chú thích tiếng Việt) cho ${targets.length} máy chủ.`);
 } catch (e) {
  console.error('[đồng-bộ-lỗi]', e?.name ?? 'Error', e?.message ?? '');
 }
});

client.on(Events.GuildCreate, guild => {
 if (!autoRegister || !client.application?.id) return;
 if (GUILD_ID ? guild.id !== GUILD_ID : client.guilds.cache.size > 5) return;
 syncGuildCommands(client.application.id, guild.id)
  .then(() => console.log(`[đồng-bộ] Đã đăng ký ${commands.length} lệnh cho máy chủ mới ${guild.id}.`))
  .catch(e => console.error('[đồng-bộ-lỗi]', e?.name ?? 'Error'));
});

client.on(Events.Error, e => console.error('[discord]', e.name));

// Gửi thông báo lỗi tiếng Việt gọn gàng cho mọi loại tương tác (Slash, Nút bấm, Menu, Modal).
async function replyInteractionError(i, e) {
 if (e?.code === 40060) {
  console.error('[CẢNH BÁO] Lệnh đã bị một nơi khác (ví dụ BMH) phản hồi trước! Token bot đang bị dùng trùng — hãy vào Discord Developer Portal bấm Reset Token rồi cập nhật lại trên Botkeep.');
  return;
 }
 console.error('[lỗi-tương-tác]', i.commandName ?? i.customId, e?.name);
 const content = KNOWN_ERROR_RE.test(e?.message ?? '') ? e.message : 'Nguồn nhạc hoặc kết nối gặp lỗi. Vui lòng thử lại sau.';
 if (i.deferred || i.replied) {
  await i.editReply({ content, allowedMentions: { parse: [] } }).catch(() => {});
 } else {
  await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
 }
}

// Xử lý tương tác trên khung Music Player (Nút bấm, Menu thả xuống và Hộp thoại thêm nhạc).
async function handlePlayerComponent(i) {
 const p = manager.get(i.guildId);

 // Trường hợp mở hộp thoại thêm bài hát mới: phải gọi showModal trước khi defer.
 if (
  (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'add_song')
  || (i.isButton() && i.customId === 'player_open_add')
 ) {
  if (!p) throw new Error('Chưa có phiên phát nhạc nào.');
  await requireSameVoiceChannel(i.guild, i.user.id);
  assertMusicAccess('play', i.user.id, p);
  await i.showModal(buildAddSongModal());
  if (p.queue.currentTrack) schedulePanelUpdate(p);
  return;
 }

 // Trường hợp xem hàng đợi từ menu (ai trong máy chủ cũng bấm xem được, hiển thị riêng tư).
 if (i.isStringSelectMenu() && i.customId === 'player_menu' && i.values[0] === 'view_queue') {
  if (!p) throw new Error('Chưa có phiên phát nhạc nào.');
  await i.reply({ embeds: [buildQueueEmbed(p, client.user)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  schedulePanelUpdate(p);
  return;
 }

 // Trường hợp làm mới thanh tiến trình (chỉ cập nhật hiển thị thời gian, có giới hạn chống bấm liên tục).
 if (i.isButton() && i.customId === 'player_refresh') {
  if (!p || !p.queue.currentTrack) return void await i.update(buildEndedPayload());
  const now = Date.now();
  if (now - (refreshCooldown.get(i.guildId) ?? 0) < 2500) {
   return void await i.reply({ content: 'Thanh tiến trình vừa được cập nhật.', flags: MessageFlags.Ephemeral });
  }
  refreshCooldown.set(i.guildId, now);
  if (p.userdata) p.userdata.panelMessage = i.message;
  await i.update(buildPlayerPayload(p));
  return;
 }

 // Trường hợp gửi hộp thoại thêm bài hát (Modal Submit).
 if (i.isModalSubmit() && i.customId === 'player_add_modal') {
  let ownsLock = false;
  try {
   await i.deferReply({ flags: MessageFlags.Ephemeral });
   if (busy) return void await i.editReply({ content: 'Đang xử lý thao tác khác, vui lòng thử lại.' });
   busy = true; ownsLock = true;
   const channel = await requireSameVoiceChannel(i.guild, i.user.id);
   assertMusicAccess('play', i.user.id, manager.get(i.guildId));
   const { track, queued } = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    rawQuery: i.fields.getTextInputValue('query'),
    userId: i.user.id,
   });
   await i.editReply({
    content: queued ? `✅ Đã thêm vào hàng đợi: **${cleanText(track.title, 90)}**` : `▶️ Đang phát: **${cleanText(track.title, 90)}**`,
    allowedMentions: { parse: [] },
   });
  } finally {
   if (ownsLock) busy = false;
  }
  return;
 }

 // Tất cả các nút & mục menu thay đổi nhạc còn lại: bắt buộc cùng kênh thoại và là chủ bài đang phát.
 if (!p) {
  if (i.isButton() || i.isStringSelectMenu()) return void await i.update(buildEndedPayload());
  throw new Error('Chưa có phiên phát nhạc nào.');
 }

 let ownsLock = false;
 try {
  if (busy) {
   return void await i.reply({ content: 'Đang xử lý thao tác khác, vui lòng thử lại.', flags: MessageFlags.Ephemeral });
  }
  busy = true; ownsLock = true;
  await requireSameVoiceChannel(i.guild, i.user.id);
  assertMusicAccess('control', i.user.id, p);
  if (p.userdata) p.userdata.panelMessage = i.message;

  if (i.isButton()) {
   switch (i.customId) {
    case 'player_pause': {
     const nextPaused = !p.isPaused;
     if (nextPaused) p.pause(); else p.resume();
     await i.update(buildPlayerPayload(p, { paused: nextPaused }));
     return;
    }
    case 'player_prev': {
     if (!p.previousTrack) throw new Error('Không có bài hát trước đó để quay lại.');
     await i.deferUpdate();
     if (!(await p.previous())) throw new Error('Không thể quay lại bài trước.');
     return;
    }
    case 'player_skip': {
     await i.deferUpdate();
     p.skip();
     return;
    }
    case 'player_leave': {
     if (p.userdata) {
      p.userdata.manualDisconnect = true;
      p.userdata.stay247 = false;
      p.userdata.ending = true;
      clearPanelTimer(p);
      clearEmptyTimer(p);
      p.userdata.panelMessage = null;
      p.userdata.textChannel = null;
     }
     await i.update(buildEndedPayload('Đã tắt chế độ 24/7 và rời khỏi kênh thoại.'));
     manager.delete(i.guildId);
     return;
    }
    case 'player_stop': {
     if (p.userdata?.stay247) {
      p.userdata.ending = true;
      p.userdata.idleOpen = true;
      p.userdata.skipNextStopEvent = true;
      clearPanelTimer(p);
      p.queue.reset();
      p.stop();
      p.clearLeaveTimeout?.();
      await i.update(buildIdle247Payload(p, 'Đã dừng phát nhạc và xóa hàng đợi — Bot vẫn đang giữ kết nối 24/7.'));
      return;
     }
     if (p.userdata) {
      p.userdata.manualDisconnect = true;
      p.userdata.ending = true;
      clearPanelTimer(p);
      clearEmptyTimer(p);
      p.userdata.panelMessage = null;
      p.userdata.textChannel = null;
     }
     await i.update(buildEndedPayload('Đã dừng phát nhạc, xóa hàng đợi và rời kênh thoại.'));
     manager.delete(i.guildId);
     return;
    }
   }
  }

  if (i.isStringSelectMenu() && i.customId === 'player_menu') {
   switch (i.values[0]) {
    case 'cycle_loop': {
     const order = ['off', 'track', 'queue'];
     const nextMode = order[(order.indexOf(p.loop()) + 1) % order.length];
     p.loop(nextMode);
     await i.update(buildPlayerPayload(p, { loopMode: nextMode }));
     return;
    }
    case 'toggle_247': {
     const next247 = !p.userdata?.stay247;
     apply247State(p, next247);
     await i.update(buildPlayerPayload(p, { stay247: next247 }));
     return;
    }
    case 'shuffle_queue': {
     if (p.upcomingTracks.length < 2) throw new Error('Hàng đợi cần ít nhất 2 bài để trộn.');
     p.shuffle();
     await i.update(buildPlayerPayload(p));
     return;
    }
    case 'vol_down':
    case 'vol_up':
    case 'vol_100': {
     const target = i.values[0] === 'vol_100' ? 100 : Math.min(100, Math.max(0, p.volume + (i.values[0] === 'vol_up' ? 20 : -20)));
     if (!p.setVolume(target)) throw new Error('Không thể chỉnh âm lượng lúc này.');
     await i.update(buildPlayerPayload(p, { volume: target }));
     return;
    }
   }
  }
 } finally {
  if (ownsLock) busy = false;
 }
}

// Xử lý toàn bộ tương tác từ Discord (Lệnh slash + Nút bấm + Menu + Modal trên khung Music Player).
client.on(Events.InteractionCreate, async i => {
 if (!i.guild) return;
 if (GUILD_ID && i.guildId !== GUILD_ID) {
  return void i.reply({ content: 'Bot chỉ phục vụ máy chủ đã cấu hình.', flags: MessageFlags.Ephemeral }).catch(() => {});
 }

 if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) {
  try { await handlePlayerComponent(i); } catch (e) { await replyInteractionError(i, e); }
  return;
 }

 if (!i.isChatInputCommand()) return;
 const reply = content => i.editReply({ content, allowedMentions: { parse: [] } });
 let ownsLock = false;
 try {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (i.commandName === 'help') return await i.editReply({ embeds: [buildHelpEmbed(client.user)], allowedMentions: { parse: [] } });
  if (i.commandName === 'ping') return await reply(`Độ trễ: ${client.ws.ping} ms • Bộ nhớ Node: ${Math.round(process.memoryUsage().rss / 1048576)} MiB (chưa tính tiến trình FFmpeg).`);
  if (busy) return await reply('Đang xử lý lệnh khác, vui lòng thử lại.');
  busy = true; ownsLock = true;

  const p = manager.get(i.guildId);
  if (i.commandName === 'queue') {
   if (!p) return await reply('Chưa có phiên phát nhạc nào.');
   return await i.editReply({ embeds: [buildQueueEmbed(p, client.user)], allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'nowplaying') {
   if (!p || !p.queue.currentTrack) return await reply('Hiện chưa phát bài hát nào.');
   return await i.editReply({ embeds: [buildNowPlayingEmbed(p, client.user)], allowedMentions: { parse: [] } });
  }

  const channel = await requireSameVoiceChannel(i.guild, i.user.id);
  // Kiểm tra quyền điều khiển: chỉ người yêu cầu bài đang phát mới được tác động vào nhạc.
  assertMusicAccess(i.commandName, i.user.id, p);

  if (i.commandName === 'join') {
   const alreadyConnected = Boolean(p?.connection);
   await ensureVoiceSession({ guild: i.guild, voiceChannel: channel, textChannel: i.channel, userId: i.user.id });
   return await reply(alreadyConnected ? `✅ Bot đang ở sẵn trong kênh thoại <#${channel.id}>.` : `✅ Đã tham gia kênh thoại <#${channel.id}>. Dùng \`/play\` để phát nhạc hoặc \`/247\` để giữ bot ở lại 24/7.`);
  }

  if (i.commandName === '247') {
   const chosen = i.options.getString('mode');
   if (!p) {
    if (chosen === 'off') return await reply('Chế độ 24/7 hiện đang tắt (bot chưa ở trong kênh thoại).');
    const { player: createdPlayer } = await ensureVoiceSession({ guild: i.guild, voiceChannel: channel, textChannel: i.channel, userId: i.user.id, initial247: true });
    await closeCurrentPanel(createdPlayer, 'Bot đang treo trong kênh thoại 24/7 và sẵn sàng phát nhạc.', { keepIdle247: true });
    return await reply(`🌙 Đã tham gia <#${channel.id}> và **BẬT** chế độ treo kênh thoại 24/7.`);
   }
   const next247 = chosen ? chosen === 'on' : !p.userdata?.stay247;
   if (p.userdata) p.userdata.textChannel = i.channel;
   apply247State(p, next247);
   if (p.queue.currentTrack) {
    schedulePanelUpdate(p, { stay247: next247 });
   } else if (next247) {
    await closeCurrentPanel(p, 'Bot đang treo trong kênh thoại 24/7 và sẵn sàng phát nhạc.', { keepIdle247: true });
   } else {
    await closeCurrentPanel(p, 'Đã tắt chế độ 24/7 — bot sẽ tự rời kênh thoại sau 30 giây nếu không phát nhạc.');
   }
   return await reply(
    next247
     ? `🌙 Đã **BẬT** chế độ 24/7 — bot sẽ giữ kết nối trong <#${channel.id}> ngay cả khi hết nhạc hoặc vắng người.`
     : '🌙 Đã **TẮT** chế độ 24/7 — bot sẽ tự rời kênh thoại sau 30 giây khi hết nhạc hoặc không còn người nghe.',
   );
  }

  if (i.commandName === 'leave') {
   if (!p) throw new Error('Bot hiện không ở trong kênh thoại nào.');
   await destroyPlayerSession(i.guildId, 'Đã dừng phát nhạc và rời kênh thoại theo lệnh `/leave`.');
   return await reply('👋 Đã tắt chế độ 24/7, xóa hàng đợi và rời khỏi kênh thoại.');
  }

  if (i.commandName === 'play') {
   const { track, queued } = await enqueueAndPlay({
    guild: i.guild,
    voiceChannel: channel,
    textChannel: i.channel,
    rawQuery: i.options.getString('query', true),
    userId: i.user.id,
   });
   return await reply(
    queued
     ? `✅ Đã thêm vào hàng đợi: **${cleanText(track.title, 90)}**`
     : `▶️ Đang phát: **${cleanText(track.title, 90)}** — dùng khung điều khiển bên dưới kênh chat để thao tác nhanh!`,
   );
  }

  if (!p) throw new Error('Chưa có phiên phát nhạc nào.');
  switch (i.commandName) {
   case 'loop': {
    const mode = i.options.getString('mode', true);
    if (!LOOP_LABELS[mode]) throw new Error('Lệnh lặp không hợp lệ.');
    p.loop(mode);
    schedulePanelUpdate(p, { loopMode: mode });
    return await reply(`Chế độ lặp: ${LOOP_LABELS[mode]}.`);
   }
   case 'shuffle':
    if (p.upcomingTracks.length < 2) throw new Error('Hàng đợi cần ít nhất 2 bài để trộn.');
    p.shuffle();
    schedulePanelUpdate(p);
    return await reply('Đã trộn ngẫu nhiên các bài đang chờ.');
   case 'volume': {
    const percent = i.options.getInteger('percent', true);
    if (percent < 0 || percent > 100) throw new Error('Lệnh âm lượng chỉ nhận 0–100.');
    if (!p.setVolume(percent)) throw new Error('Không thể chỉnh âm lượng lúc này.');
    schedulePanelUpdate(p, { volume: percent });
    return await reply(`Đã đặt âm lượng: ${percent}%.`);
   }
   case 'remove': {
    const position = i.options.getInteger('position', true);
    if (position < 1 || position > p.upcomingTracks.length) throw new Error('Hàng đợi không có vị trí này.');
    const removed = p.queue.remove(position - 1);
    if (!removed) throw new Error('Không thể xóa bài ở vị trí này.');
    schedulePanelUpdate(p);
    return await reply(`Đã xóa khỏi hàng đợi: ${cleanText(removed.title, 90)}`);
   }
   case 'pause': p.pause(); schedulePanelUpdate(p, { paused: true }); return await reply('Đã tạm dừng phát nhạc.');
   case 'resume': p.resume(); schedulePanelUpdate(p, { paused: false }); return await reply('Đã tiếp tục phát nhạc.');
   case 'skip': p.skip(); return await reply('Đã bỏ qua bài hiện tại.');
   case 'stop':
    if (p.userdata?.stay247) {
     p.userdata.idleOpen = true;
     p.userdata.skipNextStopEvent = true;
     p.queue.reset();
     p.stop();
     p.clearLeaveTimeout?.();
     await closeCurrentPanel(p, 'Đã dừng phát nhạc và xóa hàng đợi — Bot vẫn đang giữ kết nối 24/7.', { keepIdle247: true });
     return await reply('⏹️ Đã dừng nhạc và xóa hàng đợi (bot vẫn ở lại kênh thoại do đang bật `/247`; dùng `/leave` nếu muốn rời kênh).');
    }
    await destroyPlayerSession(i.guildId, 'Đã dừng phát nhạc, xóa hàng đợi và rời kênh thoại.');
    return await reply('Đã dừng nhạc, xóa hàng đợi và rời kênh thoại.');
   default: throw new Error('Lệnh không hợp lệ.');
  }
 } catch (e) {
  await replyInteractionError(i, e);
 } finally {
  if (ownsLock) busy = false;
 }
});

// Dọn dẹp tài nguyên phát nhạc, kết nối Discord và cổng HTTP khi tắt tiến trình.
async function shutdown(code = 0) {
 if (closing) return; closing = true;
 const timer = setTimeout(() => process.exit(code || 1), 5000); timer.unref();
 try { manager.destroy(); client.destroy(); server.close(() => process.exit(code)); }
 catch { process.exit(1); }
}
function fatal(e) { console.error('[lỗi-nghiêm-trọng]', e?.name ?? 'Error'); void shutdown(1); }
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
process.on('unhandledRejection', fatal);
process.on('uncaughtException', fatal);
await client.login(DISCORD_TOKEN).catch(fatal);
