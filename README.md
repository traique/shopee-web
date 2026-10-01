# Shopee Chromium CDP

Repo độc lập chỉ chạy **Chromium headless + CDP WebSocket proxy** cho flow Shopee Affiliate của repo `lananh`.

Repo này **không chứa code Telegram, Facebook, Shopee session, DB hay business logic**. Repo `lananh` giữ nguyên source code và tiếp tục dùng logic hiện có. Điểm nối duy nhất là biến môi trường đã tồn tại trong `lananh`:

```text
SHOPEE_BROWSER_CDP_URL
```

## Kiến trúc

```text
lananh (Render Free 512 MB)
  Playwright connect_over_cdp(...)
              |
              | HTTPS discovery → WSS
              v
shopee-chromium-cdp (Render Free 512 MB)
  Node proxy (~nhẹ)
              |
              | ws://127.0.0.1:9222
              v
       Chromium headless
```

Chromium chỉ được mở khi có kết nối CDP hợp lệ. Mỗi worker chỉ nhận **1 client CDP tại một thời điểm** để tránh nhiều renderer tranh 512 MB RAM.

## Deploy lên Render

1. Tạo **repo Git mới** chỉ chứa nội dung thư mục này.
2. Push lên GitHub/GitLab.
3. Render → **New → Blueprint** và chọn repo mới (hoặc New Web Service dùng Docker).
4. Chọn Free plan nếu Blueprint không tự chọn.
5. Tạo `CDP_TOKEN` dài ít nhất 32 ký tự. Ví dụ:

```bash
openssl rand -hex 32
```

6. Điền token đó vào Environment của service `shopee-chromium-cdp`.
7. Chờ deploy hoàn tất rồi kiểm tra:

```text
https://<service>.onrender.com/healthz
```

Response bình thường:

```json
{
  "ok": true,
  "chromium": {"running": false, "pid": null, "lastExit": null},
  "memory": {"usageMb": 45, "limitMb": 512},
  "activeClient": false
}
```

`running=false` khi idle là **đúng**: Chromium được launch lazy ở lần `/fb_link` tiếp theo.

## Kết nối repo `lananh` mà không sửa source

Trong Render service của `lananh`, chỉ đặt:

```text
SHOPEE_BROWSER_CDP_URL=https://<service>.onrender.com/cdp/<CDP_TOKEN>
```

Ví dụ:

```text
SHOPEE_BROWSER_CDP_URL=https://shopee-chromium-cdp.onrender.com/cdp/0123456789abcdef...
```

Không cần đổi `services/shopee_affiliate_browser.py`. Code hiện tại của `lananh` đã ưu tiên `SHOPEE_BROWSER_CDP_URL` và gọi:

```python
await playwright.chromium.connect_over_cdp(config.SHOPEE_BROWSER_CDP_URL)
```

`SHOPEE_BROWSER_ENGINE` trong `lananh` sẽ không được dùng khi `SHOPEE_BROWSER_CDP_URL` có giá trị.

## Lưu ý bảo mật

CDP có quyền điều khiển toàn bộ browser. Port 9222 vẫn chỉ bind `127.0.0.1`. Worker chỉ public hai route có token: HTTP discovery `/cdp/<CDP_TOKEN>/json/version[/]` và WebSocket `/cdp/<CDP_TOKEN>`. Discovery rewrite `webSocketDebuggerUrl` về WebSocket public, nên không làm lộ `127.0.0.1:9222`.

**Quan trọng:** source `lananh` hiện log nguyên `SHOPEE_BROWSER_CDP_URL` khi kết nối browser ngoài. Vì yêu cầu là giữ repo `lananh` hoàn toàn nguyên trạng, token nằm trong URL cũng có thể xuất hiện trong Render logs của `lananh`. Không chia sẻ log đó công khai. Muốn loại bỏ rủi ro này hoàn toàn cần một thay đổi nhỏ bên `lananh` để redact URL trước khi log, nhưng thay đổi đó không nằm trong repo này.

## Render Free

Render public web services nhận HTTP và WebSocket trên cùng một public port. Free web service có thể spin down sau 15 phút không có inbound HTTP/WebSocket traffic và được wake lại khi có request/connection mới. Vì vậy lần `/fb_link` đầu tiên sau thời gian idle có thể chậm hơn bình thường.

Repo `lananh` hiện tính timeout cho một browser batch đủ lớn hơn cold-start thông thường; nếu môi trường thực tế wake quá chậm, có thể tăng biến `SHOPEE_BROWSER_LAUNCH_BUDGET_SEC` **trong Environment của lananh** mà không sửa source.

## RAM

Worker dùng một Chromium, một renderer limit và V8 heap hint 192 MB. `CHROME_JS_HEAP_MB` chỉ giới hạn V8 heap, **không phải tổng RAM Chromium**. Endpoint `/healthz` hiển thị cgroup memory để quan sát peak thực tế trên Render.

Các biến tùy chọn:

```text
CHROME_JS_HEAP_MB=192
CHROME_START_TIMEOUT_MS=30000
CHROME_DEBUG_PORT=9222
CHROME_EXECUTABLE=/usr/bin/chromium
```

Không tăng concurrency trên Free 512 MB.

## Local test

```bash
npm ci
npm test
```

Chạy container:

```bash
docker build -t shopee-chromium-cdp .
docker run --rm -p 10000:10000 \
  -e CDP_TOKEN="$(openssl rand -hex 32)" \
  shopee-chromium-cdp
```

## Health vs CDP

- `GET /healthz`: health/metric nhẹ, không tự mở Chromium.
- `GET /cdp/<token>/json/version[/]`: Playwright CDP discovery, mở Chromium nếu chưa chạy.
- `wss://host/cdp/<token>`: CDP bridge sau discovery.
- endpoint khác: `404`.
- client CDP thứ hai trong lúc đang xử lý: `429`.
