const readOnlyCommands = new Set(['queue', 'nowplaying', 'ping']);

// No administrator bypass: controls follow the requester of the current track.
// During a gap, retain the previous requester's control; before the first track,
// only the session creator can change the player. Missing ownership fails closed.
export function assertMusicAccess(command, userId, player) {
 if (!player || readOnlyCommands.has(command)) return;
 const ownerId = player.queue.currentTrack?.requestedBy
  || player.previousTrack?.requestedBy
  || player.userdata?.ownerId;
 if (!ownerId || ownerId !== userId) {
  throw new Error('Bạn không có quyền điều khiển: chỉ người yêu cầu bài đang phát mới được thay đổi nhạc.');
 }
}
