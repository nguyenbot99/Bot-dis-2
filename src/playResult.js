// ZiPlayer.pause() trả về boolean, không phải Promise; hỗ trợ cả dạng đồng bộ/lời hứa
// để khôi phục bài đang tạm dừng không bị lỗi `.catch is not a function`.
export async function pausePlayerSafely(player) {
 try { return await player.pause(); } catch { return false; }
}

// ZiPlayer có thể trả false trong khi yêu cầu đã vào hàng đợi hoặc bắt đầu phát.
export async function playTrackChecked(player, track, userId, { waitMs = 2000, intervalMs = 100 } = {}) {
 const ok = await player.play(track, userId);
 if (ok) return true;
 const matches = item => item && (item === track || (item.id === track.id && item.source === track.source && item.requestedBy === track.requestedBy));
 const deadline = Date.now() + waitMs;
 do {
  const current = player.queue?.currentTrack;
  if (matches(current) && (player.isPlaying || player.isBuffering || player.isPaused)) return true;
  if (player.queue?.tracksList?.some(matches)) return true;
  if (Date.now() >= deadline || player.destroyed) break;
  await new Promise(resolve => setTimeout(resolve, intervalMs));
 } while (true);
 return false;
}
