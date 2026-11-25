# Flytrap

自托管轻量邮局，已收域名上的任意前缀全收。原文压缩落 `data/raw`，SQLite 仅作索引；少收一封比多留一封垃圾更糟，基石目标是收进来、不漏信、可从原文全量重建。

## 核心不变量

- **读时路由**：地址归属按「精确地址 > `+tag` 基座 > 长前缀通配 > 短前缀通配 > 整域 `*` > 主管理员兜底」实时裁决；不建归属物化表，不做历史同步。
- **共享信件与引用计数**：多人共享邮件的状态写入 `user_message_state`，删除与清空垃圾桶统一走 `deleteMessageForViewer` / `emptyTrashForViewer`，不绕过引用计数直接物理清库。
- **角色与脱敏边界**：仅 `OWNER_USER_ID` 可管理协同管理员与全域代发；协同管理员和普通成员发信均受归属裁决约束；非 Owner 的个人视角对多收件人与 SMTP 元数据做 BCC 脱敏。
- **面板安全底线**：`src/api/public/` 为纯静态原生 ES 模块，不用 `innerHTML`，模块依赖无环；预览 iframe 保持 `sandbox="allow-popups allow-popups-to-escape-sandbox"`（禁止 scripts 与 same-origin），外链图片默认不加载；界面文案不出现人称代词（你/我/他）。
- **数据库版本护栏**：启动校验 `PRAGMA user_version`；库版本高于代码识别范围时拒绝启动，不倒向迁移；旧库沿 `migrations/*.sql` 顺序前迁。

## 代码地图

- `src/main.ts`、`src/config.ts`：进程入口、角色编排（`smtp` / `worker` / `api`）与环境校验。
- `src/smtp/`、`src/ingest/`：入站 SMTP 接收、限流策略、原文落盘与断库重建（`rebuild.ts`）。
- `src/mail/`：地址规范化、SPF/DKIM/DMARC 校验、MIME 解析、DKIM 签名、拼信与发信入队。
- `src/worker/`：异步队列调度（`job-auth`、`job-parse`、`job-classify`、`job-notify`、`job-send`）与磁盘告警。
- `src/ai/`、`src/notify/`：Gemini / OpenAI-compat 分类、密钥池轮换、探针（`probe.ts`）；全局 Telegram 与按人分流 Webhook。
- `src/db/repos/`：`users.ts`（账号与四级路由）、`messages.ts`（读时可见性、脱敏与引用计数删除）、`outbox.ts`、`settings.ts`、`jobs.ts`、`audit.ts`、`attachments.ts`、`thread.ts`。
- `src/api/`：`app.ts`（Fastify 路由与权限守卫）、`session-store.ts`、`password.ts`、`static.ts`。
- `src/api/public/`：`boot.js` / `app.js`（启动与快捷键）、`state.js` / `net.js`（状态与 CSRF 请求）、`mail-view.js`（列表与阅读）、`send-view.js`（悬浮写信抽屉）、`users-view.js`（成员管理）、`settings-view.js`（五栏设置）、`dlq-view.js`（失败队列）、`util.js`（验证码提取与前端路由匹配）。

## 本地开发与验证

- 仓库即当前目录，远程 `https://github.com/wvvu/flytrap.git`。新对话动手前先 `git fetch` 核对本地与 `origin/dev`；日常改动直接进 `dev`，验证通过后推送 `origin/dev`。
- 改完运行 `npm test` 和 `npm run typecheck`；只改 `src/api/public/` 时跑 `npm run test:ui && npm run typecheck` 即可，视觉效果留给浏览器核验。
- `test/ui.test.ts` 只守安全与架构底线（沙箱、CSP、无 `innerHTML`、鉴权拦截、路径穿越、文案禁忌），不在里面写页面文案、色号、元素顺序、CSS 数值类易碎断言。
- Windows 本地 `MAIL_DATA_DIR` 用 `./data`。本地挂真实备份库调试时，优先用 `ROLES=api` 与 `CLASSIFIER=fake`，避免触发外发或消耗 AI 额度。`.env`、`data/`、`sketch.html`、`docs/` 留在工作区不入库。

## 远端 host173

- 主机 `mail.srrrs.com`，SSH 别名 `host173`。
- `/srv/flytrap` 跟踪 `origin/main`（面板 `127.0.0.1:8080`），`/srv/flytrap-dev` 跟踪 `origin/dev`（容器 `flytrap-dev`，面板 `127.0.0.1:8081`）。两者均有 `flytrap-autoupdate.timer` 每分钟执行 `scripts/auto-sync.sh`（`git pull --ff-only`）；改动仅涉及 `src/api/public`、`docs` 或 markdown 时不重建镜像，其余重建并重启容器。
- 宿主机 `docker-compose.override.yml` 已在 `.gitignore` 中，保留不覆盖（负责主机 `25 → 2525` 映射与 `src/api/public` 只读挂载）；HTTPS 由 Caddy 终结，健康检查接口为 `GET http://127.0.0.1:8080/healthz`。

## 版本与发布

- 只有 `main` 对外发版；`dev` 保持当前版本号不提前升，用 commit 哈希区分。
- `dev` 合入 `main` 发版时先在 `CHANGELOG.md` 顶部加一条（版本、日期、一句话），再按改动类型执行 `npm version patch`（仅修复）或 `npm version minor`（攒批新功能）；主版本号先商量再升。`package.json` 为唯一版本来源，`npm version` 会同步更新 `package-lock.json` 并打 tag；发布后把发版提交同步回 `dev`。
- 面板页脚通过镜像构建时注入 `git describe --tags --always` 显示版本，构建上下文不含 `.git`，不在容器启动时再跑 git。

## 协作约定

- 不要先射箭后画靶。
- 做法别扭或有更简洁的方案先开口商量，对齐后再动手。
- 文档与代码注释少用极限词，不写会过期的数字（如测试条数、代码行数），避免出现人称代词。
