import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceGuardEmbed, evaluateBotVoiceTransition, shouldAttemptSelfUnmute } from '../src/voiceGuard.js';
import { buildIdle247Payload, buildPlayerPayload } from '../src/playerGui.js';

test('detects Server Mute, auto-pauses playing music, and auto-resumes when unmuted', () => {
 const session = { voiceMuted: false, muteReason: null, autoPausedByMute: false };

 // Bị tắt mic máy chủ khi đang phát nhạc -> tự tạm dừng.
 const muted = evaluateBotVoiceTransition(
  { channelId: '100', serverMute: false, suppress: false },
  { channelId: '100', serverMute: true, suppress: false },
  session,
  { isPlaying: true, isPaused: false },
 );
 assert.equal(muted.action, 'muted');
 assert.equal(muted.muteReason, 'server_mute');
 assert.equal(muted.shouldPause, true);
 assert.equal(session.voiceMuted, true);
 assert.equal(session.autoPausedByMute, true);

 const muteEmbed = buildVoiceGuardEmbed(muted).toJSON();
 assert.equal(muteEmbed.color, 0xed4245);
 assert.match(muteEmbed.title, /bị tắt mic/);

 // Khung Player V2 chuyển viền đỏ và hiện cảnh báo bị tắt mic.
 const cardJson = JSON.stringify(
  buildPlayerPayload({
   isPaused: true,
   userdata: { voiceChannelId: '100', voiceMuted: true, muteReason: 'server_mute' },
   queue: { currentTrack: { title: 'Bài test', duration: 180000 } },
  }).components[0].toJSON(),
 );
 assert.ok(cardJson.includes('Server Mute'));

 // Được mở lại mic -> tự động phát tiếp bài đang tạm dừng do bị tắt mic.
 const unmuted = evaluateBotVoiceTransition(
  { channelId: '100', serverMute: true, suppress: false },
  { channelId: '100', serverMute: false, suppress: false },
  session,
  { isPlaying: true, isPaused: true },
 );
 assert.equal(unmuted.action, 'unmuted');
 assert.equal(unmuted.shouldResume, true);
 assert.equal(session.voiceMuted, false);
 assert.equal(session.autoPausedByMute, false);

 const unmuteEmbed = buildVoiceGuardEmbed(unmuted).toJSON();
 assert.equal(unmuteEmbed.color, 0x57f287);
});

test('does not auto-resume on unmute if user manually paused while muted', () => {
 const session = { voiceMuted: true, muteReason: 'server_mute', autoPausedByMute: false };
 const unmuted = evaluateBotVoiceTransition(
  { channelId: '100', serverMute: true },
  { channelId: '100', serverMute: false },
  session,
  { isPlaying: true, isPaused: true },
 );
 assert.equal(unmuted.action, 'unmuted');
 assert.equal(unmuted.shouldResume, false);
});

test('detects Stage channel suppression and pre-muted join', () => {
 const session = {};
 const joinedMuted = evaluateBotVoiceTransition(
  { channelId: null },
  { channelId: '200', serverMute: false, suppress: true },
  session,
  { isPlaying: false, isPaused: false },
 );
 assert.equal(joinedMuted.action, 'joined_muted');
 assert.equal(joinedMuted.muteReason, 'stage_suppress');
 assert.match(buildVoiceGuardEmbed(joinedMuted).toJSON().title, /Kênh Sân Khấu/);

 const idle247Json = JSON.stringify(
  buildIdle247Payload({ userdata: { voiceChannelId: '200', voiceMuted: true } }).components[0].toJSON(),
 );
 assert.ok(idle247Json.includes('Server Mute'));
});

test('distinguishes manual /leave from being kicked out of voice room (normal & 24/7 anti-loop)', () => {
 // Rời phòng chủ động bằng /leave -> không báo bị kick.
 const manual = evaluateBotVoiceTransition(
  { channelId: '100' },
  { channelId: null },
  { manualDisconnect: true, stay247: false },
 );
 assert.equal(manual.action, 'manual_leave');

 // Chế độ thường bị kick -> dừng phiên và báo bị kick (kèm thông báo đã lưu nhạc khi có bài đang phát).
 const kickedNormal = evaluateBotVoiceTransition(
  { channelId: '100' },
  { channelId: null },
  { manualDisconnect: false, stay247: false },
 );
 assert.equal(kickedNormal.action, 'kicked_stop');
 assert.match(buildVoiceGuardEmbed(kickedNormal).toJSON().title, /bị kick/);
 const savedKickDesc = buildVoiceGuardEmbed({ ...kickedNormal, hasSavedMusic: true }).toJSON().description;
 assert.match(savedKickDesc, /lưu lại bài đang phát/);

 // Chế độ 24/7: lần kick thứ 1 thử kết nối lại, lần kick thứ 2 trong 30 giây tự tắt 24/7 để không spam vào lại.
 const session247 = { manualDisconnect: false, stay247: true, kickTimestamps: [] };
 const kick1 = evaluateBotVoiceTransition({ channelId: '100' }, { channelId: null }, session247, { now: 1000 });
 assert.equal(kick1.action, 'kicked_reconnect_247');
 assert.equal(session247.stay247, true);

 const kick2 = evaluateBotVoiceTransition({ channelId: '100' }, { channelId: null }, session247, { now: 12000 });
 assert.equal(kick2.action, 'kicked_abort_247');
 assert.equal(session247.stay247, false);
});

test('detects being dragged to AFK channel and pauses playback', () => {
 const session = {};
 const movedAfk = evaluateBotVoiceTransition(
  { channelId: '100' },
  { channelId: '999' },
  session,
  { afkChannelId: '999', isPlaying: true, isPaused: false },
 );
 assert.equal(movedAfk.action, 'moved_afk');
 assert.equal(movedAfk.shouldPause, true);
 assert.match(buildVoiceGuardEmbed(movedAfk).toJSON().title, /AFK/);
});

test('chế độ thường tự vào lại một lần khi đang phát, kick lần hai trong 30 giây thì dừng', () => {
 const firstSession = { manualDisconnect: false, stay247: false, kickTimestamps: [] };
 const first = evaluateBotVoiceTransition(
  { channelId: '100' }, { channelId: null }, firstSession,
  { autoReconnectNormal: true, now: 1000 },
 );
 assert.equal(first.action, 'kicked_reconnect');
 assert.equal(first.oldChannelId, '100');
 assert.match(buildVoiceGuardEmbed({ ...first, hasSavedMusic: true }).toJSON().description, /mốc đang phát/);
 // Phiên mới sau khi vào lại vẫn nhớ lần kick trước, không thành vòng lặp.
 const secondSession = { manualDisconnect: false, stay247: false, kickTimestamps: firstSession.kickTimestamps };
 const second = evaluateBotVoiceTransition(
  { channelId: '100' }, { channelId: null }, secondSession,
  { autoReconnectNormal: true, now: 12000 },
 );
 assert.equal(second.action, 'kicked_abort_reconnect');
 assert.match(buildVoiceGuardEmbed(second).toJSON().description, /không tiếp tục tự vào lại/);
 const afterWindow = evaluateBotVoiceTransition(
  { channelId: '100' }, { channelId: null }, { kickTimestamps: secondSession.kickTimestamps },
  { autoReconnectNormal: true, now: 44000 },
 );
 assert.equal(afterWindow.action, 'kicked_reconnect');
});

test('chỉ tự mở Server Mute trên phòng thoại khi có Mute Members', () => {
 const context = { serverMute: true, channelId: '100', isVoiceChannel: true, isAfk: false, canMuteMembers: true };
 assert.equal(shouldAttemptSelfUnmute({ ...context, now: 1000 }), true);
 assert.equal(shouldAttemptSelfUnmute({ ...context, canMuteMembers: false, now: 1000 }), false);
 assert.equal(shouldAttemptSelfUnmute({ ...context, isAfk: true, now: 1000 }), false);
 assert.equal(shouldAttemptSelfUnmute({ ...context, isVoiceChannel: false, now: 1000 }), false);
 assert.equal(shouldAttemptSelfUnmute({ ...context, serverMute: false, now: 1000 }), false);
 const event = { action: 'muted', newChannelId: '100', muteReason: 'server_mute', autoUnmuteAttempted: true, shouldPause: true };
 assert.match(buildVoiceGuardEmbed(event).toJSON().description, /mỗi 5 giây/);
 assert.match(buildVoiceGuardEmbed({ ...event, autoUnmuteAttempted: false, autoUnmutePermissionMissing: true }).toJSON().description, /Mute Members/);
});

test('Server Mute mới không bị cờ phiên cũ che và bot vẫn tạm dừng nếu còn phát khi đang bị mute', () => {
 const session = { voiceMuted: true, autoPausedByMute: false };
 const fresh = evaluateBotVoiceTransition(
  { channelId: '100', serverMute: false },
  { channelId: '100', serverMute: true },
  session, { isPlaying: true, isPaused: false },
 );
 assert.equal(fresh.action, 'muted');
 assert.equal(fresh.shouldPause, true);
 assert.equal(session.autoPausedByMute, true);
 const stillPlaying = evaluateBotVoiceTransition(
  { channelId: '100', serverMute: true },
  { channelId: '100', serverMute: true },
  { voiceMuted: true }, { isPlaying: true, isPaused: false },
 );
 assert.equal(stillPlaying.action, 'muted');
 assert.equal(stillPlaying.shouldPause, true);
});

test('mở mic quá nhanh vẫn yêu cầu RESUME dù PAUSE bất đồng bộ chưa cập nhật isPaused', () => {
 const session = { autoPausedByMute: true };
 const ev = evaluateBotVoiceTransition(
  { channelId: '100', serverMute: true },
  { channelId: '100', serverMute: false },
  session, { isPlaying: true, isPaused: false },
 );
 assert.equal(ev.action, 'unmuted');
 assert.equal(ev.shouldResume, true);
 assert.equal(session.autoPausedByMute, false);
});
