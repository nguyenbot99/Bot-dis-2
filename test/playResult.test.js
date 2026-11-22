import test from 'node:test';
import assert from 'node:assert/strict';
import { playTrackChecked, pausePlayerSafely } from '../src/playResult.js';

test('Không báo lỗi khi ZiPlayer trả false nhưng bài đã phát', async () => {
 const track = { id: '1', source: 'soundcloud', requestedBy: 'u' };
 const p = { play: async () => false, queue: { currentTrack: track, tracksList: [] }, isPlaying: true };
 assert.equal(await playTrackChecked(p, track, 'u', { waitMs: 10 }), true);
});

test('Nhận biết bài đã được thêm vào hàng đợi dù trả false', async () => {
 const track = { id: '2', source: 'soundcloud', requestedBy: 'u' };
 const p = { play: async () => false, queue: { tracksList: [track] } };
 assert.equal(await playTrackChecked(p, track, 'u', { waitMs: 10 }), true);
});

test('Không che lỗi khi bài thực sự không phát và không vào hàng đợi', async () => {
 const track = { id: '3', source: 'soundcloud', requestedBy: 'u' };
 const p = { play: async () => false, queue: { currentTrack: null, tracksList: [] } };
 assert.equal(await playTrackChecked(p, track, 'u', { waitMs: 15, intervalMs: 5 }), false);
});

test('khôi phục bài bị tạm dừng: pause() trả boolean đồng bộ không gây TypeError', async () => {
 let called = 0;
 assert.equal(await pausePlayerSafely({ pause() { called++; return true; } }), true);
 assert.equal(called, 1);
});

test('hỗ trợ pause Promise và bắt lỗi đồng bộ/lời hứa khi khôi phục', async () => {
 assert.equal(await pausePlayerSafely({ pause: async () => true }), true);
 assert.equal(await pausePlayerSafely({ pause() { throw new Error('voice'); } }), false);
 assert.equal(await pausePlayerSafely({ pause: async () => { throw new Error('voice'); } }), false);
});
