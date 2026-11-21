// Canh phòng thoại 24/7 lúc chưa phát nhạc: hai lần kiểm tra trước khi nối lại,
// và không thử liên tục nếu quản trị viên đã đưa bot ra khỏi phòng.
export const IDLE_247_CHECK_MS = 20_000;
export const IDLE_247_GRACE_MS = 30_000;
export const IDLE_247_WINDOW_MS = 10 * 60_000;
export const IDLE_247_MAX_ATTEMPTS = 2;

export function createIdle247RecoveryPolicy() {
 const states = new Map();
 function reset(guildId) { states.delete(guildId); }
 function check(guildId, { active, healthy, now = Date.now() }) {
  if (!active) { reset(guildId); return 'none'; }
  let state = states.get(guildId);
  if (!state) {
   if (states.size >= 50) states.clear();
   state = { missingSince: null, attempts: [] };
   states.set(guildId, state);
  }
  state.attempts = state.attempts.filter(ts => now >= ts && now - ts < IDLE_247_WINDOW_MS);
  if (healthy) { state.missingSince = null; return 'healthy'; }
  if (state.missingSince === null) { state.missingSince = now; return 'wait'; }
  if (now - state.missingSince < IDLE_247_GRACE_MS) return 'wait';
  if (state.attempts.length >= IDLE_247_MAX_ATTEMPTS) return 'limit';
  state.attempts.push(now);
  state.missingSince = now;
  return 'reconnect';
 }
 return { check, reset };
}
