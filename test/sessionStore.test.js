import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
 capturePlayerSessionSnapshot,
 createRuntimeSessionStore,
 openSessionPayload,
 RESTART_247_TTL_MS,
 RESTART_NORMAL_TTL_MS,
 sealSessionPayload,
} from '../src/sessionStore.js';
import { createNowPlayingHub } from '../src/nowPlayingHub.js';

function makeFakePlayer(overrides = {}) {
 const cur = overrides.currentTrack !== undefined
  ? overrides.currentTrack
  : {
     id: 'sc-1',
     title: 'Nơi Này Có Anh',
     url: 'https://soundcloud.com/sontungmtp/noi-nay-co-anh',
     duration: 261000,
     thumbnail: 'https://i1.sndcdn.com/artworks-1-t500x500.jpg',
     requestedBy: '1243061570247069696',
     source: 'soundcloud',
     metadata: { author: 'Sơn Tùng M-TP' },
    };
 return {
  guildId: '111222333444555666',
  destroyed: false,
  isPaused: false,
  volume: 165,
  loop: () => 'queue',
  autoPlay: () => true,
  getTime: () => ({ current: 95000, total: 261000 }),
  queue: { currentTrack: cur },
  currentTrack: cur,
  upcomingTracks: [
   {
    id: 'sc-2',
    title: 'Chạy Ngay Đi',
    url: 'https://soundcloud.com/sontungmtp/chay-ngay-di',
    duration: 248000,
    requestedBy: '1243061570247069696',
    source: 'soundcloud',
    metadata: { author: 'Sơn Tùng M-TP' },
   },
  ],
  userdata: {
   voiceChannelId: '777888999000111222',
   textChannel: { id: '333444555666777888' },
   ownerId: '1243061570247069696',
   stay247: true,
   soundPreset: 'bass',
   voiceMuted: false,
  },
  ...overrides,
 };
}

test('capturePlayerSessionSnapshot & createRuntimeSessionStore persist room, 24/7, 165% volume, preset, track & queue across restart', () => {
 const dir = mkdtempSync(join(tmpdir(), 'bot-session-test-'));
 const filePath = join(dir, '.runtime-session.json');
 let fakeNow = 1_760_000_000_000;

 try {
  const player = makeFakePlayer();
  const snap = capturePlayerSessionSnapshot(player, fakeNow);
  assert.equal(snap.guildId, '111222333444555666');
  assert.equal(snap.voiceChannelId, '777888999000111222');
  assert.equal(snap.textChannelId, '333444555666777888');
  assert.equal(snap.stay247, true);
  assert.equal(snap.volume, 165);
  assert.equal(snap.soundPreset, 'bass');
  assert.equal(snap.loopMode, 'queue');
  assert.equal(snap.autoPlay, true);
  assert.equal(snap.positionMs, 95000);
  assert.equal(snap.currentTrack.title, 'Nơi Này Có Anh');
  assert.equal(snap.upcomingTracks.length, 1);

  const store1 = createRuntimeSessionStore({ filePath, nowFn: () => fakeNow });
  store1.flushAllSync([player]);
  assert.equal(existsSync(filePath), true);

  // Giả lập bot bị reset sau 3 ngày: vì đang bật 24/7 (TTL 7 ngày) nên vẫn tự vào lại phòng cũ!
  fakeNow += 3 * 24 * 3600 * 1000;
  assert.ok(3 * 24 * 3600 * 1000 > RESTART_NORMAL_TTL_MS && 3 * 24 * 3600 * 1000 < RESTART_247_TTL_MS);

  const storeAfterRestart = createRuntimeSessionStore({ filePath, nowFn: () => fakeNow });
  const restorable = storeAfterRestart.getRestorableSessions();
  assert.equal(restorable.length, 1);
  assert.equal(restorable[0].voiceChannelId, '777888999000111222');
  assert.equal(restorable[0].volume, 165);
  assert.equal(restorable[0].soundPreset, 'bass');
  assert.equal(restorable[0].positionMs, 95000);

  // Khi người dùng chủ động gọi /leave -> xóa sạch file lưu trên đĩa để không tự vào lại ngoài ý muốn.
  storeAfterRestart.removeGuild('111222333444555666');
  assert.equal(existsSync(filePath), false);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test('AES-256-GCM encrypted cloud backup (resumeSeal) hides IDs, blocks tampering, and restores via NowPlayingHub when disk is wiped', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'bot-cloud-seal-'));
 const filePath = join(dir, '.runtime-session.json');
 const secretToken = 'fake-discord-bot-token-for-unit-test';

 try {
  const store1 = createRuntimeSessionStore({ filePath });
  store1.savePlayer(makeFakePlayer({ currentTrack: null, upcomingTracks: [] }), { immediate: true });
  const exported = store1.exportSessionsObject();

  const sealed = sealSessionPayload(exported, secretToken);
  assert.equal(typeof sealed, 'string');
  assert.ok(!sealed.includes('777888999000111222'), 'ciphertext must never expose plaintext channel IDs');
  assert.ok(!sealed.includes('111222333444555666'), 'ciphertext must never expose plaintext guild IDs');

  // Sai khóa hoặc dữ liệu bị sửa đổi phải trả về null an toàn.
  assert.equal(openSessionPayload(sealed, 'wrong-token'), null);
  const tampered = `${sealed.slice(0, -3)}abc`;
  assert.equal(openSessionPayload(tampered, secretToken), null);

  // Giả lập toàn bộ container bị xóa trắng ổ đĩa khi upload ZIP mới -> khôi phục từ Cloudflare Worker!
  let pushedPayload = null;
  const hub = createNowPlayingHub({
   getPlayer: () => null,
   getResumeSeal: () => sealed,
   client: { isReady: () => true, user: { username: 'Bắt_Don' } },
   env: { NOW_PLAYING_PUSH_URL: 'https://demo.workers.dev/api/now-playing' },
   botToken: secretToken,
   logger: { log() {}, warn() {} },
   fetchImpl: async (_url, opts) => {
    if (opts?.method === 'POST') {
     pushedPayload = JSON.parse(opts.body);
     return { ok: true, status: 200 };
    }
    return {
     ok: true,
     status: 200,
     json: async () => pushedPayload,
    };
   },
  });

  hub.publish();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(pushedPayload?.resumeSeal, sealed);

  const remoteRecovered = await hub.fetchRemoteSessionBackup();
  assert.equal(remoteRecovered?.['111222333444555666']?.voiceChannelId, '777888999000111222');
  assert.equal(remoteRecovered?.['111222333444555666']?.stay247, true);
  hub.close();
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});
