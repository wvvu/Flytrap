# Flytrap 研发进度跟踪

## 本轮已完成修复与优化（2026-10-31）

- [x] **数据库启动防倒退**：`src/db/migrate.ts` 检查并写入 `PRAGMA user_version`，新库遇到旧代码启动直接拒绝，并在 `test/migrate-jobs.test.ts` 补充单测。
- [x] **防重灌丢信**：`src/ingest/accept.ts` 收到新邮件时清空 `purged_messages` 墓碑记录，避免日后 `--rebuild` 误跳过重建。
- [x] **手动改分类补齐完整 Schema**：`src/api/app.ts` 手改分类时为未分拣邮件补全 `schema: 1`、`model: manual`、`summary` 等字段，避免 Notify 任务挂掉。
- [x] **Gemini 多 Key 轮询修复**：`src/ai/gemini.ts` 修复 Key 冷却时取模导致跳过下一个可用 Key 的问题。
- [x] **OpenAI 错误回退**：`src/ai/openai-compat.ts` 保留非 200 响应体文本，确保模型不存在等错误能正确触发回退。
- [x] **SMTP 限流泄漏与大流 DoS 修复**：`src/smtp/limits.ts` 定期清理过期 IP，拒绝连接不再盲目 push；`src/smtp/server.ts` 截断拒绝流的大字节流。
- [x] **拉黑兜底与安全细节**：`src/api/app.ts` & `src/worker/job-parse.ts` 无 `From` 头邮件拉黑回退到 `envelope_from`；改密码清理重置码；提示词保存增加长度拦截。
- [x] **正文与信头编码**：`src/mail/text.ts` `htmlToText` 增加十六进制实体 `&#x...;` 与块级换行；`src/mail/headers.ts` 信头导出由 `latin1` 改为 `utf8` 避免乱码。
- [x] **前端核心交互修复**：`src/api/public/app.js` 已发信列表点击可查看详情；查看已发信隐藏置信度条；切换栏目清空旧邮件残留；支持 `/#/m/:id` URL Hash 邮件深链；写信多地址校验。
- [x] **CSS 变量拼写修正**：`src/api/public/app.css` 修复未定义的 `--border-default`（改 `--border-strong`）与 `--bg-hover`（改 `--bg-card-hover`）。
- [x] **提示词存入 SQLite**：`src/ai/prompt.ts` 等优先读写 `settings` 表，彻底兼容 Docker `read_only: true` 只读文件系统，热更新不报错、重建镜像不丢提示词。
- [x] **文案去除「您」字**：`src/api/public/index.html` 密码重置弹窗改为"请查看电子邮件"，同步更新 `test/ui.test.ts`。
- [x] **解除 Agent 测试自缚枷锁**：
  - `test/ui.test.ts` 删掉约 80 条搜色号、CSS 栅格、按钮顺序的字面量正则断言，只保留真正的安全与鉴权底线；
  - `package.json` 新增 `"test:ui": "tsx --test test/ui.test.ts"`（1 秒跑完）；
  - `AGENT.md` 明确规定只改前端时跑 `npm run test:ui && npm run typecheck`，界面交由浏览器查看。
- [x] **提示词（Prompt）3 层漏斗与大厂推广信治理**：`prompts/classify-v1.txt` 重新定义 `legit`（仅限切身相关的验证码、账单、安全提醒、交易、正事来信）与 `unsolicited-admin`（推广，包含知名大厂官方营销、功能推荐、周报），解决 OpenAI/Apple 等大厂推广信霸占收件箱、在正常与垃圾间反复横跳的问题。

---

## 待施工清单

### 一、高优先级（架构 / 配置双轨制收尾）

- [x] **打通 `.env` 与面板 AI 密钥配置**（2026-11-08 已做，未推库：`config.ts` 放宽启动要求，gemini 无 Key 可启动，openai-compat 只留 `OPENAI_BASE_URL` 必填；无 Key 时分类任务 `releaseJob` 暂缓 60 秒、不耗重试；面板保存 AI 设置后只要 AI 开着就 `wakeClassifyJobs` 立即激活；启动时无 Key 打 warning 日志）
  - **痛点**：当前在 `.env` 写了 `CLASSIFIER=gemini` 但没填 Key（想进面板再填），启动时会被 `config.ts` 强行拦截退出；设为 `fake` 启动后在面板配了 Key，Worker 又不工作。
  - **涉及文件**：`src/config.ts`、`src/worker/job-classify.ts`
  - **做法**：放宽 `config.ts` 启动时必须有 Key 的报错，允许无 Key 启动；分类任务在发现没 Key 时不消耗重试次数，暂缓或跳过，面板配好 Key 并保存后调 `wakeClassifyJobs` 立即激活。

- [x] **启用 `DISK_ALERT_BYTES` 磁盘容量告警**（2026-11-08 已做，未推库：新增 `src/worker/disk-alert.ts`，`dirSizeBytes` 递归统计、`checkDiskAlert` 超限打 warning 日志；Worker 启动时立即查一次，之后每 15 分钟查一次，`diskAlertBytes` 为 0 时不挂定时器）
  - **痛点**：`.env.example` 和 `src/config.ts` 都定义了该变量，但代码中没有任何地方调用。
  - **涉及文件**：`src/worker/loop.ts`、`src/main.ts`
  - **做法**：在 Worker 启动时根据 `diskAlertBytes` 挂一个每 15 分钟异步统计 `dataDir` 大小的定时器（递归计算文件大小），超限时打 warning 日志。

- [x] **全仓 100% 中性化（去 Flytrap 项目名）**（2026-11-08 已做，未推库：面板标题默认 `"邮箱"`、主题键 `mail_theme`（读一次旧键并迁移）、Cookie `mail.sid`、Telegram 首行 `[label] (0.90)`、DKIM 默认选择器 `mail`、原始信头展示 `X-Mail-Smtp`；注意：Cookie 改名后已登录会话失效一次，需重新登录；已生成的 DKIM 密钥不受影响，只影响新生成的。2026-11-09 跟进：删掉 `#panel-name` eyebrow（html/js/css 三处），并让已存库里的旧 `"Flytrap"` 标题读作默认 `"邮箱"`，否则旧标题还会从浏览器标签页冒出来）
  - **痛点**：面板希望作为无品牌的私人小邮局使用。目前残留 7 处硬编码项目名。
  - **涉及文件**：`src/api/public/index.html`、`src/api/public/app.js`、`src/api/public/boot.js`、`src/db/repos/settings.ts`、`src/api/app.ts`、`src/mail/dkim.ts`、`src/notify/types.ts`
  - **做法**：
    1. `DEFAULT_PANEL_TITLE` 和前端 `panelTitle` 默认值由 `"Flytrap"` 改为 `"邮箱"`；
    2. 主题存储键 `flytrap_theme` 改为 `mail_theme`（兼容读一次旧键）；
    3. Cookie 名 `flytrap.sid` 改为 `mail.sid`；
    4. Telegram 推送首行前缀去掉硬编码 `Flytrap`，改用面板标题或 `[${input.label}]`；
    5. DKIM 默认选择器 `DEFAULT_DKIM_SELECTOR` 可改用 `mail` 或保留。

---

### 二、中优先级（界面动线与设置页重塑）

- [x] **最左栏（Icon Rail）动线排布重塑**（2026-11-08 已做，未推库：仅改 `index.html` 顺序，上半区收件箱 → 已拦截 → 发信 → 垃圾桶，设置沉到左下角主题切换上方，带失败任务角标；无需改 CSS）
  - **痛点**：「发信」横插在「收件箱」和「已拦截」中间打断了查信动线；「设置」作为低频操作与日常信箱混在顶部。
  - **涉及文件**：`src/api/public/index.html`、`src/api/public/app.css`
  - **做法**：
    - 上半区纯信箱：**收件箱 → 已拦截 → 发信 → 垃圾桶**（查收信连贯，找误判最顺手）；
    - 下半区纯控制：把 **设置**（带失败任务红色角标）沉到最左下角，位于主题切换和退出按钮上方。

- [ ] **设置页「12 合 5」大重构 + 消灭保存假动作**
  - **痛点**：左边 12 个菜单太碎，管一个域名要跳 4 个页面；有的项添加直接生效，有的添加还要去右上角点保存，手感割裂。
  - **涉及文件**：`src/api/public/index.html`、`src/api/public/app.js`、`src/api/public/app.css`
  - **做法**：
    - 菜单收敛为 **5 个大面板**：
      1. **域名与发信**：收信域名 + 域名短名 + DKIM 密钥合体（每域名一张卡片）；
      2. **地址与黑名单**：收件地址备注/别名 + 发件人黑名单；
      3. **分拣与提醒**：AI 开关/思考等级/模型 Key 列表 + 提示词 + 推送通知；
      4. **状态与日志**：今日/14天统计概况 + 失败重试入口 + 运行日志；
      5. **界面与账号**：面板名称与分类显示名 + 修改密码。
    - **交互统一**：所有列表的「添加 / 移除 / 排序」点击后直接写库生效并 toast 提示，彻底消除保存假动作。

- [x] **`app.js` 拆分为原生 ES Modules**（2026-11-10 已做：3,660 行单文件 → 14 个模块，零行为改动，测试 85/85）
  - **痛点**：1,700 行单文件，顶部挂着 30 多个全局变量，缺少状态机，AI 局部打补丁容易遗漏状态重置。
  - **涉及文件**：`src/api/public/`
  - **做法**：坚决不引入 React/Vue/Webpack 等重型构建链，直接利用浏览器原生的 `<script type="module">`，拆为 4 个职责单一的文件：
    - `state.js`：全局变量、当前视图与详情面板统一重置方法；
    - `mail-view.js`：收件/拦截/垃圾桶列表、正文 iframe、AI 摘要条、分类与拉黑；
    - `send-view.js`：发信表单、已发信列表与详情、重发；
    - `settings-view.js`：各个设置板块的交互与异步保存。
  - **实际落点（与上面 4 文件计划有出入）**：按 AST 依赖分析拆成了 14 个模块才没有循环引用 —— `constants.js`（常量）、`state.js`（49 个 let 收进一个 `state` 对象，跨模块只能读写 `state.xxx`）、`dom.js`（89 个元素引用）、`util.js`（纯函数，含 `replyAddress`/`quoteLetter`/`outboxStatus` 等回复推导）、`net.js`（`request`/`fetchCsrf`）、`ui.js`（提示/确认框/标题/未读数）、`nav.js`（`switchNav` 注册表，断开 dlq/send 与 shell 的环）、`shell.js`（主题/栏目切换）、`auth.js`（登录/启动引导/找回密码）、`mail-view.js`（859 行）、`dlq-view.js`、`settings-view.js`（964 行）、`send-view.js`、`app.js`（391 行入口，只剩事件绑定 + `init` + 15 秒轮询）。附带两处配套改动：`src/api/static.ts` 的 `PANEL_FILES` 白名单加了 12 个新模块（否则浏览器 import 会 404），`test/ui.test.ts` 的安全基线（no innerHTML / 无你我他 / 无 emoji / stripRemoteImages）改为覆盖全部 14 个 JS 文件。核对过：196 个函数、49 个 let、88 个 DOM 引用一个不少；依赖图是无环的；`node --check`、typecheck、全量测试、build 全过。

---

### 三、低优先级（日常收发信体验打磨）

- [x] **点击「回复」自动填入发件人别名**（2026-11-08 已做，未推库：`startReply()` 取 `envelopeTo` 第一个地址填 `#send-from`，没有时用上次使用的；发信成功后把发件人记到 `localStorage` 的 `mail_last_from`，新写信时自动填）
  - **痛点**：Catch-all 模式下，对方可能寄到 `me@domainA` 或 `work@domainB`。目前点回复发件人是空的，需要手敲回忆。
  - **涉及文件**：`src/api/public/app.js`
  - **做法**：在 `startReply()` 中读取当前信的 `envelopeTo`，匹配出属于当前收信域名的地址自动填入 `#send-from`；日常写信时记住上一次使用的发件人地址到 `localStorage`。

- [x] **发信支持「发件人称呼（Display Name）」与界面抄送/密送**（2026-11-08 已做，未推库：发信接口在 `mailbox_history` 查发件地址的称呼，拼成 `From: 名称 <地址>`；发信表单加「抄送 / 密送」展开按钮和两个输入框，抄送进信头、密送只在信封）
  - **痛点**：后端底层早已支持 Cc/Bcc 和别名记录，但前端发信界面没画输入框，发信也只发裸邮箱地址。
  - **涉及文件**：`src/mail/submit.ts`、`src/api/public/index.html`、`src/api/public/app.js`
  - **做法**：后端发信时在 `mailbox_history` 查询发件人是否有设置称呼，拼入 `From: Display Name <email>`；前端收件人右侧加小按钮展开 Cc / Bcc 输入框。

- [x] **点开邮件合并网络请求**（2026-11-08 已做，未推库：`/v1/messages/:id/html` 顺带返回 `headers`，前端直接用，失败时才单独调 `/headers`；`/headers` 接口保留作兜底）
  - **痛点**：点开一封信同时请求详情、`/html` 和 `/headers`，后两者各自去磁盘解压一次原始邮件。
  - **涉及文件**：`src/api/app.ts`、`src/api/public/app.js`
  - **做法**：在 `/v1/messages/:id/html` 返回结果中顺带返回解压后解析好的 `headers`，前端免调 `/headers` 请求，节省一次磁盘 I/O 和内存解压。

- [x] **15 秒后台轮询改为无感增量更新**（2026-11-08 已做，未推库：短列表（<40 封）轮询不再 `reloadMessages()` 全量重绘，改走 `mergeFreshMail()` + `removeStaleMail()`，被 AI 移走的信从 DOM 里 `.remove()`；超过 40 封的长列表本来就走增量，不动）
  - **痛点**：列表信件较少时，轮询发现新信会调用 `reloadMessages()` 清空 DOM 重绘，导致滚动条回顶闪烁。
  - **涉及文件**：`src/api/public/app.js`
  - **做法**：废弃 `reloadMessages()`，统一走 `mergeFreshMail()` 增量插入新信，并把被 AI 移走或判成垃圾的信从当前 DOM 中 `.remove()`。

- [x] **收件箱「正事 / 推广」胶囊切换**（2026-11-08 已做，未推库）
  - **痛点**：把大厂推广信与钓鱼木马一起扔进「已拦截」显得过重，放在收件箱又淹没重要通知。
  - **涉及文件**：`src/api/public/index.html`、`src/api/public/app.js`
  - **做法**：收件箱顶部刷新按钮左侧放一个「推广」小按钮（复用现成的 `.pill.pill-promo` 样式），不是两个胶囊；点一下只看推广（`label=unsolicited-admin`），按钮变紫、标题变「推广」，再点一下回正常。15 秒轮询自动沿用当前模式；推广里改成正常、或正常里改成推广的信会从当前列表消失；切走别的栏目再回来自动回正常。未读数暂不挂：`/v1/unread` 只有收件箱和已拦截两个数，推广没有单独的数。

---

## 方向性讨论结论与认知备忘（勿盲目开发）

- **多用户**：做起来很轻（约 300～400 行代码），本质是 SQLite 加 `user_id` 和域名归属隔离，底层 EML 原文按 SHA-256 天然去重共享，随时可做。
- **IMAP**：**坚决别做！** Node.js 无成熟轻量库，手搓 RFC 3501 状态机极其沉重；且传统客户端只认死板正文，展示不了 AI 摘要/重分类，UID 机制也与异步分拣天生冲突。
- **移动端正解（PWA）**：加 20 行 `manifest.json` 配置原生级 PWA，在手机浏览器中"添加到主屏幕"变身全屏独立 App，配合 Telegram 推送里的 `/#/m/:id` 深链秒开，体验远胜 IMAP。
- **拉黑后对方不再发信的真相**：不是漏信 Bug。系统默认零外链沙箱（`img-src data: cid:`）彻底掐断了 HTML 里的 1×1 透明追踪像素（Tracking Pixel），加上静默进垃圾桶，对方连续收不到已读信号，会触发大厂营销系统的"日落策略"或群发器的"防蜜罐机制"，主动对你停发或退订。
