import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMusicAccess } from '../src/access.js';
const mutations = ['join', 'leave', '247', 'play', 'pause', 'resume', 'skip', 'stop', 'loop', 'shuffle', 'volume', 'remove'];
const player = { queue: { currentTrack: { requestedBy: 'alice' } }, userdata: { ownerId: 'creator' } };

test('only current track requester may mutate music', () => {
 for (const command of mutations) {
  assert.doesNotThrow(() => assertMusicAccess(command, 'alice', player));
  assert.throws(() => assertMusicAccess(command, 'bob', player), /Bạn không có quyền/);
  assert.throws(() => assertMusicAccess(command, 'creator', player));
 }
});

test('read-only commands stay public', () => {
 for (const command of ['help', 'queue', 'nowplaying', 'ping']) {
  assert.doesNotThrow(() => assertMusicAccess(command, 'bob', player));
 }
});

test('ownership follows next track', () => {
 const next = { ...player, queue: { currentTrack: { requestedBy: 'bob' } } };
 assert.doesNotThrow(() => assertMusicAccess('skip', 'bob', next));
 assert.throws(() => assertMusicAccess('skip', 'alice', next));
});

test('gaps use previous requester, then session creator; idle 24/7 allows new /play while protecting /leave and /247', () => {
 assert.doesNotThrow(() => assertMusicAccess('stop', 'alice', { queue: {}, previousTrack: { requestedBy: 'alice' } }));
 assert.doesNotThrow(() => assertMusicAccess('play', 'creator', { queue: {}, userdata: { ownerId: 'creator' } }));
 assert.throws(() => assertMusicAccess('stop', 'bob', { queue: {} }));
 assert.doesNotThrow(() => assertMusicAccess('play', 'bob', undefined));

 const idle247 = {
  queue: { currentTrack: null },
  previousTrack: { requestedBy: 'alice' },
  userdata: { ownerId: 'alice', stay247: true, idleOpen: true },
 };
 assert.doesNotThrow(() => assertMusicAccess('play', 'bob', idle247));
 assert.throws(() => assertMusicAccess('leave', 'bob', idle247));
 assert.throws(() => assertMusicAccess('247', 'bob', idle247));
 assert.doesNotThrow(() => assertMusicAccess('leave', 'alice', idle247));
});
