# Flytrap

自托管、单进程、多域名全收（Catch-all）与多用户隔离的轻量级邮件网关及 Web 工作台。

核心工程哲学只有一条：**少收一封信，远比多留一封垃圾邮件更不可接受。**  
所有发往托管域名任意前缀的邮件都会先原子落盘保存压缩原文（`.eml.zst` / `.eml.gz`），再进入 SQLite WAL 索引与异步流水线完成 SPF / DKIM / DMARC 核验、正文拆解、AI 分拣与通知推送；即便数据库文件彻底损坏，一条 `--rebuild` 命令即可从磁盘原文完整重建索引。

## 核心特性

### 1. 收发一体的轻量邮件底座
- **全前缀兜底收信（Catch-all SMTP）**：无需预先创建邮箱地址，托管域名下的任意前缀（含 `user+tag@domain` 子地址）一律先落盘再入库，按连接数、速率与体积实施分级流控。
- **原文内容寻址去重**：入站与出站原文均以压缩前字节流的 `SHA-256` 分片落盘，支持 `zstd` 高压缩率与 `gzip` 无缝回退，读取时强制校验哈希完整性。
- **直投 MX 与双算法 DKIM 签名**：内置异步外发队列，自动解析目标域名 MX 记录（按优先级故障切换）并发起机会性 STARTTLS 投递；面板内一键生成 **RSA-2048** 或 **Ed25519** DKIM 密钥并导出 DNS TXT 记录，支持 `In-Reply-To` / `References` 会话链串联。

### 2. 多用户与精细化邮箱隔离
- **三级角色体系**：
  - `owner`（根管理员）：由环境变量 `API_USERNAME` / `API_PASSWORD` 定义，掌控全局收发、系统配置与所有管理员/成员账号。
  - `admin`（协同管理员）：数据库托管账号，具备全局邮件审阅与基础设施配置权限，可开立并管理普通成员账号。
  - `member`（独立成员）：严格隔离在所分配的邮箱规则与个人发件箱内，无法访问全局配置、失败队列或非授权邮件与附件。
- **三种邮箱分配模式**：
  - **精确邮箱**（`alice@example.com`）：自动兼容 RFC 5233 `+tag` 子地址（如 `alice+github@example.com`）。
  - **前缀通配**（`team-*@example.com`）：接管指定前缀开头的整组业务或团队地址。
  - **整域接管**（`* @friend.org`）：将托管的独立域名完整交由信任伙伴独立使用。
- **独立用户态与发信配额**：同一封多收件人邮件在底层仅存一份压缩原文，各成员拥有彼此独立的已读/未读、垃圾桶、分类覆盖、个人黑名单与显示偏好，并受按账号独立的 **24 小时发信配额**约束。

### 3. 智能分拣与抗提示词注入
- **多模型 / 多密钥轮换池**：原生支持 Google Gemini（含思考预算分级）与任意 OpenAI 兼容接口；多把密钥自动轮询并在 `429 / 503` 时进入冷却自动切换，面板内提供一键服务端连通性与延迟探测。
- **安全边界隔离**：分拣输入严格拆分为 `<system_telemetry>` 与 `<untrusted_email>`，内置确定性防注入护栏——凡试图在邮件正文中伪造系统指令操纵分类结果的来信，一律强制改判为 `phish` 并打上 `prompt-injection` 标记。
- **无密钥优雅启动**：未配置模型密钥时系统照常收发信件，分拣任务自动暂缓挂起而不消耗重试次数，待面板填入密钥后自动唤醒。

### 4. 零构建原生 ES 模块工作台
- **三栏精密交互**：支持深色碳素黑曜与浅色矿物蓝双主题、按收信域名快速过滤、一键全标已读、正文验证码（OTP）智能提取复制、写信草稿本地实时暂存、全套键盘流快捷键（`/`、`c`、`j/k`、`u`、`r`、`?`）以及原生级 PWA 安装。
- **零信任前端预览**：前端源码零构建依赖、零 `innerHTML`；邮件正文运行于无脚本、无同源权限的隔离 `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` 中，默认剥离一切外链图片与追踪像素（Tracking Pixel），彻底阻断跨站脚本与隐蔽打开回执。

## 快速开始

### 方式一：Docker Compose 部署（推荐生产环境）

```bash
git clone https://github.com/wvvu/flytrap.git
cd flytrap
cp .env.example .env
```

编辑 `.env`，至少配置以下三项（生产环境会拒绝弱口令与示例占位密钥）：

```ini
ACCEPT_DOMAINS=example.com,example.org
API_USERNAME=owner@example.com
API_PASSWORD=请替换为高强度随机密码
# 生成至少 32 字节的随机密钥：node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
SESSION_SECRET=请替换为随机生成的长密钥
```

启动容器：

```bash
docker compose up -d
```

- Web 工作台默认监听宿主机回环地址 `127.0.0.1:8080`，请在前方配置 Caddy / Nginx 终结 HTTPS（生产环境下会话 Cookie 启用 `Secure` 属性）。
- 入站 SMTP 默认监听容器 `2525` 端口，可在宿主机通过防火墙转发或 `docker-compose.override.yml` 将公网 `25` 端口映射至 `2525`。
- 健康探针地址：`http://127.0.0.1:8080/healthz`。

### 方式二：本地源码运行与开发

环境要求：**Node.js >= 22**（包含 C++ 编译工具链以构建 `better-sqlite3`）。

```bash
npm install
cp .env.example .env
# 编辑 .env 设置本地开发参数（NODE_ENV=development）
npm run dev
```

常用工程脚本：

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 使用 `tsx` 直接启动开发态（默认同时拉起 `smtp,worker,api` 三个角色） |
| `npm run build` | 编译 TypeScript 至 `dist/` 并同步前端静态资源 |
| `npm start` | 以生产态运行编译产物 `node dist/main.js` |
| `npm run typecheck` | 对源码与测试套件执行严格 TypeScript 类型检查 |
| `npm test` | 运行全量单元与集成测试套件 |
| `npm run test:ui` | 单独运行前端静态资源、CSP、沙箱与鉴权基线测试 |

## 域名 DNS 配置指南

假设服务器公网 IP 为 `203.0.113.10`，主机名为 `mx.example.com`，收信域名为 `example.com`：

| 记录类型 | 主机名 | 记录值示例 | 用途说明 |
| :--- | :--- | :--- | :--- |
| `A` / `AAAA` | `mx.example.com` | `203.0.113.10` | 邮件网关主机地址（建议同步在云厂商控制台配置反向解析 PTR 指向 `mx.example.com`，并将 `.env` 中 `SMTP_EHLO` 设为 `mx.example.com`） |
| `MX` | `example.com` | `10 mx.example.com.` | 将发往 `@example.com` 的邮件路由至本机 |
| `TXT` (SPF) | `example.com` | `v=spf1 mx -all` | 声明允许 `mx.example.com` 代表该域名外发邮件 |
| `TXT` (DKIM) | `mail._domainkey.example.com` | `v=DKIM1; k=ed25519; p=...` | 在工作台「设置 → 域名与发信」一键生成后复制填入 |
| `TXT` (DMARC) | `_dmarc.example.com` | `v=DMARC1; p=quarantine` | 声明未通过 SPF/DKIM 对齐时的接收方处置策略 |

## 多用户开户与权限管控

以管理员身份登录工作台后，点击左侧导航轨的 **「成员」**（或进入「设置 → 成员与权限」）：

1. **开立独立账号**：填写登录名、显示称呼、24 小时发信配额，点击「随机生成强口令」并提交；系统会自动把登录地址、账号与初始口令格式化复制到剪贴板。
2. **分配邮箱规则**：支持随时为成员追加或收回多条规则：
   - 填入精确邮箱 `alice@example.com`：该成员自动拥有 `alice@example.com` 及一切 `alice+任意标签@example.com` 的收发权。
   - 填入前缀通配 `dev-*@example.com`：该成员接管所有以 `dev-` 开头的邮箱地址。
   - 填入整域规则 `*@sub.example.com`：该成员独占该域名下的全部收发信件。
3. **安全管控与自助找回**：管理员可随时修改配额、重置口令、踢出在线会话或一键停用账号（停用瞬间吊销全部活跃 Cookie 会话）；绑定了精确邮箱或邮箱登录名的账号亦可在登录页通过邮件验证码自助重置密码。

## 架构概览与灾备恢复

```text
Flytrap/
├── migrations/          # 前向单调递增 SQLite 迁移脚本（由 PRAGMA user_version 严格门禁）
├── prompts/             # 默认智能分拣提示词模板（支持面板在线覆盖落库）
├── src/
│   ├── smtp/            # 入站 SMTP 协议服务、IP 连接/速率限流与 RCPT 策略校验
│   ├── ingest/          # 原子先写压缩原文（raw/ 与 sent/）、SHA-256 校验与灾备重建
│   ├── worker/          # 双通道异步任务循环（入站 auth→parse→classify→notify 与出站 send）
│   ├── mail/            # RFC822 组装、SPF/DKIM/DMARC 核验、DKIM 签名、MX 投递与会话链扫描
│   ├── ai/              # Gemini / OpenAI 兼容多密钥池、在线探活与防提示词注入护栏
│   ├── notify/          # Telegram Bot 与 Webhook 告警推送
│   ├── db/              # SQLite 连接管理、迁移器与消息/用户/队列/设置仓储层
│   └── api/             # Fastify 5 会话鉴权、CSRF 防护、多租户路由与 public/ 原生模块前端
└── test/                # 覆盖 SMTP、存储、恢复、分拣、发信、多用户隔离与前端安全的测试集
```

### 运维 CLI 参数

- **启动前自检与执行迁移**：
  ```bash
  node dist/main.js --check
  ```
  校验环境变量合法性、应用未执行的 SQL 迁移并安全退出（若数据库 `user_version` 高于当前代码版本则拒绝启动，防止降级破坏 Schema）。

- **从磁盘原文灾备重建索引**：
  ```bash
  node dist/main.js --rebuild
  ```
  扫描 `MAIL_DATA_DIR/raw/` 下的全部 `.eml.zst` / `.eml.gz` 原文，校验 `SHA-256`、跳过已永久清除墓碑（`purged_messages`），补齐缺失索引行并重新排入异步解析与分拣队列。

## 关键环境变量速查

完整带注释示例见 [`.env.example`](.env.example)。

| 变量名 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `ROLES` | 否 | `smtp,worker,api` | 当前进程启用的角色组合 |
| `MAIL_DATA_DIR` | 否 | `/srv/mail/data` | 存放 `db/`、`raw/`、`sent/`、`attachments/` 的根目录（本地开发建议 `./data`） |
| `ACCEPT_DOMAINS` | **是** | — | 初始收信域名列表（逗号分隔，后续可在面板动态增删覆盖） |
| `API_HOST` / `API_PORT` | 否 | `127.0.0.1` / `8080` | Web 面板与 HTTP API 监听地址及端口 |
| `API_USERNAME` | 否 | `admin` | 根管理员登录名（设为托管邮箱地址时支持邮件验证码找回密码） |
| `API_PASSWORD` | **是** | — | 根管理员初始密码（面板内改密后以数据库哈希为准） |
| `SESSION_SECRET` | **是** | — | 会话签名密钥，长度不少于 32 字节 |
| `SESSION_DAYS` | 否 | `15` | 登录会话滚动有效天数 |
| `SMTP_HOST` / `SMTP_PORT` | 否 | `0.0.0.0` / `25` | 入站 SMTP 监听地址与端口（Docker 内默认为 `2525`） |
| `SMTP_BANNER` / `SMTP_EHLO` | 否 | `mx` / 自动推导 | 入站欢迎横幅与出站投递 `EHLO` 域名（建议与公网 PTR 一致） |
| `CLASSIFIER` | 否 | `openai-compat` | 分拣引擎：`gemini`、`openai-compat` 或 `fake`（本地离线测试） |
| `GEMINI_API_KEYS` / `GEMINI_MODEL` | 否 | — / `gemini-2.5-flash` | Gemini 初始密钥列表（逗号分隔）与默认型号，亦可在面板后配 |
| `OPENAI_BASE_URL` | 条件 | — | 当 `CLASSIFIER=openai-compat` 时必填的基础接口地址 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 否 | — | Telegram 推送凭据（需成对配置） |
| `NOTIFY_WEBHOOK_URL` | 否 | — | 自定义 Webhook 推送地址 |
| `COMPRESS` | 否 | `auto` | 原文压缩编码：`auto`（优先 `zstd` 否则回退 `gzip`）、`zstd`、`gzip` |
| `DISK_ALERT_BYTES` | 否 | `0` | 数据目录容量告警阈值（字节，`0` 表示关闭，仅告警不删信） |

## 许可证

[MIT](LICENSE)
