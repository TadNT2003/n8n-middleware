# Báo cáo: Triển khai n8n trong môi trường local network

## Tổng quan hạ tầng

Toàn bộ stack chạy trên một máy self-host. Cloudflare Tunnel đóng vai trò cầu nối giữa internet và máy chủ — không mở port nào ra ngoài. Bên trong, Traefik là reverse proxy trung tâm điều phối traffic vào các service.

```
Internet
  │
  ▼
Cloudflare Tunnel  (không expose port vật lý ra ngoài)
  │
  ▼
Traefik  (traefik_reverse_proxy network)
  │  n8n-webhooks-proxy : POST /webhook/* hoặc /webhook-test/*
  │  n8n-all-proxy      : tất cả method / path còn lại
  ▼
Hono middleware  (kiểm soát truy cập theo biến môi trường)
  │  /webhook/*         → xác thực chữ ký GitHub (nếu có secret) → proxy n8n
  │  non-/api/* paths   → proxy n8n (chỉ khi N8N_EXPOSE_UI=true)
  │  /api/*             → proxy n8n (chỉ khi N8N_EXPOSE_API=true)
  │  còn lại            → 404
  ▼
n8n Enterprise  (chỉ nằm trên internal Docker network)
```

---

## 1. Cách middleware hoạt động

Middleware được xây dựng bằng [Hono](https://hono.dev/) v4 trên Node.js 22 LTS, đóng vai trò là một HTTP proxy mỏng chuyên xử lý webhook.

### Bảng route

| Method | Path | Điều kiện | Hành vi |
| --- | --- | --- | --- |
| `GET` | `/health` | Luôn bật | Trả về `{"status":"ok"}` |
| `POST` | `/webhook/*` | Luôn bật | Xác thực chữ ký GitHub (nếu có secret) → proxy n8n |
| `POST` | `/webhook-test/*` | Luôn bật | Xác thực chữ ký GitHub (nếu có secret) → proxy n8n |
| Bất kỳ | Các path không phải `/api/*` | `N8N_EXPOSE_UI=true` | Proxy n8n (giao diện web, static assets, `/rest/*`) |
| Bất kỳ | `/api/*` | `N8N_EXPOSE_API=true` | Proxy n8n (REST API công khai) |
| Bất kỳ | Tất cả còn lại | — | `404 Not Found` |

### Xác thực chữ ký GitHub

Khi biến môi trường `GITHUB_WEBHOOK_SECRET` được đặt, middleware sẽ xác thực mọi request `POST /webhook/*` trước khi proxy sang n8n:

1. Kiểm tra header `X-Hub-Signature-256` — trả về `401` nếu thiếu
2. Tính HMAC-SHA256 của request body với secret làm key, so sánh với chữ ký nhận được
3. Dùng so sánh constant-time (`timingSafeEqual`) để tránh timing attack
4. Trả về `401 Invalid signature` nếu không khớp; forward sang n8n nếu hợp lệ

Khi xác thực được kích hoạt, body của request được **buffer vào bộ nhớ** (thay vì stream trực tiếp) để tính HMAC, sau đó buffer đó được dùng lại khi gọi n8n.

### Cơ chế proxy

Mỗi request được proxy sang n8n với toàn bộ thông tin gốc:

- **Body** được stream trực tiếp (không buffer) khi không có xác thực chữ ký; được buffer để tính HMAC khi `GITHUB_WEBHOOK_SECRET` được đặt
- **Headers** được giữ nguyên, đồng thời bổ sung `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto: https` để n8n nhận ra client thực
- **Query string** được bảo toàn — nhiều webhook sender (như GitHub) gửi tham số trên URL
- **Response** từ n8n (status code, headers, body) được stream ngược về caller không thay đổi

Traefik có hai router rule ở cấp load-balancer:

```
# Router chuyên biệt cho webhook (ưu tiên cao hơn)
n8n-webhooks-proxy: (PathPrefix(`/webhook/`) || PathPrefix(`/webhook-test/`)) && Method(`POST`) && Host(`n8n.mydomain.com`)

# Router bắt-tất-cả (ưu tiên thấp hơn, cần thiết khi bật N8N_EXPOSE_UI hoặc N8N_EXPOSE_API)
n8n-all-proxy: Host(`n8n.mydomain.com`)
```

Router `n8n-all-proxy` luôn được khai báo trong `docker-compose.yml`. Khi cả `N8N_EXPOSE_UI` và `N8N_EXPOSE_API` đều là `false`, traffic vào router này vẫn nhận `404` từ middleware — không có rủi ro bảo mật.

---

## 2. n8n không tiếp xúc trực tiếp với internet

Trong `docker-compose.yml` của n8n stack, toàn bộ block `labels` của Traefik trên service `n8n-patch-enterprise` đã được comment out:

```yaml
# labels:
  # - traefik.enable=true
  # - "traefik.http.routers.n8n-enty.rule=Host(`${SUBDOMAIN}.${DOMAIN_NAME}`)"
  # ...
```

Điều này có nghĩa:

- Traefik **không** tạo router nào trỏ trực tiếp đến n8n
- n8n **không** nhận được bất kỳ request nào từ internet hoặc từ Traefik
- n8n chỉ lắng nghe trên Docker internal network (`default`) và `traefik_reverse_proxy` network
- Duy nhất Hono middleware — nằm trên cùng Docker network — mới có thể gọi `http://n8n:5678`

Kết quả: toàn bộ UI, API, và workflow editor của n8n bị ẩn khỏi internet. Mọi request từ bên ngoài vào đường `n8n.mydomain.com` mà không phải `POST /webhook/*` đều nhận `404` ngay tại Traefik.

---

## 3. Webhook hoạt động bình thường — test với GitHub

Webhook của GitHub sử dụng `POST` kèm `Content-Type: application/json` hoặc `application/x-www-form-urlencoded`, phù hợp chính xác với cơ chế proxy của middleware.

Luồng khi GitHub gửi event (ví dụ: `push`):

```
GitHub
  │  POST https://n8n.mydomain.com/webhook/<id>
  │  Headers: X-GitHub-Event, X-Hub-Signature-256, Content-Type, ...
  ▼
Cloudflare Tunnel → Traefik
  │  Rule khớp: POST + PathPrefix(/webhook/) + Host(n8n.mydomain.com)
  ▼
Hono middleware
  │  Xác thực X-Hub-Signature-256 (HMAC-SHA256 với GITHUB_WEBHOOK_SECRET)
  │  Thêm X-Forwarded-For, X-Forwarded-Proto: https
  │  Forward body và headers sang n8n
  ▼
n8n  (xử lý workflow, trả về 200)
  │
  ▼
Hono middleware stream response về → Traefik → Cloudflare → GitHub
```

Middleware tự xác thực `X-Hub-Signature-256` trước khi forward — nếu chữ ký sai hoặc thiếu, request bị từ chối ngay tại middleware với `401`, không bao giờ chạm đến n8n. Sau khi xác thực thành công, n8n nhận được đầy đủ headers gốc từ GitHub và trả về HTTP 200, GitHub xác nhận delivery thành công.

---

## 4. Toàn bộ nằm sau reverse proxy Traefik

Traefik là điểm vào duy nhất cho tất cả traffic HTTP/HTTPS từ internet vào hạ tầng:

| Service | Tiếp cận qua Traefik | Router rule |
| --- | --- | --- |
| Hono middleware (webhook) | Có | `POST + /webhook/* + Host(n8n.mydomain.com)` |
| Hono middleware (all-proxy) | Có | `Host(n8n.mydomain.com)` — middleware tự gate theo `N8N_EXPOSE_*` |
| mitmweb UI | Có | `Host(mitm.mydomain.com)` |
| n8n UI/API trực tiếp | Không | Labels bị comment, không có router |

Traefik đọc labels từ Docker provider, không cần thay đổi static config. TLS được quản lý tự động qua cert resolver (`mytlschallenge`). Cả middleware và mitmproxy đều join vào network `traefik_reverse_proxy` (external) để Traefik nhận diện và route.

---

## 5. Tailscale — VPN truy cập trực tiếp vào n8n

Tailscale tạo một WireGuard mesh VPN, cho phép truy cập trực tiếp vào n8n mà không qua Cloudflare Tunnel hay Traefik — tương tự như OpenVPN nhưng không cần cấu hình server phức tạp.

Theo sơ đồ hạ tầng, Tailscale client kết nối đến n8n qua địa chỉ Tailscale IP (ví dụ `100.100.100.100`):

```
Tailscale client (máy dev, laptop,...)
  │  GET 100.100.100.100:5678  (Tailscale IP của máy self-host)
  ▼
n8n Enterprise  (truy cập trực tiếp, không qua Traefik)
  │  status: 200
```

So sánh với OpenVPN:

| Tiêu chí | Tailscale | OpenVPN |
|----------|-----------|---------|
| Cài đặt | Không cần server riêng, dùng Tailscale coordination server | Cần server OpenVPN riêng |
| Cấu hình | Cài client, đăng nhập, xong | Tạo cert, config file, phức tạp hơn |
| Giao thức | WireGuard (nhanh, hiệu quả) | OpenVPN (TCP/UDP) |
| Mục đích | Như nhau: truy cập private network an toàn |

Qua Tailscale, người dùng nội bộ có thể dùng toàn bộ n8n UI, quản lý workflow, và xem logs — mà không cần mở bất kỳ port nào ra internet.

---

## 6. Cấu hình môi trường để webhook URL trên UI hoạt động đúng

Có hai mục đích tách biệt cần cấu hình:

- `N8N_HOST` / `N8N_PORT` / `N8N_PROTOCOL` — xác định địa chỉ n8n **lắng nghe**. Đặt về `localhost` và `http` để đảm bảo n8n chỉ nhận connection từ trong cùng máy/network nội bộ, không thể bị gọi trực tiếp từ bên ngoài.
- `WEBHOOK_URL` — hoàn toàn khác: đây là URL **public** mà n8n dùng để **sinh ra** webhook URL hiển thị trong editor. Nó trỏ đến middleware (qua Traefik), không phải địa chỉ n8n thực sự lắng nghe.

**Cấu hình trong n8n stack:**

```dotenv
# .env của n8n stack

# n8n chỉ lắng nghe trên localhost, không expose ra ngoài
N8N_HOST=localhost
N8N_PORT=5678
N8N_PROTOCOL=http

# URL public của middleware — n8n dùng để sinh webhook URL trong editor
WEBHOOK_URL=https://n8n.mydomain.com/
```

**Cấu hình trong middleware:**

```dotenv
# .env của n8n-middleware
N8N_BASE_URL=http://n8n:5678
N8N_MIDDLEWARE_HOST=n8n.mydomain.com
PORT=3000

# Xác thực chữ ký GitHub (tuỳ chọn — bỏ trống nếu không dùng)
GITHUB_WEBHOOK_SECRET=

# Cho phép truy cập giao diện web n8n qua middleware (mặc định: false)
N8N_EXPOSE_UI=false

# Cho phép truy cập REST API công khai của n8n (/api/*) qua middleware (mặc định: false)
N8N_EXPOSE_API=false
```

Với cấu hình này, khi mở workflow editor, n8n hiển thị webhook URL dạng:

```
https://n8n.mydomain.com/webhook/<workflow-id>
```

URL này có thể dùng trực tiếp để cấu hình trên GitHub, Slack, hay bất kỳ service nào — vì Traefik + middleware đã sẵn sàng nhận và forward request về n8n.

---

## 7. Outbound từ n8n được proxy qua mitmproxy

Trong `docker-compose.yml`, n8n được cấu hình dùng mitmproxy làm HTTP/HTTPS proxy cho toàn bộ outbound traffic:

```yaml
environment:
  HTTPS_PROXY: http://n8n-mitmproxy:8080
  HTTP_PROXY: http://n8n-mitmproxy:8080
  NODE_EXTRA_CA_CERTS: /home/node/mitmproxy-certs/mitmproxy-ca-cert.pem
  NODE_TLS_REJECT_UNAUTHORIZED: "0"
  NODE_OPTIONS: "--require /home/node/proxy-preload.js"
```

Cơ chế hoạt động:

1. n8n gửi request HTTPS (ví dụ đến `api.github.com`)
2. Request đi qua mitmproxy container (`n8n-mitmproxy:8080`)
3. mitmproxy thực hiện TLS interception (MITM), dùng CA cert của nó để ký lại certificate
4. n8n tin tưởng CA cert này vì được chỉ định qua `NODE_EXTRA_CA_CERTS`
5. `proxy-preload.js` đảm bảo Node.js global fetch và các HTTP client đều dùng proxy này

mitmproxy web UI (`mitmweb`) được expose qua Traefik tại `https://mitm.mydomain.com`, cho phép inspect real-time toàn bộ request/response giữa n8n và các service bên ngoài.

---

## 8. Kết nối đến các credential provider bên ngoài

Theo sơ đồ hạ tầng, n8n kết nối thành công đến các provider sau (qua mitmproxy, status 200):

| Provider | Giao thức | Mục đích trong n8n |
|----------|-----------|---------------------|
| Google | HTTPS | Google Sheets, Gmail, Google Drive, Calendar,... |
| Atlassian | HTTPS | Jira, Confluence nodes |
| Discord | HTTPS | Discord bot, webhooks |

Các request outbound này đi theo luồng:

```
n8n
  │  (HTTP_PROXY=http://n8n-mitmproxy:8080)
  ▼
mitmproxy  (inspect, log, forward)
  │
  ▼
Internet → Google / Atlassian / Discord API
```

mitmproxy hoạt động transparent với n8n — n8n không cần thay đổi code hay config đặc biệt cho từng provider. Đây cũng là công cụ debug hữu ích khi các credential node báo lỗi kết nối.

---

## 9. Tổng kết

| Khía cạnh | Trạng thái | Chi tiết |
| --- | --- | --- |
| n8n UI | Có thể cấu hình | Mặc định ẩn; bật `N8N_EXPOSE_UI=true` để expose qua middleware |
| n8n REST API | Có thể cấu hình | Mặc định ẩn; bật `N8N_EXPOSE_API=true` để expose `/api/*` qua middleware |
| Webhook từ internet | Hoạt động bình thường | Qua Hono middleware, có xác thực chữ ký GitHub nếu đặt secret |
| Xác thực webhook GitHub | Có thể cấu hình | Bật bằng `GITHUB_WEBHOOK_SECRET`; dùng HMAC-SHA256, constant-time compare |
| Kết nối đến provider bên ngoài | Hoạt động | Google, Atlassian, Discord đều kết nối được |
| Outbound inspection | Hoạt động | mitmproxy intercept và log toàn bộ outbound HTTPS |
| Bảo mật | Tốt | n8n không expose trực tiếp ra internet; middleware là điểm kiểm soát duy nhất |
| TLS | Được quản lý tự động | Traefik + Cloudflare cert resolver |

**Kết luận:** n8n hoạt động đầy đủ chức năng trong môi trường local network. Middleware hiện có khả năng cấu hình linh hoạt hơn: webhook luôn hoạt động và tùy chọn có xác thực chữ ký GitHub; UI và REST API có thể bật độc lập theo nhu cầu. Mặc định vẫn giữ nguyên nguyên tắc ban đầu — chỉ webhook được public, n8n UI/API ẩn trong internal network và truy cập qua Tailscale.
