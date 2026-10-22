# Zi Light Music Bot

Bot Discord Music bằng JavaScript ESM, discord.js v14 và ZiPlayer. Thiết kế cho **một guild / một phiên voice**, ưu tiên tiết kiệm tài nguyên, không cam kết RAM <256 MB hoặc uptime 24/7 trên host miễn phí.

## 1. Phiên bản và yêu cầu thực tế

- **Node >=22.12.0**, đề xuất Node 22 LTS; npm và Linux x64 có truy cập outbound HTTPS + Discord voice UDP.
- discord.js 14.27.0, ziplayer 1.0.4, @discordjs/voice 0.19.2; toàn bộ dependency trực tiếp ghim phiên bản trong package.json, dependency bắc cầu cố định qua package-lock.json.
- Không hỗ trợ Node 18/20 trong cấu hình này: dependency voice hiện tại đòi Node >=22.12.0. Không dùng `--force` để bỏ qua engines.
- Plugin nguồn là `@ziplayer/plugin`, cần cài riêng ngoài `ziplayer`.
- `opusscript` dễ cài nhưng tốn CPU hơn native Opus. Không cài đồng thời nhiều encoder khi chưa đo. ffmpeg-static tải binary trong quá trình npm ci, host phải cho phép tải.

Tham khảo upstream đã đối chiếu khi xây dựng:
https://github.com/ZiProject/ZiPlayer/tree/main
https://github.com/ZiProject/ZiPlayer/blob/main/README.md

Bản main có thể khác bản npm phát hành. Mã dùng API của **npm 1.0.4**. Plugin import trực tiếp hai module dist trong gói đã ghim để tránh nạp toàn bộ TTS/Spotify qua barrel; đây là đường dẫn nội bộ, phải kiểm tra lại khi nâng phiên bản.

## 2. Cài đặt

```sh
node --version
npm ci --omit=dev
cp .env.example .env
```

Điền trong `.env` (trên **botkeep.cloud** chỉ cần cấu hình `DISCORD_TOKEN` trong phần Environment/Token là chạy được ngay):
- DISCORD_TOKEN: Bot Token từ Discord Developer Portal (cũng chấp nhận alias `BOT_TOKEN`).
- CLIENT_ID: *(tùy chọn)* Application ID — nếu để trống, bot/script tự lấy từ token.
- GUILD_ID: *(tùy chọn)* Server ID được phép sử dụng bot (17–20 chữ số). Nếu để trống, bot tự đồng bộ lệnh slash cho các server bot tham gia (tối đa 5 server) và vẫn giới hạn tối đa 1 phiên phát đồng thời.
- AUTO_REGISTER: *(mặc định `true`)* tự đồng bộ 16 lệnh slash khi bot kết nối (`ClientReady` / `GuildCreate`). Đặt `false` nếu chỉ muốn đăng ký thủ công qua `npm run register`.
- PORT: cổng web host cấp. Nếu không đặt, chương trình đọc SERVER_PORT hoặc dùng 3000 (tự chuyển cổng trống nếu 3000 bận).
- NODE_OPTIONS: giới hạn old-space 128 MB; KHÔNG giới hạn tổng RAM.

Khởi chạy (lệnh slash sẽ tự đăng ký khi bot online, hoặc chạy `npm run register` thủ công nếu đặt `AUTO_REGISTER=false`):

```sh
npm start
```

Script start chính xác là `node index.js`. Không cần build TypeScript.

## 3. Cấu hình Discord

1. Tạo application và bot trong Developer Portal; copy token vào biến môi trường bí mật.
2. OAuth2 URL Generator: scope `bot`, `applications.commands`.
3. Chỉ cấp View Channels, Connect, Speak; không cần Administrator.
4. Mời bot vào guild khớp GUILD_ID, chạy register.
5. Không bật Message Content, Presence hoặc Server Members privileged intent. Bot chỉ dùng Guilds và GuildVoiceStates.
6. Vào kênh voice thường rồi `/play query: tên bài`.

Lệnh: `/help`, `/join`, `/leave`, `/247 [mode:on|off]`, `/loop mode:off|track|queue`, `/shuffle`, `/volume percent:0–100`, `/remove position:1–20`, `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`, `/nowplaying`, `/ping` *(Discord không cho dấu `/` trong tên lệnh nên 24/7 được đặt là `/247`)*.
Lệnh phản hồi riêng cho người dùng; chỉ người cùng voice và là người yêu cầu bài đang phát mới điều khiển được (không có ngoại lệ cho admin). Quyền áp dụng cả /play khi đã có phiên phát, pause/resume/skip/stop/loop/shuffle/volume/remove. Khi chuyển bài, quyền đi theo requestedBy của bài mới. Trong khoảng chuyển bài, quyền giữ theo bài trước; trước bài đầu tiên dùng người tạo phiên. `/help`, `/queue`, `/nowplaying` và `/ping` là lệnh xem thông tin, không bị giới hạn này. `/queue` hiển thị 10 bài; không gửi mention từ tiêu đề. Bot không lưu hàng đợi ra đĩa; restart sẽ mất phiên phát.

## 4. Chính sách tiết kiệm tài nguyên

- Một phiên phát, một guild; không Message cache, không Presence cache, member cache giới hạn.
- Không preload, crossfade, smart transition, loudness normalization, filter, autoplay, TTS hoặc Spotify. Loop/shuffle chỉ thao tác hàng đợi; volume có thể tăng CPU khi cần xử lý âm lượng.
- Search cache/stats của manager tắt. Chỉ lấy một track từ kết quả; tối đa 20 bài chờ, mỗi bài tối đa 10 phút, không livestream/playlist.
- Yêu cầu người dùng dùng tên bài hoặc URL HTTPS YouTube/SoundCloud. Không nhận local file, URL tùy ý hay endpoint nội bộ từ lệnh.
- Tự rời khi kết thúc hoặc kênh trống sau khoảng 30 giây qua lifecycle ZiPlayer; `/stop` hủy player ngay.
- Khóa xử lý lệnh âm nhạc toàn cục, cooldown /play 5 giây; không cho các request search chồng lên nhau.
- Không retry stream vô hạn. Lỗi player hủy phiên; lỗi tiến trình nghiêm trọng thoát để host restart.
- SIGINT/SIGTERM dọn manager, voice, client và HTTP server.

**256 MB là ngân sách cần kiểm thử, không phải bảo đảm.** JS heap, Buffer, Opus WASM, plugin YouTube và tiến trình FFmpeg đều tiêu thụ RAM. Search có thể tải metadata playlist trước khi trả kết quả nếu nguồn thay đổi hành vi. Giới hạn heap không giới hạn RSS/cgroup. Nếu vượt: giảm tải, kiểm tra tiến trình con hoặc nâng gói; không nên giảm heap quá mức gây restart liên tục.

## 5. botkeep.cloud / Pterodactyl

Chưa xác minh chính sách gói Free hiện tại của botkeep.cloud. Chỉ triển khai nếu gói cho Node 22+, tiến trình liên tục, đủ RAM/CPU, outbound UDP voice và tải ffmpeg. Nếu không có thì không tương thích dù web health vẫn hoạt động.

botkeep.cloud / Pterodactyl:
1. Kết nối repo GitHub hoặc upload mã nguồn dự án (không upload `node_modules` hay `.env`), chọn Node >=22.12.0.
2. Dán Bot Token vào biến môi trường `DISCORD_TOKEN` trên panel (trên botkeep.cloud chỉ cần mỗi `DISCORD_TOKEN`; `GUILD_ID` là tùy chọn nếu muốn khóa cứng vào 1 server ID 17–20 chữ số).
3. Startup command: `npm start` (`node index.js`). Khi online, bot tự đồng bộ 16 lệnh slash cho server của bạn mà không cần chạy bước `register` riêng.
4. Khi cập nhật code mới trên GitHub, mở tab **GitHub** trên panel Botkeep để pull phiên bản mới về rồi Restart (nút Redeploy không tự kéo commit mới từ GitHub).
5. Bật restart-on-crash của panel, tránh chạy thêm PM2 trong container RAM thấp.

Không tự ping hoặc mở nhiều web worker. `GET /healthz` trả 200 khi Discord client ready, 503 khi chưa ready; `/` chỉ báo dịch vụ web đang sống. Endpoint bind `0.0.0.0`. Health endpoint không chứng minh audio hoạt động và **không vượt được sleep/time quota/termination** do nhà cung cấp áp dụng. Chỉ dùng uptime monitor bên ngoài nếu điều khoản host cho phép.

Docker (tùy chọn):
```sh
docker build -t zi-light .
docker run --env-file .env --memory=256m --restart=unless-stopped -p 3000:3000 zi-light
```

Docker memory limit là giới hạn cứng, có thể OOM kill; không phải lời cam kết bot chạy vừa 256 MB.

## 6. Kiểm thử và đo RAM

```sh
npm test
npm run check
```

Đã chạy: 4 unit tests (query validation và command schema), kiểm tra cú pháp index.js; smoke test trên Node 22 khởi tạo plugin/manager/player và destroy thành công. **Chưa login Discord hoặc thử phát âm thanh thực tế**, vì chưa có token/guild. Không giả lập kết quả benchmark.

Kiểm thử trước khi đưa vào chạy dài hạn:
- /play bằng tên bài và link, pause/resume/skip, queue/stop.
- Bot thiếu quyền, người dùng khác voice, playlist và nguồn hỏng.
- Mọi người rời voice, hết hàng đợi, shutdown/restart.
- Đo idle, search, phát nhạc và chuyển bài qua panel/cgroup hoặc `docker stats`; theo dõi ít nhất 24 giờ. `/ping` chỉ đo RSS Node, không bao gồm FFmpeg.
- Test lại khi nguồn YouTube chặn IP/đòi đăng nhập. Không có bảo đảm nguồn nhạc hoạt động mãi; bot không vượt cơ chế chặn. Chỉ phát nội dung bạn có quyền sử dụng.

## 7. Bảo mật

Không commit `.env`, token hoặc private SSH key. Dự án không chứa deploy key đã tạo ở bước trước. Không đưa private key vào ZIP hoặc Docker image. Nếu token bị lộ, reset ngay. Chỉ public key mới được nhập vào GitHub Deploy keys; deploy read-only là đủ cho pull code.

## Cấu trúc

```
index.js                 Discord client, player, khung điều khiển tương tác, HTTP, graceful shutdown
src/commands.js          Slash command schema & khung Embed /help
src/playerGui.js         Khung Music Player tương tác kiểu Ziji V10 (Components V2, nút bấm, menu, modal, Embeds)
src/access.js            Kiểm tra quyền điều khiển theo người yêu cầu bài đang phát
src/policy.js            Kiểm tra đầu vào và biến môi trường
scripts/register.js      Đăng ký lệnh thủ công
test/*.test.js           Bộ unit tests kiểm tra quyền, đầu vào và giao diện
.env.example             Cấu hình mẫu không chứa bí mật
Dockerfile               Image Node 22
package-lock.json        Dependency lock
```
