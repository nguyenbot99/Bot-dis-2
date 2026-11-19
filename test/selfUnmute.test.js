import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelfUnmuteController } from '../src/selfUnmute.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('thử ngay, mỗi 5 giây khi còn Server Mute, dừng khi mic mở và không tạo hai vòng lặp', async () => {
 let muted = true;
 let attempts = 0;
 const timers = [];
 const controller = createSelfUnmuteController({
  getContext: async (id, channelId) => {
   assert.equal(channelId, 'voice');
   return { active: true, muted, canUnmute: true, unmute: async () => { attempts++; } };
  },
  setTimer: (fn, ms) => { const entry = { fn, ms, cancelled: false }; timers.push(entry); return entry; },
  clearTimer: entry => { entry.cancelled = true; },
 });
 assert.equal(controller.start('guild', 'voice'), true);
 assert.equal(controller.start('guild', 'voice'), false);
 await flush();
 assert.equal(attempts, 1);
 assert.equal(timers[0].ms, 5000);
 timers[0].fn();
 await flush();
 assert.equal(attempts, 2);
 muted = false;
 timers[1].fn();
 await flush();
 assert.equal(attempts, 2);
 assert.equal(controller.isRunning('guild'), false);
});

test('dừng khi bot rời phòng và không thử lại nếu thiếu quyền', async () => {
 let attempts = 0;
 let error = '';
 const controller = createSelfUnmuteController({
  getContext: async () => ({ active: true, muted: true, canUnmute: false, unmute: () => { attempts++; } }),
  onError: (id, err) => { error = err.message; },
 });
 controller.start('guild', 'voice');
 await flush();
 assert.equal(attempts, 0);
 assert.match(error, /thiếu quyền/);
 assert.equal(controller.isRunning('guild'), false);
});

test('mute liên tiếp vẫn không gửi quá một yêu cầu trong mỗi 5 giây', async () => {
 let time = 10000;
 let attempts = 0;
 const timers = [];
 const ctrl = createSelfUnmuteController({
  now: () => time,
  getContext: async () => ({ active: true, muted: true, canUnmute: true, unmute: async () => { attempts++; } }),
  setTimer: (fn, ms) => { const entry = { fn, ms, cancelled: false }; timers.push(entry); return entry; },
  clearTimer: entry => { entry.cancelled = true; },
 });
 ctrl.start('guild', 'voice');
 await flush();
 assert.equal(attempts, 1);
 ctrl.stop('guild'); // Discord báo mic vừa mở.
 time += 1000;
 ctrl.start('guild', 'voice'); // Quản trị viên tắt lại ngay.
 await flush();
 assert.equal(attempts, 1);
 assert.equal(timers[1].ms, 4000);
 time += 4000;
 timers[1].fn();
 await flush();
 assert.equal(attempts, 2);
 ctrl.stop('guild');
});
