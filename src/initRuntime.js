import { installResilientDnsShield } from './networkShield.js';

// Tăng nhẹ số luồng I/O/DNS của libuv lên 8 (trước khi libuv khởi tạo) để 1 truy vấn DNS chậm trên VPS dùng chung
// không bao giờ làm nghẽn cả 4 luồng mặc định gây trễ nhịp tim Heartbeat của Discord Gateway.
if (!process.env.UV_THREADPOOL_SIZE) {
 process.env.UV_THREADPOOL_SIZE = '8';
}

installResilientDnsShield();
