# Flytrap

*Lightweight full-stack email service for small VPS — small but complete.*

一个 Node.js 进程 + 一个 SQLite 文件，收信、发信、Web 面板全在一块。空库启动约 123 MB 内存，手边随便一台小 VPS 就能跑。

## 特性

- **收信**：本域 Catch-all 全收，先落盘校验再回 `250`，不漏信；外域严拒，不做开放中继。内置 SPF / DKIM / DMARC / ARC 校验与附件去重。
- **发信**：直连 MX 投递，自动 DKIM 签名。单封最多 5 个附件（共 10 MB），支持按账号设置每日发信上限。
- **AI 分拣与验证码**：支持 Gemini / OpenAI 兼容接口自动分类（内置 `fake` 驱动供本地测试）；自动提取登录邮件里的验证码，一键复制。
- **多用户与四级路由**：可给家人、朋友开独立账号。地址分配按「`精确地址` > `+tag 基座` > `前缀通配 (alerts-*@)` > `整域划拨 (*@)` > `主管理员兜底`」读时裁决；前缀与整域接管会自动归拢历史邮件。
- **原文与索引分离**：原始邮件压缩后直接落盘，SQLite 仅作索引。索引损坏随时可从磁盘原文全量重建，信不会丢。
- **安全与通知**：正文在禁脚本沙箱中渲染，默认不加载外链图片；BCC 对看信人不可见。

## 快速开始

```bash
git clone https://github.com/wvvu/Flytrap.git
cd Flytrap
cp .env.example .env
```

编辑 `.env`，至少填这三项：

```ini
ACCEPT_DOMAINS=example.com
API_PASSWORD=换一个强口令
SESSION_SECRET=至少 32 个字符的随机串
```

生成随机 `SESSION_SECRET`：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

启动：

```bash
docker compose up -d
```

- 面板：`127.0.0.1:8080`，前面挂 Caddy / Nginx 做 HTTPS 反代（生产模式下会话 Cookie 带 `Secure`，必须走 HTTPS）。
- 收信：容器 `2525`，把公网 `25` 端口转发过去。

### DNS

| 记录 | 主机 | 值 | 用途 |
|---|---|---|---|
| `MX` | `@` | `10 mx.example.com.` | 本域收件指向这台服务器 |
| `A` / `AAAA` | `mx` | 服务器公网 IP | 建议反向解析（PTR）也指向它 |
| `TXT` (SPF) | `@` | `v=spf1 mx -all` | 声明只允许本机发信 |
| `TXT` (DKIM) | `mail._domainkey` | 面板「设置 → 域名与发信」生成 | 出站自动签名 |
| `TXT` (DMARC) | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com` | 防伪策略 |

## 配置

只列常用的，完整列表见 `.env.example`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ACCEPT_DOMAINS` | 必填 | 收信域名，逗号分隔 |
| `API_USERNAME` / `API_PASSWORD` | `admin` / 必填 | 主管理员登录凭证 |
| `SESSION_SECRET` | 必填 | 会话密钥，至少 32 字节 |
| `MAIL_DATA_DIR` | `/srv/mail/data` | 原文、附件、SQLite 存放处 |
| `ROLES` | `smtp,worker,api` | 进程启用的角色 |
| `CLASSIFIER` | `openai-compat` | 分拣驱动：`gemini`、`openai-compat`、`fake` |
| `SMTP_PORT` | `2525` | 入站监听端口 |
| `API_PORT` | `8080` | 面板监听端口 |

## 本地开发

```bash
npm install          # 需要 Node.js >= 22
npm run dev          # 本地开发
npm run typecheck    # 类型检查
npm test             # 测试
npm run build        # 构建生产产物
node dist/main.js --check    # 只校验配置与迁移后退出
node dist/main.js --rebuild  # 从磁盘原文全量重建 SQLite 索引
```

## 说明

没做 IMAP / JMAP，也不打算做。想用客户端收信的，这不是你要的。
