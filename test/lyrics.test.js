import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrackLyrics, sanitizeLyricsTitle } from '../src/lyrics.js';
import { buildHistoryEmbed, buildLyricsEmbed } from '../src/playerGui.js';

test('sanitizeLyricsTitle cleans YouTube/SoundCloud noise cleanly', () => {
 const cleaned = sanitizeLyricsTitle('Sơn Tùng M-TP - Nơi Này Có Anh (Official Music Video) [4K] ft. Guest', '');
 assert.equal(cleaned.artist, 'Sơn Tùng M-TP');
 assert.equal(cleaned.title, 'Nơi Này Có Anh');
});

test('fetchTrackLyrics and buildLyricsEmbed / buildHistoryEmbed work cleanly', async () => {
 const fakeFetch = async () => ({
  ok: true,
  json: async () => [{
   trackName: 'Fearless',
   artistName: 'Lost Sky',
   plainLyrics: 'Line 1\nLine 2',
  }],
 });
 const lyrics = await fetchTrackLyrics({ title: 'Fearless [NCS Release]', artist: 'Lost Sky - Topic', durationMs: 194000 }, fakeFetch);
 assert.equal(lyrics.source, 'LRCLIB');
 assert.equal(lyrics.text, 'Line 1\nLine 2');

 const botUser = { username: 'Bắt_Don', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
 const lEmbed = buildLyricsEmbed({ ...lyrics, text: 'A'.repeat(4500) }, botUser).toJSON();
 assert.ok(lEmbed.description.length <= 4096);

 const hEmbed = buildHistoryEmbed({
  previousTracks: [
   { title: 'Old Song', duration: 180000, requestedBy: '111' },
   { title: 'Auto Song', duration: 200000, requestedBy: 'auto' },
  ],
 }, botUser).toJSON();
 assert.ok(hEmbed.description.includes('AutoPlay'));
});
