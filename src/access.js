// Các lệnh chỉ đọc thông tin, ai trong máy chủ cũng có thể xem được.
const readOnlyCommands = new Set(['help', 'queue', 'nowplaying', 'history', 'lyrics', 'ping']);

// Loại bỏ các mã định danh hệ thống sinh tự động khi bật AutoPlay (như "auto", "Unknown") để quyền luôn thuộc về người thật.
export function resolveHumanRequester(id) {
 if (!id || typeof id !== 'string') return null;
 if (id === 'auto' || id === 'Unknown' || id === 'SoundCloud_Related') return null;
 return id;
}

// Không mở ngoại lệ cho quản trị viên: quyền điều khiển nhạc đi theo người yêu cầu bài đang phát.
// Ngoại lệ duy nhất: khi chế độ 24/7 đang bật và bot đang nghỉ hoàn toàn (hết nhạc, idleOpen = true),
// người trong kênh thoại được phép gọi /play để mở lượt phát nhạc mới; còn /leave và /247 vẫn khóa theo chủ phiên.
export function assertMusicAccess(command, userId, player) {
 if (!player || readOnlyCommands.has(command)) return;
 if (
  command === 'play'
  && player.userdata?.stay247
  && player.userdata?.idleOpen
  && !player.queue?.currentTrack
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
