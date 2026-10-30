# Flytrap

小邮局，已收域名上的任意前缀都收下。原文在 `data/raw`，索引在 SQLite。设计初衷就是少收一封比多留一封垃圾更糟，基石需求就是至少收进来和不要漏掉任何一封。

## 本地

仓库就是这个目录。命令在这里跑。远程 `https://github.com/wvvu/flytrap.git`。改动进 `dev`，上线再合 `main`。

改完跑 `npm test` 和 `npm run typecheck`。只改 `src/api/public/` 时，跑 `npm run test:ui && npm run typecheck` 就够了，界面效果留给浏览器看。不要在 `test/ui.test.ts` 里加页面文案、色号、元素顺序、CSS 数值等字面量断言；那里只守安全底线（沙箱属性、CSP、无 innerHTML、鉴权拦截、路径穿越）。面板是 `src/api/public` 的静态文件，禁止 `innerHTML`。预览 iframe 用空的 `sandbox=""`，外链图片默认不加载。文案里不要出现「你」「我」「他」。

Windows 上 `MAIL_DATA_DIR` 用 `./data`。本地 `.env` 的 `admin` / `admin` 和占位 session secret 只给开发，生产启动会拒绝。`557555.xyz` 已在收信域名里，留着。不要提交 `sketch.html`。`docs/` 不入库。

## 远端 host173

`mail.srrrs.com`。SSH 名 `host173`。

`/srv/flytrap` 跟踪 `origin/main`。`flytrap-autoupdate.timer` 每分钟跑 `scripts/auto-sync.sh`，只做 `git pull --ff-only`。改动只有 `src/api/public`、`docs` 或 markdown 时不重建，其余执行 `docker compose build flytrap && docker compose up -d flytrap`。`/srv/flytrap-dev` 跟踪 `origin/dev`，同样有 timer，容器 `flytrap-dev`，面板在 `127.0.0.1:8081`。

宿主机的 `docker-compose.override.yml` 被 gitignore，不要覆盖。它把主机 25 映到容器 2525，并把 `src/api/public` 只读挂到 `/app/dist/api/public`。仓库里的 compose 没有 25 端口。数据目录 `/srv/flytrap/data` 挂到容器 `/srv/mail/data`。面板只听 `127.0.0.1:8080`，HTTPS 由 Caddy 终结。健康检查是 `curl http://127.0.0.1:8080/healthz`。

## 商量

做法不合适，或者有更合适的做法，先说出来。多聊几句，把这东西该长什么样定下来，再动手。

## 版本与发布

只有 `main` 对外。公开面板跟着 `origin/main`。bug 在 `dev` 修，不改版本号，用 commit 哈希区分。`dev` 可以在 `flytrap-dev` 上跑，那不是发行。

`dev` 合并进 `main` 时才升版本。这次只有修复，用 `npm version patch`。有新功能，用 `npm version minor`。主版本号先聊再升。一次合并升一次，修订号不是提交计数。

`package.json` 是唯一版本来源。`npm version` 会改 `package-lock.json` 并打 tag。不要在 `docker-compose.yml` 里再手写一个号。

升版本时在 `CHANGELOG.md` 加一行：版本、日期、一句话。

面板页脚显示 `git describe --tags --always`，构建镜像时注入。构建上下文没有 `.git`，不要等容器启动再去跑 git。`dev` 上出现 `v0.6.0-3-g……` 这种是对的。

启动时读 `PRAGMA user_version`。库比这份代码认识的新，就拒绝启动，不要倒着迁。库更旧时，仍用 `migrations/*.sql` 往前迁。

文档里不写会过期的数字，比如测试有多少个。
