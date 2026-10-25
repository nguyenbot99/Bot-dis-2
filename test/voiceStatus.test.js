import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceRoomStatusSync, formatVoiceRoomStatus } from '../src/voiceStatus.js';

test('formatVoiceRoomStatus formats playing, paused, avoids duplicate artist, and clears on null', () => {
 assert.equal(formatVoiceRoomStatus({ track: null }), '');

 assert.equal(
  formatVoiceRoomStatus({
   track: { title: 'Nơi Này Có Anh', metadata: { author: 'Sơn Tùng M-TP' } },
  }),
  '🎵 Nơi Này Có Anh • Sơn Tùng M-TP',
 );

 assert.equal(
  formatVoiceRoomStatus({
   track: { title: 'Sơn Tùng M-TP - Nơi Này Có Anh', metadata: { author: 'Sơn Tùng M-TP' } },
  }),
  '🎵 Sơn Tùng M-TP - Nơi Này Có Anh',
 );

 assert.equal(
  formatVoiceRoomStatus({
   track: { title: 'Chạy Ngay Đi', metadata: { author: 'Sơn Tùng M-TP' } },
   paused: true,
  }),
  '⏸️ Chạy Ngay Đi • Sơn Tùng M-TP',
 );
});

test('createVoiceRoomStatusSync sets voice channel status, deduplicates, coalesces rate limits, moves rooms, and clears cleanly', async () => {
 const calls = [];
 let fakeNow = 10_000;
 const sync = createVoiceRoomStatusSync({
  rest: {
   put: async (route, opts) => {
    calls.push({ route, status: opts?.body?.status });
   },
  },
  minIntervalMs: 100,
  nowFn: () => fakeNow,
  logger: { warn() {} },
 });

 // Nếu bot chỉ vào phòng (/join) chưa phát bài nào -> không tự ý xóa status do chủ phòng đặt sẵn.
 await sync.clearChannelNow('vc-100');
 assert.equal(calls.length, 0);

 const player = {
  guildId: 'g-1',
  isPaused: false,
  userdata: { voiceChannelId: 'vc-100', voiceMuted: false },
  queue: {
   currentTrack: { title: 'Chúng Ta Của Hiện Tại', metadata: { author: 'Sơn Tùng M-TP' } },
  },
 };

 sync.syncPlayer(player);
 await new Promise(r => setTimeout(r, 20));
 assert.equal(calls.length, 1);
 assert.equal(calls[0].route, '/channels/vc-100/voice-status');
 assert.equal(calls[0].status, '🎵 Chúng Ta Của Hiện Tại • Sơn Tùng M-TP');

 // Gọi trùng nội dung (ví dụ khi chỉ chỉnh âm lượng / tua nhạc) -> không tốn thêm bất kỳ request nào.
 sync.syncPlayer(player);
 await new Promise(r => setTimeout(r, 20));
 assert.equal(calls.length, 1);

 // Bấm Tạm dừng trong vùng chống rate-limit 100ms -> tự đợi hết cooldown rồi cập nhật ⏸️.
 fakeNow += 20;
 sync.syncPlayer(player, { paused: true });
 assert.equal(calls.length, 1);
 fakeNow += 100;
 await new Promise(r => setTimeout(r, 110));
 assert.equal(calls.length, 2);
 assert.equal(calls[1].status, '⏸️ Chúng Ta Của Hiện Tại • Sơn Tùng M-TP');

 // Khi kéo bot từ vc-100 sang vc-200 -> dọn sạch vc-100 và đặt tên bài lên vc-200.
 fakeNow += 200;
 player.userdata.voiceChannelId = 'vc-200';
 sync.handleRoomMove('vc-100', 'vc-200', player);
 await new Promise(r => setTimeout(r, 30));
 assert.ok(calls.some(c => c.route === '/channels/vc-100/voice-status' && c.status === ''));
 assert.ok(calls.some(c => c.route === '/channels/vc-200/voice-status' && c.status === '🎵 Chúng Ta Của Hiện Tại • Sơn Tùng M-TP'));

 // Khi dừng nhạc / rời phòng -> dọn sạch vc-200 ngay lập tức.
 await sync.clearChannelNow('vc-200');
 assert.equal(calls.at(-1).route, '/channels/vc-200/voice-status');
 assert.equal(calls.at(-1).status, '');
});

test('createVoiceRoomStatusSync handles AutoMod 200000 fallback and Missing Permissions 50013 safely without throwing', async () => {
 const calls = [];
 const warnings = [];
 const sync = createVoiceRoomStatusSync({
  rest: {
   put: async (route, opts) => {
    calls.push({ route, status: opts?.body?.status });
    if (opts?.body?.status?.includes('BadWord')) {
     const err = new Error('Blocked by AutoMod');
     err.code = 200000;
     err.status = 400;
     throw err;
    }
    if (route.includes('vc-noperm')) {
     const err = new Error('Missing Permissions');
     err.code = 50013;
     throw err;
    }
   },
  },
  minIntervalMs: 0,
  logger: { warn: m => warnings.push(m) },
 });

 sync.setChannelStatus('vc-automod', '🎵 BadWord Song');
 await new Promise(r => setTimeout(r, 25));
 assert.equal(calls.at(-1).status, '🎵 Đang phát nhạc');

 sync.setChannelStatus('vc-noperm', '🎵 Bài hát A');
 sync.setChannelStatus('vc-noperm', '🎵 Bài hát B');
 await new Promise(r => setTimeout(r, 25));
 assert.equal(warnings.length, 1);
});
