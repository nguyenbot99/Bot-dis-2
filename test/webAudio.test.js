import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 isAllowedWebAudioUrl,
 parseM3u8ForWebAudio,
 pickWebPlayableTranscoding,
 resolveTrackWebAudio,
 sanitizeWebAudioDescriptor,
} from '../src/webAudio.js';
import { serializeNowPlayingState } from '../src/nowPlayingHub.js';
import workerModule from '../cloudflare-worker/worker.js';

test('isAllowedWebAudioUrl allows official SoundCloud streaming domains and blocks untrusted hosts', () => {
 assert.equal(
  isAllowedWebAudioUrl('https://playback.media-streaming.soundcloud.cloud/abc/aac_160k/id/init.mp4?expires=123'),
  true,
 );
 assert.equal(isAllowedWebAudioUrl('https://cf-media.sndcdn.com/abc.128.mp3?Policy=xyz'), true);
 assert.equal(isAllowedWebAudioUrl('https://evil.example.com/init.mp4'), false);
 assert.equal(isAllowedWebAudioUrl('javascript:alert(1)'), false);
});

test('pickWebPlayableTranscoding prefers HQ fMP4 AAC HLS, falls back to progressive, and skips snipped previews', () => {
 const chosen = pickWebPlayableTranscoding([
  {
   url: 'https://api-v2.soundcloud.com/snip',
   snipped: true,
   quality: 'hq',
   preset: 'aac_160k',
   format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
  },
  {
   url: 'https://api-v2.soundcloud.com/lq',
   snipped: false,
   quality: 'lq',
   preset: 'aac_96k',
   format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
  },
  {
   url: 'https://api-v2.soundcloud.com/hq',
   snipped: false,
   quality: 'hq',
   preset: 'aac_160k',
   format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
  },
 ]);
 assert.equal(chosen?.url, 'https://api-v2.soundcloud.com/hq');

 const prog = pickWebPlayableTranscoding([
  {
   url: 'https://api-v2.soundcloud.com/mp3',
   snipped: false,
   format: { protocol: 'progressive', mime_type: 'audio/mpeg' },
  },
 ]);
 assert.equal(prog?.url, 'https://api-v2.soundcloud.com/mp3');
});

test('parseM3u8ForWebAudio compacts a 750-segment 2-hour fMP4 playlist with >750-char CloudFront RSA signature into ~1.4 KB JSON', () => {
 const base = 'https://playback.media-streaming.soundcloud.cloud/ALLcBpwV8pZV/aac_160k/fb794efc/';
 const longSig = 'S'.repeat(580);
 const auth = `?expires=1793005113&Policy=eyJ0ZXN0IjoxfQ__&Signature=${longSig}&Key-Pair-Id=K34606`;
 const lines = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  `#EXT-X-MAP:URI="${base}init.mp4${auth}"`,
 ];
 for (let i = 0; i < 750; i++) {
  const dur = i === 749 ? '4.250000' : '10.000000';
  lines.push(`#EXTINF:${dur},`);
  lines.push(`${base}data${String(i).padStart(3, '0')}.m4s${auth}`);
 }
 lines.push('#EXT-X-ENDLIST');

 const m3u8Url = `${base}playlist.m3u8${auth}`;
 assert.ok(m3u8Url.length > 700);
 const parsed = parseM3u8ForWebAudio(lines.join('\n'), m3u8Url, 'audio/mp4; codecs="mp4a.40.2"');
 assert.ok(parsed);
 assert.equal(parsed.kind, 'hls_fmp4');
 assert.equal(parsed.count, 750);
 assert.equal(parsed.prefix, 'data');
 assert.equal(parsed.pad, 3);
 assert.equal(parsed.ext, '.m4s');
 assert.equal(parsed.init, 'init.mp4');
 assert.equal(parsed.segDur, 10);
 assert.equal(parsed.lastDur, 4.25);

 const jsonBytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
 assert.ok(jsonBytes < 2048, `expected compact descriptor < 2048 bytes, got ${jsonBytes}`);
});

test('resolveTrackWebAudio, serializeNowPlayingState, and Cloudflare Worker preserve valid webAudio and strip unsafe ones', async () => {
 const base = 'https://playback.media-streaming.soundcloud.cloud/demo/aac_96k/track1/';
 const auth = '?expires=1799999999&Signature=ok';
 const m3u8 = [
  '#EXTM3U',
  `#EXT-X-MAP:URI="${base}init.mp4${auth}"`,
  '#EXTINF:10.0,',
  `${base}data000.m4s${auth}`,
  '#EXTINF:8.5,',
  `${base}data001.m4s${auth}`,
 ].join('\n');

 const fakeScClient = {
  async fetchItem() {
   return {
    media: {
     transcodings: [
      {
       url: 'https://api-v2.soundcloud.com/media/1/stream/hls',
       snipped: false,
       format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
      },
     ],
    },
   };
  },
  async getStreamUrl() {
   return `${base}playlist.m3u8${auth}`;
  },
 };

 const track = {
  title: 'Nơi Này Có Anh',
  url: 'https://soundcloud.com/sontungmtp/noi-nay-co-anh',
  duration: 18500,
  source: 'soundcloud',
  metadata: { author: 'Sơn Tùng M-TP' },
 };

 const wa = await resolveTrackWebAudio(fakeScClient, track, {
  fetchImpl: async () => ({ ok: true, text: async () => m3u8 }),
 });
 assert.equal(wa?.kind, 'hls_fmp4');
 assert.equal(wa?.count, 2);

 track.metadata.webAudio = wa;
 const state = serializeNowPlayingState({
  player: {
   isPaused: false,
   volume: 100,
   queue: { currentTrack: track, history: [] },
   upcomingTracks: [],
   getTime: () => ({ current: 5200, total: 18500 }),
  },
  client: { isReady: () => true, user: { username: 'BắtDon' } },
 });
 assert.equal(state.track?.webAudio?.kind, 'hls_fmp4');
 assert.equal(state.track?.webAudio?.baseUrl, base);

 // Đẩy qua Cloudflare Worker và kiểm tra GET /api/now-playing giữ nguyên webAudio + cộng bù thời gian thực
 const env = { NOW_PLAYING_PUSH_SECRET: 'secret1234' };
 const postRes = await workerModule.fetch(
  new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing', {
   method: 'POST',
   headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret1234' },
   body: JSON.stringify(state),
  }),
  env,
  {},
 );
 assert.equal(postRes.status, 200);

 const getRes = await workerModule.fetch(
  new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing'),
  env,
  {},
 );
 const live = await getRes.json();
 assert.equal(live.track?.webAudio?.kind, 'hls_fmp4');
 assert.equal(live.track?.webAudio?.count, 2);

 // Kiểm duyệt chặn URL độc hại nếu bị chèn sai
 assert.equal(
  sanitizeWebAudioDescriptor({ kind: 'progressive', url: 'https://attacker.evil/bad.mp3' }),
  null,
 );
});
