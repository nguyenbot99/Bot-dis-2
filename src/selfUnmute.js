// Tối đa một vòng hẹn giờ cho mỗi máy chủ, không tạo setInterval hay giữ tệp/bộ đệm.
// Chỉ thử tiếp khi bot vẫn ở phòng cũ và Discord vẫn báo Server Mute.
export function createSelfUnmuteController({ getContext, onError = () => {}, intervalMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
 const loops = new Map();
 const lastAttemptAt = new Map();
 function stop(guildId) {
  const state = loops.get(guildId);
  if (!state) return;
  loops.delete(guildId);
  if (state.timer) clearTimer(state.timer);
 }
 async function attempt(guildId, state, initialVoiceState = null) {
  if (loops.get(guildId) !== state) return;
  let context;
  try { context = await getContext(guildId, state.channelId, initialVoiceState); }
  catch (err) { onError(guildId, err); stop(guildId); return; }
  if (loops.get(guildId) !== state) return;
  if (!context?.active || !context.muted) { stop(guildId); return; }
  if (!context.canUnmute) {
   onError(guildId, new Error('Bot thiếu quyền Tắt tiếng thành viên trong kênh thoại.'));
   stop(guildId);
   return;
  }
  if (lastAttemptAt.size >= 50 && !lastAttemptAt.has(guildId)) lastAttemptAt.clear();
  lastAttemptAt.set(guildId, now());
  try {
   await context.unmute();
   state.attempts = Math.min(1000000, state.attempts + 1);
  } catch (err) {
   onError(guildId, err);
   // Thiếu quyền: dừng ngay, không gửi yêu cầu lỗi vô hạn tới Discord.
   if (err?.code === 50013 || err?.status === 403) { stop(guildId); return; }
  }
  if (loops.get(guildId) !== state) return;
  state.timer = setTimer(() => {
   state.timer = null;
   void attempt(guildId, state);
  }, intervalMs);
  state.timer?.unref?.();
 }
 function start(guildId, channelId, initialVoiceState = null) {
  if (loops.has(guildId)) return false;
  if (loops.size >= 50) return false;
  const state = { channelId, timer: null, attempts: 0 };
  loops.set(guildId, state);
  const previous = lastAttemptAt.get(guildId);
  const waitMs = previous === undefined ? 0 : Math.max(0, intervalMs - (now() - previous));
  if (waitMs > 0) {
   state.timer = setTimer(() => {
    state.timer = null;
    void attempt(guildId, state);
   }, waitMs);
   state.timer?.unref?.();
  } else {
   void attempt(guildId, state, initialVoiceState);
  }
  return true;
 }
 return { start, stop, isRunning: guildId => loops.has(guildId) };
}
