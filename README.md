# Flytrap

轻量、自托管、零前端构建链的现代多用户邮件工作台与智能分拣网关。

单进程即可同时驱动 **SMTP 收信网关**、**直连 MX 发信引擎**、**AI 多密钥分拣流水线** 与 **三列式安全 Web 工作台**。底层遵循「**原始 EML 字节流是唯一不可变真源，SQLite 只是随时可全量重建的派生索引**」的架构原则——少收一封信，永远比多留一封垃圾更不可接受。

## 核心特性

### 1. 现代三列邮件工作台（零前端构建、原生 ES Modules）
- **双色高质感界面**：深色（Obsidian Studio）与浅色（Paper & Cobalt `#0B57D0`）双主题无闪烁切换，支持移动端自适应单栏抽屉与桌面端宽幅阅读，内置 `manifest.webmanifest` 原生级 PWA 支持。
- **高效键盘流与命令面板**：全局 `Ctrl/Cmd + K` 速达面板，`?` 快捷键速查，`/` 搜索聚焦、`C` 写信、`J / K` 翻信、`S` 星标、`U` 标未读、`E` 移入垃圾桶、`Ctrl + Enter` 立即发信。
- **贴合日常痛点的阅读与发信体验**：
  - **智能验证码提取**：在验证类邮件头部自动识别 4–8 位一次性验证码并提供一键复制横幅。
  - **多维筛选与批处理**：支持星标视图、未读/有附件胶囊过滤、推广分流、多选批量已读/未读/归档/删除、一键全部标为已读。
  - **顺手的发信工作台**：浏览器本地草稿自动持久化与恢复、发件身份胶囊快选、实时 DKIM 签名状态检测、回复 / 全部回复 / 转发及 RFC 5322 会话串（`In-Reply-To` / `References`）双向聚合。

### 2. 完整的多用户体系与管理员全权管控
- **开箱即用、平滑兼容**：环境变量定义的根管理员（`API_USERNAME` / `API_PASSWORD`）天然拥有全局域与管理权限，无需额外初始化即可直接创建协同管理员（`admin`）或普通成员（`member`）账号。
- **三种灵活的邮箱分配粒度**：
  - **精确邮箱 + 子地址（`alice@example.com`）**：自动兼容 RFC 5233 `+tag` 子地址（如 `alice+github@example.com`），方便注册不同外部服务。
  - **前缀通配（`team-*@example.com`）**：按前缀命名空间批量归属给指定成员或项目组。
  - **整域接管（`*@studio.org`）**：将独立域名的全部收发权完整交付给对应成员。
- **严密的数据隔离与去重共存**：
  - 同一封信（相同 SHA-256）或群发给多位站内成员的邮件，磁盘仅存一份压缩原文，但每位成员拥有完全独立的**已读/未读、星标、垃圾桶、软删除与个人分类覆盖状态**（`user_message_state`），互不干扰。
  - 成员收件列表、正文/信头/原文下载、附件哈希下载（`/v1/attachments/:sha256`）、会话串、已发队列、个人黑名单与统计图表均在服务端严格按授权边界隔离，越权请求一律返回 `404` 或 `403`。
  - 外发邮件强制校验成员对 `From` 地址的发信授权（`can_send`）与滚动 24 小时发信配额（`quota_send_day`），彻底杜绝身份伪造与滥发。
- **管理员全权治理**：一键生成随机强口令与可复制交付卡片、按成员筛选全局收件箱、随时停用账号（实时吊销在线 Cookie 会话）、重置口令、调整配额及查阅全局操作审计日志（`audit_log`）。

### 3. 可靠收发与安全底座
- **本域 Accept-All & 防开放中继**：`ACCEPT_DOMAINS` 内任意前缀一律先行落盘再返回 `250 OK`，非本域收件严格返回 `550 5.7.1 relay denied`，内置单 IP 并发、分钟连接率与小时邮件量三维限流。
- **全链路邮件鉴权与直连发信**：入站通过 `mailauth` 异步执行 SPF / DKIM / DMARC / ARC 核验（带 10 秒 DNS 硬超时熔断）；出站支持面板一键生成 **RSA-2048** 或 **Ed25519** DKIM 密钥对，自动签名并按 MX 优先级直连投递（多收件域部分成功自动记录，重试不重复投递）。
- **AI 多密钥轮询与在线测通**：原生对接 **Gemini** 与 **OpenAI 兼容接口**，支持多模型优先级回退、多 API Key 轮询与 `429/503` 自动冷却熔断；面板内置单密钥在线连通性与延迟实测、在线热更新系统提示词与防 Prompt Injection 确定性护栏。
- **纵深防御的前端与存储安全**：全站前端源码零 `innerHTML`；HTML 邮件预览运行于无脚本无同源隔离沙箱（`sandbox="allow-popups allow-popups-to-escape-sandbox"`），默认剥离全部远程图片与追踪像素；写接口强制校验 CSRF 令牌；口令采用 `scrypt` 与常量时间比对；磁盘文件读取经 `resolveInside()` 物理边界锁死。

## 架构概览

```text
Inbound SMTP (25 / 2525)
  │  IP 三维限速 · 本域校验 · 字节流实时上限守卫
  ▼
Content-Addressed Raw Store (data/raw/YYYY/MM/hh/<sha256>.eml.{zst,gz})
  │  原子写临时文件 -> 哈希回读校验 -> rename -> SQLite 入队
  ▼
SQLite WAL Job Queue (Inbound Lane / Outbound Lane 双通道并发)
  ├─ [auth]     mailauth SPF / DKIM / DMARC / ARC (10s DNS 超时熔断)
  ├─ [parse]    postal-mime 拆信 · 附件按 SHA-256 去重落盘 · 成员/全局黑名单分流
  ├─ [classify] Gemini / OpenAI 多 Key 轮换池 + Prompt Injection 护栏
  ├─ [notify]   Telegram / Webhook 高危摘要与深链推送
  └─ [send]     RFC 5322 组装 · DKIM (RSA/Ed25519) 签名 · MX 直连投递

Fastify 5 JSON API & Static ES-Module Workbench (127.0.0.1:8080)
  ├─ 根管理员 & 协同管理员：成员开户、邮箱分配、域名/DKIM、AI 密钥池、死信治愈、安全审计
  └─ 独立成员工作台：专属邮箱 (+子地址) 收发、独立阅读/星标/垃圾桶、草稿与验证码快取
```

## 快速部署（Docker Compose）

### 1. 准备配置文件

```bash
git clone https://github.com/wvvu/flytrap.git
cd flytrap
cp .env.example .env
```

编辑 `.env`，至少设置以下三项核心参数（生产环境严禁使用弱口令或示例占位符）：

```ini
ACCEPT_DOMAINS=example.com,example.org
API_USERNAME=admin
API_PASSWORD=请替换为高强度管理员密码
SESSION_SECRET=请使用下方命令生成至少32字节随机串
```

生成随机 `SESSION_SECRET`：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

### 2. 启动服务

```bash
mkdir -p data
docker compose up -d --build
```

- **Web 工作台与 API**：默认仅监听宿主机回环 `127.0.0.1:8080`。生产环境请在前方配置 Caddy / Nginx 反向代理并终结 HTTPS（容器在 `NODE_ENV=production` 下默认启用 `Secure` 会话 Cookie，并已开启 `trustProxy: true`）。
- **SMTP 收信端口**：容器监听 `2525`（可在宿主机通过防火墙 DNAT 或 Compose 端口映射绑定公网 `25` 端口）。
- **健康检查**：`curl http://127.0.0.1:8080/healthz`

### 3. 配置域名 DNS 记录（收发信最佳实践）

| 记录类型 | 主机名 | 记录值示例 | 用途 |
| :--- | :--- | :--- | :--- |
| `A` / `AAAA` | `mx.example.com` | 服务器公网 IP | 邮件网关主机地址（建议同步配置服务商反向解析 PTR 指向该域名，并设置 `SMTP_EHLO=mx.example.com`） |
| `MX` | `@` | `10 mx.example.com.` | 将本域全部收件路由至 Flytrap |
| `TXT` (SPF) | `@` | `v=spf1 mx -all` | 声明允许本机外发该域名邮件 |
| `TXT` (DKIM) | `mail._domainkey` | 在工作台「设置 → 域名与发信」一键生成并复制 | 为外发邮件提供 RSA-2048 或 Ed25519 数字签名 |
| `TXT` (DMARC) | `_dmarc` | `v=DMARC1; p=quarantine; adkim=r; aspf=r` | 声明域级反伪造策略 |

## 多用户开通与邮箱分配指南

1. 使用管理员账号登录工作台，点击左侧导航轨的 **「成员」**（或按 `Ctrl + K` 输入 `新建`）。
2. 点击 **「+ 新建账号」**，填写登录名（支持短账号如 `alice` 或完整邮箱 `alice@example.com`）、生成随机强口令、设置角色与 24 小时发信配额，并指定初始邮箱规则。
3. 创建完成后，直接点击 **「一键复制登录信息」** 即可将登录地址、账号、初始口令与专属邮箱发送给对方。
4. 在成员详情页可随时增删多条授权规则，实时切换每条规则的 **「允许发信 / 仅限收信」** 状态，或点击 **「停用并踢下线」** 立即冻结账号并吊销其所有活跃会话。

## 本地开发与验证

环境要求：**Node.js >= 22**（包含 SQLite C++ 编译工具链以构建 `better-sqlite3`）。

```bash
# 安装依赖
npm install

# 启动开发模式（默认同时运行 smtp, worker, api 三个角色）
npm run dev

# 向本地 2525 端口灌入模拟测试邮件
node scripts/seed-mock-emails.mjs

# TypeScript 全量严格类型检查（含 src 与 test）
npm run typecheck

# 生产构建（编译 TS 至 dist/ 并同步静态前端模块）
npm run build

# 运行全量自动化测试套件
npm test
```

## 灾难恢复与命令行工具

当 SQLite 数据库文件损坏或误删时，只要 `MAIL_DATA_DIR/raw` 目录下的压缩原始邮件仍在，即可随时一键无损重建索引并恢复待分拣队列：

```bash
# 校验环境变量配置与数据库迁移状态后退出
node dist/main.js --check

# 从 data/raw/ 原始压缩字节流全量核验哈希并重建 SQLite 索引
node dist/main.js --rebuild
```

## 环境变量速查

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `development` / `production` / `test`（生产模式拒绝弱口令并启用 `Secure` Cookie） |
| `ROLES` | `smtp,worker,api` | 当前进程启用的角色集合，逗号分隔 |
| `MAIL_DATA_DIR` | `/srv/mail/data` | 原始邮件（`raw/`、`sent/`）、去重附件（`attachments/`）与 `db/mail.db` 存储根目录 |
| `ACCEPT_DOMAINS` | *(必填)* | 允许接收的域名列表（逗号分隔，不支持通配符），面板内可动态增删 |
| `SMTP_HOST` / `SMTP_PORT` | `0.0.0.0` / `25` | SMTP 监听地址与端口（Compose 默认映射 `2525`） |
| `SMTP_BANNER` / `SMTP_EHLO` | `mx` / 自动推导 | SMTP 欢迎横幅与外发投递 `EHLO` 域名（建议与公网 IP 反向解析 PTR 一致） |
| `SMTP_MAX_BYTES` | `20971520` | 单封邮件最大允许字节数（默认 20 MiB） |
| `SMTP_TLS_KEY_FILE` / `CERT` | 空 | 成对配置后自动通告 `STARTTLS`；留空则仅明文接收 |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `8080` | Web 工作台与 JSON API 监听地址与端口 |
| `API_USERNAME` / `API_PASSWORD` | `admin` / *(必填)* | 根管理员登录名与初始密码（支持在面板中在线改密，若为邮箱地址可收重置验证码） |
| `SESSION_SECRET` | *(必填)* | 会话签名密钥，至少 32 字节 |
| `SESSION_DAYS` | `15` | 登录会话滚动有效天数 |
| `CLASSIFIER` | `openai-compat` | `gemini`、`openai-compat` 或 `fake`（密钥留空时仍可正常启动并在面板后配） |
| `GEMINI_API_KEYS` / `MODEL` | 空 / `gemini-2.5-flash` | Gemini 多密钥池（逗号分隔）与默认型号 |
| `OPENAI_BASE_URL` / `API_KEY` | 空 | OpenAI 兼容接口地址、密钥与 `OPENAI_MODEL` |
| `TELEGRAM_BOT_TOKEN` / `CHAT_ID` | 空 | Telegram 告警机器人配置（与 `NOTIFY_WEBHOOK_URL` 均可独立启用） |
| `COMPRESS` | `auto` | 原始邮件压缩算法：`auto`（优先 zstd，不可用时无缝回退 gzip）、`zstd`、`gzip` |
| `DISK_ALERT_BYTES` | `0` | 数据目录容量告警阈值（字节，`0` 关闭，超限仅告警绝不删信） |

## 许可证

[MIT](LICENSE)
