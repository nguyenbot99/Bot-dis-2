// Các lệnh chỉ đọc thông tin, ai trong máy chủ cũng có thể xem được.
const readOnlyCommands = new Set(['queue', 'nowplaying', 'ping']);

// Không mở ngoại lệ cho quản trị viên: quyền điều khiển nhạc đi theo người yêu cầu bài đang phát.
// Trong khoảng chuyển bài ngắn, giữ quyền của người yêu cầu bài liền trước; trước bài đầu tiên,
// dùng người tạo phiên phát. Nếu không xác định được chủ sở hữu thì từ chối để an toàn.
export function assertMusicAccess(command, userId, player) {
 if (!player || readOnlyCommands.has(command)) return;
 const ownerId = player.queue.currentTrack?.requestedBy
  || player.previousTrack?.requestedBy
  || player.userdata?.ownerId;
 if (!ownerId || ownerId !== userId) {
  throw new Error('Bạn không có quyền điều khiển: chỉ người yêu cầu bài đang phát mới được thay đổi nhạc.');
 }
}
