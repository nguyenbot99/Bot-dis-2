import test from 'node:test';
import assert from 'node:assert/strict';
import { playTrackChecked } from '../src/playResult.js';

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
