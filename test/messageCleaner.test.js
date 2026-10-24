import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 deleteDiscordMessage,
 extractMessageRef,
 isStaleBotNoticeMessage,
 sweepChannelStaleNotices,
} from '../src/messageCleaner.js';
import { buildEndedPayload, buildIdle247Payload, buildPlayerPayload } from '../src/playerGui.js';
import { buildVoiceGuardEmbed } from '../src/voiceGuard.js';
import { buildHelpEmbed } from '../src/commands.js';

const BOT_ID = '999888777666555444';
const USER_ID = '1243061570247069696';
const CH_ID = '555444333222111000';

test('extractMessageRef and deleteDiscordMessage work via REST even when MessageManager cache is 0 (no msg.delete)', async () => {
 const rawInteractionMsg = { id: '111222333444555666', channel_id: CH_ID };
 assert.deepEqual(extractMessageRef(rawInteractionMsg), {
  channelId: CH_ID,
  messageId: '111222333444555666',
 });

 const deletedPaths = [];
 const fakeRest = {
  async delete(path) {
   deletedPaths.push(path);
  },
 };

 const ok = await deleteDiscordMessage(fakeRest, rawInteractionMsg);
 assert.equal(ok, true);
 assert.deepEqual(deletedPaths, [`/channels/${CH_ID}/messages/111222333444555666`]);

 // Mã lỗi 10008 (Unknown Message - tin nhắn đã xóa trước đó) vẫn được coi là thành công êm ái.
 const rest404 = {
  async delete() {
   const err = new Error('Unknown Message');
   err.code = 10008;
   throw err;
  },
 };
 assert.equal(await deleteDiscordMessage(rest404, { id: '222' }, CH_ID), true);
});

test('sweepChannelStaleNotices cleans stuck kick embeds & expired ended panels while preserving active panels, help embeds, and user chat', async () => {
 const now = 1_760_000_000_000;
 const threeHoursAgoSec = Math.floor((now - 3 * 3600 * 1000) / 1000);
 const futureSec = Math.floor((now + 240_000) / 1000);

 const kickEmbedJson = buildVoiceGuardEmbed({ action: 'kicked_stop', oldChannelId: '100' }).toJSON();
 // Giả lập mốc thời gian cũ 3 giờ trước giống hệt ảnh chụp #nghich_bot.
 const expiredEndedComponents = [buildEndedPayload('Đã dừng phát nhạc, xóa hàng đợi và rời kênh thoại.').components[0].toJSON()];
 expiredEndedComponents[0].components[0].content = expiredEndedComponents[0].components[0].content.replace(
  /<t:\d+:R>/,
  `<t:${threeHoursAgoSec}:R>`,
 );

 const freshPendingEndedComponents = [buildEndedPayload('Vừa dừng xong.').components[0].toJSON()];
 freshPendingEndedComponents[0].components[0].content = freshPendingEndedComponents[0].components[0].content.replace(
  /<t:\d+:R>/,
  `<t:${futureSec}:R>`,
 );

 const activePanelComponents = [
  buildPlayerPayload({
   isPaused: false,
   volume: 100,
   loop: () => 'off',
   queue: { currentTrack: { title: 'Đang phát', duration: 200000 } },
   upcomingTracks: [],
   userdata: { voiceChannelId: '100' },
  }).components[0].toJSON(),
 ];

 const orphanedIdleComponents = [
  buildIdle247Payload({ userdata: { voiceChannelId: '100' } }).components[0].toJSON(),
 ];

 const helpEmbedJson = buildHelpEmbed({ username: 'Bắt_Don' }).toJSON();

 const channelHistory = [
  // 1 & 2: Hai thông báo kick bị kẹt từ 15:00 (cần xóa sạch cả 2!)
  { id: 'kick_1', channel_id: CH_ID, author: { id: BOT_ID }, embeds: [kickEmbedJson], components: [] },
  { id: 'kick_2', channel_id: CH_ID, author: { id: BOT_ID }, embeds: [kickEmbedJson], components: [] },
  // 3: Khung "Phiên phát nhạc đã kết thúc - Thông báo này sẽ tự xóa 3 giờ trước" (cần xóa sạch!)
  { id: 'ended_old', channel_id: CH_ID, author: { id: BOT_ID }, embeds: [], components: expiredEndedComponents },
  // 4: Khung 24/7 cũ mồ côi sau khi bot restart (cần xóa sạch!)
  { id: 'idle_orphan', channel_id: CH_ID, author: { id: BOT_ID }, embeds: [], components: orphanedIdleComponents },
  // 5: Khung kết thúc vừa mới hiện đang trong thời gian chờ 4m30s (KHÔNG được xóa sớm!)
  { id: 'ended_fresh', channel_id: CH_ID, author: { id: BOT_ID }, embeds: [], components: freshPendingEndedComponents },
  // 6: Khung điều khiển bài hát đang phát hiện tại (TUYỆT ĐỐI giữ nguyên!)
  { id: 'active_panel', channel_id: CH_ID, author: { id: BOT_ID }, embeds: [], components: activePanelComponents },
  // 7: Bảng /help của bot (TUYỆT ĐỐI giữ nguyên!)
  { id: 'help_msg', channel_id: CH_ID, author: { id: BOT_ID }, embeds: [helpEmbedJson], components: [] },
  // 8: Tin nhắn chat của người dùng (TUYỆT ĐỐI giữ nguyên!)
  { id: 'user_msg', channel_id: CH_ID, author: { id: USER_ID }, content: 'Phiên phát nhạc đã kết thúc', embeds: [], components: [] },
 ];

 const activeMessageIds = new Set(['active_panel']);
 const pendingKeys = new Set([`${CH_ID}:ended_fresh`]);

 // Kiểm tra phân loại từng tin nhắn.
 assert.equal(isStaleBotNoticeMessage(channelHistory[0], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), true);
 assert.equal(isStaleBotNoticeMessage(channelHistory[1], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), true);
 assert.equal(isStaleBotNoticeMessage(channelHistory[2], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), true);
 assert.equal(isStaleBotNoticeMessage(channelHistory[3], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), true);
 assert.equal(isStaleBotNoticeMessage(channelHistory[4], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), false);
 assert.equal(isStaleBotNoticeMessage(channelHistory[5], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), false);
 assert.equal(isStaleBotNoticeMessage(channelHistory[6], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), false);
 assert.equal(isStaleBotNoticeMessage(channelHistory[7], { botId: BOT_ID, now, activeMessageIds, pendingKeys }), false);

 // Kiểm tra khi gọi bot vào lại phòng (clearAllKickAlerts = true): xóa ngay cả thông báo kick vừa mới gửi đang nằm trong pendingKeys!
 const freshKickMsg = {
  id: 'kick_fresh',
  channel_id: CH_ID,
  author: { id: BOT_ID },
  embeds: [{ ...kickEmbedJson, description: `Vừa bị kick\n🧹 Thông báo này sẽ tự xóa <t:${futureSec}:R>.` }],
  components: [],
 };
 pendingKeys.add(`${CH_ID}:kick_fresh`);
 assert.equal(isStaleBotNoticeMessage(freshKickMsg, { botId: BOT_ID, now, activeMessageIds, pendingKeys, clearAllKickAlerts: false }), false);
 assert.equal(isStaleBotNoticeMessage(freshKickMsg, { botId: BOT_ID, now, activeMessageIds, pendingKeys, clearAllKickAlerts: true }), true);

 // Kiểm tra luồng sweepChannelStaleNotices thực tế qua REST mock.
 const deletedIds = [];
 const fakeRest = {
  async get() {
   return channelHistory;
  },
  async delete(path) {
   deletedIds.push(path.split('/').pop());
  },
 };

 const count = await sweepChannelStaleNotices({
  rest: fakeRest,
  channelId: CH_ID,
  botId: BOT_ID,
  activeMessageIds,
  pendingKeys,
  now,
 });
 assert.equal(count, 4);
 assert.deepEqual(deletedIds, ['kick_1', 'kick_2', 'ended_old', 'idle_orphan']);
});
