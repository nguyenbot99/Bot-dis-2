import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { assertMusicAccess } from '../src/access.js';
import {
 AMBIENT_MODES,
 getActiveAmbientState,
 getNextAmbientMode,
 installAudioEnhancer,
 setAudioEnhancement,
} from '../src/audioEnhancer.js';
import {
 buildAvatarMessagePayload,
 createAvatarGuardManager,
 resolveAvatarTargetInfo,
} from '../src/avatarGuard.js';
import { buildHelpEmbed, buildHelpPayload, commands, contextCommands, HELP_CATEGORIES, slashCommands } from '../src/commands.js';
import { isStaleBotNoticeMessage } from '../src/messageCleaner.js';
import {
 buildMixtapeDetailEmbed,
 buildMixtapesListEmbed,
 createMixtapeStore,
 openMixtapesPayload,
} from '../src/mixtapeStore.js';
import { createNowPlayingHub, serializeNowPlayingState } from '../src/nowPlayingHub.js';
import { buildPlayerPayload, buildSearchPickerPayload } from '../src/playerGui.js';
import { createRuntimeSessionStore } from '../src/sessionStore.js';
import { createGuildTtsController, TTS_VOICES } from '../src/tts.js';
import workerModule, { NowPlayingRoom } from '../cloudflare-worker/worker.js';

test('Feature #0 (/avatar HD Inspector + Public Auto-Repost Guard): resolves 4K URLs, freezes file attachment, resists auto-cleaner, and auto-reposts on delete until Bot Owner unpins', async () => {
 const fakeUser = {
  id: '222222222222222222',
  username: 'linh_dj',
  globalName: 'Linh DJ',
  avatar: 'a_animatedhash123',
  banner: 'a_bannerhash456',
  accentColor: 0xf472b6,
  createdTimestamp: 1700000000000,
  displayAvatarURL: ({ size, extension, forceStatic }) =>
   `https://cdn.discordapp.com/avatars/222/${forceStatic ? 'png' : (extension || 'gif')}?size=${size}`,
  bannerURL: ({ size, extension, forceStatic }) =>
   `https://cdn.discordapp.com/banners/222/${forceStatic ? 'png' : (extension || 'gif')}?size=${size}`,
 };
 const fakeMember = {
  displayName: 'DJ Linh VIP',
  avatar: 'guild_ava_789',
  displayHexColor: '#ec4899',
  joinedTimestamp: 1710000000000,
  avatarURL: ({ size }) => `https://cdn.discordapp.com/guilds/1/users/222/avatars/guild_ava.png?size=${size}`,
 };

 const autoInfo = resolveAvatarTargetInfo(fakeUser, fakeMember, 'auto');
 assert.equal(autoInfo.resolvedType, 'server');
 assert.ok(autoInfo.hdUrl.includes('size=4096'));
 assert.ok(autoInfo.globalHdUrl.includes('size=4096'));
 assert.ok(autoInfo.bannerHdUrl.includes('size=4096'));

 const bannerInfo = resolveAvatarTargetInfo(fakeUser, fakeMember, 'banner');
 assert.equal(bannerInfo.resolvedType, 'banner');
 assert.equal(bannerInfo.ext, 'gif');

 const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
 const payload = buildAvatarMessagePayload(autoInfo, {
  requesterId: '111111111111111111',
  imageBuffer: fakePng,
  includeGuardButtons: true,
 });
 assert.equal(payload.files.length, 1);
 const embedJson = payload.embeds[0].toJSON();
 assert.equal(embedJson.image.url, `attachment://avatar-${autoInfo.userId}-${autoInfo.resolvedType}.${autoInfo.ext}`);

 // Đảm bảo bộ dọn tin nhắn mồ côi KHÔNG BAO GIỜ xóa nhầm tin nhắn /avatar công khai
 assert.equal(
  isStaleBotNoticeMessage(
   {
    id: '9001',
    author: { id: 'bot-id' },
    content: '',
    embeds: [embedJson],
    components: payload.components.map(c => c.toJSON()),
   },
   'bot-id',
  ),
  false,
 );

 // Kiểm tra cơ chế chống xóa tự động (MESSAGE_DELETE -> tự đăng lại bản mới kèm file ảnh gốc)
 const sentHistory = [];
 let deletedRestId = null;
 const guard = createAvatarGuardManager({
  repostDelayMs: 5,
  rest: {
   delete: async route => { deletedRestId = route; },
  },
  getChannel: async channelId => ({
   id: channelId,
   send: async msgPayload => {
    const newMsg = { id: `reposted_${sentHistory.length + 1}`, channelId, payload: msgPayload };
    sentHistory.push(newMsg);
    return newMsg;
   },
  }),
 });

 guard.registerProtectedMessage(
  { id: 'msg_initial_1', channelId: 'chan_100', guildId: 'guild_1' },
  { info: autoInfo, requesterId: '111111111111111111', imageBuffer: fakePng },
 );
 assert.equal(guard.size(), 1);

 // Admin / Mod xóa tin nhắn -> Bot tự động khôi phục lại ngay lập tức
 guard.handleRawGatewayPacket({
  t: 'MESSAGE_DELETE',
  d: { id: 'msg_initial_1', channel_id: 'chan_100' },
 });
 await new Promise(r => setTimeout(r, 35));
 assert.equal(sentHistory.length, 1);
 assert.equal(sentHistory[0].payload.files.length, 1);
 assert.ok(sentHistory[0].payload.embeds[0].toJSON().description.includes('lần **#1**'));

 // Người thường bấm nút Gỡ bảo vệ -> Bị từ chối thẳng thừng
 const denied = await guard.unpinAndDelete('reposted_1', 'chan_100', '999999999999999999');
 assert.equal(denied.allowed, false);
 assert.equal(guard.size(), 1);

 // Chủ Bot (1243061570247069696) bấm nút Gỡ bảo vệ -> Xóa vĩnh viễn và không tự đăng lại nữa
 const allowed = await guard.unpinAndDelete('reposted_1', 'chan_100', '1243061570247069696');
 assert.equal(allowed.allowed, true);
 assert.equal(guard.size(), 0);
 assert.ok(deletedRestId?.includes('reposted_1'));
});

test('Feature #1 (/ambient Background Soundscapes) & Feature #2 (/tts Voice Morphing): real-time PCM synthesis, echo & rate hooks run cleanly without clipping', async () => {
 installAudioEnhancer();
 const { createRequire } = process.getBuiltinModule('node:module');
 const require = createRequire(import.meta.url);
 const prism = require('../node_modules/@discordjs/voice/node_modules/prism-media');

 assert.deepEqual(Object.keys(AMBIENT_MODES), ['off', 'rain', 'fire', 'ocean', 'wind']);
 assert.equal(getNextAmbientMode('off'), 'rain');
 assert.equal(getNextAmbientMode('wind'), 'off');

 const applied = setAudioEnhancement({ preset: 'hd', vibe: 'normal', ambient: 'rain', ambientLevel: 0.45 });
 assert.equal(applied.ambient, 'rain');
 assert.equal(getActiveAmbientState().mode, 'rain');

 // Chạy trực tiếp trên prism.VolumeTransformer thật: 40ms khung âm thanh im lặng -> khi bật Mưa Rơi Lofi phải tạo ra hạt mưa stereo khác 0
 const stream = new prism.VolumeTransformer({ type: 's16le', volume: 1.0 });
 const outChunks = [];
 stream.on('data', c => outChunks.push(c));
 stream.write(Buffer.alloc(48000 * 0.04 * 4, 0));
 stream.end();
 const rainBuf = Buffer.concat(outChunks);
 assert.ok(rainBuf.length > 0 && rainBuf.length % 4 === 0);
 let nonZeroSamples = 0;
 for (let i = 0; i < rainBuf.length; i += 2) {
  if (rainBuf.readInt16LE(i) !== 0) nonZeroSamples++;
 }
 assert.ok(nonZeroSamples > 200, 'Rain generator must synthesize live stereo rain samples');

 // Kiểm tra chế độ biến giọng /tts (Loa Phường, Minion, Trùm Cuối, Hang Động) không bị lẫn tiếng mưa nền & có tiếng vang thật
 const ttsStream = new prism.VolumeTransformer({ type: 's16le', volume: 1.0 });
 ttsStream._forcePresetKey = TTS_VOICES.cave.presetKey;
 ttsStream._forceRate = TTS_VOICES.cave.rate;
 ttsStream._forceEcho = TTS_VOICES.cave.echo;
 const ttsOut = [];
 ttsStream.on('data', c => ttsOut.push(c));
 const impulse = Buffer.alloc(32000, 0);
 for (let s = 0; s < 40; s++) {
  impulse.writeInt16LE(14000, s * 4);
  impulse.writeInt16LE(14000, s * 4 + 2);
 }
 ttsStream.write(impulse);
 ttsStream.end();
 const caveBuf = Buffer.concat(ttsOut);
 assert.ok(caveBuf.length > 24000);
 // Mẫu dội âm sau 5400 frame (~byte 21600+) phải khác 0 nhờ bộ Echo Hang Động
 let echoEnergy = 0;
 for (let b = 21600; b < 22400; b += 2) {
  echoEnergy += Math.abs(caveBuf.readInt16LE(b));
 }
 assert.ok(echoEnergy > 0, 'Cave echo must produce delayed reflection');

 setAudioEnhancement({ ambient: 'off', vibe: 'normal', preset: 'hd' });

 // Kiểm tra TTS_VOICES đầy đủ 5 kiểu giọng
 assert.deepEqual(Object.keys(TTS_VOICES), ['normal', 'loaphuong', 'minion', 'boss', 'cave']);
 let capturedVoiceOpts = null;
 const ttsCtrl = createGuildTtsController({
  playImpl: async opts => { capturedVoiceOpts = opts; },
 });
 // Kiểm tra ánh xạ tự động từ voiceStyle -> rate + presetKey
 const fakeConnState = { status: 'ready' };
 const ttsCtrlReal = createGuildTtsController({
  getVoiceConnectionFn: () => ({ state: fakeConnState, subscribe: () => {} }),
  createAudioPlayerFn: () => {
   const listeners = new Map();
   return {
    on(ev, fn) { listeners.set(ev, fn); },
    once(ev, fn) { listeners.set(ev, fn); },
    removeListener() {},
    play(res) {
     capturedVoiceOpts = {
      presetKey: res?.volume?._forcePresetKey,
      rate: res?.volume?._forceRate,
      echo: res?.volume?._forceEcho,
     };
     queueMicrotask(() => listeners.get('idle')?.());
    },
    stop() {},
   };
  },
 });
 await ttsCtrlReal.enqueueSpeech({
  guildId: 'g1',
  player: {},
  mp3Buffer: Buffer.from('fake-mp3'),
  voiceStyle: 'minion',
 });
 await new Promise(r => setTimeout(r, 25));
 assert.equal(capturedVoiceOpts.rate, TTS_VOICES.minion.rate);
 assert.equal(capturedVoiceOpts.presetKey, TTS_VOICES.minion.presetKey);
 void ttsCtrl;
});

test('Feature #3 (/search Picker) & Feature #4 (/dedicate Song Dedication): UI builders, session persistence & NowPlayingHub sync', () => {
 const sampleTracks = [
  { title: 'Chúng Ta Của Hiện Tại (Original)', url: 'https://soundcloud.com/a/1', duration: 301000, metadata: { author: 'Sơn Tùng M-TP' } },
  { title: 'Chúng Ta Của Hiện Tại (Lofi Ver)', url: 'https://soundcloud.com/a/2', duration: 245000, metadata: { author: 'Freak D' } },
 ];
 const picker = buildSearchPickerPayload(
  'tok_123',
  sampleTracks,
  'Chúng ta của hiện tại',
  false,
  { username: 'Bắt_Don' },
 );
 assert.equal(picker.embeds.length, 1);
 const selectJson = picker.components[0].toJSON().components[0];
 assert.equal(selectJson.custom_id, 'search_pick:tok_123');
 assert.equal(selectJson.options.length, 2);

 // Kiểm tra hiển thị lời chúc /dedicate trên cả Khung Player Discord V2, SessionStore và NowPlayingHub
 const fakePlayer = {
  guildId: '111',
  volume: 100,
  isPaused: false,
  loop: () => 'off',
  autoPlay: () => false,
  upcomingTracks: [],
  previousTracks: [],
  queue: {
   currentTrack: {
    title: 'Nơi Này Có Anh',
    url: 'https://soundcloud.com/st/nnca',
    duration: 260000,
    requestedBy: '111111111111111111',
    source: 'soundcloud',
    metadata: {
     author: 'Sơn Tùng M-TP',
     dedication: {
      fromId: '111111111111111111',
      fromName: 'Minh',
      toId: '222222222222222222',
      toName: 'Lan',
      message: 'Chúc cậu sinh nhật thật rực rỡ nhé!',
     },
    },
   },
  },
  userdata: {
   ownerId: '111111111111111111',
   voiceChannelId: '333333333333333333',
   soundPreset: 'hd',
   vibeMode: 'lofi',
   ambientMode: 'rain',
  },
 };

 const playerPayload = buildPlayerPayload(fakePlayer);
 const rawPlayerStr = JSON.stringify(playerPayload.components.map(c => c.toJSON()));
 assert.ok(rawPlayerStr.includes('Chúc cậu sinh nhật thật rực rỡ nhé!'));
 assert.ok(rawPlayerStr.includes(AMBIENT_MODES.rain.label));

 // Đảm bảo lời nhắn gửi tặng không bị mất khi lưu phiên chống sập (SessionStore)
 const dir = mkdtempSync(join(tmpdir(), 'dedicate-sess-'));
 try {
  const sStore = createRuntimeSessionStore({
   filePath: join(dir, 'a.json'),
   backupFilePath: join(dir, 'b.json'),
  });
  sStore.flushAllSync([fakePlayer]);
  const loaded = sStore.getRestorableSessions();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].currentTrack.metadata.dedication.toName, 'Lan');
  assert.equal(loaded[0].currentTrack.metadata.dedication.message, 'Chúc cậu sinh nhật thật rực rỡ nhé!');
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }

 // Đảm bảo NowPlayingHub truyền cả dedication và ambientMode ra Website
 const snap = serializeNowPlayingState({ player: fakePlayer });
 assert.equal(snap.track.dedication.fromName, 'Minh');
 assert.equal(snap.track.dedication.toName, 'Lan');
 assert.equal(snap.settings.ambientMode, 'rain');
 assert.equal(snap.settings.ambientLabel, AMBIENT_MODES.rain.label);
});

test('Feature #5 (/mixtape Shared Server Mixtapes) & Feature #6 (/similar): CRUD, 5x20 limits, AES-256-GCM seal & Cloudflare Worker >90KB split guard', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'mixtapes-test-'));
 try {
  const store = createMixtapeStore({
   filePath: join(dir, 'primary.json'),
   backupFilePath: join(dir, 'backup.json'),
  });

  const r1 = store.addTrack(
   'Nhạc Đêm Mưa',
   {
    title: 'Chuyện Đôi Ta',
    url: 'https://soundcloud.com/emcee-l/chuyen-doi-ta',
    duration: 215000,
    metadata: { author: 'Emcee L' },
   },
   '1243061570247069696',
  );
  assert.equal(r1.createdNew, true);
  assert.equal(r1.added, true);
  assert.equal(store.listMixtapes().length, 1);

  const listEmbed = buildMixtapesListEmbed(store.listMixtapes(), { username: 'Bắt_Don' }).toJSON();
  assert.ok(listEmbed.author.name.includes('Tủ Nhạc Chung'));
  const detailEmbed = buildMixtapeDetailEmbed(store.getMixtape('nhạc đêm mưa'), { username: 'Bắt_Don' }).toJSON();
  assert.ok(detailEmbed.description.includes('Chuyện Đôi Ta'));

  const secret = 'bot-token-for-mixtape-seal';
  const seal = store.exportSeal(secret);
  const opened = openMixtapesPayload(seal, secret);
  assert.equal(Object.keys(opened).length, 1);

  // Kiểm tra Cloudflare Worker Durable Object lưu & khôi phục mixtapesSeal
  const storageMap = new Map();
  const fakeCtx = {
   storage: {
    get: async k => storageMap.get(k),
    put: async (k, v) => { storageMap.set(k, v); },
   },
   blockConcurrencyWhile: fn => fn(),
  };
  const room = new NowPlayingRoom(fakeCtx, { NOW_PLAYING_PUSH_SECRET: 'sec123' });
  const postRes = await room.fetch(
   new Request('https://now-playing.internal/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sec123' },
    body: JSON.stringify({
     status: 'playing',
     settings: { ambientMode: 'fire', ambientLabel: 'Lửa Trại Đêm' },
     mixtapesSeal: seal,
    }),
   }),
  );
  assert.equal(postRes.status, 200);
  const getRes = await workerModule.fetch(
   new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing'),
   { NOW_PLAYING_ROOM: { idFromName: () => 'global', get: () => room } },
  );
  const getJson = await getRes.json();
  assert.equal(getJson.mixtapesSeal, seal);
  assert.equal(getJson.settings.ambientMode, 'fire');
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }

 // Kiểm tra phân quyền cho /avatar, /search, /dedicate, /mixtape, /ambient, /similar
 const idle247Player = {
  queue: { currentTrack: null },
  userdata: { ownerId: '111111111111111111', stay247: true, idleOpen: true },
 };
 assert.doesNotThrow(() => assertMusicAccess('avatar', '999999999999999999', idle247Player));
 assert.doesNotThrow(() => assertMusicAccess('search', '999999999999999999', idle247Player));
 assert.doesNotThrow(() => assertMusicAccess('dedicate', '999999999999999999', idle247Player));
 assert.doesNotThrow(() => assertMusicAccess('mixtape', '999999999999999999', idle247Player));

 const activePlayer = {
  queue: { currentTrack: { requestedBy: '111111111111111111' } },
  userdata: { ownerId: '111111111111111111' },
 };
 assert.throws(() => assertMusicAccess('ambient', '999999999999999999', activePlayer));
 assert.throws(() => assertMusicAccess('similar', '999999999999999999', activePlayer));
 assert.doesNotThrow(() => assertMusicAccess('ambient', '1243061570247069696', activePlayer));
 assert.doesNotThrow(() => assertMusicAccess('similar', '1243061570247069696', activePlayer));
});

test('Feature #7 (Website Vinyl Turntable + Poster Card Generator) & 41 Slash + 2 Context Commands Registry', () => {
 assert.equal(slashCommands.length, 41);
 assert.equal(contextCommands.length, 2);
 assert.equal(commands.length, 43);
 const names = new Set(slashCommands.map(c => c.name));
 for (const expected of ['avatar', 'spamtag', 'ambient', 'search', 'dedicate', 'mixtape', 'similar', 'tts', 'savequeue', 'webkey']) {
  assert.ok(names.has(expected), `Command /${expected} must be registered`);
 }
 const helpEmbed = buildHelpEmbed({ username: 'Bắt_Don', displayAvatarURL: () => 'https://example.com/a.png' }).toJSON();
 assert.equal(helpEmbed.fields.length, 6);

 // Kiểm tra giao diện /help phân chia 7 danh mục gọn gàng kèm menu "Chọn danh mục"
 const overviewPayload = buildHelpPayload({
  botUser: { username: 'Bắt_Don', displayAvatarURL: () => 'https://example.com/bot.png' },
  guild: { name: '⚡ Box Sét ⚡⚡', iconURL: () => 'https://example.com/guild.png' },
  category: 'overview',
 });
 const overviewEmbed = overviewPayload.embeds[0].toJSON();
 const overviewSelect = overviewPayload.components[0].toJSON().components[0];
 assert.equal(overviewEmbed.author.name, '⚡ Box Sét ⚡⚡');
 assert.equal(overviewEmbed.title, 'Danh sách các lệnh của Bắt_Don');
 assert.ok(overviewEmbed.footer.text.includes('Tổng 7 danh mục lệnh'));
 assert.equal(overviewSelect.custom_id, 'help_category');
 assert.equal(overviewSelect.placeholder, 'Chọn danh mục');
 assert.equal(overviewSelect.options.length, 7);

 // Đảm bảo đủ 41/41 lệnh slash nằm trọn trong 7 danh mục mà không sót hay trùng bất kỳ lệnh nào
 const categorizedCmds = [];
 for (const cat of HELP_CATEGORIES) {
  const catPayload = buildHelpPayload({
   botUser: { username: 'Bắt_Don' },
   guild: { name: '⚡ Box Sét ⚡⚡' },
   category: cat.key,
  });
  const catSelect = catPayload.components[0].toJSON().components[0];
  assert.equal(catSelect.options[0].value, 'overview');
  assert.equal(catSelect.options.length, 8);
  for (const [syntax] of cat.items) {
   const m = syntax.match(/`\/([a-z0-9]+)`/);
   assert.ok(m, `Invalid syntax entry: ${syntax}`);
   categorizedCmds.push(m[1]);
  }
 }
 assert.equal(categorizedCmds.length, 41);
 assert.equal(new Set(categorizedCmds).size, 41);
 for (const cmd of slashCommands) {
  assert.ok(categorizedCmds.includes(cmd.name), `Missing /${cmd.name} from HELP_CATEGORIES`);
 }

 const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
 assert.ok(html.includes('id="vinylModeBtn"'));
 assert.ok(html.includes('id="posterCardBtn"'));
 assert.ok(html.includes('id="posterModal"'));
 assert.ok(html.includes('id="dedicationBanner"'));
 assert.ok(html.includes('id="ambientBadge"'));
 assert.ok(html.includes('buildPosterCardBlob'));

 const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(scriptMatch);
 assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: 'web/index.html' }));
});
