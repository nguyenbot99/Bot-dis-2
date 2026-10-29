import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AudioPlayerStatus } from '@discordjs/voice';
import { assertMusicAccess } from '../src/access.js';
import {
 createGuildTtsController,
 sanitizeTtsText,
 splitTtsChunks,
 synthesizeGoogleTtsBuffer,
} from '../src/tts.js';

test('sanitizeTtsText cleans Discord mentions, custom emojis, and URLs cleanly', () => {
 const out = sanitizeTtsText(
  'Chào <@!123456789012345678> vào <#987654321098765432> nghe https://example.com/abc <:pepe_happy:111111111111111111> nhé!',
  {
   resolveUserName: id => (id === '123456789012345678' ? 'Minh' : null),
   resolveChannelName: id => (id === '987654321098765432' ? 'phòng-nhạc' : null),
  },
 );
 assert.equal(out, 'Chào Minh vào kênh phòng-nhạc nghe đường dẫn pepe happy nhé!');
 assert.throws(() => sanitizeTtsText('   '), /Nội dung đọc không được để trống/);
});

test('splitTtsChunks splits long Vietnamese sentences naturally at punctuation and spaces', () => {
 const longText =
  'Xin chào tất cả anh em trong phòng thoại tối nay nha. Chúc mọi người nghe nhạc thật vui vẻ, thoải mái sau một ngày làm việc mệt mỏi! Ai muốn nghe bài gì thì cứ gõ lệnh play để bot phục vụ tận răng luôn nhé anh em ơi.';
 const chunks = splitTtsChunks(longText, 120);
 assert.ok(chunks.length >= 2);
 assert.ok(chunks.every(c => c.length <= 120));
 assert.equal(chunks.join(' '), longText);
});

test('everyone in voice room may use /tts and start /play after tts-only join', () => {
 const activePlayer = {
  queue: { currentTrack: { requestedBy: '111111111111111111' } },
  userdata: { ownerId: '111111111111111111' },
 };
 // Người khác (222...) dùng /tts không bị chặn quyền chủ bài nhạc, nhưng dùng /skip vẫn bị chặn
 assert.doesNotThrow(() => assertMusicAccess('tts', '222222222222222222', activePlayer));
 assert.throws(() => assertMusicAccess('skip', '222222222222222222', activePlayer));

 // Phiên chỉ mới mở bằng /tts chưa phát nhạc -> người khác gõ /play được ngay
 const ttsIdlePlayer = {
  queue: { currentTrack: null },
  userdata: { ownerId: '111111111111111111', ttsOnlyIdle: true },
 };
 assert.doesNotThrow(() => assertMusicAccess('play', '222222222222222222', ttsIdlePlayer));
});

test('synthesizeGoogleTtsBuffer and createGuildTtsController auto-pause playing music, speak queued TTS, and auto-resume music', async () => {
 const synth = await synthesizeGoogleTtsBuffer('Alo một hai ba bốn', {
  lang: 'vi',
  fetchImpl: async () => ({
   ok: true,
   arrayBuffer: async () => new Uint8Array(128).fill(7).buffer,
  }),
 });
 assert.equal(synth.lang, 'vi');
 assert.equal(synth.buffer.length, 128);

 const events = [];
 const fakeTtsPlayer = new EventEmitter();
 fakeTtsPlayer.play = resource => {
  events.push(`tts:play:preset=${resource?.volume?._forcePresetKey}`);
  setTimeout(() => {
   fakeTtsPlayer.emit('stateChange', { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  }, 25);
 };
 fakeTtsPlayer.stop = () => {};

 const fakeConn = {
  state: { status: 'ready' },
  subscribe(target) {
   events.push(target === fakeTtsPlayer ? 'conn:sub:tts' : 'conn:sub:music');
   return { unsubscribe() {} };
  },
 };

 const musicAudioPlayer = { name: 'ziplayerAudio' };
 const fakeMusicPlayer = {
  destroyed: false,
  isPaused: false,
  audioPlayer: musicAudioPlayer,
  queue: { currentTrack: { title: 'Nơi Này Có Anh' } },
  userdata: { voiceMuted: false, autoPausedByTts: false },
  runtimeGraph: {
   connectionController: {
    connection: fakeConn,
    ensureSubscription(conn) {
     conn.subscribe(musicAudioPlayer);
    },
   },
  },
  pause() {
   this.isPaused = true;
   events.push('music:pause');
  },
  resume() {
   this.isPaused = false;
   events.push('music:resume');
  },
 };

 const ctrl = createGuildTtsController({
  createAudioPlayerFn: () => fakeTtsPlayer,
  createAudioResourceFn: () => ({
   volume: {
    _forcePresetKey: null,
    setVolume() {},
   },
  }),
 });

 const r1 = await ctrl.enqueueSpeech({
  guildId: 'g1',
  player: fakeMusicPlayer,
  mp3Buffer: synth.buffer,
 });
 const r2 = await ctrl.enqueueSpeech({
  guildId: 'g1',
  player: fakeMusicPlayer,
  mp3Buffer: synth.buffer,
 });
 assert.equal(r1.queued, false);
 assert.equal(r2.queued, true);

 await new Promise(r => setTimeout(r, 120));

 assert.deepEqual(events, [
  'music:pause',
  'conn:sub:tts',
  'conn:sub:tts',
  'tts:play:preset=vocal',
  'conn:sub:tts',
  'tts:play:preset=vocal',
  'conn:sub:music',
  'music:resume',
 ]);
 assert.equal(fakeMusicPlayer.isPaused, false);

 // Nếu bài nhạc vốn đã được người dùng chủ động tạm dừng từ trước khi gõ /tts -> đọc xong KHÔNG tự bật nhạc
 events.length = 0;
 fakeMusicPlayer.isPaused = true;
 await ctrl.enqueueSpeech({
  guildId: 'g1',
  player: fakeMusicPlayer,
  mp3Buffer: synth.buffer,
 });
 await new Promise(r => setTimeout(r, 80));
 assert.equal(events.includes('music:resume'), false);
 assert.equal(fakeMusicPlayer.isPaused, true);
});
