import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 cleanYouTubeMetadata,
 extractYouTubeVideoId,
 parseSeekTime,
 pickBestMatchingTrack,
 resolveConfig,
 resolveMusicQuery,
 resolveMusicRequest,
 validateQuery,
} from '../src/policy.js';
import { buildHelpEmbed, commands } from '../src/commands.js';

test('valid search, SoundCloud/Spotify normalization, and mobile share text extraction', () => {
 assert.equal(validateQuery(' hello '), 'hello');
 assert.equal(validateQuery('https://youtu.be/abc'), 'https://youtu.be/abc');
 assert.equal(validateQuery('https://m.youtube.com/watch?v=abc&si=xyz'), 'https://www.youtube.com/watch?v=abc');
 assert.equal(
  validateQuery('https://www.soundcloud.com/lostskydiary/tule-fearless-2/?in=a/sets/b&si=123&utm_source=clipboard'),
  'https://soundcloud.com/lostskydiary/tule-fearless-2',
 );
 assert.equal(
  validateQuery('https://open.spotify.com/intl-vi/track/4cOdK2wGLETKBW3PvgPWqT?si=12345'),
  'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
 );
 assert.equal(
  validateQuery('https://open.spotify.com/intl-vi/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abcd'),
  'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
 );
 assert.equal(
  validateQuery('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=xyz'),
  'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
 );
 assert.equal(
  validateQuery('https://m.soundcloud.com/a/sets/b/?si=123'),
  'https://soundcloud.com/a/sets/b',
 );
 assert.equal(
  validateQuery('Nghe nhạc trên #SoundCloud https://m.soundcloud.com/lostskydiary/tule-fearless-2/?si=abc'),
  'https://soundcloud.com/lostskydiary/tule-fearless-2',
 );
});

test('resolveMusicQuery expands on.soundcloud.com & Spotify track links safely and rejects unsafe targets', async () => {
 const fakeFetch302 = async () => ({
  headers: new Map([['location', 'https://m.soundcloud.com/lostskydiary/tule-fearless-2/?si=xyz&utm_medium=text']]),
  body: { cancel: async () => {} },
 });
 const expanded = await resolveMusicQuery('https://on.soundcloud.com/AbCdEf/', fakeFetch302);
 assert.equal(expanded, 'https://soundcloud.com/lostskydiary/tule-fearless-2');

 const fakeSpotifyFetch = async () => ({
  headers: new Map([['location', 'https://open.spotify.com/intl-vi/track/4cOdK2wGLETKBW3PvgPWqT?si=xyz']]),
  body: { cancel: async () => {} },
 });
 const spotifyQuery = await resolveMusicQuery(
  'https://spotify.link/AbCdEf',
  fakeSpotifyFetch,
  async () => ({ title: 'Nơi Này Có Anh', artist: 'Sơn Tùng M-TP' }),
 );
 assert.equal(spotifyQuery, 'Nơi Này Có Anh - Sơn Tùng M-TP');

 const fakeFetchEvil = async () => ({
  headers: new Map([['location', 'http://127.0.0.1/internal']]),
  body: { cancel: async () => {} },
 });
 await assert.rejects(() => resolveMusicQuery('https://on.soundcloud.com/AbCdEf', fakeFetchEvil), /Chỉ nhận URL HTTPS/);
});

test('parseSeekTime parses seconds and mm:ss / hh:mm:ss cleanly', () => {
 assert.equal(parseSeekTime('90'), 90000);
 assert.equal(parseSeekTime('1:30'), 90000);
 assert.equal(parseSeekTime('01:02:03'), 3723000);
 assert.throws(() => parseSeekTime('1:75'), /nhỏ hơn 60/);
 assert.throws(() => parseSeekTime('abc'), /không hợp lệ/);
});

test('pickBestMatchingTrack prefers exact 4:21 audio over 6-minute MV or slowed remix', () => {
 const candidates = [
  { id: 'mv', title: 'Nơi Này Có Anh (Slowed + Reverb)', duration: 365000, metadata: { author: 'Channel A' } },
  { id: 'cover', title: 'Branime Studios - Nơi Này Có Anh (Cover)', duration: 260000, metadata: { author: 'Ruan Elias' } },
  { id: 'orig', title: 'Sơn Tùng M-TP - Nơi Này Có Anh (Official Audio)', duration: 261000, metadata: { author: 'Sơn Tùng M-TP - Topic' } },
  { id: 'hour', title: 'Nơi Này Có Anh 1 Hour Loop', duration: 3600000, metadata: { author: 'Loop' } },
 ];
 const best = pickBestMatchingTrack(candidates, {
  title: 'Nơi Này Có Anh',
  artist: 'Sơn Tùng M-TP',
  durationMs: 261000,
 });
 assert.equal(best.id, 'orig');

 // Nhưng nếu người dùng chủ động gõ từ khóa "cover", vẫn cho phép chọn bản cover.
 const wantCover = pickBestMatchingTrack(candidates, { title: 'Nơi Này Có Anh cover' });
 assert.equal(wantCover.id, 'cover');
});

test('resolveMusicRequest resolves YouTube links via lightweight oEmbed without JSDOM', async () => {
 assert.equal(extractYouTubeVideoId('https://www.youtube.com/shorts/FN7ALfpGxiI?feature=share'), 'FN7ALfpGxiI');
 assert.throws(() => validateQuery('https://www.youtube.com/live/FN7ALfpGxiI'), /livestream/);

 const cleaned = cleanYouTubeMetadata(
  'NƠI NÀY CÓ ANH | OFFICIAL MUSIC VIDEO | SƠN TÙNG M-TP',
  'Sơn Tùng M-TP Official',
 );
 assert.deepEqual(cleaned, { title: 'NƠI NÀY CÓ ANH', artist: 'Sơn Tùng M-TP' });

 const fakeOembedFetch = async url => {
  assert.ok(String(url).startsWith('https://www.youtube.com/oembed?url='));
  return {
   ok: true,
   json: async () => ({
    title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
    author_name: 'Rick Astley',
    thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
   }),
  };
 };
 const resolved = await resolveMusicRequest('https://youtu.be/dQw4w9WgXcQ?si=123', fakeOembedFetch);
 assert.equal(resolved.query, 'Never Gonna Give You Up Rick Astley');
 assert.equal(resolved.spotifyMeta?.title, 'Never Gonna Give You Up');
 assert.equal(resolved.spotifyMeta?.artist, 'Rick Astley');
 assert.equal(resolved.spotifyMeta?.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
});

test('reject dangerous URLs and unsupported collections', () => {
 for (const q of [
  'http://127.0.0.1',
  'file:///etc/passwd',
  'https://youtube.com.evil.org/x',
  'https://youtube.com/playlist?list=x',
  'https://open.spotify.com/artist/37i9dQZF1DXcBWIGoYBM5M',
  'https://open.spotify.com/episode/123456',
  'https://soundcloud.com/only-profile',
  '',
  'x'.repeat(401),
 ]) {
  assert.throws(() => validateQuery(q));
 }
});

test('resolveConfig works with DISCORD_TOKEN only and optional GUILD_ID', () => {
 assert.deepEqual(resolveConfig({ DISCORD_TOKEN: ' "abc.def" ' }), { token: 'abc.def', guildId: null, autoRegister: true });
 assert.deepEqual(resolveConfig({ BOT_TOKEN: 'xyz', GUILD_ID: '123456789012345678', AUTO_REGISTER: 'false' }), { token: 'xyz', guildId: '123456789012345678', autoRegister: false });
 assert.throws(() => resolveConfig({}), /Thiếu DISCORD_TOKEN/);
 assert.throws(() => resolveConfig({ DISCORD_TOKEN: 'abc', GUILD_ID: 'ten-server' }), /GUILD_ID không hợp lệ/);
});

test('unique guild-only commands and valid help embed covering all 32 commands', () => {
 assert.equal(new Set(commands.map(c => c.name)).size, 32);
 assert.ok(commands.every(c => c.dm_permission === false));
 const data = buildHelpEmbed({ username: 'Bắt_Don', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }).toJSON();
 assert.equal(data.color, 0x5865f2);
 assert.equal(data.fields.length, 6);
 assert.ok(data.fields.every(f => f.name.length <= 256 && f.value.length <= 1024));
 const allValues = data.fields.map(f => f.value).join('\n');
 for (const c of commands) assert.ok(allValues.includes(`\`/${c.name}\``), `missing /${c.name} in help embed`);
});

test('new music command options are bounded', () => {
 const option = name => commands.find(c => c.name === name).options[0];
 assert.deepEqual(option('247').choices.map(c => c.value), ['on', 'off']);
 assert.deepEqual(option('autoplay').choices.map(c => c.value), ['on', 'off']);
 assert.deepEqual(option('loop').choices.map(c => c.value), ['off', 'track', 'queue']);
 assert.equal(option('volume').min_value, 0);
 assert.equal(option('volume').max_value, 200);
 assert.equal(option('remove').min_value, 1);
 assert.equal(option('remove').max_value, 20);
 assert.equal(option('move').min_value, 1);
 assert.equal(option('move').max_value, 20);
 assert.equal(option('play').max_length, 400);
 assert.equal(option('tts').max_length, 500);
});
