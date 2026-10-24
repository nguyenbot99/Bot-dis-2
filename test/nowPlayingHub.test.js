import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createNowPlayingHub, DEFAULT_NOW_PLAYING_PUSH_URL, resolvePushEndpoint, serializeNowPlayingState } from '../src/nowPlayingHub.js';
import workerModule, { NowPlayingRoom } from '../cloudflare-worker/worker.js';

test('serializeNowPlayingState formats playing, paused, muted, and sanitizes unsafe URLs', () => {
 const fakePlayer = {
  guildId: 'g1',
  isPaused: false,
  volume: 80,
  loop: () => 'track',
  autoPlay: () => true,
  getTime: () => ({ current: 42000, total: 261000 }),
  userdata: {
   voiceChannelId: 'vc1',
   stay247: true,
   voiceMuted: false,
   soundPreset: 'vocal',
  },
  queue: {
   currentTrack: {
    title: 'Nơi Này Có Anh',
    url: 'https://soundcloud.com/sontungmtp/noi-nay-co-anh',
    thumbnail: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
    duration: 261000,
    source: 'soundcloud',
    metadata: { author: 'Sơn Tùng M-TP' },
   },
   history: [
    {
     title: 'Bài cũ',
     url: 'javascript:alert(1)',
     duration: 180000,
     source: 'soundcloud',
     metadata: { author: 'Ca sĩ A' },
    },
   ],
  },
  upcomingTracks: [
   {
    title: 'Bài tiếp theo',
    url: 'https://soundcloud.com/artist/next',
    duration: 200000,
    source: 'soundcloud',
    metadata: { author: 'Ca sĩ B' },
   },
  ],
 };

 const fakeClient = {
  isReady: () => true,
  user: {
   username: 'Bắt_Don',
   displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
  },
  guilds: {
   cache: new Map([
    ['g1', { channels: { cache: new Map([['vc1', { name: 'Phòng Nhạc Chill' }]]) } }],
   ]),
  },
 };

 const snap = serializeNowPlayingState({ player: fakePlayer, client: fakeClient });
 assert.equal(snap.status, 'playing');
 assert.equal(snap.voiceChannelName, 'Phòng Nhạc Chill');
 assert.equal(snap.track.title, 'Nơi Này Có Anh');
 assert.equal(snap.track.author, 'Sơn Tùng M-TP');
 assert.equal(snap.track.artworkUrl, 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg');
 assert.equal(snap.track.url, 'https://soundcloud.com/sontungmtp/noi-nay-co-anh');
 assert.equal(snap.track.positionMs, 42000);
 assert.equal(snap.track.durationMs, 261000);
 assert.equal(snap.upcoming.length, 1);
 assert.equal(snap.history.length, 1);
 assert.equal(snap.history[0].url, null); // Chặn hoàn toàn javascript: URL

 const mutedSnap = serializeNowPlayingState({
  player: fakePlayer,
  client: fakeClient,
  overrides: { voiceMuted: true, muteReason: 'server_mute' },
 });
 assert.equal(mutedSnap.status, 'muted');
});

test('createNowPlayingHub serves HTML, JSON API, real-time SSE updates, and outbound push', async () => {
 let currentPlayer = null;
 const pushedPayloads = [];
 const fakePushFetch = async (url, init) => {
  pushedPayloads.push({
   url,
   auth: init.headers.Authorization,
   body: JSON.parse(init.body),
  });
  return { ok: true };
 };

 const hub = createNowPlayingHub({
  getPlayer: () => currentPlayer,
  client: { isReady: () => true, user: { username: 'Bắt_Don' } },
  env: {
   NOW_PLAYING_PUSH_URL: 'https://demo.workers.dev/api/now-playing',
   NOW_PLAYING_PUSH_SECRET: 'secret-demo-123',
  },
  fetchImpl: fakePushFetch,
 });

 const app = express();
 hub.mountRoutes(app);
 const srv = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
 });
 const baseUrl = `http://127.0.0.1:${srv.address().port}`;

 try {
  // 1. Trang giao diện chính GET /
  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  const htmlText = await htmlRes.text();
  assert.ok(htmlText.includes('Now Playing'));
  assert.ok(htmlText.includes('/api/now-playing/events'));

  // 2. API JSON ban đầu khi chưa phát bài nào
  const idleRes = await fetch(`${baseUrl}/api/now-playing`);
  assert.equal(idleRes.status, 200);
  assert.equal(idleRes.headers.get('access-control-allow-origin'), '*');
  const idleData = await idleRes.json();
  assert.equal(idleData.status, 'idle');
  assert.equal(idleData.track, null);

  // 3. Kết nối SSE thời gian thực nhận ngay bản tin đầu tiên + bản tin khi bot bắt đầu bài mới
  const ac = new AbortController();
  const sseRes = await fetch(`${baseUrl}/api/now-playing/events`, { signal: ac.signal });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  const readNextStateEvent = async () => {
   while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
   }
   const idx = buffer.indexOf('\n\n');
   const rawFrame = buffer.slice(0, idx);
   buffer = buffer.slice(idx + 2);
   const dataLine = rawFrame.split('\n').find(l => l.startsWith('data: '));
   return JSON.parse(dataLine.slice(6));
  };

  const firstEvent = await readNextStateEvent();
  assert.equal(firstEvent.status, 'idle');

  // Giả lập sự kiện trackStart từ ZiPlayer
  currentPlayer = {
   isPaused: false,
   volume: 100,
   loop: () => 'off',
   autoPlay: () => false,
   getTime: () => ({ current: 5000, total: 214000 }),
   userdata: { soundPreset: 'hd', stay247: false },
   queue: {
    currentTrack: {
     title: 'Never Gonna Give You Up',
     url: 'https://soundcloud.com/rick-astley/never-gonna-give-you-up',
     duration: 214000,
     source: 'soundcloud',
     metadata: { author: 'Rick Astley' },
    },
    history: [],
   },
   upcomingTracks: [],
  };
  hub.publish({ player: currentPlayer });

  const secondEvent = await readNextStateEvent();
  assert.equal(secondEvent.status, 'playing');
  assert.equal(secondEvent.track.title, 'Never Gonna Give You Up');
  assert.equal(secondEvent.track.author, 'Rick Astley');
  ac.abort();

  // Chờ debounce 180ms để kiểm tra lệnh đẩy outbound sang Cloudflare Worker
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pushedPayloads.length, 1);
  assert.equal(pushedPayloads[0].auth, 'Bearer secret-demo-123');
  assert.equal(pushedPayloads[0].body.track.title, 'Never Gonna Give You Up');
 } finally {
  hub.close();
  await new Promise(resolve => srv.close(resolve));
 }
});

test('Cloudflare Worker relay enforces secret on POST and serves live HTML + JSON', async () => {
 const env = { NOW_PLAYING_PUSH_SECRET: 'my-secret' };
 const ctx = { waitUntil: () => {} };

 // POST sai mật khẩu bị chặn 401
 const badPost = await workerModule.fetch(
  new Request('https://demo.workers.dev/api/now-playing', {
   method: 'POST',
   headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
   body: JSON.stringify({ status: 'playing' }),
  }),
  env,
  ctx,
 );
 assert.equal(badPost.status, 401);

 // POST đúng mật khẩu lưu trạng thái thành công
 const okPost = await workerModule.fetch(
  new Request('https://demo.workers.dev/api/now-playing', {
   method: 'POST',
   headers: { Authorization: 'Bearer my-secret', 'Content-Type': 'application/json' },
   body: JSON.stringify({
    status: 'playing',
    statusLabel: '▶️ Đang phát nhạc',
    serverTimeMs: Date.now() - 2000,
    track: { title: 'Chúng Ta Của Hiện Tại', author: 'Sơn Tùng M-TP', positionMs: 10000, durationMs: 300000 },
    upcoming: [],
    history: [],
   }),
  }),
  env,
  ctx,
 );
 assert.equal(okPost.status, 200);

 // GET /api/now-playing trả dữ liệu đã cộng bù thời gian trôi
 const getApi = await workerModule.fetch(new Request('https://demo.workers.dev/api/now-playing'), env, ctx);
 assert.equal(getApi.status, 200);
 const json = await getApi.json();
 assert.equal(json.track.title, 'Chúng Ta Của Hiện Tại');
 assert.ok(json.track.positionMs >= 11500);

 // GET / trả giao diện HTML đầy đủ
 const getHtml = await workerModule.fetch(new Request('https://demo.workers.dev/'), env, ctx);
 assert.equal(getHtml.status, 200);
 assert.match(getHtml.headers.get('content-type'), /text\/html/);

 // Kiểm tra Durable Object NowPlayingRoom đồng bộ xuyên biên giới giữa VPS và điện thoại người dùng
 const backingMap = new Map();
 const roomInstance = new NowPlayingRoom(
  {
   storage: {
    get: async k => backingMap.get(k),
    put: async (k, v) => backingMap.set(k, v),
   },
  },
  {},
 );
 const envWithDO = {
  NOW_PLAYING_PUSH_SECRET: 'bao123',
  NOW_PLAYING_ROOM: {
   idFromName: name => name,
   get: () => ({
    fetch: (url, init) => roomInstance.fetch(new Request(url, init)),
   }),
  },
 };
 const doPost = await workerModule.fetch(
  new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing', {
   method: 'POST',
   headers: { Authorization: 'Bearer bao123', 'Content-Type': 'application/json' },
   body: JSON.stringify({
    status: 'playing',
    statusLabel: '▶️ Đang phát nhạc',
    serverTimeMs: Date.now() - 1000,
    track: { title: 'Lạc Trôi', author: 'Sơn Tùng M-TP', positionMs: 5000, durationMs: 240000 },
    upcoming: [],
    history: [],
   }),
  }),
  envWithDO,
  ctx,
 );
 assert.equal(doPost.status, 200);
 assert.equal(backingMap.get('latest')?.track?.title, 'Lạc Trôi');

 const doGet = await workerModule.fetch(
  new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing'),
  envWithDO,
  ctx,
 );
 const doJson = await doGet.json();
 assert.equal(doJson.track.title, 'Lạc Trôi');
 assert.ok(doJson.track.positionMs >= 5800);
});

test('resolvePushEndpoint normalizes root Worker URL, defaults when secret is set, and auto-derives key from botToken', () => {
 assert.deepEqual(
  resolvePushEndpoint({ NOW_PLAYING_PUSH_SECRET: 'bao123' }),
  { pushUrl: DEFAULT_NOW_PLAYING_PUSH_URL, pushSecret: 'bao123', ownerProof: '' },
 );
 assert.deepEqual(
  resolvePushEndpoint({
   NOW_PLAYING_PUSH_URL: 'https://bot-dis-2.botmusicvip.workers.dev/',
   NOW_PLAYING_PUSH_SECRET: 'bao123',
  }),
  { pushUrl: 'https://bot-dis-2.botmusicvip.workers.dev/api/now-playing', pushSecret: 'bao123', ownerProof: '' },
 );
 const autoDerived = resolvePushEndpoint({}, 'sample-discord-bot-token');
 assert.equal(autoDerived.pushUrl, DEFAULT_NOW_PLAYING_PUSH_URL);
 assert.equal(autoDerived.pushSecret.length, 64);
 assert.equal(autoDerived.ownerProof.length, 64);
 assert.notEqual(autoDerived.pushSecret, 'sample-discord-bot-token');
});

test('NowPlayingRoom auto-pairs on first bot push without needing Cloudflare secret and blocks strangers', async () => {
 const backing = new Map();
 const room = new NowPlayingRoom(
  {
   storage: {
    get: async k => backing.get(k),
    put: async (k, v) => backing.set(k, v),
   },
  },
  {},
 );
 const envNoSecret = {
  NOW_PLAYING_ROOM: {
   idFromName: name => name,
   get: () => ({
    fetch: (url, init) => room.fetch(new Request(url, init)),
   }),
  },
 };

 // Lần đầu bot thật gửi lên: tự động ghép đôi thành công
 const firstPush = await workerModule.fetch(
  new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing', {
   method: 'POST',
   headers: { Authorization: 'Bearer bot-auto-key-123', 'Content-Type': 'application/json' },
   body: JSON.stringify({ status: 'playing', bot: { ready: true, name: 'Bắt_Don' }, track: { title: 'Bài 1', positionMs: 0, durationMs: 180000 } }),
  }),
  envNoSecret,
  {},
 );
 assert.equal(firstPush.status, 200);

 // Người lạ thử gửi đè bằng khóa khác: bị chặn 401 ngay lập tức
 const strangerPush = await workerModule.fetch(
  new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing', {
   method: 'POST',
   headers: { Authorization: 'Bearer hacker-wrong-key', 'Content-Type': 'application/json' },
   body: JSON.stringify({ status: 'playing', bot: { ready: true, name: 'Fake' } }),
  }),
  envNoSecret,
  {},
 );
 assert.equal(strangerPush.status, 401);
});
