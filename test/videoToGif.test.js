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
 BOOSTED_DISCORD_GIF_BYTES,
 buildGifActionComponents,
 buildGifTuneModal,
 buildMemeAssConfig,
 buildRenderCandidates,
 computeScaledDimensions,
 createVideoToGifManager,
 extractVideoFromMessage,
 formatGifSummaryLine,
 isBlockedIpAddress,
 MAX_DISCORD_GIF_BYTES,
 normalizeCandidateVideoUrl,
 normalizeGifOptions,
 parseFfmpegProbeOutput,
 parseGifTimestamp,
 parseGifTimingRange,
 parseQualityAndFpsInput,
 resolveExactGifFps,
 resolveSourceMaxFps,
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
 const qualityOpt = guildGif.options.find(o => o.name === 'quality');
 assert.equal(qualityOpt.choices[0].value, 'auto', 'First quality choice should be Auto-Max');

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

test('Auto-detect source resolution, FPS, cover-art stream skip, and Smart Budget Planner', () => {
 assert.equal(parseGifTimestamp(''), 0);
 assert.equal(parseGifTimestamp('4.5s'), 4.5);
 assert.equal(parseGifTimestamp('01:15'), 75);
 assert.equal(parseGifTimestamp('1:02:03.5'), 3723.5);
 assert.throws(() => parseGifTimestamp('abc'), /Thời gian bắt đầu không hợp lệ/);

 assert.deepEqual(parseGifTimingRange('01:10 - 5'), { startSec: 70, durationSec: 5 });
 assert.deepEqual(parseGifTimingRange('3.5', 0, 6), { startSec: 3.5, durationSec: 6 });

 // Mặc định normalizeGifOptions chọn chế độ 'auto' (Auto Max Độ Nét & Max FPS gốc)
 const defaultOpts = normalizeGifOptions({});
 assert.equal(defaultOpts.quality, 'auto');
 assert.equal(defaultOpts.fps, null);

 // Quay chậm 0.25x trên đoạn 15s tự động giới hạn lại để không vượt 16s đầu ra
 const slowOpts = normalizeGifOptions({ duration: 15, speed: 0.25, caption: 'Đỉnh nóc | Kịch trần' });
 assert.equal(slowOpts.durationSec, 4);
 assert.equal(slowOpts.cappedBySlowMo, true);

 // Bóc video từ tin nhắn Chuyển tiếp (messageSnapshots) & Embed
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

 // 1. Nhận diện video iPhone quay dọc 60fps có cờ xoay -90 độ
 const probeRotated = parseFfmpegProbeOutput(
  '  Duration: 00:00:08.40, start: 0.000000\n  Stream #0:0: Video: hevc, yuv420p10le, 1920x1080, 59.94 fps, 60 tbr\n    Side data:\n      displaymatrix: rotation of -90.00 degrees',
 );
 assert.equal(probeRotated.hasVideo, true);
 assert.equal(probeRotated.width, 1080);
 assert.equal(probeRotated.height, 1920);
 assert.equal(probeRotated.fps, 59.94);
 assert.equal(probeRotated.durationSec, 8.4);
 assert.equal(probeRotated.streamSpec, '0:0');

 // 2. Tự động bỏ qua ảnh bìa đính kèm `(attached pic)` để bắt đúng luồng video chuyển động thật!
 const probeWithCover = parseFfmpegProbeOutput([
  '  Duration: 00:00:05.20, start: 0.000000',
  '  Stream #0:0: Audio: aac, 44100 Hz, stereo',
  '  Stream #0:1: Video: png, rgb24, 600x600, 90k tbr (attached pic)',
  '  Stream #0:2: Video: h264, yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 29.97 fps, 30 tbr',
 ].join('\n'));
 assert.equal(probeWithCover.streamSpec, '0:2');
 assert.equal(probeWithCover.width, 1280);
 assert.equal(probeWithCover.height, 720);
 assert.equal(probeWithCover.fps, 29.97);

 // 3. Kiểm tra ánh xạ FPS gốc sang FPS tối đa chuẩn 1:1 của GIF89a
 assert.deepEqual(resolveSourceMaxFps(59.94, 1), { fpsExpr: '50', fpsLabel: 50 });
 assert.deepEqual(resolveSourceMaxFps(50, 1), { fpsExpr: '50', fpsLabel: 50 });
 assert.deepEqual(resolveSourceMaxFps(29.97, 1), { fpsExpr: '30', fpsLabel: 30 });
 assert.deepEqual(resolveSourceMaxFps(25, 1), { fpsExpr: '25', fpsLabel: 25 });
 assert.deepEqual(resolveSourceMaxFps(23.98, 1), { fpsExpr: '24', fpsLabel: 24 });
 assert.deepEqual(resolveSourceMaxFps(25, 2.0), { fpsExpr: '50', fpsLabel: 50 });

 // 4. Video 640x360 @ 24fps ở chế độ Auto không bao giờ phóng đại vượt 640x360 hay nhân bản >24fps
 const planSmall = buildRenderCandidates({
  probe: { width: 640, height: 360, fps: 24 },
  opts: normalizeGifOptions({ duration: 4 }),
  uploadCap: MAX_DISCORD_GIF_BYTES,
 });
 assert.equal(planSmall.candidates[0].width, 640);
 assert.equal(planSmall.candidates[0].height, 360);
 assert.equal(planSmall.candidates[0].fpsLabel, 24);
 assert.equal(planSmall.skippedForBudget, 0);

 // 5. Video dài 10s ở 1080p@60fps: trên server thường (9.75MB) tự nhảy qua bậc quá trần để xuất nhanh 1 lượt,
 // còn trên Server Boost Cấp 2/3 (35MB) giữ trọn 1920x1080 @ 50 FPS!
 const longProbe = { width: 1920, height: 1080, fps: 60 };
 const longOpts = normalizeGifOptions({ duration: 10 });
 const planStd = buildRenderCandidates({ probe: longProbe, opts: longOpts, uploadCap: MAX_DISCORD_GIF_BYTES });
 const planBoost = buildRenderCandidates({ probe: longProbe, opts: longOpts, uploadCap: BOOSTED_DISCORD_GIF_BYTES });
 assert.ok(planStd.skippedForBudget > 0, 'Standard 9.75MB cap should skip guaranteed-oversize 10s 1080p@50fps');
 assert.equal(planBoost.candidates[0].width, 1920);
 assert.equal(planBoost.candidates[0].fpsLabel, 50);

 const scaledPortraitFhd = computeScaledDimensions(1080, 1920, { maxLongSide: 1920, maxShortSide: 1080 });
 assert.equal(scaledPortraitFhd.width, 1080);
 assert.equal(scaledPortraitFhd.height, 1920);
 const scaledLandscape720 = computeScaledDimensions(1920, 1080, { maxLongSide: 1280, maxShortSide: 720 });
 assert.equal(scaledLandscape720.width, 1280);
 assert.equal(scaledLandscape720.height, 720);

 const assCfg = buildMemeAssConfig({
  width: 1920,
  height: 1080,
  caption: 'Khi bạn phát hiện Bot đổi GIF | Đỉnh nóc kịch trần!',
  captionStyle: 'bar',
 });
 assert.ok(assCfg.padTop > 120);
 assert.ok(assCfg.assContent.includes('MemeBar'));
 assert.ok(assCfg.assContent.includes('MemeSub'));

 const modalJson = buildGifTuneModal('abc123', {
  startSec: 1,
  durationSec: 5,
  speed: 1.5,
  caption: 'Xin chào',
  captionStyle: 'bar',
  quality: 'auto',
  fps: null,
 }).toJSON();
 assert.ok(modalJson.title.length <= 45);
 assert.equal(modalJson.components.length, 5);
 for (const row of modalJson.components) {
  const input = row.components[0];
  assert.ok(input.label.length <= 45, `Modal label too long: ${input.label}`);
  assert.ok((input.placeholder ?? '').length <= 100);
 }

 assert.deepEqual(parseQualityAndFpsInput('auto', 'hd', 25), { quality: 'auto', fps: null });
 assert.deepEqual(parseQualityAndFpsInput('fhd 50'), { quality: 'fhd', fps: 50 });
 assert.deepEqual(parseQualityAndFpsInput('1080p 33fps'), { quality: 'fhd', fps: 33 });
 assert.deepEqual(parseQualityAndFpsInput('720p 30fps'), { quality: 'ultra', fps: 33 });
 assert.equal(resolveExactGifFps(50).fpsExpr, '50');
 assert.equal(resolveExactGifFps(30).fpsExpr, '100/3');

 const comps = buildGifActionComponents({ token: 'abc123', requesterId: '1243061570247069696' });
 assert.equal(comps.length, 1);
 assert.equal(comps[0].components.length, 3);
});

test('End-to-end Ultra-Light Auto-Max FPS & Resolution + Multi-Stream Cover-Art Video-to-GIF', async () => {
 const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-test-src-'));
 const sample1080p50 = path.join(fixtureDir, 'sample1080p50.mp4');
 const coverPng = path.join(fixtureDir, 'cover.png');
 const multiStreamMp4 = path.join(fixtureDir, 'multistream_854x480_24fps.mp4');
 const diskTempDir = path.join(fixtureDir, 'ssd-gif-tmp');

 try {
  // Video 1: 1920x1080 @ 50 FPS
  execFileSync(ffmpegPath, [
   '-y',
   '-f', 'lavfi',
   '-i', 'testsrc=duration=1.1:size=1920x1080:rate=50',
   '-c:v', 'libx264',
   '-pix_fmt', 'yuv420p',
   sample1080p50,
  ], { stdio: 'ignore' });

  // Video 2: MP4 phức tạp giống thực tế TikTok/CapCut gồm Audio AAC + Ảnh bìa PNG (attached_pic) + Video 854x480 @ 24 FPS dài 1.6s!
  execFileSync(ffmpegPath, [
   '-y', '-f', 'lavfi', '-i', 'color=c=red:s=400x400', '-frames:v', '1', coverPng,
  ], { stdio: 'ignore' });
  execFileSync(ffmpegPath, [
   '-y',
   '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.6',
   '-i', coverPng,
   '-f', 'lavfi', '-i', 'testsrc2=duration=1.6:size=854x480:rate=24',
   '-map', '0:a', '-map', '1:v', '-map', '2:v',
   '-c:a', 'aac',
   '-c:v:0', 'png', '-disposition:v:0', 'attached_pic',
   '-c:v:1', 'libx264', '-pix_fmt', 'yuv420p',
   multiStreamMp4,
  ], { stdio: 'ignore' });

  const mp4Bytes1080 = fs.readFileSync(sample1080p50);
  const mp4BytesMulti = fs.readFileSync(multiStreamMp4);

  const mockFetch = async url => {
   const u = String(url);
   if (u.includes('/share-page')) {
    const html = '<html><head><meta property="og:video" content="https://cdn.example.com/1080p50.mp4"></head></html>';
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
   }
   if (u.includes('multistream')) {
    return new Response(mp4BytesMulti, {
     status: 200,
     headers: { 'content-type': 'video/mp4', 'content-length': String(mp4BytesMulti.length) },
    });
   }
   return new Response(mp4Bytes1080, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(mp4Bytes1080.length) },
   });
  };
  const mockLookup = async () => [{ address: '162.159.130.233', family: 4 }];

  const gifMgr = createVideoToGifManager({
   ffmpegPath,
   lookupFn: mockLookup,
   fetchFn: mockFetch,
   tempBaseDir: diskTempDir,
  });

  // Chạy đồng thời 3 yêu cầu để kiểm thử hàng đợi FIFO, Auto-Max 1080p@50FPS, chữ Meme Tiếng Việt và MP4 có ảnh bìa đính kèm!
  let queuedCalled = false;
  const [resMeme1080, resAuto1080, resMultiAuto] = await Promise.all([
   gifMgr.convertVideoToGif({
    sourceUrl: 'https://cdn.example.com/share-page',
    requesterId: '111111111111111111',
    options: {
     start: '0.1',
     duration: 0.6,
     speed: 1.0,
     caption: 'Full HD 1080p gốc | Tiếng Việt 100% ăâđêôơư!',
     captionStyle: 'bar',
     quality: 'fhd',
     fps: 25,
    },
   }),
   gifMgr.convertVideoToGif({
    sourceUrl: 'https://cdn.example.com/1080p50.mp4',
    requesterId: '222222222222222222',
    options: { duration: 0.7 }, // Không truyền quality & fps -> Tự nhận diện 1920x1080 @ 50 FPS tối đa!
    onQueued: async pos => {
     if (pos >= 1) queuedCalled = true;
    },
   }),
   gifMgr.convertVideoToGif({
    sourceUrl: 'https://cdn.example.com/multistream.mp4',
    requesterId: '333333333333333333',
    options: {}, // Không truyền duration/quality/fps -> Tự lấy trọn 1.6s ở đúng 854x480 @ 24 FPS gốc, không kẹt ảnh bìa!
   }),
  ]);

  assert.equal(queuedCalled, true, 'Concurrent jobs should wait cleanly in FIFO queue');
  assert.equal(resMeme1080.gifBuffer.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(resAuto1080.gifBuffer.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(resMultiAuto.gifBuffer.subarray(0, 6).toString('ascii'), 'GIF89a');

  // Kiểm tra kết quả Meme 1080p
  assert.equal(resMeme1080.meta.width, 1920);
  assert.equal(resMeme1080.meta.fps, 25);
  assert.ok(resMeme1080.meta.height > 1080, 'Meme white top bar should increase 1080p GIF height');

  // Kiểm tra chế độ Tự Động Tối Đa trên video 1920x1080 @ 50 FPS -> đúng 1920x1080 & 50 FPS gốc!
  assert.equal(resAuto1080.meta.width, 1920);
  assert.equal(resAuto1080.meta.height, 1080);
  assert.equal(resAuto1080.meta.fps, 50);
  assert.equal(resAuto1080.meta.isNativeMax, true);

  // Kiểm tra video nhiều stream có ảnh bìa (854x480 @ 24 FPS, 1.6s) -> đúng 854x480 & 24 FPS gốc!
  assert.equal(resMultiAuto.meta.width, 854);
  assert.equal(resMultiAuto.meta.height, 480);
  assert.equal(resMultiAuto.meta.fps, 24);
  assert.equal(resMultiAuto.meta.outputDurationSec, 1.6);
  assert.equal(resMultiAuto.meta.isNativeMax, true);

  assert.ok(formatGifSummaryLine(resAuto1080.meta).includes('1920×1080 • 50 FPS'));
  assert.ok(gifMgr.getTuneSession(resAuto1080.session.token));

  // Đảm bảo cả ổ SSD tạm lẫn /tmp đều được dọn sạch 100%, không sót file batdon-gif-*
  const leftoverDisk = fs.existsSync(diskTempDir)
   ? fs.readdirSync(diskTempDir).filter(n => n.startsWith('batdon-gif-'))
   : [];
  const leftoverTmp = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('batdon-gif-') && n !== 'batdon-gif-fonts');
  assert.deepEqual(leftoverDisk, []);
  assert.deepEqual(leftoverTmp, []);
 } finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
 }
});
