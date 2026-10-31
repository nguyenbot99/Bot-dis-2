import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InteractionContextType } from 'discord.js';
import ffmpegPath from 'ffmpeg-static';
import { assertMusicAccess } from '../src/access.js';
import { commands, CONTEXT_GIF_NAME, dmCommands } from '../src/commands.js';
import {
 assertSafePublicUrl,
 buildGifActionComponents,
 buildGifTuneModal,
 buildMemeAssConfig,
 computeScaledDimensions,
 createVideoToGifManager,
 extractVideoFromMessage,
 formatGifSummaryLine,
 isBlockedIpAddress,
 normalizeCandidateVideoUrl,
 normalizeGifOptions,
 parseFfmpegProbeOutput,
 parseGifTimestamp,
 parseGifTimingRange,
 parseQualityAndFpsInput,
 resolveExactGifFps,
} from '../src/videoToGif.js';

test('Video-to-GIF Discord command schemas obey strict Guild & BotDM constraints', () => {
 const guildGif = commands.find(c => c.name === 'gif');
 assert.ok(guildGif, 'Guild /gif must exist');
 assert.equal(guildGif.dm_permission, false);
 assert.ok(guildGif.description.length <= 100);
 for (const opt of guildGif.options ?? []) {
  assert.ok(opt.name.length <= 32);
  assert.ok(opt.description.length <= 100, `Option ${opt.name} description > 100 chars`);
  for (const ch of opt.choices ?? []) {
   assert.ok(ch.name.length <= 100, `Choice ${ch.name} > 100 chars`);
  }
 }

 const guildCtxGif = commands.find(c => c.name === CONTEXT_GIF_NAME);
 assert.ok(guildCtxGif, 'Guild Context Menu GIF command must exist');
 assert.equal(guildCtxGif.type, 3); // ApplicationCommandType.Message

 const dmGif = dmCommands.find(c => c.name === 'gif');
 const dmCtxGif = dmCommands.find(c => c.name === CONTEXT_GIF_NAME);
 assert.ok(dmGif, 'BotDM /gif must exist');
 assert.ok(dmCtxGif, 'BotDM Context Menu GIF command must exist');
 assert.deepEqual(dmGif.contexts, [InteractionContextType.BotDM]);
 assert.deepEqual(dmCtxGif.contexts, [InteractionContextType.BotDM]);
 assert.equal(dmGif.integration_types, undefined);
 assert.equal(dmCtxGif.integration_types, undefined);
 assert.equal(dmGif.options.some(o => o.name === 'private'), false);

 // /gif mở cho mọi thành viên trong server kể cả khi người khác đang phát nhạc
 assert.doesNotThrow(() => {
  assertMusicAccess('gif', '999999999999999999', {
   queue: { currentTrack: { requestedBy: '111111111111111111' } },
   userdata: { ownerId: '111111111111111111' },
  });
 });
});

test('SSRF protection blocks private/loopback/link-local IPv4 & IPv6 including hex IPv4-mapped IPv6', async () => {
 for (const blocked of [
  '127.0.0.1',
  '0.0.0.0',
  '10.0.0.5',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.10',
  '169.254.169.254',
  '100.64.1.2',
  '::1',
  '::',
  'fe80::1',
  'fd12:3456::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:a9fe:a9fe',
 ]) {
  assert.equal(isBlockedIpAddress(blocked), true, `Expected ${blocked} to be blocked`);
 }

 for (const allowed of ['162.159.130.233', '8.8.8.8', '2606:4700:4700::1111']) {
  assert.equal(isBlockedIpAddress(allowed), false, `Expected ${allowed} to be allowed`);
 }

 await assert.rejects(() => assertSafePublicUrl('http://127.0.0.1:3000/video.mp4'), /nội bộ/);
 await assert.rejects(() => assertSafePublicUrl('http://[::ffff:127.0.0.1]/video.mp4'), /nội bộ/);
 await assert.rejects(() => assertSafePublicUrl('file:///etc/passwd'), /http/);
 await assert.rejects(
  () => assertSafePublicUrl('https://evil.example/clip.mp4', async () => [{ address: '192.168.1.99', family: 4 }]),
  /nội bộ/,
 );

 const validUrl = await assertSafePublicUrl(
  'https://i.imgur.com/AbCdEf9.gifv',
  async () => [{ address: '151.101.1.193', family: 4 }],
 );
 assert.equal(validUrl, 'https://i.imgur.com/AbCdEf9.mp4');
 assert.equal(normalizeCandidateVideoUrl('<https://cdn.discordapp.com/attachments/1/2/clip.mp4>'), 'https://cdn.discordapp.com/attachments/1/2/clip.mp4');
});

test('Timestamp, timing range, option normalization, message video extraction & Modal limits', () => {
 assert.equal(parseGifTimestamp(''), 0);
 assert.equal(parseGifTimestamp('4.5s'), 4.5);
 assert.equal(parseGifTimestamp('01:15'), 75);
 assert.equal(parseGifTimestamp('1:02:03.5'), 3723.5);
 assert.throws(() => parseGifTimestamp('abc'), /Thời gian bắt đầu không hợp lệ/);

 assert.deepEqual(parseGifTimingRange('01:10 - 5'), { startSec: 70, durationSec: 5 });
 assert.deepEqual(parseGifTimingRange('3.5', 0, 6), { startSec: 3.5, durationSec: 6 });

 // Quay chậm 0.25x trên đoạn 15s tự động giới hạn lại để không vượt 16s đầu ra
 const slowOpts = normalizeGifOptions({ duration: 15, speed: 0.25, caption: 'Đỉnh nóc | Kịch trần' });
 assert.equal(slowOpts.durationSec, 4);
 assert.equal(slowOpts.cappedBySlowMo, true);

 // Bóc video từ cả tin nhắn thường, embed video (Tenor) lẫn tin nhắn Chuyển tiếp (messageSnapshots)
 const fromForward = extractVideoFromMessage({
  content: '',
  attachments: new Map(),
  embeds: [],
  messageSnapshots: new Map([
   ['snap1', {
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/funny.mov', contentType: 'video/quicktime', size: 1024 }],
   }],
  ]),
 });
 assert.equal(fromForward.url, 'https://cdn.discordapp.com/attachments/1/2/funny.mov');

 const fromEmbed = extractVideoFromMessage({
  content: 'https://tenor.com/view/cat-123',
  embeds: [{ video: { url: 'https://media.tenor.com/abc/cat.mp4' } }],
 });
 assert.equal(fromEmbed.url, 'https://media.tenor.com/abc/cat.mp4');

 const probeRotated = parseFfmpegProbeOutput(
  '  Duration: 00:00:08.40, start: 0.000000\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n  displaymatrix: rotation of -90.00 degrees',
 );
 assert.equal(probeRotated.hasVideo, true);
 assert.equal(probeRotated.width, 1080);
 assert.equal(probeRotated.height, 1920);
 assert.equal(probeRotated.durationSec, 8.4);

 const scaled = computeScaledDimensions(1080, 1920, { maxWidth: 380, maxHeight: 460 });
 assert.equal(scaled.width % 2, 0);
 assert.equal(scaled.height, 460);

 const assCfg = buildMemeAssConfig({
  width: 380,
  height: 214,
  caption: 'Khi bạn phát hiện Bot đổi GIF | Đỉnh nóc kịch trần!',
  captionStyle: 'bar',
 });
 assert.ok(assCfg.padTop > 0);
 assert.ok(assCfg.assContent.includes('MemeBar'));
 assert.ok(assCfg.assContent.includes('MemeSub'));

 const modalJson = buildGifTuneModal('abc123', {
  startSec: 1,
  durationSec: 5,
  speed: 1.5,
  caption: 'Xin chào',
  captionStyle: 'bar',
  quality: 'ultra',
  fps: 50,
 }).toJSON();
 assert.ok(modalJson.title.length <= 45);
 assert.equal(modalJson.components.length, 5);
 for (const row of modalJson.components) {
  const input = row.components[0];
  assert.ok(input.label.length <= 45, `Modal label too long: ${input.label}`);
  assert.ok((input.placeholder ?? '').length <= 100);
 }

 assert.deepEqual(parseQualityAndFpsInput('ultra 50'), { quality: 'ultra', fps: 50 });
 assert.deepEqual(parseQualityAndFpsInput('720p 30fps'), { quality: 'ultra', fps: 33 });
 assert.equal(resolveExactGifFps(50).fpsExpr, '50');
 assert.equal(resolveExactGifFps(30).fpsExpr, '100/3');

 const comps = buildGifActionComponents({ token: 'abc123', requesterId: '1243061570247069696' });
 assert.equal(comps.length, 1);
 assert.equal(comps[0].components.length, 3);
});

test('End-to-end FFmpeg two-pass 720p Ultra & 50 FPS Video-to-GIF conversion with Vietnamese Meme caption, HTML og:video hop, concurrency queue & /tmp cleanup', async () => {
 const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-test-src-'));
 const sampleMp4Path = path.join(fixtureDir, 'sample.mp4');
 try {
  execFileSync(ffmpegPath, [
   '-y',
   '-f', 'lavfi',
   '-i', 'testsrc=duration=1.6:size=1280x720:rate=50',
   '-c:v', 'libx264',
   '-pix_fmt', 'yuv420p',
   sampleMp4Path,
  ], { stdio: 'ignore' });
  const mp4Bytes = fs.readFileSync(sampleMp4Path);

  const mockFetch = async url => {
   if (String(url).includes('/share-page')) {
    const html = '<html><head><meta property="og:video" content="https://cdn.example.com/real-clip.mp4"></head></html>';
    return new Response(html, {
     status: 200,
     headers: { 'content-type': 'text/html; charset=utf-8' },
    });
   }
   return new Response(mp4Bytes, {
    status: 200,
    headers: {
     'content-type': 'video/mp4',
     'content-length': String(mp4Bytes.length),
    },
   });
  };
  const mockLookup = async () => [{ address: '162.159.130.233', family: 4 }];

  const gifMgr = createVideoToGifManager({
   ffmpegPath,
   lookupFn: mockLookup,
   fetchFn: mockFetch,
  });

  // Chạy đồng thời 2 yêu cầu:
  // - res1: 720p Ultra + 50 FPS kịch trần chuẩn GIF + chữ Meme Tiếng Việt
  // - res2: để mặc định trên clip ngắn <=4s -> tự kích lên 720p Ultra • 33 FPS!
  let queuedCalled = false;
  const [res1, res2] = await Promise.all([
   gifMgr.convertVideoToGif({
    sourceUrl: 'https://cdn.example.com/share-page',
    requesterId: '111111111111111111',
    options: {
     start: '0.1',
     duration: 1.0,
     speed: 1.0,
     caption: 'Khi Bot Discord đổi GIF | Nét căng 720p • 50 FPS!',
     captionStyle: 'bar',
     quality: 'ultra',
     fps: 50,
    },
   }),
   gifMgr.convertVideoToGif({
    sourceUrl: 'https://cdn.example.com/real-clip.mp4',
    requesterId: '222222222222222222',
    options: { duration: 1.0 },
    onQueued: async pos => {
     if (pos >= 1) queuedCalled = true;
    },
   }),
  ]);

  assert.equal(queuedCalled, true, 'Second concurrent job should wait in FIFO queue');
  assert.equal(res1.gifBuffer.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(res2.gifBuffer.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(res1.meta.width, 720);
  assert.equal(res1.meta.fps, 50);
  assert.ok(res1.meta.height > 404, 'Meme white top bar should increase 720p GIF height');
  assert.equal(res2.meta.width, 720, 'Short <=4s clip without explicit quality auto-promotes to 720p Ultra');
  assert.equal(res2.meta.fps, 33);
  assert.ok(formatGifSummaryLine(res1.meta).includes('720×'));
  assert.ok(gifMgr.getTuneSession(res1.session.token));

  // Đảm bảo không còn thư mục tạm batdon-gif-* nào sót lại trên /tmp sau khi kết xuất xong
  const leftover = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('batdon-gif-') && n !== 'batdon-gif-fonts');
  assert.deepEqual(leftover, []);
 } finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
 }
});
