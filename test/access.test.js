import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMusicAccess, resolveHumanRequester } from '../src/access.js';

const mutations = [
 'join', 'leave', '247', 'autoplay', 'play', 'pause', 'resume',
 'skip', 'previous', 'seek', 'stop', 'loop', 'shuffle', 'move', 'clear', 'volume', 'remove',
];
const player = { queue: { currentTrack: { requestedBy: 'alice' } }, userdata: { ownerId: 'creator' } };

test('only current track requester may mutate music', () => {
 for (const command of mutations) {
  assert.doesNotThrow(() => assertMusicAccess(command, 'alice', player));
  assert.throws(() => assertMusicAccess(command, 'bob', player), /Bạn không có quyền/);
  assert.throws(() => assertMusicAccess(command, 'creator', player));
 }
});

test('read-only commands stay public', () => {
 for (const command of ['help', 'queue', 'history', 'nowplaying', 'lyrics', 'ping']) {
  assert.doesNotThrow(() => assertMusicAccess(command, 'bob', player));
 }
});

test('ownership follows next track and ignores synthetic AutoPlay requester ids', () => {
 const next = { ...player, queue: { currentTrack: { requestedBy: 'bob' } } };
 assert.doesNotThrow(() => assertMusicAccess('skip', 'bob', next));
 assert.throws(() => assertMusicAccess('skip', 'alice', next));

 assert.equal(resolveHumanRequester('auto'), null);
 assert.equal(resolveHumanRequester('Unknown'), null);
 const autoPlaying = {
  queue: { currentTrack: { requestedBy: 'auto' } },
  previousTrack: { requestedBy: 'alice' },
  userdata: { ownerId: 'alice' },
 };
 assert.doesNotThrow(() => assertMusicAccess('skip', 'alice', autoPlaying));
 assert.throws(() => assertMusicAccess('skip', 'bob', autoPlaying));
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
