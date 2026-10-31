import { randomBytes } from 'node:crypto';
import {
 ActionRowBuilder,
 ButtonBuilder,
 ButtonStyle,
 ChannelType,
 EmbedBuilder,
 ModalBuilder,
 OverwriteType,
 PermissionFlagsBits,
 Routes,
 StringSelectMenuBuilder,
 StringSelectMenuOptionBuilder,
 TextInputBuilder,
 TextInputStyle,
} from 'discord.js';
import { isBotOwner } from './access.js';
import { cleanText } from './playerGui.js';

export const CHAT_LOCK_BITS =
 PermissionFlagsBits.SendMessages |
 PermissionFlagsBits.SendMessagesInThreads |
 PermissionFlagsBits.CreatePublicThreads |
 PermissionFlagsBits.CreatePrivateThreads |
 PermissionFlagsBits.SendVoiceMessages |
 PermissionFlagsBits.SendPolls;

export const POSTER_ALLOW_BITS =
 PermissionFlagsBits.ViewChannel |
 PermissionFlagsBits.SendMessages |
 PermissionFlagsBits.SendMessagesInThreads |
 PermissionFlagsBits.EmbedLinks |
 PermissionFlagsBits.AttachFiles |
 PermissionFlagsBits.AddReactions |
 PermissionFlagsBits.ReadMessageHistory;

const DEFAULT_ANNOUNCE_REACTIONS = ['❤️', '🔥'];

export function buildChannelLockButtons(channelId, { locked = true } = {}) {
 const ch = String(channelId);
 return new ActionRowBuilder().addComponents(
  locked
   ? new ButtonBuilder()
      .setCustomId(`chlock_unlock:${ch}`)
      .setStyle(ButtonStyle.Success)
      .setLabel('Mở khóa lại kênh này')
      .setEmoji('🔓')
   : new ButtonBuilder()
      .setCustomId(`chlock_lock:${ch}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Khóa lại kênh này')
      .setEmoji('🔒'),
 );
}

export function buildAnnounceModal({ channelId, pingRoleId = '', pingEveryone = false, style = 'text', autoReact = true }) {
 const meta = [
  channelId,
  pingRoleId || '0',
  pingEveryone ? '1' : '0',
  style === 'embed' ? 'embed' : 'text',
  autoReact ? '1' : '0',
 ].join(':');

 const modal = new ModalBuilder()
  .setCustomId(`announce_modal:${meta}`)
  .setTitle('📢 Đăng Thông Báo Bằng Bot');

 const contentInput = new TextInputBuilder()
  .setCustomId('announce_content')
  .setLabel('Nội dung thông báo (Enter xuống dòng tự do)')
  .setPlaceholder('Ví dụ:\nMấy nay nhiều việc quá\nHẹn mn cuối tuần sau nhé!\n\nFree')
  .setStyle(TextInputStyle.Paragraph)
  .setRequired(true)
  .setMaxLength(1900);

 modal.addComponents(new ActionRowBuilder().addComponents(contentInput));
 return modal;
}

export function buildDmAnnounceModal(token, defaultText = '') {
 const modal = new ModalBuilder()
  .setCustomId(`dm_ann_modal:${token}`)
  .setTitle('📢 Soạn Bài Đăng Lên Server (Từ DM)');

 const contentInput = new TextInputBuilder()
  .setCustomId('announce_content')
  .setLabel('Nội dung thông báo (Enter xuống dòng tự do)')
  .setPlaceholder('Ví dụ:\nMấy nay nhiều việc quá\nHẹn mn cuối tuần sau nhé!\n\nFree')
  .setStyle(TextInputStyle.Paragraph)
  .setRequired(true)
  .setMaxLength(1900);

 if (defaultText && defaultText.trim()) {
  contentInput.setValue(defaultText.slice(0, 1900));
 }

 modal.addComponents(new ActionRowBuilder().addComponents(contentInput));
 return modal;
}

// Dựng Trạm Đăng Thông Báo & Khóa Kênh từ xa ngay trong Tin nhắn riêng (DM) với Bot cho Chủ Bot.
export function buildDmAnnounceStudioPayload(session, statusNotice = null) {
 const selCh = session.channels.find(c => c.id === session.channelId) ?? session.channels[0];
 const chIcon = selCh?.type === ChannelType.GuildAnnouncement ? '📢' : '#';
 const chTypeLabel = selCh?.type === ChannelType.GuildAnnouncement ? 'Kênh Thông Báo (có nút Theo dõi)' : 'Kênh Văn Bản thường';

 let pingLabel = '🔕 Không tag ai';
 if (session.pingMode === 'everyone') {
  pingLabel = '🌐 Tag `@everyone`';
 } else if (session.pingMode && session.pingMode !== 'none') {
  const foundRole = session.roles.find(r => r.id === session.pingMode);
  pingLabel = foundRole ? `🏷️ Tag Role \`@${foundRole.name}\`` : '🔕 Không tag ai';
 }

 const descLines = [
  statusNotice ? `> ${statusNotice}\n` : null,
  `🏠 **Máy chủ đích :** **${cleanText(session.guildName, 55)}**`,
  `📍 **Kênh đang chọn :** **${chIcon}${cleanText(selCh?.name ?? 'kênh', 45)}** *(${chTypeLabel})*`,
  `🏷️ **Chế độ Tag :** ${pingLabel}`,
  `🎨 **Định dạng :** ${session.style === 'embed' ? '📋 Khung thẻ Embed' : '💬 Chữ tự nhiên (giống Meow Bot)'} • ${session.autoReact ? '❤️ 🔥 Tự thả tim: **Bật**' : '🤍 Tự thả tim: **Tắt**'}`,
 ].filter(Boolean);

 if (session.draftText) {
  const preview = session.draftText.length > 350
   ? `${session.draftText.slice(0, 350)}…`
   : session.draftText;
  descLines.push('', '📝 **Nội dung nháp sẵn sàng đăng:**', `\`\`\`\n${preview.replace(/```/g, "'''")}\n\`\`\``);
 } else {
  descLines.push('', '💡 *Chọn kênh & chế độ tag bên dưới, rồi bấm **✍️ Soạn nhiều dòng & Đăng** để viết bài thoải mái!*');
 }

 const embed = new EmbedBuilder()
  .setColor(0x8b5cf6)
  .setTitle('📢 Trạm Đăng Thông Báo & Quản Trị Kênh Từ Xa (DM)')
  .setDescription(descLines.join('\n'))
  .setFooter({ text: 'Chỉ Chủ Bot mới mở được bảng điều khiển ngầm này • 0 MB RAM' })
  .setTimestamp();

 const components = [];

 // Hàng 1: Menu chọn Kênh trên Server (ưu tiên kênh 📢 Thông báo lên đầu)
 if (session.channels.length > 0) {
  const chSelect = new StringSelectMenuBuilder()
   .setCustomId(`dm_ann_ch:${session.token}`)
   .setPlaceholder(`📍 Đang chọn: ${chIcon}${cleanText(selCh?.name ?? 'Chọn kênh', 35)}`)
   .addOptions(
    session.channels.slice(0, 25).map(ch =>
     new StringSelectMenuOptionBuilder()
      .setLabel(`${ch.type === ChannelType.GuildAnnouncement ? '📢' : '#'} ${cleanText(ch.name, 85)}`)
      .setDescription(ch.type === ChannelType.GuildAnnouncement ? 'Kênh Thông Báo (hỗ trợ nút Theo dõi)' : 'Kênh văn bản trong máy chủ')
      .setValue(ch.id)
      .setDefault(ch.id === session.channelId),
    ),
   );
  components.push(new ActionRowBuilder().addComponents(chSelect));
 }

 // Hàng 2: Menu chọn Tag (@everyone hoặc Role như @Member)
 const pingOpts = [
  new StringSelectMenuOptionBuilder()
   .setLabel('🔕 Không tag (Đăng im lặng)')
   .setDescription('Chỉ đăng nội dung bài viết, không réo chuông ai')
   .setValue('none')
   .setDefault(!session.pingMode || session.pingMode === 'none'),
  new StringSelectMenuOptionBuilder()
   .setLabel('🌐 Tag @everyone (Thông báo toàn máy chủ)')
   .setDescription('Đính kèm @everyone ở đầu bài thông báo')
   .setValue('everyone')
   .setDefault(session.pingMode === 'everyone'),
  ...session.roles.slice(0, 23).map(r =>
   new StringSelectMenuOptionBuilder()
    .setLabel(`🏷️ Tag @${cleanText(r.name, 75)}`)
    .setDescription(`Đính kèm tag vai trò @${cleanText(r.name, 60)} ở đầu bài`)
    .setValue(r.id)
    .setDefault(session.pingMode === r.id),
  ),
 ];
 components.push(
  new ActionRowBuilder().addComponents(
   new StringSelectMenuBuilder()
    .setCustomId(`dm_ann_ping:${session.token}`)
    .setPlaceholder('🏷️ Chọn chế độ Tag ở đầu bài đăng')
    .addOptions(pingOpts),
  ),
 );

 // Hàng 3: Nút Đăng ngay / Mở bảng gõ nhiều dòng + Đổi kiểu & Tự thả tim
 const postBtns = [];
 if (session.draftText) {
  postBtns.push(
   new ButtonBuilder()
    .setCustomId(`dm_ann_send:${session.token}`)
    .setStyle(ButtonStyle.Success)
    .setLabel('Đăng ngay nội dung nháp')
    .setEmoji('🚀'),
  );
 }
 postBtns.push(
  new ButtonBuilder()
   .setCustomId(`dm_ann_compose:${session.token}`)
   .setStyle(ButtonStyle.Primary)
   .setLabel(session.draftText ? 'Sửa & Đăng' : 'Soạn nhiều dòng & Đăng')
   .setEmoji('✍️'),
  new ButtonBuilder()
   .setCustomId(`dm_ann_style:${session.token}`)
   .setStyle(ButtonStyle.Secondary)
   .setLabel(session.style === 'embed' ? 'Kiểu: Embed' : 'Kiểu: Chữ')
   .setEmoji('🎨'),
  new ButtonBuilder()
   .setCustomId(`dm_ann_react:${session.token}`)
   .setStyle(ButtonStyle.Secondary)
   .setLabel(session.autoReact ? 'Tim ❤️🔥: Bật' : 'Tim ❤️🔥: Tắt'),
 );
 components.push(new ActionRowBuilder().addComponents(postBtns));

 // Hàng 4: Khóa / Mở khóa nhanh kênh đang chọn ngay từ trong DM!
 components.push(
  new ActionRowBuilder().addComponents(
   new ButtonBuilder()
    .setCustomId(`dm_ann_lock:${session.token}`)
    .setStyle(ButtonStyle.Danger)
    .setLabel('Khóa kênh này (📢 Theo dõi)')
    .setEmoji('🔒'),
   new ButtonBuilder()
    .setCustomId(`dm_ann_unlock:${session.token}`)
    .setStyle(ButtonStyle.Success)
    .setLabel('Mở khóa kênh này')
    .setEmoji('🔓'),
  ),
 );

 return {
  embeds: [embed],
  components,
  allowedMentions: { parse: [] },
 };
}

// Bộ quản lý Khóa / Mở khóa kênh (hỗ trợ cả Kênh Thông Báo 📢 có nút "Theo dõi" y hệt ảnh mẫu) & Đăng bài bằng Bot (~0 MB RAM).
export function createChannelLockManager({ rest, env = process.env } = {}) {
 // Lưu nhẹ bản chụp quyền gốc của kênh trước khi khóa để lúc /unlock trả lại chính xác (tối đa 30 kênh ~ 2 KB RAM).
 const savedSnapshots = new Map();
 // Phiên soạn thảo thông báo qua DM của Chủ Bot (tối đa 8 phiên, tự hết hạn sau 30 phút ~ 2 KB RAM).
 const dmSessions = new Map();
 const DM_SESSION_TTL_MS = 30 * 60 * 1000;

 async function openDmStudioSession({
  guildId,
  guildName = 'Máy chủ Discord',
  requesterId,
  initialMessage = '',
  style = 'text',
  autoReact = true,
 } = {}) {
  assertOwner(requesterId);
  const gId = String(guildId ?? '').trim();
  if (!/^\d{15,22}$/.test(gId)) {
   throw new Error('Bot hiện chưa tham gia máy chủ nào để đăng thông báo.');
  }

  const [rawChannels, rawRoles] = await Promise.all([
   rest.get(Routes.guildChannels(gId)).catch(() => []),
   rest.get(Routes.guildRoles(gId)).catch(() => []),
  ]);

  const textChannels = (Array.isArray(rawChannels) ? rawChannels : [])
   .filter(ch => ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement))
   .sort((a, b) => {
    const aAnn = a.type === ChannelType.GuildAnnouncement ? 2 : (/(announc|thong-bao|thông-báo|tin-tuc|update)/i.test(a.name ?? '') ? 1 : 0);
    const bAnn = b.type === ChannelType.GuildAnnouncement ? 2 : (/(announc|thong-bao|thông-báo|tin-tuc|update)/i.test(b.name ?? '') ? 1 : 0);
    if (bAnn !== aAnn) return bAnn - aAnn;
    return (Number(a.position) || 0) - (Number(b.position) || 0);
   })
   .slice(0, 25)
   .map(ch => ({ id: String(ch.id), name: String(ch.name ?? 'channel'), type: ch.type }));

  if (textChannels.length === 0) {
   throw new Error('Không tìm thấy kênh văn bản hoặc kênh thông báo nào trong máy chủ.');
  }

  const roles = (Array.isArray(rawRoles) ? rawRoles : [])
   .filter(r => r && String(r.id) !== gId && !r.managed)
   .sort((a, b) => (Number(b.position) || 0) - (Number(a.position) || 0))
   .slice(0, 23)
   .map(r => ({ id: String(r.id), name: String(r.name ?? 'role') }));

  const now = Date.now();
  for (const [k, v] of dmSessions) {
   if (now > v.expiresAt) dmSessions.delete(k);
  }
  if (dmSessions.size >= 8) {
   const oldest = dmSessions.keys().next().value;
   if (oldest) dmSessions.delete(oldest);
  }

  const token = randomBytes(6).toString('hex');
  const session = {
   token,
   guildId: gId,
   guildName,
   channels: textChannels,
   roles,
   channelId: textChannels[0].id,
   pingMode: 'none', // 'none' | 'everyone' | roleId
   style: style === 'embed' ? 'embed' : 'text',
   autoReact: Boolean(autoReact),
   draftText: String(initialMessage ?? '').replace(/\\n/g, '\n').trim(),
   expiresAt: now + DM_SESSION_TTL_MS,
  };
  dmSessions.set(token, session);
  return session;
 }

 function getDmStudioSession(token, requesterId) {
  assertOwner(requesterId);
  const s = dmSessions.get(String(token ?? ''));
  if (!s || Date.now() > s.expiresAt) {
   dmSessions.delete(String(token ?? ''));
   throw new Error('Bảng điều khiển DM này đã hết hạn (30 phút) — hãy gõ lại `/announce` ngay trong DM để mở bảng mới nhé!');
  }
  s.expiresAt = Date.now() + DM_SESSION_TTL_MS;
  return s;
 }

 function assertOwner(userId) {
  if (!isBotOwner(userId, env)) {
   throw new Error('Chỉ Chủ Bot mới có quyền khóa/mở kênh hoặc dùng Bot đăng thông báo.');
  }
 }

 async function putOverwrite(channelId, targetId, type, allowBig, denyBig, reason) {
  await rest.put(Routes.channelPermission(String(channelId), String(targetId)), {
   body: {
    id: String(targetId),
    type,
    allow: String(allowBig),
    deny: String(denyBig),
   },
   reason,
  });
 }

 async function lockChannel({
  guildId,
  channelId,
  requesterId,
  botUserId,
  mode = 'announcement', // 'announcement' (hiện nút Theo dõi xanh) | 'normal' (kênh chữ thường)
  allowReactions = true,
  extraRoleId = null,
 } = {}) {
  assertOwner(requesterId);
  const gId = String(guildId ?? '').trim();
  const chId = String(channelId ?? '').trim();
  if (!/^\d{15,22}$/.test(gId) || !/^\d{15,22}$/.test(chId)) {
   throw new Error('Kênh cần khóa không hợp lệ.');
  }

  let rawCh;
  try {
   rawCh = await rest.get(Routes.channel(chId));
  } catch (err) {
   if (err?.status === 403 || err?.code === 50013) {
    throw new Error('Bot chưa thấy kênh này — hãy cấp quyền **Xem Kênh & Quản lý Kênh (Manage Channels)** cho Role của Bot.');
   }
   throw new Error('Không đọc được thông tin kênh cần khóa.');
  }

  if (rawCh.type !== ChannelType.GuildText && rawCh.type !== ChannelType.GuildAnnouncement) {
   throw new Error('Chỉ hỗ trợ khóa Kênh Văn Bản (`#`) hoặc Kênh Thông Báo (`📢`).');
  }

  const overwrites = Array.isArray(rawCh.permission_overwrites) ? rawCh.permission_overwrites : [];
  const byKey = new Map(overwrites.map(ov => [`${ov.type}:${ov.id}`, {
   id: String(ov.id),
   type: Number(ov.type),
   allow: BigInt(ov.allow ?? '0'),
   deny: BigInt(ov.deny ?? '0'),
  }]));

  // Chỉ chụp lại quyền gốc nếu kênh chưa lưu snapshot trước đó (để bấm Khóa 2 lần liên tiếp không ghi đè mất quyền gốc).
  if (!savedSnapshots.has(chId)) {
   if (savedSnapshots.size >= 30) {
    const oldest = savedSnapshots.keys().next().value;
    if (oldest) savedSnapshots.delete(oldest);
   }
   savedSnapshots.set(chId, {
    origType: rawCh.type,
    overwrites: overwrites.map(ov => ({
     id: String(ov.id),
     type: Number(ov.type),
     allow: String(ov.allow ?? '0'),
     deny: String(ov.deny ?? '0'),
    })),
   });
  }

  // 1. Cấp trước quyền gửi tin riêng cho chính Bot và Chủ Bot để không bao giờ tự khóa chính mình!
  try {
   if (botUserId && /^\d{15,22}$/.test(String(botUserId))) {
    const prevBot = byKey.get(`1:${botUserId}`) ?? { allow: 0n, deny: 0n };
    await putOverwrite(
     chId,
     botUserId,
     OverwriteType.Member,
     prevBot.allow | POSTER_ALLOW_BITS,
     prevBot.deny & ~POSTER_ALLOW_BITS,
     'Mở quyền đăng bài cho Bot khi khóa kênh',
    );
   }
   const prevOwner = byKey.get(`1:${requesterId}`) ?? { allow: 0n, deny: 0n };
   await putOverwrite(
    chId,
    requesterId,
    OverwriteType.Member,
    prevOwner.allow | POSTER_ALLOW_BITS,
    prevOwner.deny & ~POSTER_ALLOW_BITS,
    'Mở quyền đăng bài cho Chủ Bot khi khóa kênh',
   );
  } catch (err) {
   if (err?.status === 403 || err?.code === 50013) {
    throw new Error('Bot thiếu quyền **Quản lý Quyền (Manage Permissions / Manage Roles)** trên kênh này — hãy bật quyền `Quản lý Kênh` & `Quản lý Vai trò` (hoặc `Administrator`) cho Bot rồi thử lại nhé!');
   }
   throw err;
  }

  // 2. Khóa chat + khóa tạo Thread trên @everyone (và giữ quyền Xem lịch sử + Thả biểu cảm ❤️🔥 như ảnh mẫu).
  const roleTargets = new Set([gId]);
  if (extraRoleId && /^\d{15,22}$/.test(String(extraRoleId))) {
   roleTargets.add(String(extraRoleId));
  }
  // Tự động phát hiện các Role thành viên đang được bật tường minh SendMessages trên kênh (ví dụ @Member) để khóa đồng bộ, tránh bị lọt ô chat!
  for (const ov of overwrites) {
   if (Number(ov.type) === OverwriteType.Role && String(ov.id) !== gId) {
    const allowBits = BigInt(ov.allow ?? '0');
    if ((allowBits & PermissionFlagsBits.SendMessages) !== 0n) {
     roleTargets.add(String(ov.id));
    }
   }
  }

  for (const rId of roleTargets) {
   const prev = byKey.get(`0:${rId}`) ?? { allow: 0n, deny: 0n };
   let nextAllow = prev.allow & ~CHAT_LOCK_BITS;
   let nextDeny = prev.deny | CHAT_LOCK_BITS;
   if (allowReactions) {
    nextAllow |= PermissionFlagsBits.AddReactions | PermissionFlagsBits.ReadMessageHistory;
    nextDeny &= ~(PermissionFlagsBits.AddReactions | PermissionFlagsBits.ReadMessageHistory);
   } else {
    nextAllow &= ~PermissionFlagsBits.AddReactions;
    nextDeny |= PermissionFlagsBits.AddReactions;
   }
   await putOverwrite(chId, rId, OverwriteType.Role, nextAllow, nextDeny, 'Khóa kênh bằng lệnh /lock');
  }

  // 3. Nếu chọn chế độ "announcement" (hiện nút xanh [Theo dõi] ở đáy kênh y hệt ảnh), chuyển kênh sang GuildAnnouncement (type 5).
  let announcementStatus = rawCh.type === ChannelType.GuildAnnouncement ? 'already_announcement' : 'normal_text';
  if (mode === 'announcement' && rawCh.type !== ChannelType.GuildAnnouncement) {
   try {
    const patched = await rest.patch(Routes.channel(chId), {
     body: { type: ChannelType.GuildAnnouncement },
     reason: 'Chuyển sang Kênh Thông Báo để hiện nút Theo dõi khi khóa kênh',
    });
    if (patched?.type === ChannelType.GuildAnnouncement) {
     announcementStatus = 'converted_announcement';
    } else {
     announcementStatus = 'community_needed';
    }
   } catch {
    announcementStatus = 'community_needed';
   }
  }

  return {
   channelId: chId,
   channelName: rawCh.name ?? 'channel',
   lockedRolesCount: roleTargets.size,
   allowReactions,
   announcementStatus,
  };
 }

 async function unlockChannel({
  guildId,
  channelId,
  requesterId,
  extraRoleId = null,
  revertNormalText = false,
 } = {}) {
  assertOwner(requesterId);
  const gId = String(guildId ?? '').trim();
  const chId = String(channelId ?? '').trim();
  if (!/^\d{15,22}$/.test(gId) || !/^\d{15,22}$/.test(chId)) {
   throw new Error('Kênh cần mở khóa không hợp lệ.');
  }

  let rawCh;
  try {
   rawCh = await rest.get(Routes.channel(chId));
  } catch {
   throw new Error('Không đọc được thông tin kênh cần mở khóa.');
  }

  const snap = savedSnapshots.get(chId) ?? null;
  savedSnapshots.delete(chId);

  try {
   if (snap?.overwrites) {
    // Khôi phục chính xác trạng thái quyền các Role trước lúc /lock
    for (const orig of snap.overwrites) {
     if (orig.type === OverwriteType.Role) {
      await putOverwrite(
       chId,
       orig.id,
       OverwriteType.Role,
       BigInt(orig.allow),
       BigInt(orig.deny),
       'Khôi phục quyền kênh gốc khi /unlock',
      );
     }
    }
    // Nếu trước lúc /lock kênh chưa từng có overwrite cho @everyone -> trả @everyone về trung lập
    if (!snap.overwrites.some(o => o.type === OverwriteType.Role && o.id === gId)) {
     await putOverwrite(chId, gId, OverwriteType.Role, 0n, 0n, 'Mở khóa @everyone khi /unlock');
    }
   } else {
    // Trường hợp bot đã restart sau khi khóa: gỡ sạch cờ chặn CHAT_LOCK_BITS trên @everyone và các Role đang bị chặn SendMessages
    const overwrites = Array.isArray(rawCh.permission_overwrites) ? rawCh.permission_overwrites : [];
    const targets = new Set([gId]);
    if (extraRoleId && /^\d{15,22}$/.test(String(extraRoleId))) targets.add(String(extraRoleId));
    for (const ov of overwrites) {
     if (Number(ov.type) === OverwriteType.Role && (BigInt(ov.deny ?? '0') & PermissionFlagsBits.SendMessages) !== 0n) {
      targets.add(String(ov.id));
     }
    }
    for (const rId of targets) {
     const found = overwrites.find(o => Number(o.type) === OverwriteType.Role && String(o.id) === rId);
     const allowBig = BigInt(found?.allow ?? '0');
     const denyBig = BigInt(found?.deny ?? '0') & ~(CHAT_LOCK_BITS | PermissionFlagsBits.AddReactions);
     await putOverwrite(chId, rId, OverwriteType.Role, allowBig, denyBig, 'Mở khóa kênh bằng lệnh /unlock');
    }
   }
  } catch (err) {
   if (err?.status === 403 || err?.code === 50013) {
    throw new Error('Bot thiếu quyền **Quản lý Quyền (Manage Permissions)** để mở khóa kênh này.');
   }
   throw err;
  }

  let revertedType = false;
  if (revertNormalText && rawCh.type === ChannelType.GuildAnnouncement) {
   try {
    await rest.patch(Routes.channel(chId), {
     body: { type: ChannelType.GuildText },
     reason: 'Chuyển kênh thông báo về lại kênh văn bản thường',
    });
    revertedType = true;
   } catch {}
  }

  return {
   channelId: chId,
   channelName: rawCh.name ?? 'channel',
   revertedType,
  };
 }

 // Cho Bot đăng thông báo / bài viết vào kênh đã khóa (giống Meow Bot trong ảnh: hỗ trợ tag @Member / @everyone, tự thả sẵn ❤️ 🔥 & tự Xuất bản cho người bấm "Theo dõi").
 async function postBotAnnouncement({
  channelId,
  requesterId,
  rawContent,
  pingRoleId = null,
  pingEveryone = false,
  style = 'text',
  autoReact = true,
  crosspost = true,
 } = {}) {
  assertOwner(requesterId);
  const chId = String(channelId ?? '').trim();
  const normalizedText = String(rawContent ?? '')
   .replace(/\\n/g, '\n')
   .trim();
  if (!normalizedText) {
   throw new Error('Nội dung thông báo không được để trống.');
  }

  const prefixParts = [];
  const allowedMentions = { parse: [], roles: [], users: [] };
  if (pingEveryone) {
   prefixParts.push('@everyone');
   allowedMentions.parse.push('everyone');
  }
  if (pingRoleId && /^\d{15,22}$/.test(String(pingRoleId)) && String(pingRoleId) !== '0') {
   prefixParts.push(`<@&${pingRoleId}>`);
   allowedMentions.roles.push(String(pingRoleId));
  }

  let body;
  if (style === 'embed') {
   const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription(normalizedText.slice(0, 3900))
    .setTimestamp();
   body = {
    ...(prefixParts.length > 0 ? { content: prefixParts.join(' ') } : {}),
    embeds: [embed.toJSON()],
    allowed_mentions: allowedMentions,
   };
  } else {
   const fullText = prefixParts.length > 0
    ? `${prefixParts.join(' ')} ${normalizedText}`
    : normalizedText;
   body = {
    content: fullText.slice(0, 1990),
    allowed_mentions: allowedMentions,
   };
  }

  let sent;
  try {
   sent = await rest.post(Routes.channelMessages(chId), { body });
  } catch (err) {
   if (err?.status === 403 || err?.code === 50013) {
    throw new Error('Bot chưa có quyền gửi tin nhắn vào kênh này — hãy cấp quyền `Gửi tin nhắn` hoặc `Quản lý Kênh` cho Bot nhé!');
   }
   throw new Error('Không thể đăng thông báo vào kênh này lúc này.');
  }

  // Tự động gắn sẵn biểu cảm ❤️ 🔥 bên dưới bài viết giống hệt ảnh mẫu để thành viên chỉ việc bấm thả tim!
  if (autoReact && sent?.id) {
   for (const emoji of DEFAULT_ANNOUNCE_REACTIONS) {
    try {
     await rest.put(Routes.channelMessageOwnReaction(chId, sent.id, encodeURIComponent(emoji)));
    } catch {}
   }
  }

  // Nếu kênh là Kênh Thông Báo (📢), tự động Xuất bản (Crosspost) để đẩy tin sang các máy chủ đã bấm nút [Theo dõi]!
  let published = false;
  if (crosspost && sent?.id) {
   try {
    await rest.post(Routes.channelMessageCrosspost(chId, sent.id));
    published = true;
   } catch {}
  }

  return {
   messageId: sent?.id ?? null,
   channelId: chId,
   published,
  };
 }

 return {
  assertOwner,
  lockChannel,
  unlockChannel,
  postBotAnnouncement,
  openDmStudioSession,
  getDmStudioSession,
 };
}
