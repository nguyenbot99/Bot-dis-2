import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';
import ffmpeg from 'ffmpeg-static';
import {
 getNextSoundPreset,
 installAudioEnhancer,
 setAudioEnhancement,
 SOUND_PRESET_ORDER,
 SOUND_PRESETS,
} from '../src/audioEnhancer.js';

test('sound preset rotation and bitrate clamping work cleanly', () => {
 assert.deepEqual(SOUND_PRESET_ORDER, ['hd', 'vocal', 'bass', 'flat']);
 assert.equal(getNextSoundPreset('hd'), 'vocal');
 assert.equal(getNextSoundPreset('vocal'), 'bass');
 assert.equal(getNextSoundPreset('bass'), 'flat');
 assert.equal(getNextSoundPreset('flat'), 'hd');

 assert.deepEqual(setAudioEnhancement({ preset: 'vocal', channelBitrate: 64000 }), {
  preset: 'vocal',
  bitrate: 128000,
 });
 assert.deepEqual(setAudioEnhancement({ preset: 'hd', channelBitrate: 256000 }), {
  preset: 'hd',
  bitrate: 256000,
 });
 assert.ok(Object.values(SOUND_PRESETS).every(p => p.filter.includes('resampler=soxr')));
});

test('installAudioEnhancer encodes real PCM WAV through FFmpeg SoX + Opus Music Mode cleanly', async () => {
 installAudioEnhancer(ffmpeg);
 setAudioEnhancement({ preset: 'hd', channelBitrate: 128000 });

 // Tạo 0.25 giây dữ liệu WAV 44.1 kHz stereo hợp lệ trong bộ nhớ để kiểm thử toàn bộ đường ống FFmpeg -> Volume -> Opus.
 const sampleRate = 44100;
 const numSamples = sampleRate / 4;
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
  const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
  wav.writeInt16LE(sample, 44 + i * 4);
  wav.writeInt16LE(sample, 46 + i * 4);
 }

 const resource = createAudioResource(Readable.from([wav]), {
  inputType: StreamType.Arbitrary,
  inlineVolume: true,
 });

 const packets = [];
 await new Promise((resolve, reject) => {
  resource.playStream.on('data', chunk => packets.push(chunk));
  resource.playStream.on('end', resolve);
  resource.playStream.on('error', reject);
 });

 assert.ok(packets.length >= 10, `expected >=10 Opus packets, got ${packets.length}`);
});
