import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrackLyrics, fetchWebKaraokeLyrics, parseSyncedLyrics, sanitizeLyricsTitle } from '../src/lyrics.js';
import { buildHistoryEmbed, buildLyricsEmbed } from '../src/playerGui.js';

test('parseSyncedLyrics parses LRC [mm:ss.xx] timestamps into sorted ms entries', () => {
 const raw = '[00:12.50] Câu mở đầu\n[00:05.00] Intro nhẹ\n[01:02.125] Điệp khúc cao trào\n[00:18.00]   ';
 const parsed = parseSyncedLyrics(raw);
 assert.deepEqual(parsed, [
  { t: 5000, text: 'Intro nhẹ' },
  { t: 12500, text: 'Câu mở đầu' },
  { t: 62125, text: 'Điệp khúc cao trào' },
 ]);
});

test('fetchWebKaraokeLyrics extracts synced LRC lines and caches repeat lookups', async () => {
 let calls = 0;
 const fakeFetch = async () => {
  calls++;
  return {
   ok: true,
   json: async () => [{
    trackName: 'Chúng Ta Của Hiện Tại',
    artistName: 'Sơn Tùng M-TP',
    syncedLyrics: '[00:15.20] Mùa thu mang giấc mơ quay về\n[00:21.40] Vẫn nguyên vẹn như hôm nào',
    plainLyrics: 'Mùa thu mang giấc mơ quay về\nVẫn nguyên vẹn như hôm nào',
   }],
  };
 };
 const track = { title: 'Chúng Ta Của Hiện Tại', duration: 290000, metadata: { author: 'Sơn Tùng M-TP' } };
 const first = await fetchWebKaraokeLyrics(track, fakeFetch);
 const second = await fetchWebKaraokeLyrics(track, fakeFetch);
 assert.equal(calls, 1);
 assert.equal(first?.source, 'LRCLIB');
 assert.equal(first?.synced?.length, 2);
 assert.deepEqual(first, second);
});

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
