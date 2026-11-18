# Flytrap

> 轻量、自托管的多域名全收（Accept-All）与多成员协作邮局。少收一封信，比多留一封垃圾更糟。

单进程 Node.js + SQLite 派生索引 + 磁盘不可变压缩原文。不依赖外部数据库、消息队列或前端打包工具链，开箱即拥有完整的 SMTP 收信、直连 MX 出站投递、DKIM 签名、AI 智能分拣、零外链安全预览沙箱与精细化多成员邮箱分配能力。

---

## 核心特性

### 1. 绝不漏信的存储底座
- **本域全收，外域严拒**：凡命中收信域名列表的任意前缀（含退信空信封 `<>`）一律先原子落盘校验哈希，再返回 `250`；非本域收件严格返回 `550 5.7.1 relay denied`，杜绝开放中继。
- **EML 原文真源与索引分离**：原始邮件经 `zstd`（无原生扩展时自动回退 `gzip`）压缩后按未压缩字节 `SHA-256` 去重存储于 `raw/` 与 `sent/`；SQLite 仅作高速检索索引，随时可通过 `--rebuild` 从磁盘原文全量重建。
- **双车道异步队列**：入站流水线（`SPF/DKIM/DMARC/ARC 鉴权 -> MIME 拆解与附件去重 -> AI 分拣 -> 规则提醒`）与出站发信通道独立运行，慢速远端 MX 绝不阻塞新邮件入库。

### 2. 多用户与精细化邮箱分配
- **独立信任账号**：管理员可在面板内一键为家人或合作伙伴开通独立账号、生成随机强口令并复制开户凭证。
- **三级路由与特异性优先级**：
  - **精确邮箱**（如 `alice@example.com`）：自动兼容 RFC 5233 加号子地址（`alice+github@example.com`）；
  - **整域划拨**（`* @example.org`）：将整条域名的其余收件交由指定成员接管；
  - **优先级裁决**：`精确前缀 > +子地址基座 > 整域通配 * > 主管理员兜底`，同服多成员信封密送（BCC）自动脱敏隔离，多收件人共享信件采用引用计数物理清理。
- **出站防伪造与配额管理**：普通成员仅能使用已授权邮箱作为 `From` 发信，支持按账号设置每日发信上限、随时停用账号并毫秒级吊销活跃会话。

### 3. 智能分拣与安全阅读工作台
- **多密钥轮换池与在线测活**：原生支持 Google Gemini 与 OpenAI 兼容接口，内置 429/503 自动冷却轮换、在线提示词热更新、防提示词注入确定性护栏，并支持在设置页一键实测单把密钥连通延迟。
- **零脚本隔离沙箱**：邮件 HTML 正文在无同源权限、禁脚本的独立 `iframe` 沙箱中渲染，默认剥离外链追踪像素，按需手动加载图片。
- **高频效率打磨**：自动提取登录/通知邮件中的动态验证码一键复制、按用户隔离的写信自动草稿箱、来回会话链聚合、一键全部已读、全键盘快捷键流（`J/K`、`C`、`/`、`U`、`?`）以及原生级移动端 PWA 支持。

---

## 快速部署（Docker Compose）

```bash
git clone https://github.com/wvvu/flytrap.git
cd flytrap
cp .env.example .env
```

编辑 `.env`，至少填入以下三项必填配置：

```ini
ACCEPT_DOMAINS=example.com,example.net
API_USERNAME=admin@example.com
API_PASSWORD=请替换为高强度密码
SESSION_SECRET=请填入至少32字节随机串
```

> 生成随机 `SESSION_SECRET`：
> `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"`

启动容器：

```bash
docker compose up -d
```

- **Web 管理台**：默认仅监听宿主机回环 `127.0.0.1:8080`。生产环境请前置 Caddy / Nginx 提供 HTTPS 反向代理（生产模式下会话 Cookie 启用 `Secure`，需通过 HTTPS 访问）。
- **SMTP 收信端口**：Compose 默认映射 `2525:2525`；公网收信可在宿主机通过 `docker-compose.override.yml` 或防火墙转发将公网 `25` 端口映射至容器 `2525`。

### 域名 DNS 配置建议

| 记录类型 | 主机记录 | 记录值示例 | 用途说明 |
|---|---|---|---|
| `MX` | `@` | `10 mx.example.com.` | 将本域收件指向运行本服务的服务器 |
| `A` / `AAAA` | `mx` | `<服务器公网 IP>` | 建议同时将服务器 IP 反向解析（rDNS / PTR）指向 `mx.example.com` 以提升出站信誉 |
| `TXT` (SPF) | `@` | `v=spf1 mx -all` | 声明允许本机对外发信 |
| `TXT` (DKIM) | `mail._domainkey` | 面板「设置 -> 域名与发信」一键生成并复制 | 出站邮件自动附带 RSA-2048 或 Ed25519 数字签名 |
| `TXT` (DMARC) | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com` | 声明本域防伪策略 |

---

## 环境变量参考

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ROLES` | `smtp,worker,api` | 当前进程启用的角色集合 |
| `MAIL_DATA_DIR` | `/srv/mail/data` | 原文、附件与 SQLite 存储目录（本地开发建议设为 `./data`） |
| `ACCEPT_DOMAINS` | *（必填）* | 逗号分隔的收信域名列表，支持在面板内动态增删 |
| `SMTP_PORT` / `SMTP_BANNER` | `25` / `mx` | 入站监听端口与欢迎横幅 |
| `SMTP_EHLO` | 同域名横幅 | 出站投递 MX 时宣告的 EHLO 域名（建议与公网 PTR 一致） |
| `SMTP_MAX_BYTES` | `20971520` | 单封邮件体积上限（默认 20 MiB，超限返回 `552`） |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `8080` | HTTP API 与静态工作台监听地址 |
| `API_USERNAME` / `API_PASSWORD` | `admin` / *（必填）* | 主管理员初始登录凭证（面板内改密后优先使用数据库加密哈希） |
| `SESSION_SECRET` / `SESSION_DAYS` | *（必填）* / `15` | 会话签名密钥（至少 32 字节）与滚动续期天数 |
| `CLASSIFIER` | `openai-compat` | 分拣驱动：`gemini`、`openai-compat` 或 `fake`（本地测试免调模型） |
| `GEMINI_API_KEYS` / `GEMINI_MODEL` | 空 / `gemini-2.5-flash` | Gemini 密钥池（可留空并在面板后配）与默认型号 |
| `OPENAI_BASE_URL` | 空 | 使用 `openai-compat` 时的接口根地址（密钥与型号可在面板配置） |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 空 | 高优先级邮件摘要推送至 Telegram（仅含摘要与深链，不含正文） |
| `NOTIFY_WEBHOOK_URL` | 空 | 自定义 Webhook 告警端点 |
| `DISK_ALERT_BYTES` | `0` | 数据目录容量告警阈值（字节，`0` 为关闭；超限仅打告警日志，绝不删信） |

---

## 本地开发与运维命令

```bash
# 安装依赖（需 Node.js >= 22）
npm install

# 启动本地开发服务
npm run dev

# 运行类型检查与测试套件
npm run typecheck
npm test

# 构建生产产物
npm run build

# 仅校验环境变量与执行数据库迁移后退出
node dist/main.js --check

# 从 data/raw 原始压缩邮件全量重建 SQLite 索引
node dist/main.js --rebuild
```

### 备份策略
只需定期增量备份 `$MAIL_DATA_DIR/raw`、`$MAIL_DATA_DIR/sent`、`$MAIL_DATA_DIR/attachments` 以及 `$MAIL_DATA_DIR/db/mail.db`。即使 SQLite 文件意外损毁，删除库文件后执行 `--rebuild` 即可从 `raw/` 完整恢复全部历史收件索引。

---

## License

[MIT](LICENSE)
