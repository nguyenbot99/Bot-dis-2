// Các lệnh chỉ đọc thông tin, ai trong máy chủ cũng có thể xem được.
const readOnlyCommands = new Set(['help', 'queue', 'nowplaying', 'history', 'lyrics', 'ping', 'stats', 'grab']);
const sharedVoiceFunCommands = new Set(['tts', 'sfx']);

// ID Discord chủ bot có toàn quyền điều khiển mọi phiên nhạc bất kể ai là người bắt bài.
export const DEFAULT_BOT_OWNER_IDS = Object.freeze(['1243061570247069696']);

// Kiểm tra xem người dùng có phải chủ bot (mặc định gồm ID 1243061570247069696 hoặc khai báo thêm qua BOT_OWNER_ID / OWNER_IDS) hay không.
export function isBotOwner(userId, env = process.env) {
 const id = String(userId ?? '').trim();
 if (!id) return false;
 if (DEFAULT_BOT_OWNER_IDS.includes(id)) return true;
 const extraRaw = `${env?.BOT_OWNER_ID ?? ''},${env?.OWNER_IDS ?? ''}`;
 if (!extraRaw.trim()) return false;
 return extraRaw
  .split(/[\s,;]+/)
  .map(s => s.trim())
  .filter(s => /^\d{17,20}$/.test(s))
  .includes(id);
}

// Loại bỏ các mã định danh hệ thống sinh tự động khi bật AutoPlay (như "auto", "Unknown") để quyền luôn thuộc về người thật.
export function resolveHumanRequester(id) {
 if (!id || typeof id !== 'string') return null;
 if (id === 'auto' || id === 'Unknown' || id === 'SoundCloud_Related') return null;
 return id;
}

// Quyền điều khiển nhạc đi theo người yêu cầu bài đang phát, NGOẠI TRỪ chủ bot (isBotOwner) luôn có toàn quyền tác động.
// Ngoài ra khi chế độ 24/7 đang bật và bot đang nghỉ hoàn toàn (hết nhạc, idleOpen = true),
// người trong kênh thoại được phép gọi /play để mở lượt phát nhạc mới; còn /leave và /247 vẫn khóa theo chủ phiên (hoặc chủ bot).
export function assertMusicAccess(command, userId, player, env = process.env) {
 if (!player || readOnlyCommands.has(command) || sharedVoiceFunCommands.has(command) || isBotOwner(userId, env)) return;
 if (
  command === 'play'
  && !player.queue?.currentTrack
  && ((player.userdata?.stay247 && player.userdata?.idleOpen) || player.userdata?.ttsOnlyIdle)
 ) {
  return;
 }
 const ownerId = resolveHumanRequester(player.queue?.currentTrack?.requestedBy)
  || (!player.userdata?.idleOpen ? resolveHumanRequester(player.previousTrack?.requestedBy) : null)
  || resolveHumanRequester(player.userdata?.ownerId);
 if (!ownerId || ownerId !== userId) {
  throw new Error('Bạn không có quyền điều khiển: chỉ người yêu cầu bài đang phát mới được thay đổi nhạc.');
 }
}
