import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 cleanYouTubeMetadata,
 extractYouTubePlaylistId,
 extractYouTubeVideoId,
 parseSeekTime,
 pickBestMatchingTrack,
 resolveConfig,
 resolveMusicQuery,
 resolveMusicRequest,
 resolveYouTubeCollection,
 validateQuery,
} from '../src/policy.js';
import { buildHelpEmbed, commands, contextCommands, slashCommands } from '../src/commands.js';

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

test('resolveMusicRequest preserves exact YouTube URLs & youtubeMeta for native YouTube playback without SoundCloud remapping', async () => {
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
 assert.equal(resolved.query, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
 assert.equal(resolved.youtubeMeta?.videoId, 'dQw4w9WgXcQ');
 assert.equal(resolved.youtubeMeta?.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
 assert.equal(resolved.youtubeMeta?.source, 'youtube');
 assert.equal(resolved.youtubeMeta?.title, 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)');
 assert.equal(resolved.youtubeMeta?.cleanTitle, 'Never Gonna Give You Up');
 assert.equal(resolved.youtubeMeta?.artist, 'Rick Astley');
 assert.equal(resolved.youtubeMeta?.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
 assert.equal(resolved.spotifyMeta, null);
});

test('resolveMusicRequest resolves native YouTube Playlists (PL...), YouTube Mixes (RD...), starting video rotation & private WL fallback', async () => {
 assert.equal(
  validateQuery('https://m.youtube.com/playlist?list=PLHNNYen-Kcf6XW_30sNPqDtW04cHd8bM2&si=abc'),
  'https://www.youtube.com/playlist?list=PLHNNYen-Kcf6XW_30sNPqDtW04cHd8bM2',
 );
 assert.equal(
  validateQuery('https://www.youtube.com/watch?v=xypzmu5mMPY&list=RDxypzmu5mMPY&start_radio=1&pp=abc'),
  'https://www.youtube.com/watch?v=xypzmu5mMPY&list=RDxypzmu5mMPY',
 );
 // watch?v=...&list=WL (Xem sau riêng tư) tự động lột bỏ list=WL để phát bài lẻ bình thường
 assert.equal(
  validateQuery('https://www.youtube.com/watch?v=xypzmu5mMPY&list=WL&index=3'),
  'https://www.youtube.com/watch?v=xypzmu5mMPY',
 );
 assert.equal(extractYouTubePlaylistId('https://music.youtube.com/playlist?list=OLAK5uy_AbCdEf12345'), 'OLAK5uy_AbCdEf12345');

 const mockPlaylistFetch = async (url, init) => {
  assert.ok(String(url).includes('/youtubei/v1/next'));
  assert.ok(init?.headers?.['X-Goog-FieldMask']);
  const reqBody = JSON.parse(init.body);
  assert.equal(reqBody.playlistId, 'PLHNNYen-Kcf6XW_30sNPqDtW04cHd8bM2');
  assert.equal(reqBody.videoId, 'Llw9Q6akRo4');
  return {
   ok: true,
   json: async () => ({
    contents: {
     twoColumnWatchNextResults: {
      playlist: {
       playlist: {
        title: 'List nhạc Sơn Tùng M-TP',
        totalVideos: 3,
        contents: [
         {
          playlistPanelVideoRenderer: {
           videoId: 'FN7ALfpGxiI',
           title: { simpleText: 'NƠI NÀY CÓ ANH | OFFICIAL MUSIC VIDEO | SƠN TÙNG M-TP' },
           shortBylineText: { runs: [{ text: 'Sơn Tùng M-TP Official' }] },
           lengthText: { simpleText: '4:39' },
          },
         },
         {
          playlistPanelVideoRenderer: {
           videoId: 'dead123',
           title: { simpleText: '[Deleted video]' },
          },
         },
         {
          playlistPanelVideoRenderer: {
           videoId: 'Llw9Q6akRo4',
           selected: true,
           title: { simpleText: 'LẠC TRÔI | OFFICIAL MUSIC VIDEO | SƠN TÙNG M-TP' },
           shortBylineText: { runs: [{ text: 'Sơn Tùng M-TP Official' }] },
           lengthText: { simpleText: '4:33' },
          },
         },
        ],
       },
      },
     },
    },
   }),
  };
 };

 const resolvedPl = await resolveMusicRequest(
  'https://www.youtube.com/watch?v=Llw9Q6akRo4&list=PLHNNYen-Kcf6XW_30sNPqDtW04cHd8bM2',
  mockPlaylistFetch,
 );
 assert.equal(resolvedPl.youtubeCollection?.kind, 'youtube_playlist');
 assert.equal(resolvedPl.youtubeCollection?.name, 'List nhạc Sơn Tùng M-TP');
 assert.equal(resolvedPl.youtubeCollection?.items.length, 2, 'Deleted videos should be skipped cleanly');
 assert.equal(resolvedPl.spotifyCollection, null, 'YouTube playlists must NOT be routed via Spotify->SoundCloud search');
 // Bài đang chọn trong URL (Lạc Trôi) phải được xoay lên vị trí đầu tiên (#0) và giữ nguyên URL YouTube gốc!
 assert.equal(resolvedPl.youtubeCollection?.items[0].videoId, 'Llw9Q6akRo4');
 assert.equal(resolvedPl.youtubeCollection?.items[0].url, 'https://www.youtube.com/watch?v=Llw9Q6akRo4');
 assert.equal(resolvedPl.youtubeCollection?.items[0].source, 'youtube');
 assert.equal(resolvedPl.youtubeCollection?.items[0].cleanTitle, 'LẠC TRÔI');
 assert.equal(resolvedPl.youtubeCollection?.items[0].artist, 'Sơn Tùng M-TP');
 assert.equal(resolvedPl.youtubeCollection?.items[0].durationMs, 273_000);
 assert.equal(resolvedPl.youtubeCollection?.items[1].videoId, 'FN7ALfpGxiI');
 assert.equal(resolvedPl.youtubeCollection?.items[1].url, 'https://www.youtube.com/watch?v=FN7ALfpGxiI');

 // Nếu oEmbed bị tắt (401) trên bài lẻ -> tự động nhảy sang dự phòng JSON /next siêu nhẹ (715 byte)
 const mockEmbedDisabledFetch = async url => {
  if (String(url).includes('/oembed')) return { ok: false, status: 401 };
  return {
   ok: true,
   json: async () => ({
    contents: {
     twoColumnWatchNextResults: {
      results: {
       results: {
        contents: [
         { videoPrimaryInfoRenderer: { title: { runs: [{ text: 'CHÚNG TA CỦA TƯƠNG LAI | SƠN TÙNG M-TP | OFFICIAL MV' }] } } },
         { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { title: { runs: [{ text: 'Sơn Tùng M-TP Official' }] } } } } },
        ],
       },
      },
     },
    },
   }),
  };
 };
 const fallbackSingle = await resolveMusicRequest('https://www.youtube.com/watch?v=abPmZCZZrFA', mockEmbedDisabledFetch);
 assert.equal(fallbackSingle.query, 'https://www.youtube.com/watch?v=abPmZCZZrFA');
 assert.equal(fallbackSingle.youtubeMeta?.videoId, 'abPmZCZZrFA');
 assert.equal(fallbackSingle.youtubeMeta?.cleanTitle, 'CHÚNG TA CỦA TƯƠNG LAI');
 assert.equal(fallbackSingle.youtubeMeta?.artist, 'Sơn Tùng M-TP');
 assert.ok(resolveYouTubeCollection);
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

test('unique guild-only commands (46 slash + 3 context menu) and valid help embed covering all 46 slash commands', () => {
 assert.equal(slashCommands.length, 46);
 assert.equal(contextCommands.length, 3);
 assert.equal(commands.length, 49);
 assert.equal(new Set(commands.map(c => c.name)).size, 49);
 assert.ok(commands.every(c => c.dm_permission === false));
 const data = buildHelpEmbed({ username: 'Bắt_Don', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }).toJSON();
 assert.equal(data.color, 0x5865f2);
 assert.equal(data.fields.length, 6);
 assert.ok(data.fields.every(f => f.name.length <= 256 && f.value.length <= 1024));
 const allValues = data.fields.map(f => f.value).join('\n');
 for (const c of slashCommands) assert.ok(allValues.includes(`\`/${c.name}\``), `missing /${c.name} in help embed`);
});

test('new music command options are bounded', () => {
 const option = name => commands.find(c => c.name === name).options[0];
 assert.deepEqual(option('247').choices.map(c => c.value), ['on', 'off']);
 assert.deepEqual(option('autoplay').choices.map(c => c.value), ['on', 'off']);
 assert.deepEqual(option('loop').choices.map(c => c.value), ['off', 'track', 'queue']);
 assert.equal(option('volume').min_value, 0);
 assert.equal(option('volume').max_value, 200);
 assert.equal(option('remove').min_value, 1);
 assert.equal(option('remove').max_value, 50);
 assert.equal(option('move').min_value, 1);
 assert.equal(option('move').max_value, 50);
 assert.equal(option('play').max_length, 400);
 assert.equal(option('tts').max_length, 500);
});

test('YouTube RDMM personal mix rewrites to RD<videoId> & unwraps playlistPanelVideoWrapperRenderer with startIndex', async () => {
 let capturedBody = null;
 const mockFetch = async (_url, init) => {
  capturedBody = JSON.parse(init.body);
  return {
   ok: true,
   json: async () => ({
    contents: {
     twoColumnWatchNextResults: {
      playlist: {
       playlist: {
        title: 'Danh sách kết hợp – Hãy Cho Tôi - Kejo',
        totalVideos: 2,
        contents: [
         {
          playlistPanelVideoRenderer: {
           videoId: '7h9ST6bd-5w',
           selected: true,
           title: { simpleText: 'Hãy Cho Tôi - Kejo aka Lil Luyến (Reup)' },
           shortBylineText: { runs: [{ text: 'Trần Gia Huy' }] },
           lengthText: { simpleText: '3:29' },
          },
         },
         {
          playlistPanelVideoWrapperRenderer: {
           primaryRenderer: {
            playlistPanelVideoRenderer: {
             videoId: 'TOfE7nlF7vc',
             selected: false,
             title: { simpleText: 'Thiên Thần Đang Dẫm - Kejo aka Lil Luyến (Reup)' },
             shortBylineText: { runs: [{ text: 'Trần Gia Huy' }] },
             lengthText: { simpleText: '3:16' },
            },
           },
          },
         },
        ],
       },
      },
     },
    },
   }),
  };
 };

 const res = await resolveMusicRequest(
  'https://www.youtube.com/watch?v=7h9ST6bd-5w&list=RDMM&index=4',
  mockFetch,
 );
 assert.equal(capturedBody.playlistId, 'RD7h9ST6bd-5w');
 assert.equal(capturedBody.videoId, '7h9ST6bd-5w');
 assert.equal(capturedBody.index, 3);
 assert.equal(res.youtubeCollection?.items?.length, 2);
 assert.equal(res.youtubeCollection.items[0].videoId, '7h9ST6bd-5w');
 assert.equal(res.youtubeCollection.items[1].videoId, 'TOfE7nlF7vc');
 assert.equal(res.youtubeCollection.items[1].source, 'youtube');
});

