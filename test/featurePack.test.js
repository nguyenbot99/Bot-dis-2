import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';
import ffmpeg from 'ffmpeg-static';
import { assertMusicAccess } from '../src/access.js';
import { installAudioEnhancer, setAudioEnhancement } from '../src/audioEnhancer.js';
import {
 buildFavoritesEmbed,
 createFavoritesStore,
 MAX_FAVORITES_PER_USER,
 openFavoritesPayload,
 sealFavoritesPayload,
} from '../src/favoritesStore.js';
import { serializeNowPlayingState } from '../src/nowPlayingHub.js';
import { SFX_PRESETS, synthesizeSfxWav } from '../src/sfx.js';
import { createSleepTimerManager } from '../src/sleepTimer.js';

test('8D audio preset creates real binaural L/R panning difference without clipping', async () => {
 installAudioEnhancer(ffmpeg);
 setAudioEnhancement({ preset: '8d', channelBitrate: 128000 });

 // Tạo 2.2 giây sóng sine mono đều nhau 2 kênh để đo độ lệch biên độ L/R khi xoay 8D 360°
 const sampleRate = 48000;
 const numSamples = Math.floor(sampleRate * 2.2);
 const pcmIn = Buffer.alloc(numSamples * 4);
 for (let i = 0; i < numSamples; i++) {
  const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 9000);
  pcmIn.writeInt16LE(s, i * 4);
  pcmIn.writeInt16LE(s, i * 4 + 2);
 }

 const resource = createAudioResource(Readable.from([pcmIn]), {
  inputType: StreamType.Raw,
  inlineVolume: true,
 });
 resource.volume.setVolume(1);

 const outChunks = [];
 for await (const chunk of resource.volume) {
  outChunks.push(chunk);
 }
 const outPcm = Buffer.concat(outChunks);
 assert.equal(outPcm.length, pcmIn.length);

 // Ở thời điểm ~2.0 giây (gần đỉnh vòng xoay 0.11 Hz), năng lượng kênh Trái và Phải phải lệch nhau rõ rệt
 let sumL = 0;
 let sumR = 0;
 const startSample = Math.floor(sampleRate * 1.6);
 const endSample = Math.floor(sampleRate * 2.1);
 for (let i = startSample; i < endSample; i++) {
  const l = outPcm.readInt16LE(i * 4);
  const r = outPcm.readInt16LE(i * 4 + 2);
  sumL += l * l;
  sumR += r * r;
 }
 const ratio = Math.max(sumL, sumR) / Math.max(1, Math.min(sumL, sumR));
 assert.ok(ratio > 2.2, `Expected strong 8D binaural L/R separation, got power ratio ${ratio.toFixed(2)}`);

 setAudioEnhancement({ preset: 'hd', channelBitrate: 128000 });
});

test('favoritesStore manages per-user cabinet, deduplicates, caps at 25, and seals with AES-256-GCM', () => {
 const dir = mkdtempSync(join(tmpdir(), 'fav-test-'));
 try {
  const fileA = join(dir, 'primary.json');
  const fileB = join(dir, 'backup.json');
  const store = createFavoritesStore({ primaryFile: fileA, backupFile: fileB });

  const uid = '1243061570247069696';
  for (let i = 1; i <= MAX_FAVORITES_PER_USER; i++) {
   store.addTrack(uid, {
    id: `sc-${i}`,
    title: `Bài hát số ${i}`,
    url: `https://soundcloud.com/artist/track-${i}`,
    duration: 180000,
    metadata: { author: 'Ca sĩ A' },
   });
  }
  const list = store.getList(uid);
  assert.equal(list.length, MAX_FAVORITES_PER_USER);
  assert.equal(list[0].title, `Bài hát số ${MAX_FAVORITES_PER_USER}`);

  // Vượt quá 25 bài mới sẽ báo đầy rõ ràng
  assert.throws(
   () => store.addTrack(uid, { title: 'Bài hát 26', url: 'https://soundcloud.com/artist/track-26' }),
   /đã đầy \(25\/25 bài\)/,
  );

  // Lưu trùng bài cũ sẽ đẩy bài đó lên đầu thay vì nhân đôi
  const dup = store.addTrack(uid, {
   title: 'Bài hát số 20',
   url: 'https://soundcloud.com/artist/track-20',
   duration: 180000,
  });
  assert.equal(dup.added, false);
  assert.equal(dup.total, MAX_FAVORITES_PER_USER);
  assert.equal(store.getList(uid)[0].url, 'https://soundcloud.com/artist/track-20');

  // Kiểm tra đóng gói & mở khóa AES-256-GCM sao lưu đám mây
  const seal = store.exportSeal('my-secret-bot-token');
  assert.ok(typeof seal === 'string' && seal.split('.').length === 3);
  assert.equal(openFavoritesPayload(seal, 'wrong-token'), null);

  const restoredStore = createFavoritesStore({
   primaryFile: join(dir, 'restored1.json'),
   backupFile: join(dir, 'restored2.json'),
  });
  assert.equal(restoredStore.importSeal(seal, 'my-secret-bot-token'), true);
  assert.equal(restoredStore.getList(uid).length, MAX_FAVORITES_PER_USER);

  const embedJson = buildFavoritesEmbed({ username: 'Nam' }, restoredStore.getList(uid)).toJSON();
  assert.ok(embedJson.footer.text.includes('25/25'));
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test('sleepTimer supports after_track and timed smooth volume fade-out', async () => {
 let volumeValue = 120;
 let stoppedInfo = null;
 const mockPlayer = {
  guildId: 'g1',
  destroyed: false,
  isPaused: false,
  volume: 120,
  queue: { currentTrack: { title: 'Ru Ngủ' } },
  setVolume(v) {
   volumeValue = v;
   this.volume = v;
   return true;
  },
 };

 const timer = createSleepTimerManager({
  getPlayer: () => mockPlayer,
  onTriggerStop: info => {
   stoppedInfo = info;
  },
 });

 // Chế độ tắt ngay sau bài hiện tại
 timer.setAfterCurrentTrack('g1', { leaveVoice: false });
 assert.equal(timer.getStatus('g1')?.mode, 'after_track');
 assert.equal(timer.notifyTrackEnded('g1'), true);
 assert.equal(stoppedInfo?.mode, 'after_track');
 assert.equal(timer.getStatus('g1'), null);

 // Chế độ hủy hẹn giờ
 timer.setMinutes('g1', 15);
 assert.equal(timer.getStatus('g1')?.minutes, 15);
 assert.equal(timer.cancel('g1'), true);
 assert.equal(volumeValue, 120);
});

test('sfx procedural generator synthesizes valid 44.1kHz stereo WAV for all 8 meme presets', () => {
 const keys = Object.keys(SFX_PRESETS);
 assert.equal(keys.length, 8);
 for (const key of keys) {
  const { buffer, preset } = synthesizeSfxWav(key);
  assert.ok(preset.label.length > 0);
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(buffer.readUInt16LE(22), 2); // Stereo
  assert.equal(buffer.readUInt32LE(24), 44100);
  assert.ok(buffer.length > 44100);
 }
 assert.throws(() => synthesizeSfxWav('khong_ton_tai'), /Không tìm thấy hiệu ứng âm thanh/);
});

test('access allows /sfx for any listener in voice while keeping /sleeptimer requester-locked', () => {
 const fakePlayer = {
  queue: { currentTrack: { requestedBy: 'requester_1' } },
  userdata: { ownerId: 'requester_1' },
 };
 assert.doesNotThrow(() => assertMusicAccess('sfx', 'random_friend', fakePlayer, {}));
 assert.throws(() => assertMusicAccess('sleeptimer', 'random_friend', fakePlayer, {}), /chỉ người yêu cầu bài đang phát/);
 assert.doesNotThrow(() => assertMusicAccess('sleeptimer', 'requester_1', fakePlayer, {}));
});

test('serializeNowPlayingState includes synced Karaoke lyrics and sleepTimerLabel cleanly', () => {
 const fakePlayer = {
  guildId: 'g1',
  isPaused: false,
  volume: 100,
  userdata: { soundPreset: '8d', sleepTimerLabel: '25p' },
  queue: {
   currentTrack: {
    title: 'Lạc Trôi',
    duration: 240000,
    source: 'soundcloud',
    metadata: {
     author: 'Sơn Tùng M-TP',
     webLyrics: {
      source: 'LRCLIB',
      synced: [{ t: 1000, text: 'Người theo hương hoa mây mù giăng lối' }],
     },
    },
   },
   history: [],
  },
  upcomingTracks: [],
 };
 const snap = serializeNowPlayingState({ player: fakePlayer, client: { isReady: () => true } });
 assert.equal(snap.settings.soundPreset, '8d');
 assert.equal(snap.settings.soundLabel, '8D Xoay Vòng 360°');
 assert.equal(snap.settings.sleepTimerLabel, '25p');
 assert.equal(snap.track.lyrics.synced.length, 1);
 assert.equal(snap.track.lyrics.synced[0].text, 'Người theo hương hoa mây mù giăng lối');
});
