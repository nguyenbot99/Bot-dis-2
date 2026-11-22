import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsEmbed } from '../src/statsStore.js';

test('/stats không lỗi Discord Embed khi 8 bài có URL SoundCloud rất dài', () => {
 const summary = {
  totalPlays: 150,
  totalListenMs: 500000,
  topTracks: Array.from({ length: 8 }, (_, idx) => ({
   title: `Bài hát rất dài số ${idx} ` + 'nhạc '.repeat(16),
   url: `https://soundcloud.com/artist/${'ten-bai-nhac-dai-'.repeat(35)}${idx}`,
   plays: 20,
  })),
  topDjs: [],
 };
 const embed = buildStatsEmbed(summary).toJSON();
 assert.equal(embed.fields.length, 2);
 assert.ok(embed.fields.every(field => field.value.length <= 1024));
 assert.match(embed.fields[0].value, /Bài hát rất dài số 0/);
 assert.match(embed.fields[0].value, /Bài hát rất dài số 7/);
});

test('/stats với nhiều link hợp lệ vẫn giới hạn 1024 ký tự trong từng ô', () => {
 const summary = {
  totalPlays: 10, totalListenMs: 60000,
  topTracks: Array.from({ length: 8 }, (_, idx) => ({
   title: 'Tên bài hát nhiều ký tự '.repeat(4),
   url: `https://soundcloud.com/a/${'x'.repeat(70)}${idx}`, plays: 2,
  })),
  topDjs: Array.from({ length: 5 }, (_, idx) => ({ userId: `12345678901234567${idx}`, plays: 5, listenMs: 30000 })),
 };
 const json = buildStatsEmbed(summary).toJSON();
 assert.ok(json.fields.every(field => field.value.length <= 1024));
});
