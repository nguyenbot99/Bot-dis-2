import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { assertMusicAccess } from '../src/access.js';
import {
 getActiveVibeMode,
 getNextVibeMode,
 installAudioEnhancer,
 setAudioEnhancement,
 VIBE_MODE_ORDER,
 VIBE_MODES,
} from '../src/audioEnhancer.js';
import { createNowPlayingHub } from '../src/nowPlayingHub.js';
import { buildGrabDmEmbed, buildPlayerPayload, renderSyncedProgress, syncPlayerVibeAnchor } from '../src/playerGui.js';
import { MAX_COLLECTION_TRACKS, resolveMusicRequest, resolveSpotifyCollection } from '../src/policy.js';
import { RADIO_STATION_IDS, RADIO_STATIONS, resolveRadioStation } from '../src/radioStations.js';
import { buildStatsEmbed, createStatsStore, openStatsPayload, sealStatsPayload } from '../src/statsStore.js';

test('Feature #1 (/vibe): real-time fractional resampler & vinyl/echo DSP keep 4-byte stereo alignment and bypass TTS/SFX', () => {
 installAudioEnhancer();
 assert.deepEqual(VIBE_MODE_ORDER, ['normal', 'nightcore', 'slowed', 'lofi']);
 assert.equal(getNextVibeMode('normal'), 'nightcore');
 assert.equal(getNextVibeMode('nightcore'), 'slowed');
 assert.equal(getNextVibeMode('slowed'), 'lofi');
 assert.equal(getNextVibeMode('lofi'), 'normal');

 // Tạo tín hiệu PCM 48kHz stereo mẫu dài 200ms (9600 frame = 38400 byte)
 const frames = 9600;
 const input = Buffer.alloc(frames * 4);
 for (let i = 0; i < frames; i++) {
  const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 14000);
  input.writeInt16LE(sample, i * 4);
  input.writeInt16LE(sample, i * 4 + 2);
 }

 const { createRequire } = process.getBuiltinModule('node:module');
 const require = createRequire(import.meta.url);
 const prism = require('../node_modules/@discordjs/voice/node_modules/prism-media');

 function runThroughTransformer(vibeKey, forcePresetKey = null) {
  setAudioEnhancement({ preset: 'hd', vibe: vibeKey });
  const vt = new prism.VolumeTransformer({ type: 's16le', volume: 1.0 });
  if (forcePresetKey) vt._forcePresetKey = forcePresetKey;
  const chunks = [];
  vt.on('data', c => chunks.push(c));
  vt.write(input.subarray(0, 19201)); // Cố tình cắt lẻ byte để kiểm tra căn biên 4-byte stereo
  vt.write(input.subarray(19201));
  vt.end();
  return Buffer.concat(chunks);
 }

 const outNormal = runThroughTransformer('normal');
 assert.equal(outNormal.length, input.length);
 assert.equal(outNormal.length % 4, 0);

 const outNightcore = runThroughTransformer('nightcore');
 assert.equal(getActiveVibeMode(), 'nightcore');
 assert.equal(outNightcore.length % 4, 0);
 // Nightcore 1.2x phát nhanh hơn nên số frame đầu ra xấp xỉ frames / 1.2 (~8000 frame = 32000 byte)
 assert.ok(outNightcore.length > 31500 && outNightcore.length < 32500, `unexpected nightcore bytes: ${outNightcore.length}`);

 const outSlowed = runThroughTransformer('slowed');
 assert.equal(outSlowed.length % 4, 0);
 // Slowed 0.86x kéo giãn sóng âm nên số frame đầu ra xấp xỉ frames / 0.86 (~11162 frame = 44648 byte)
 assert.ok(outSlowed.length > 44200 && outSlowed.length < 45100, `unexpected slowed bytes: ${outSlowed.length}`);

 const outLofi = runThroughTransformer('lofi');
 assert.equal(outLofi.length, input.length);
 assert.equal(outLofi.length % 4, 0);

 // Khi phát giọng nói /tts hoặc hiệu ứng /sfx (_forcePresetKey), tự động bỏ qua hiệu ứng Nightcore/Slowed
 setAudioEnhancement({ preset: 'hd', vibe: 'nightcore' });
 const outTtsBypass = runThroughTransformer('nightcore', 'vocal');
 assert.equal(outTtsBypass.length, input.length);

 // Khôi phục về normal sau bài test
 setAudioEnhancement({ preset: 'hd', vibe: 'normal' });
});

test('Feature #1 (/vibe): renderSyncedProgress & syncPlayerVibeAnchor track exact song position across speed switches', () => {
 let rawClockMs = 0;
 const fakePlayer = {
  isPaused: false,
  userdata: { vibeMode: 'normal', vibeAnchor: null },
  getTime: () => ({ current: rawClockMs, total: 240000 }),
 };
 const track = { title: 'Test Song', duration: 240000 };

 syncPlayerVibeAnchor(fakePlayer, 'normal', 0);
 rawClockMs = 10000; // 10s ở 1.0x => bài hát ở mốc 10s
 assert.equal(Math.round(renderSyncedProgress(fakePlayer, track, false).currentMs), 10000);

 // Đổi sang Nightcore 1.2x ngay tại giây thứ 10
 syncPlayerVibeAnchor(fakePlayer, 'nightcore');
 fakePlayer.userdata.vibeMode = 'nightcore';
 rawClockMs = 20000; // Thêm 10s thực tế ở tốc độ 1.2x => bài hát tiến thêm 12s = 22s
 assert.equal(Math.round(renderSyncedProgress(fakePlayer, track, false).currentMs), 22000);

 // Đổi tiếp sang Slowed 0.86x ngay tại mốc 22s của bài hát
 syncPlayerVibeAnchor(fakePlayer, 'slowed');
 fakePlayer.userdata.vibeMode = 'slowed';
 rawClockMs = 30000; // Thêm 10s thực tế ở 0.86x => bài hát tiến thêm 8.6s = 30.6s
 assert.equal(Math.round(renderSyncedProgress(fakePlayer, track, false).currentMs), 30600);
});

test('Feature #2 (Playlist/Album Import): resolveSpotifyCollection & resolveMusicRequest handle Spotify playlists/albums and SoundCloud sets', async () => {
 const fakeNextData = {
  props: {
   pageProps: {
    state: {
     data: {
      entity: {
       title: 'V-Pop Khung Trời Kỷ Niệm',
       visualIdentity: { image: [{ url: 'https://i.scdn.co/image/cover500' }] },
       trackList: Array.from({ length: 25 }, (_, idx) => ({
        title: `Bài Hát Số ${idx + 1}`,
        subtitle: 'Sơn Tùng M-TP\u00a0•\u00a0Đen Vâu',
        duration: 215000,
       })),
      },
     },
    },
   },
  },
 };
 const fakeFetch = async url => {
  assert.equal(url, 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M');
  return {
   ok: true,
   text: async () => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(fakeNextData)}</script></html>`,
  };
 };

 const col = await resolveSpotifyCollection(
  'playlist',
  '37i9dQZF1DXcBWIGoYBM5M',
  'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  fakeFetch,
 );
 assert.equal(col.name, 'V-Pop Khung Trời Kỷ Niệm');
 assert.equal(col.items.length, MAX_COLLECTION_TRACKS); // Giới hạn gọn 20 bài để nhẹ RAM 512MB
 assert.equal(col.items[0].artist, 'Sơn Tùng M-TP, Đen Vâu');

 const reqSpotify = await resolveMusicRequest('https://open.spotify.com/intl-vi/playlist/37i9dQZF1DXcBWIGoYBM5M?si=xyz', fakeFetch);
 assert.equal(reqSpotify.spotifyCollection?.items.length, 20);

 const reqScSet = await resolveMusicRequest('https://m.soundcloud.com/chillhopdotcom/sets/lofi-hip-hop-beats?si=123');
 assert.equal(reqScSet.isSoundCloudSet, true);
 assert.equal(reqScSet.query, 'https://soundcloud.com/chillhopdotcom/sets/lofi-hip-hop-beats');
});

test('Feature #3 (/radio): all 6 curated nonstop stations exist with valid queries and Vietnamese descriptions', () => {
 assert.deepEqual(RADIO_STATION_IDS, ['lofi', 'vpop', 'edm', 'piano', 'usuk', 'sleep']);
 for (const id of RADIO_STATION_IDS) {
  const st = resolveRadioStation(id);
  assert.equal(st, RADIO_STATIONS[id]);
  assert.ok(st.queries.length >= 3);
  assert.ok(st.name.length > 5);
 }
 assert.throws(() => resolveRadioStation('unknown_station'), /Đài Radio không hợp lệ/);
});

test('Feature #5 (/stats): bounded Wrapped tracking, AES-256-GCM cloud seal, and read-only access for all members', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'bot-stats-'));
 try {
  const store = createStatsStore({
   filePath: join(dir, 'stats-a.json'),
   backupFilePath: join(dir, 'stats-b.json'),
  });

  store.recordTrackPlay({
   title: 'Chúng Ta Của Hiện Tại',
   url: 'https://soundcloud.com/st/chung-ta-cua-hien-tai',
   duration: 300000,
   requestedBy: '1243061570247069696',
   metadata: { author: 'Sơn Tùng M-TP' },
  });
  store.recordTrackPlay({
   title: 'Chúng Ta Của Hiện Tại',
   url: 'https://soundcloud.com/st/chung-ta-cua-hien-tai',
   duration: 300000,
   requestedBy: 'SoundCloud_Related', // AutoPlay: cộng lượt bài hát nhưng không tạo DJ ảo
   metadata: { author: 'Sơn Tùng M-TP' },
  });

  const summary = store.getSummary('1243061570247069696');
  assert.equal(summary.totalPlays, 2);
  assert.equal(summary.totalListenMs, 600000);
  assert.equal(summary.topTracks[0].plays, 2);
  assert.equal(summary.topDjs.length, 1);
  assert.equal(summary.me?.rank, 1);

  const secret = 'test-discord-bot-token-secret';
  const seal = store.exportSeal(secret);
  assert.ok(seal && seal.length < 8000);
  const opened = openStatsPayload(seal, secret);
  assert.equal(opened.totalPlays, 2);
  assert.equal(openStatsPayload(seal, 'wrong-secret'), null);

  // Kiểm tra đồng bộ qua NowPlayingHub
  let importedRemote = null;
  const hub = createNowPlayingHub({
   getPlayer: () => null,
   getStatsSeal: () => seal,
   onRemoteStats: data => { importedRemote = data; },
   env: { NOW_PLAYING_PUSH_URL: 'https://example.workers.dev/api/now-playing' },
   botToken: secret,
   deferInitialPush: true,
   fetchImpl: async () => ({
    ok: true,
    json: async () => ({ status: 'idle', statsSeal: seal }),
   }),
  });
  await hub.fetchRemoteSessionBackup({ retries: 1 });
  assert.equal(importedRemote?.totalPlays, 2);
  hub.close();

  const serverEmbed = buildStatsEmbed(summary, {
   scope: 'server',
   discordUser: { id: '1243061570247069696', username: 'Bắt_Don' },
   botUser: { username: 'Bắt_Don' },
  }).toJSON();
  assert.ok(serverEmbed.author.name.includes('Bảng Vàng'));
  assert.equal(serverEmbed.fields.length, 2);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test('Feature #6 (/grab, /replay) & Discord StringSelectMenu <= 25 options hard limit', () => {
 const fakePlayer = {
  volume: 100,
  isPaused: false,
  loop: () => 'off',
  autoPlay: () => true,
  upcomingTracks: [],
  queue: {
   currentTrack: {
    title: 'Nơi Này Có Anh',
    url: 'https://soundcloud.com/st/noi-nay-co-anh',
    duration: 261000,
    thumbnail: 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg',
    requestedBy: '111111111111111111',
    source: 'soundcloud',
    metadata: { author: 'Sơn Tùng M-TP' },
   },
  },
  userdata: {
   ownerId: '111111111111111111',
   soundPreset: 'hd',
   vibeMode: 'nightcore',
   stay247: true,
   voiceChannelId: '222222222222222222',
  },
 };

 // Ai trong máy chủ cũng dùng được /grab và /stats, nhưng người lạ không thể gọi /vibe, /radio, /replay
 assert.doesNotThrow(() => assertMusicAccess('grab', '999999999999999999', fakePlayer));
 assert.doesNotThrow(() => assertMusicAccess('stats', '999999999999999999', fakePlayer));
 assert.throws(() => assertMusicAccess('vibe', '999999999999999999', fakePlayer));
 assert.throws(() => assertMusicAccess('replay', '999999999999999999', fakePlayer));
 assert.throws(() => assertMusicAccess('radio', '999999999999999999', fakePlayer));
 // Chủ bot (1243061570247069696) luôn có đặc quyền
 assert.doesNotThrow(() => assertMusicAccess('vibe', '1243061570247069696', fakePlayer));

 const dmEmbed = buildGrabDmEmbed(
  fakePlayer.queue.currentTrack,
  fakePlayer,
  { name: 'Server Anh Em' },
  { username: 'Bắt_Don' },
 ).toJSON();
 assert.ok(dmEmbed.title.includes('Nơi Này Có Anh'));
 assert.ok(dmEmbed.description.includes('Server Anh Em'));

 // Kiểm tra khung Player V2 không bao giờ vượt trần 25 lựa chọn của Discord StringSelectMenu
 const payload = buildPlayerPayload(fakePlayer);
 const serialized = JSON.stringify(payload.components.map(c => c.toJSON()));
 assert.ok(serialized.includes(VIBE_MODES.nightcore.label));
 const containerJson = payload.components[0].toJSON();
 const menuRow = containerJson.components.find(
  c => c.type === 1 && c.components?.[0]?.custom_id === 'player_menu',
 );
 assert.ok(menuRow, 'player_menu row must exist');
 const optionCount = menuRow.components[0].options.length;
 assert.ok(optionCount <= 25, `Discord StringSelectMenu allows max 25 options, got ${optionCount}`);
 assert.equal(optionCount, 24);
});

test('Feature #7 (Website Fullscreen Karaoke Stage Mode & Vibe Sync): web/index.html markup and inline JS compile cleanly', () => {
 const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
 assert.ok(html.includes('id="stageOverlay"'));
 assert.ok(html.includes('id="openStageBtn"'));
 assert.ok(html.includes('id="vibeBadge"'));
 assert.ok(html.includes('getBaseVibeRate'));
 assert.ok(html.includes('preservesPitch = !tapeMode'));

 const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(scriptMatch, 'inline script must exist in web/index.html');
 assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: 'web/index.html' }));
});
