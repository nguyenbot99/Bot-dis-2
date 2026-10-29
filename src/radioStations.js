// Danh sách các Đài Radio Không Ngủ theo tâm trạng: tự chọn lọc các bài trọn vẹn chất lượng cao & tự bật AutoPlay phát xuyên đêm.

export const RADIO_STATIONS = {
 lofi: {
  id: 'lofi',
  emoji: '☕',
  label: 'Lo-Fi Chill Học Bài & Code Đêm',
  name: 'Đài Lo-Fi Chill Học Bài & Code Đêm',
  description: 'Giai điệu Lo-Fi êm dịu, thư giãn tập trung xuyên đêm',
  defaultVibe: 'normal',
  defaultPreset: 'hd',
  queries: [
   'lofi hip hop chill beats to study relax',
   'japanese lofi chillhop aesthetic beats',
   'coffee shop lofi chill instrumental',
  ],
 },
 vpop: {
  id: 'vpop',
  emoji: '🇻🇳',
  label: 'V-Pop Ballad & Indie Tâm Trạng',
  name: 'Đài V-Pop Ballad & Indie Tâm Trạng',
  description: 'Tuyển tập Ballad & Indie Việt Nam sâu lắng dễ nghe',
  defaultVibe: 'normal',
  defaultPreset: 'vocal',
  queries: [
   'nhạc trẻ ballad việt nhẹ nhàng sâu lắng',
   'indie việt chill buồn tâm trạng',
   'vpop acoustic mộc mạc dễ nghe',
  ],
 },
 edm: {
  id: 'edm',
  emoji: '🔥',
  label: 'EDM & Remix Khuấy Động Phòng',
  name: 'Đài EDM & Remix Khuấy Động Phòng',
  description: 'Nhịp bass căng tràn năng lượng khuấy động kênh thoại',
  defaultVibe: 'normal',
  defaultPreset: 'bass',
  queries: [
   'melodic progressive house festival anthem',
   'future bass edm energetic drop',
   'vietnam club house remix sôi động',
  ],
 },
 piano: {
  id: 'piano',
  emoji: '🎹',
  label: 'Piano & Anime Ghibli Không Lời',
  name: 'Đài Piano & Anime Ghibli Không Lời',
  description: 'Tiếng dương cầm trong trẻo từ phim Ghibli & Anime',
  defaultVibe: 'normal',
  defaultPreset: 'hd',
  queries: [
   'studio ghibli relaxing piano collection track',
   'emotional anime ost solo piano',
   'yiruma relaxing neo classical piano',
  ],
 },
 usuk: {
  id: 'usuk',
  emoji: '🌎',
  label: 'US-UK Pop & Chill Hits',
  name: 'Đài US-UK Pop & Chill Hits',
  description: 'Những bản Pop & R&B Âu Mỹ bắt tai nhất',
  defaultVibe: 'normal',
  defaultPreset: 'hd',
  queries: [
   'pop chill english hits acoustic',
   'indie pop late night drive english',
   'rnb chill vibes smooth vocals',
  ],
 },
 sleep: {
  id: 'sleep',
  emoji: '🌧️',
  label: 'Acoustic & Ambient Dịu Êm Dễ Ngủ',
  name: 'Đài Acoustic & Ambient Dịu Êm Dễ Ngủ',
  description: 'Âm thanh guitar mộc và ambient nhẹ nhàng đưa vào giấc ngủ',
  defaultVibe: 'normal',
  defaultPreset: 'hd',
  queries: [
   'calm ambient sleep music soft piano',
   'soft acoustic guitar peaceful night',
   'warm pad ambient relaxation track',
  ],
 },
};

export const RADIO_STATION_IDS = Object.keys(RADIO_STATIONS);

export function resolveRadioStation(stationId) {
 const key = String(stationId ?? '').trim().toLowerCase();
 const station = RADIO_STATIONS[key];
 if (!station) {
  throw new Error('Đài Radio không hợp lệ.');
 }
 return station;
}
