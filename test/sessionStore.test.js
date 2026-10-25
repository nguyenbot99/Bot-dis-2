import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
 captureGatewayFallbackSessions,
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

test('capturePlayerSessionSnapshot & dual-file store survive git clean of primary file and clear both on /leave', () => {
 const dir = mkdtempSync(join(tmpdir(), 'bot-session-test-'));
 const filePath = join(dir, '.runtime-session.json');
 const backupFilePath = join(dir, 'tmp-backup-session.json');
 let fakeNow = 1_760_000_000_000;

 try {
  const player = makeFakePlayer();
  const snap = capturePlayerSessionSnapshot(player, fakeNow);
  assert.equal(snap.guildId, '111222333444555666');
  assert.equal(snap.voiceChannelId, '777888999000111222');
  assert.equal(snap.stay247, true);
  assert.equal(snap.volume, 165);
  assert.equal(snap.soundPreset, 'bass');
  assert.equal(snap.positionMs, 95000);

  const store1 = createRuntimeSessionStore({ filePath, backupFilePath, nowFn: () => fakeNow });
  store1.flushAllSync([player]);
  assert.equal(existsSync(filePath), true);
  assert.equal(existsSync(backupFilePath), true);

  // Giả lập git clean xóa mất file trong thư mục dự án, chỉ còn file backup trong /tmp + sau 3 ngày:
  unlinkSync(filePath);
  fakeNow += 3 * 24 * 3600 * 1000;
  assert.ok(3 * 24 * 3600 * 1000 > RESTART_NORMAL_TTL_MS && 3 * 24 * 3600 * 1000 < RESTART_247_TTL_MS);

  const storeAfterRestart = createRuntimeSessionStore({ filePath, backupFilePath, nowFn: () => fakeNow });
  const restorable = storeAfterRestart.getRestorableSessions();
  assert.equal(restorable.length, 1);
  assert.equal(restorable[0].voiceChannelId, '777888999000111222');
  assert.equal(restorable[0].volume, 165);
  assert.equal(restorable[0].soundPreset, 'bass');
  assert.equal(restorable[0].positionMs, 95000);

  // Khi người dùng chủ động gọi /leave -> xóa sạch cả 2 file lưu trên đĩa.
  storeAfterRestart.removeGuild('111222333444555666');
  assert.equal(existsSync(filePath), false);
  assert.equal(existsSync(backupFilePath), false);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test('captureGatewayFallbackSessions detects bot ghost voice room on fast restart while ignoring AFK channel', () => {
 const fakeClient = {
  user: { id: '999000999' },
  guilds: {
   cache: new Map([
    [
     'g1',
     {
      id: 'g1',
      afkChannelId: 'afk-room',
      voiceStates: { cache: new Map([['999000999', { channelId: 'music-room-1' }]]) },
     },
    ],
    [
     'g2',
     {
      id: 'g2',
      afkChannelId: 'afk-room',
      voiceStates: { cache: new Map([['999000999', { channelId: 'afk-room' }]]) },
     },
    ],
   ]),
  },
 };
 const res = captureGatewayFallbackSessions(fakeClient, 123456);
 assert.equal(res.g1?.voiceChannelId, 'music-room-1');
 assert.equal(res.g2, undefined);
});

test('AES-256-GCM cloud backup (resumeSeal) retries on cold boot and never overwrites remote backup before reading', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'bot-cloud-seal-'));
 const filePath = join(dir, '.runtime-session.json');
 const secretToken = 'fake-discord-bot-token-for-unit-test';

 try {
  const store1 = createRuntimeSessionStore({ filePath, backupFilePath: null });
  store1.savePlayer(makeFakePlayer({ currentTrack: null, upcomingTracks: [] }), { immediate: true });
  const sealed = sealSessionPayload(store1.exportSessionsObject(), secretToken);
  assert.ok(!sealed.includes('777888999000111222'));
  assert.equal(openSessionPayload(sealed, 'wrong-token'), null);

  let remoteCloudState = { status: 'idle_247', resumeSeal: sealed };
  let getAttempts = 0;

  // Giả lập bot mới khởi động lại với ổ đĩa trống + deferInitialPush=true + lần GET đầu bị lỗi mạng lạnh:
  const hubOnBoot = createNowPlayingHub({
   getPlayer: () => null,
   getResumeSeal: () => null,
   client: { isReady: () => true, user: { username: 'Bắt_Don' } },
   env: { NOW_PLAYING_PUSH_URL: 'https://demo.workers.dev/api/now-playing' },
   botToken: secretToken,
   deferInitialPush: true,
   logger: { log() {}, warn() {} },
   fetchImpl: async (_url, opts) => {
    if (opts?.method === 'POST') {
     remoteCloudState = JSON.parse(opts.body);
     return { ok: true, status: 200 };
    }
    getAttempts++;
    if (getAttempts === 1) throw new Error('Cold boot DNS timeout');
    return {
     ok: true,
     status: 200,
     json: async () => remoteCloudState,
    };
   },
  });

  // Kể cả có sự kiện publish sớm khi đang deferInitialPush, không được ghi đè mất resumeSeal trên mây!
  hubOnBoot.publish();
  assert.equal(remoteCloudState.resumeSeal, sealed);

  const recovered = await hubOnBoot.fetchRemoteSessionBackup({ retries: 3 });
  assert.equal(getAttempts, 2);
  assert.equal(recovered?.['111222333444555666']?.voiceChannelId, '777888999000111222');

  // Khi người dùng bấm /leave chủ động -> clearRemoteSession xóa sạch resumeSeal trên mây ngay lập tức.
  hubOnBoot.setOutboundPushPaused(false);
  hubOnBoot.publish({ reason: 'Rời phòng' }, { immediatePush: true, clearRemoteSession: true });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(remoteCloudState.resumeSeal, null);
  hubOnBoot.close();
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});
