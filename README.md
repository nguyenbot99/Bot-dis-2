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

Điền trong `.env`:
- DISCORD_TOKEN: Bot Token từ Discord Developer Portal, không phải OAuth client secret.
- CLIENT_ID: Application ID.
- GUILD_ID: Server ID được phép sử dụng bot.
- PORT: cổng web host cấp. Nếu không đặt, chương trình đọc SERVER_PORT hoặc dùng 3000.
- NODE_OPTIONS: giới hạn old-space 128 MB; KHÔNG giới hạn tổng RAM.

Đăng ký lệnh (chỉ chạy khi thay đổi danh sách lệnh):

```sh
npm run register
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

Lệnh: `/loop mode:off|track|queue`, `/shuffle`, `/volume percent:0–100`, `/remove position:1–20`, `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`, `/nowplaying`, `/ping`.
Lệnh phản hồi riêng cho người dùng; chỉ người cùng voice mới điều khiển được. `/queue` hiển thị 10 bài; không gửi mention từ tiêu đề. Bot không lưu hàng đợi ra đĩa; restart sẽ mất phiên phát.

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

Pterodactyl:
1. Chọn egg Node.js với image Node 22 >=22.12.0; upload nội dung dự án (không upload node_modules).
2. Cài `npm ci --omit=dev` bằng console/install step host cung cấp.
3. Đặt DISCORD_TOKEN, CLIENT_ID, GUILD_ID, PORT theo allocation; đặt `NODE_OPTIONS=--max-old-space-size=128` nếu muốn giới hạn heap.
4. Startup `npm start` hoặc `node index.js`.
5. Chạy đăng ký slash command một lần bằng console/task riêng trước khi start.
6. Bật restart-on-crash của panel, tránh chạy thêm PM2 trong container RAM thấp.

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
index.js                 Discord client, player, HTTP, graceful shutdown
src/commands.js          Slash command schema
src/policy.js            Kiểm tra đầu vào
scripts/register.js      Đăng ký lệnh một guild
test/policy.test.js       Unit tests
.env.example             Cấu hình mẫu không chứa bí mật
Dockerfile               Image Node 22
package-lock.json        Dependency lock
```
