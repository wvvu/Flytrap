# Flytrap

一个克制、轻巧、自托管的多域名个人与小团队邮局。

设计基石只有一句话：**少收一封真邮件，比多留十封垃圾信更糟。**  
在已配置的域名上，任意前缀默认全部收下并先一步压缩落盘；AI 只负责把重要来信、推广订阅与垃圾钓鱼分门别类，绝不在收信闸口误拒任何一封信。

单 Node.js 进程、一个 SQLite 索引库、以及磁盘上按 `SHA-256` 去重存储的不可变 `.eml` 原文。零前端构建链，开箱即跑。

---

## 核心特性

- **不漏信的 Catch-All 收信架构**  
  本域任意前缀一律 `250` 接纳（严格阻断外域中继），原始字节完成 `zstd` / `gzip` 落盘与哈希读回校验后才向对端确认。SQLite 仅作派生索引，随时可通过 `--rebuild` 从磁盘原文完整重建。
- **优雅的多用户与邮箱分配体系**  
  管理员可为信任的家人、伙伴或团队成员开通独立登录账号，支持三种颗粒度分配：
  - **精确邮箱 + 自动子地址**：分配 `alice@example.com` 后，自动接管 `alice+github@example.com` 等加号子地址；
  - **整域委托（`*@friend.org`）**：将一整个域名的收发权完整交给指定成员；
  - **兜底保护（Catch-All）**：未被成员规则命中的其余前缀自动落入管理员收件箱，零遗漏。
  - **底层共享、上层隔离**：多收件人同源邮件在磁盘只存一份，但各账号的已读、星标、分类覆盖、黑名单、发信箱与彻底删除引用计数彼此完全隔离。
- **AI 智能分拣与多密钥轮换池**  
  原生支持 Google Gemini 与任意 OpenAI 兼容接口。支持多模型/多 API Key 顺序轮换、429/503 自动熔断冷却、在线热改提示词、服务端一键实测密钥连通与延迟，并内置 XML 边界隔离与提示词注入护栏。
- **直投 MX 出站发信与 DKIM 签名**  
  内置独立发信队列（慢速外部 MX 不阻塞入站拆信），支持一键生成 `RSA 2048` 或 `Ed25519` DKIM 密钥并导出 DNS 记录，支持多附件 MIME 组装、线程引用串联（`In-Reply-To` / `References`）与发件身份权限边界校验。
- **零外链像素追踪阅读器与全键盘工作台**  
  正文运行于独立不透明源沙箱 `iframe`（禁脚本、禁同源逃逸、默认剥离一切外链追踪像素），自动识别并一键复制登录验证码（OTP）；配备非侵入式可折叠写信抽屉（本地自动草稿）、批量操作栏、`Ctrl/Cmd + K` 命令面板、深浅双主题与原生 PWA 主屏安装支持。

---

## 快速部署

### 1. 准备配置

```bash
git clone https://github.com/wvvu/flytrap.git
cd flytrap
cp .env.example .env
```

编辑 `.env`，至少填入以下必填项（切勿使用弱口令）：

```ini
ACCEPT_DOMAINS=example.com,example.org
SMTP_BANNER=mx.example.com
SMTP_EHLO=mx.example.com

API_USERNAME=admin@example.com
API_PASSWORD=请替换为高强度管理密码
SESSION_SECRET=请填入至少32字节随机字符串

# 可选：启用 Gemini 自动分拣（也可留空启动后在面板添加密钥）
CLASSIFIER=gemini
GEMINI_API_KEYS=
```

生成随机 `SESSION_SECRET`：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

### 2. 启动容器

```bash
docker compose up -d
```

- 默认管理面板仅监听宿主机回环地址 `127.0.0.1:8080`（生产环境启用 `Secure` Cookie，请通过 Caddy / Nginx 反代并提供 HTTPS）。
- 容器内 SMTP 默认监听 `2525`，可在宿主机通过 `docker-compose.override.yml` 或防火墙转发映射公网 `25` 端口，并将宿主机数据目录挂载至 `/srv/mail/data`。

---

## DNS 记录配置指南

假设服务器公网 IP 为 `203.0.113.10`，邮局主机名为 `mx.example.com`：

| 类型 | 主机记录 | 记录值示例 | 用途 |
| :--- | :--- | :--- | :--- |
| `A` | `mx` | `203.0.113.10` | 邮局服务器地址（建议同步配置服务商反向解析 PTR 指向 `mx.example.com`） |
| `MX` | `@` | `10 mx.example.com.` | 将域名收信指向本实例 |
| `TXT` | `@` | `v=spf1 ip4:203.0.113.10 -all` | SPF 发信授权 |
| `TXT` | `mail._domainkey` | 在面板「设置 → 域名与发信」一键生成复制 | DKIM 出站数字签名（支持 RSA 2048 / Ed25519） |
| `TXT` | `_dmarc` | `v=DMARC1; p=quarantine; adkim=r; aspf=r` | DMARC 策略声明 |

---

## 多用户与邮箱分配

以管理员身份登录后，点击左侧栏底部的 **「成员与邮箱」** 即可管理系统账号：

1. **开通成员**：设置登录名、随机生成初始密码，可一步分配初始邮箱并一键复制完整登录凭据发给对方。
2. **分配规则**：
   - 填写前缀（如 `alice`）+ 域名（如 `example.com`）：该成员即可收发 `alice@example.com` 及任意 `alice+tag@example.com` 子地址邮件，其他地址对其完全不可见；
   - 填写 `*` + 域名（如 `friend.org`）：将该域名的全量收发权委托给该成员；
   - 勾选「同步历史匹配邮件」可将库内过往收到的对应邮件即刻归入该成员收件箱。
3. **安全管控**：成员仅能以已授权的自身地址发信；停用账号会立即吊销其所有在线会话，同时后台仍继续安全代收其邮件不丢失。

---

## 键盘快捷键

在工作台非输入焦点状态下可直接触发：

| 按键 | 动作 | 按键 | 动作 |
| :--- | :--- | :--- | :--- |
| `Ctrl / Cmd + K` | 呼出全局命令面板 | `J` / `K` | 下一封 / 上一封邮件 |
| `/` | 聚焦当前列表搜索框 | `A` | 回复当前打开的邮件 |
| `Esc` | 清空搜索框 / 关闭浮层 | `U` | 切换当前邮件已读 / 未读 |
| `C` | 打开悬浮写信窗口 | `S` | 切换当前邮件星标状态 |
| `R` | 刷新当前视图 | `#` | 将当前邮件移入垃圾桶 |
| `?` | 打开快捷键速查表 | | |

---

## 数据备份与本地开发

### 备份与灾难重建

磁盘数据目录（`$MAIL_DATA_DIR`）结构清晰独立：

- `raw/`、`sent/`、`attachments/`：**不可变真源**，日常备份只需保护这三处目录；
- `db/mail.db`：SQLite 索引库。即便数据库文件损毁丢失，执行以下命令即可从 `raw/` 全量校验哈希并重建索引：

```bash
node dist/main.js --rebuild
```

### 本地开发与测试

需要 Node.js `>= 22`：

```bash
npm install
npm run dev          # 本地热启动
npm test             # 运行全量单元与集成测试（含多租户隔离、前端 DAG 与安全沙箱基线测试）
npm run typecheck    # 严格 TypeScript 类型检查
npm run build        # 编译产物至 dist/
```

## License

[MIT](LICENSE)
