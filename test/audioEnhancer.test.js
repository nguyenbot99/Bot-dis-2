import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';
import ffmpeg from 'ffmpeg-static';
import {
 clampVolumePercent,
 computePerceptualGain,
 configurePlayerAudio,
 getNextSoundPreset,
 installAudioEnhancer,
 MAX_VOLUME_PERCENT,
 MIN_VOLUME_PERCENT,
 parseCustomVolumeInput,
 setAudioEnhancement,
 SOUND_PRESET_ORDER,
 SOUND_PRESETS,
} from '../src/audioEnhancer.js';

const req = createRequire(import.meta.url);
const prism = createRequire(req.resolve('@discordjs/voice'))('prism-media');

function buildTwoToneWav({ durationSec = 0.5, sampleRate = 44100, amp = 7500 } = {}) {
 const numSamples = Math.floor(sampleRate * durationSec);
 const dataSize = numSamples * 4;
 const wav = Buffer.alloc(44 + dataSize);
 wav.write('RIFF', 0);
 wav.writeUInt32LE(36 + dataSize, 4);
 wav.write('WAVEfmt ', 8);
 wav.writeUInt32LE(16, 16);
 wav.writeUInt16LE(1, 20);
 wav.writeUInt16LE(2, 22);
 wav.writeUInt32LE(sampleRate, 24);
 wav.writeUInt32LE(sampleRate * 4, 28);
 wav.writeUInt16LE(4, 32);
 wav.writeUInt16LE(16, 34);
 wav.write('data', 36);
 wav.writeUInt32LE(dataSize, 40);
 for (let i = 0; i < numSamples; i++) {
  const s75 = Math.sin((2 * Math.PI * 75 * i) / sampleRate);
  const s3600 = Math.sin((2 * Math.PI * 3600 * i) / sampleRate);
  const sample = Math.round((s75 + s3600) * 0.5 * amp);
  wav.writeInt16LE(sample, 44 + i * 4);
  wav.writeInt16LE(sample, 46 + i * 4);
 }
 return wav;
}

function goertzelDb(pcm, freq, sampleRate = 48000) {
 const n = Math.floor(pcm.length / 4);
 const k = Math.round((n * freq) / sampleRate);
 const w = (2 * Math.PI * k) / n;
 const coeff = 2 * Math.cos(w);
 let s0 = 0, s1 = 0, s2 = 0;
 for (let i = 0; i < n; i++) {
  const x = pcm.readInt16LE(i * 4) / 32768;
  s0 = x + coeff * s1 - s2;
  s2 = s1;
  s1 = s0;
 }
 const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
 const amp = (2 * Math.sqrt(Math.max(0, power))) / n;
 return 20 * Math.log10(Math.max(1e-9, amp));
}

function measureRmsDb(pcm) {
 const n = Math.floor(pcm.length / 2);
 let sum = 0;
 for (let i = 0; i < n; i++) {
  const s = pcm.readInt16LE(i * 2) / 32768;
  sum += s * s;
 }
 const rms = Math.sqrt(sum / Math.max(1, n));
 return 20 * Math.log10(Math.max(1e-9, rms));
}

async function renderWavThroughPipeline(wav, { volumeRatio = 1, preset = 'flat' } = {}) {
 installAudioEnhancer(ffmpeg);
 setAudioEnhancement({ preset, channelBitrate: 128000 });
 const resource = createAudioResource(Readable.from([wav]), {
  inputType: StreamType.Arbitrary,
  inlineVolume: true,
 });
 resource.volume.setVolume(volumeRatio);

 const packets = [];
 await new Promise((resolve, reject) => {
  resource.playStream.on('data', chunk => packets.push(chunk));
  resource.playStream.on('end', resolve);
  resource.playStream.on('error', reject);
 });
 const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
 const decoded = packets.map(pkt => decoder._decode(pkt));
 // Bỏ 3 khung đầu (60ms) khởi động bộ lọc để đo dải tần ổn định chính xác.
 return Buffer.concat(decoded.slice(3));
}

test('sound preset rotation and bitrate clamping work cleanly', () => {
 assert.deepEqual(SOUND_PRESET_ORDER, ['hd', 'vocal', 'bass', '8d', 'flat']);
 assert.equal(getNextSoundPreset('hd'), 'vocal');
 assert.equal(getNextSoundPreset('vocal'), 'bass');
 assert.equal(getNextSoundPreset('bass'), '8d');
 assert.equal(getNextSoundPreset('8d'), 'flat');
 assert.equal(getNextSoundPreset('flat'), 'hd');

 assert.deepEqual(setAudioEnhancement({ preset: 'vocal', channelBitrate: 64000 }), {
  preset: 'vocal',
  vibe: 'normal',
  bitrate: 128000,
 });
 assert.deepEqual(setAudioEnhancement({ preset: 'hd', channelBitrate: 256000 }), {
  preset: 'hd',
  vibe: 'normal',
  bitrate: 256000,
 });
 assert.ok(Object.values(SOUND_PRESETS).every(p => p.filter.includes('resampler=soxr')));
});

test('custom volume validation (0% - 200%), perceptual curve, and configurePlayerAudio unlock 200%', () => {
 assert.equal(MIN_VOLUME_PERCENT, 0);
 assert.equal(MAX_VOLUME_PERCENT, 200);
 assert.equal(clampVolumePercent(-10), 0);
 assert.equal(clampVolumePercent(175.4), 175);
 assert.equal(clampVolumePercent(250), 200);

 assert.equal(parseCustomVolumeInput('0'), 0);
 assert.equal(parseCustomVolumeInput('20'), 20);
 assert.equal(parseCustomVolumeInput(' 165% '), 165);
 assert.equal(parseCustomVolumeInput('200'), 200);
 assert.throws(() => parseCustomVolumeInput('-5'), /hợp lệ/);
 assert.throws(() => parseCustomVolumeInput('201'), /tối đa 200%/);
 assert.throws(() => parseCustomVolumeInput('abc'), /hợp lệ/);

 assert.equal(computePerceptualGain(0), 0);
 assert.ok(computePerceptualGain(0.2) < 0.08, '20% volume attenuates deeply (~ -25 dB)');
 assert.equal(computePerceptualGain(1), 1);
 assert.ok(computePerceptualGain(2) > 2.4, '200% volume boosts strongly (~ +8.4 dB)');

 let appliedRatio = null;
 let storedVolume = 100;
 const fakeResource = { volume: { setVolume: v => { appliedRatio = v; } } };
 const fakeVc = {
  clamp: v => Math.min(100, Math.max(0, v)),
  bindActiveResourceResolver(fn) { this._resolver = fn; },
 };
 const fakePlayer = {
  bus: {
   requestRpcSync(name, payload) {
    if (name === 'volume.set') storedVolume = fakeVc.clamp(payload.value);
   },
  },
  runtimeGraph: {
   volumeController: fakeVc,
   playbackController: { activeResource: fakeResource, fadeGain: 1 },
   audioPlayer: { state: { resource: fakeResource } },
  },
  setVolume() { return false; },
 };

 configurePlayerAudio(fakePlayer);
 assert.equal(fakePlayer.setVolume(175), true);
 assert.equal(storedVolume, 175);
 assert.equal(appliedRatio, 1.75);
 assert.equal(fakePlayer.setVolume(200), true);
 assert.equal(storedVolume, 200);
 assert.equal(appliedRatio, 2.0);
 assert.equal(fakePlayer.setVolume(201), false);
 assert.equal(fakePlayer.setVolume(-1), false);
});

test('real FFmpeg SoX + Realtime DSP + Opus pipeline produces distinct audible volume (0-200%) and EQ presets', async () => {
 const wav = buildTwoToneWav({ durationSec: 0.55 });

 const pcmVol100 = await renderWavThroughPipeline(wav, { volumeRatio: 1.0, preset: 'flat' });
 const pcmVol20 = await renderWavThroughPipeline(wav, { volumeRatio: 0.2, preset: 'flat' });
 const pcmVol0 = await renderWavThroughPipeline(wav, { volumeRatio: 0.0, preset: 'flat' });
 const pcmVol200 = await renderWavThroughPipeline(wav, { volumeRatio: 2.0, preset: 'flat' });

 const rms100 = measureRmsDb(pcmVol100);
 const rms20 = measureRmsDb(pcmVol20);
 const rms0 = measureRmsDb(pcmVol0);
 const rms200 = measureRmsDb(pcmVol200);

 assert.ok(rms100 - rms20 > 20, `expected 20% volume to drop >20 dB below 100%, got ${(rms100 - rms20).toFixed(2)} dB`);
 assert.ok(rms0 < -90, `expected 0% volume to be silent, got ${rms0.toFixed(2)} dB`);
 assert.ok(rms200 - rms100 > 6.5, `expected 200% volume to boost >6.5 dB over 100%, got ${(rms200 - rms100).toFixed(2)} dB`);

 const pcmVocal = await renderWavThroughPipeline(wav, { volumeRatio: 1.0, preset: 'vocal' });
 const pcmBass = await renderWavThroughPipeline(wav, { volumeRatio: 1.0, preset: 'bass' });
 const pcmHd = await renderWavThroughPipeline(wav, { volumeRatio: 1.0, preset: 'hd' });

 const flatBass = goertzelDb(pcmVol100, 75);
 const flatVocal = goertzelDb(pcmVol100, 3600);
 const bassPreset75 = goertzelDb(pcmBass, 75);
 const vocalPreset75 = goertzelDb(pcmVocal, 75);
 const vocalPreset3600 = goertzelDb(pcmVocal, 3600);
 const hdPreset3600 = goertzelDb(pcmHd, 3600);

 assert.ok(bassPreset75 - flatBass > 5.5, `expected bass preset to boost 75Hz >5.5 dB over flat, got ${(bassPreset75 - flatBass).toFixed(2)} dB`);
 assert.ok(bassPreset75 - vocalPreset75 > 18, `expected >18 dB 75Hz contrast between bass and vocal presets, got ${(bassPreset75 - vocalPreset75).toFixed(2)} dB`);
 assert.ok(vocalPreset3600 - flatVocal > 5.5, `expected vocal preset to boost 3.6kHz >5.5 dB over flat, got ${(vocalPreset3600 - flatVocal).toFixed(2)} dB`);
 assert.ok(hdPreset3600 - flatVocal > 2.5, `expected hd preset to boost 3.6kHz >2.5 dB over flat, got ${(hdPreset3600 - flatVocal).toFixed(2)} dB`);
});

test('configurePlayerAudio prevents StreamManager 5m expiry & holds paused track on stream drop without skipping to next track', () => {
 const EventEmitter = req('node:events');
 const ap = new EventEmitter();
 ap.state = { status: 'paused', resource: {} };

 let trackEndCount = 0;
 let trackErrorCount = 0;
 let refreshedAtPos = null;
 let actionHandler = null;

 const session = {
  id: 'sess-1',
  status: 'paused',
  position: 42500,
  isActive() { return this.status !== 'ended' && this.status !== 'stopped'; },
 };

 const pc = {
  activeSession: session,
  activeResource: {},
  position: 42500,
  onStateChange(_oldS, newS) {
   if (newS.status === 'idle') trackEndCount += 1;
  },
  onError() {
   trackErrorCount += 1;
  },
  resume() {
   ap.state = { status: 'playing', resource: {} };
   return true;
  },
  stop() {
   this.activeSession = null;
   ap.state = { status: 'idle' };
   return true;
  },
 };
 ap.on('stateChange', pc.onStateChange);
 ap.on('error', pc.onError);

 const now = Date.now();
 const streams = new Map([
  ['active-1', { track: { id: 't1' }, status: 'paused', lastAccessed: now - 600_000, metadata: {} }],
  ['preload-2', { track: { id: 't2' }, status: 'active', lastAccessed: now - 600_000, metadata: { isPreload: true } }],
 ]);
 const evicted = [];
 const sm = {
  streams,
  cleanupExpiredStreams() {
   const cutoff = Date.now() - 300_000;
   for (const [id, m] of this.streams.entries()) {
    if (m.lastAccessed < cutoff) evicted.push(id);
   }
  },
 };

 const player = {
  isIdle: false,
  queue: { currentTrack: { id: 't1' } },
  bus: {
   onAction(fn) { actionHandler = fn; },
   requestRpc(name, payload) {
    if (name === 'playback.refreshResource') refreshedAtPos = payload.position;
    return Promise.resolve(true);
   },
  },
  runtimeGraph: {
   playbackController: pc,
   audioPlayer: ap,
   streamManager: sm,
   streamController: { current: { streamId: 'active-1' } },
  },
 };

 configurePlayerAudio(player);

 // 1) StreamManager cleanup chỉ dọn luồng preload hết hạn, bảo vệ tuyệt đối bài đang phát / đang tạm dừng dù quá 5 phút
 sm.cleanupExpiredStreams();
 assert.deepEqual(evicted, ['preload-2']);

 // 2) Nếu socket CDN đóng khi đang tạm dừng, KHÔNG phát TRACK_END / TRACK_ERROR (không tự nhảy qua bài kế tiếp)
 ap.emit('error', new Error('Premature close'));
 const prevState = ap.state;
 ap.state = { status: 'idle' };
 ap.emit('stateChange', prevState, ap.state);

 assert.equal(trackErrorCount, 0);
 assert.equal(trackEndCount, 0);
 assert.equal(pc.status, 'paused');

 // 3) Khi người dùng bấm Tiếp tục, tự nạp lại luồng tại đúng vị trí 42.5s đã tạm dừng
 assert.equal(pc.resume(), true);
 assert.equal(refreshedAtPos, 42500);

 // 4) Nếu đang tạm dừng mà người dùng chủ động bấm /skip hoặc /stop thì cho phép chuyển bài bình thường
 session.status = 'paused';
 ap.state = { status: 'paused', resource: {} };
 ap.emit('error', new Error('Socket timeout'));
 ap.state = { status: 'idle' };
 assert.equal(pc.status, 'paused');
 actionHandler?.({ type: 'SKIP' });
 assert.equal(pc.status, 'idle');
});

