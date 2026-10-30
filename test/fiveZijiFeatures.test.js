import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ApplicationCommandType } from 'discord.js';
import ffmpeg from 'ffmpeg-static';

const voiceRequire = createRequire(import.meta.resolve('@discordjs/voice'));
const prism = voiceRequire('prism-media');

import { assertMusicAccess } from '../src/access.js';
import { installAudioEnhancer, setAudioEnhancement, triggerSmoothTransitionFade } from '../src/audioEnhancer.js';
import { CONTEXT_AVATAR_NAME, CONTEXT_PLAY_NAME, contextCommands } from '../src/commands.js';
import { isStaleBotNoticeMessage } from '../src/messageCleaner.js';
import { buildSaveQueuePayload, extractPlayableFromMessage, extractSaveQueueUrls } from '../src/saveQueue.js';
import { createWebRemoteManager, normalizeRemoteCommandInput } from '../src/webRemote.js';
import workerDefault, { NowPlayingRoom } from '../cloudflare-worker/worker.js';

test('Feature #1: Context Menu Commands (Message Play & User 4K Avatar) + Smart Message Extraction', () => {
 assert.equal(contextCommands.length, 2);
 const msgMenu = contextCommands.find(c => c.type === ApplicationCommandType.Message);
 const usrMenu = contextCommands.find(c => c.type === ApplicationCommandType.User);
 assert.ok(msgMenu);
 assert.ok(usrMenu);
 assert.equal(msgMenu.name, CONTEXT_PLAY_NAME);
 assert.equal(usrMenu.name, CONTEXT_AVATAR_NAME);
 assert.ok(msgMenu.name.length <= 32 && usrMenu.name.length <= 32);
 assert.equal(msgMenu.dm_permission, false);
 assert.equal(usrMenu.dm_permission, false);

 // Bắt link nhạc từ tin nhắn chat kèm chữ thừa & dấu câu
 const fromLink = extractPlayableFromMessage({
  content: 'Ê nghe thử bài này đỉnh lắm https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc!',
 });
 assert.equal(fromLink.kind, 'query');
 assert.ok(fromLink.query.startsWith('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'));

 // Bắt tên bài hát thuần túy sau khi gọt sạch mention & custom emoji
 const fromText = extractPlayableFromMessage({
  content: '<@1243061570247069696> <:pepe_jam:123456789012345678> Nơi Này Có Anh Sơn Tùng',
 });
 assert.deepEqual(fromText, { kind: 'query', query: 'Nơi Này Có Anh Sơn Tùng' });

 // Báo lỗi thân thiện tiếng Việt khi tin nhắn rỗng
 assert.throws(
  () => extractPlayableFromMessage({ content: '   ', embeds: [] }),
  /Tin nhắn này không chứa tên bài hát/,
 );
});

test('Feature #3: /savequeue Stateless Queue Snapshot + 1-Tap Restore + Anti-Sweep Safety', () => {
 const mockPlayer = {
  queue: {
   currentTrack: {
    title: 'Nơi Này Có Anh [Official MV] (Remix)',
    url: 'https://soundcloud.com/sontungmtp/noi-nay-co-anh',
    duration: 260000,
    thumbnail: 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg',
    requestedBy: '111111111111111111',
   },
  },
  upcomingTracks: [
   {
    title: 'Chúng Ta Của Hiện Tại',
    url: 'https://soundcloud.com/sontungmtp/chung-ta-cua-hien-tai',
    duration: 301000,
   },
   {
    title: 'Muộn Rồi Mà Sao Còn',
    url: 'https://soundcloud.com/sontungmtp/muon-roi-ma-sao-con',
    duration: 275000,
   },
  ],
 };

 // Ai trong server cũng được gõ /savequeue để đóng gói, nhưng /webkey bị chặn nếu không phải chủ bài hay chủ bot
 assert.doesNotThrow(() => assertMusicAccess('savequeue', '999999999999999999', mockPlayer));
 assert.throws(() => assertMusicAccess('webkey', '999999999999999999', mockPlayer), /chỉ người yêu cầu/i);
 assert.doesNotThrow(() => assertMusicAccess('webkey', '111111111111111111', mockPlayer));
 assert.doesNotThrow(() => assertMusicAccess('webkey', '1243061570247069696', mockPlayer));

 const { payload, count } = buildSaveQueuePayload(mockPlayer, {
  customTitle: 'Đêm Mưa Chill',
  requesterId: '111111111111111111',
  botUser: { username: 'Bắt_Don' },
  includeRestoreButton: true,
 });
 assert.equal(count, 3);
 assert.equal(payload.components[0].toJSON().components[0].custom_id, 'savequeue_restore');

 // Đọc ngược từ Embed vừa tạo (cả qua nút bấm lẫn qua Context Menu "▶️ Phát / Thêm nhạc")
 const fakeDiscordMessage = {
  id: '199999999999999999',
  author: { id: '888888888888888888' },
  embeds: [payload.embeds[0].toJSON()],
  components: payload.components.map(c => c.toJSON()),
 };
 const parsed = extractSaveQueueUrls(fakeDiscordMessage);
 assert.ok(parsed);
 assert.deepEqual(parsed.urls, [
  'https://soundcloud.com/sontungmtp/noi-nay-co-anh',
  'https://soundcloud.com/sontungmtp/chung-ta-cua-hien-tai',
  'https://soundcloud.com/sontungmtp/muon-roi-ma-sao-con',
 ]);

 const viaContext = extractPlayableFromMessage(fakeDiscordMessage);
 assert.equal(viaContext.kind, 'savequeue');
 assert.equal(viaContext.urls.length, 3);

 // Bộ dọn rác messageCleaner tuyệt đối không bao giờ xóa nhầm Thẻ Phiên Nhạc (/savequeue)
 assert.equal(
  isStaleBotNoticeMessage(fakeDiscordMessage, {
   botId: '888888888888888888',
   now: Date.now() + 86_400_000,
  }),
  false,
 );
});

test('Feature #2: Two-Way Website Remote Control (/webkey PIN + Brute-Force Guard + Cloudflare Worker Queue)', async () => {
 const fakeNow = Date.now();
 const remote = createWebRemoteManager({ nowFn: () => fakeNow });

 const ownerIssued = remote.issueOrGetPin('1243061570247069696');
 const djIssued = remote.issueOrGetPin('222222222222222222');
 assert.equal(ownerIssued.role, 'owner');
 assert.equal(djIssued.role, 'dj');
 assert.match(ownerIssued.pin, /^\d{6}$/);
 assert.match(djIssued.pin, /^\d{6}$/);
 assert.notEqual(ownerIssued.pin, djIssued.pin);

 // Brute-force: sai 5 lần liên tiếp từ 1 IP sẽ bị khóa tạm 60 giây
 for (let attempt = 0; attempt < 5; attempt++) {
  const bad = remote.verifyPin('000000', '1.2.3.4');
  assert.equal(bad.ok, false);
 }
 const locked = remote.verifyPin(ownerIssued.pin, '1.2.3.4');
 assert.equal(locked.ok, false);
 assert.equal(locked.locked, true);

 // IP khác vẫn xác thực bình thường
 const okVerify = remote.verifyPin(ownerIssued.pin, '5.6.7.8');
 assert.equal(okVerify.ok, true);
 assert.equal(okVerify.role, 'owner');

 // Kiểm tra giới hạn âm lượng 0 - 200% trên lệnh từ xa
 assert.equal(normalizeRemoteCommandInput({ action: 'volume', value: 185 }).value, 185);
 assert.throws(() => normalizeRemoteCommandInput({ action: 'volume', value: 250 }), /0% – 200%/);

 // Kiểm tra luồng Cloudflare Worker Durable Object: ẩn remoteAuth khỏi GET công khai, xác thực PIN SHA-256 & trả lệnh về Bot
 const storageMap = new Map();
 const room = new NowPlayingRoom(
  {
   storage: {
    get: async k => storageMap.get(k),
    put: async (k, v) => storageMap.set(k, v),
   },
  },
  { NOW_PLAYING_PUSH_SECRET: 'top-secret-key' },
 );

 const env = {
  NOW_PLAYING_PUSH_SECRET: 'top-secret-key',
  NOW_PLAYING_ROOM: {
   idFromName: () => 'global',
   get: () => room,
  },
 };

 // 1. Bot đẩy trạng thái kèm bảng băm remoteAuth lên Worker
 const pushRes = await workerDefault.fetch(
  new Request('https://bot.workers.dev/api/now-playing', {
   method: 'POST',
   headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer top-secret-key',
   },
   body: JSON.stringify({
    status: 'playing',
    statusLabel: 'Đang phát',
    remoteControl: { enabled: true },
    remoteAuth: remote.exportWorkerAuth(),
    track: { title: 'Test Song', durationMs: 180000, positionMs: 1000 },
   }),
  }),
  env,
  {},
 );
 assert.equal(pushRes.status, 200);

 // 2. Người xem công khai gọi GET /api/now-playing -> TUYỆT ĐỐI không bị lộ remoteAuth (salt/hash)
 const pubGet = await workerDefault.fetch(new Request('https://bot.workers.dev/api/now-playing'), env, {});
 const pubData = await pubGet.json();
 assert.equal(pubData.remoteAuth, undefined);
 assert.equal(pubData.remoteControl.enabled, true);

 // 3. Trình duyệt gửi mã PIN sai -> bị từ chối 401
 const badCmdRes = await workerDefault.fetch(
  new Request('https://bot.workers.dev/api/remote-command', {
   method: 'POST',
   headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
   body: JSON.stringify({ pin: '000000', action: 'skip' }),
  }),
  env,
  {},
 );
 assert.equal(badCmdRes.status, 401);

 // 4. Trình duyệt gửi mã PIN đúng của DJ -> xếp hàng lệnh thành công
 const goodCmdRes = await workerDefault.fetch(
  new Request('https://bot.workers.dev/api/remote-command', {
   method: 'POST',
   headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '8.8.8.8' },
   body: JSON.stringify({ pin: djIssued.pin, action: 'vibe', value: 'nightcore' }),
  }),
  env,
  {},
 );
 assert.equal(goodCmdRes.status, 200);
 const goodCmdJson = await goodCmdRes.json();
 assert.equal(goodCmdJson.queued, true);
 assert.equal(goodCmdJson.role, 'dj');

 // 5. Bot rút lệnh qua /api/remote-drain -> nhận đúng lệnh kèm userId của DJ và xóa sạch hàng đợi
 const drainRes = await workerDefault.fetch(
  new Request('https://bot.workers.dev/api/remote-drain', {
   method: 'POST',
   headers: { Authorization: 'Bearer top-secret-key' },
  }),
  env,
  {},
 );
 const drainJson = await drainRes.json();
 assert.equal(drainJson.commands.length, 1);
 assert.equal(drainJson.commands[0].action, 'vibe');
 assert.equal(drainJson.commands[0].value, 'nightcore');
 assert.equal(drainJson.commands[0].userId, '222222222222222222');
});

test('Feature #4: Client-Side Korean Hangul & Japanese Kana Karaoke Phonetic Transliterator (0 MB Bot RAM)', () => {
 const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
 assert.ok(html.includes('id="tabRemoteBtn"'));
 assert.ok(html.includes('id="stagePhoneticBtn"'));

 // Trích xuất đúng hàm transliterateSingAlong từ web/index.html để kiểm thử trực tiếp thuật toán phiên âm
 const startIdx = html.indexOf('const KR_INITIALS =');
 const endMarker = 'function syncPhoneticBtnUi()';
 const endIdx = html.indexOf(endMarker);
 assert.ok(startIdx > 0 && endIdx > startIdx);
 const snippet = html.slice(startIdx, endIdx);
 const runTranslit = new Function('rawLine', 'const phoneticMode = true;\n' + snippet + '\nreturn transliterateSingAlong(rawLine);');

 // Tiếng Hàn Hangul -> Revised Romanization
 assert.equal(runTranslit('사랑해요'), 'sa rang hae yo');
 // Tiếng Nhật Hiragana + Katakana + âm ngắt っ + trường âm ー -> Hepburn Romaji
 assert.equal(runTranslit('ずっとすきキャー'), 'zutto su ki kyaa');
 // Tiếng Việt / Tiếng Anh không có chữ Hàn/Nhật -> trả chuỗi rỗng để không hiện dòng thừa
 assert.equal(runTranslit('Cơn mưa ngang qua mang em đi xa'), '');
});

test('Feature #5: Smart Smooth Micro-Fade S-Curve Envelope on Music vs Zero-Delay Punch on /sfx & /tts', async () => {
 installAudioEnhancer(ffmpeg);
 setAudioEnhancement({ preset: 'flat', vibe: 'normal', ambient: 'off' });

 // Kịch bản A: Chuyển bài / tua bài với triggerSmoothTransitionFade(200) -> mẫu đầu tiên = 0 (không bao giờ nổ click), cuối đoạn đạt 100% biên độ
 triggerSmoothTransitionFade(200);
 const musicVt = new prism.VolumeTransformer({ type: 's16le', volume: 1.0 });
 const totalFrames = 14400; // 300ms @ 48kHz
 const inputBuf = Buffer.alloc(totalFrames * 4);
 for (let f = 0; f < totalFrames; f++) {
  inputBuf.writeInt16LE(12000, f * 4);
  inputBuf.writeInt16LE(12000, f * 4 + 2);
 }
 const outMusicChunks = [];
 musicVt.on('data', d => outMusicChunks.push(d));
 musicVt.write(inputBuf);
 musicVt.end();
 await new Promise(r => musicVt.once('finish', r));
 const outMusic = Buffer.concat(outMusicChunks);

 const firstSample = Math.abs(outMusic.readInt16LE(0));
 const midSample = Math.abs(outMusic.readInt16LE(4800 * 4)); // tại 100ms (giữa đường cong S-curve 200ms) -> ~50% biên độ
 const tailSample = Math.abs(outMusic.readInt16LE((totalFrames - 10) * 4)); // tại 300ms -> 100% biên độ
 assert.equal(firstSample, 0);
 assert.ok(midSample > 4500 && midSample < 7500, `Expected smooth midpoint around ~6000, got ${midSample}`);
 assert.ok(tailSample > 11500, `Expected full steady amplitude at tail, got ${tailSample}`);

 // Kịch bản B: Luồng giọng đọc /tts hoặc hiệu ứng /sfx (_forcePresetKey) giữ nguyên 100% lực ngay từ mẫu đầu tiên (không làm mất tiếng đầu câu)
 triggerSmoothTransitionFade(360);
 const sfxVt = new prism.VolumeTransformer({ type: 's16le', volume: 1.0 });
 sfxVt._forcePresetKey = 'flat';
 const outSfxChunks = [];
 sfxVt.on('data', d => outSfxChunks.push(d));
 sfxVt.write(inputBuf.subarray(0, 400));
 sfxVt.end();
 await new Promise(r => sfxVt.once('finish', r));
 const outSfx = Buffer.concat(outSfxChunks);
 assert.ok(Math.abs(outSfx.readInt16LE(0)) > 11500);
});
