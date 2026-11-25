# Flytrap 研发进度跟踪

判断以这份清单为准。四份结论里「以第 3 抽为底座」是当时说的「搞 3」，后来的决定是：骨用第 4 抽，皮用第 3 抽，第 1、2 抽只拆零件。`dev` 与 `origin/dev` 停在 `c50ad2a`，版本停在 `0.8.0`。施工从 `tan/studio-2`（`587bbf9`）拉 `tan/integrate`，一段一段提交，不并进 `dev` / `main`，不推远程，除非另行说明。`tan/integrate` 已推进到 `4ef77d6`，阶段 1 到 8 的施工与验证完成；2026-11-19 评审修复 P0 到 P3 已完成，代码停在 `2b15020`，102 项测试全绿。只剩合 `main` 发版时才做的 CHANGELOG 和版本号。

`.env` 留在工作区。提交前看 `git status`，跳过 `.env`，不用 `git add -f`。

做法是抄，不是按这份清单重写。`tan/integrate` 的起点就是第 4 抽整棵树，测试和路由都带着。三个删信洞是改现成函数。第 3 抽的 403 是把现成判断贴进第 4 抽已有的用户路由。成员页用第 4 抽现成的 `users-view.js`，只把入口挪进设置，文案从第 3 抽的表单抄。星标、审计列表、抽屉、验证码提取，从对应抽抄函数或整段，只改第 4 抽的名字。每人 Webhook 不能整文件贴，第 2 抽查的是 `user_messages`，第 4 抽没有这张表，循环抄过来，人改成读时裁决的结果。

## 已定、不再重开

- 骨是第 4 抽的读时裁决：精确 > `+tag` 基座 > 前缀 > 整域 `*` > owner 兜底。归属每次读的时候算，不入库盖章，不做「同步历史」。改分配会立刻改历史可见性，撤分配和删号都不删信，信回到 owner。
- 皮是第 3 抽看过并留下的那套：原版三栏，成员做在设置里，成员自己只看见自己的额度和规则。第 4 抽的「收件视角」下拉留着（本号与未分配 / 全站 / 某个成员）。两套成员页不并存。
- 前缀通配要有。第 4 抽没有，第 1、3 抽有。排在 `+tag` 基座之后、整域 `*` 之前。存成带尾星的 localpart，例如 `alerts-*`，沿用第 4 抽的 `UNIQUE(localpart, domain)`。第 3 抽的 `UNIQUE(kind, localpart, domain)` 跨 kind 碰不上，这轮不抄那条约束。精确和通配可以共存，档位小的赢。
- 两人共管同一地址这轮不做。第 1 抽那是故意的。以后若做，管理员勾选之后才允许同一地址第二条，未勾选时返回 409。
- 星标只做每人一份，写 `user_message_state`。owner 和协同管理员也各写各的。不新增、不使用 `messages.starred_at`。
- 找回密码走第 4 抽的密保邮箱，不按分配反查。前缀和整域成员靠密保邮箱，不靠「地址匹配到谁」。
- 发信配额沿用第 4 抽：按 UTC 日，默认 100，可设 0–10000，超了 429。不改成第 1 抽的滚动 24 小时。
- owner 可以以本域任意地址代发。协同管理员和成员一样，只能用裁决赢家是自己的地址，不能拿整域去冒用别人的精确地址。第 4 抽现在对所有 admin 豁免，接上第 3 抽的角色分开之后把豁免收成只剩 owner。
- 自己改密码：踢掉其他会话，留下当前这次。管理员改别人的密码：对方全部会话踢掉。
- 管理员用「某成员视角」预览时保持现在的未脱敏，界面标明「管理员视角，未脱敏」。成员自己看信沿用第 4 抽：列表和信封只留自己的地址，原文里的 To/Cc 保持原样。BCC 仍只活在信封上。
- 第 3 抽的 trash 已对过代码，这轮不搬它的读法。成员恢复写的是个人行的 NULL，列表却用 `COALESCE(ums.trashed_at, m.trashed_at)`，全局列还有值时信仍在垃圾桶。接口不看这个结果，直接回 `trashed: false`。第 4 抽的删除洞用它自己的引用计数改。
- 第 2 抽的触发器和一键回溯不拿。第 4 抽没有回溯漏洞的土壤，接上去会把漏洞接回来。
- 第 1 抽的三列重做、`0.9.0`、CHANGELOG 里的 v0.9.0 条目，不拿。
- 通知：分类和 AI 结果仍是全局一份。Telegram 仍是全局。每人一套的是 Webhook（标签和置信度阈值也按人）。owner 手改分类会冻住这封信以后的自动分类，文档里写明，这轮不改这个行为。
- 发版前才写 CHANGELOG、才动版本号。

## 已对过的代码

第 3 抽 `src/db/repos/messages.ts`、`src/api/app.ts`：

- 成员恢复在 `restoreMessage`：有 `memberScope` 时把 `user_message_state.trashed_at` 写成 `NULL`（约 532–544 行）。
- 列表在 `listMemberMessages`：`effTrashed = COALESCE(ums.trashed_at, m.trashed_at)`（438 行），选出的 `trashed_at` 用的是这个值（492 行）。个人行是 NULL、全局列还有值时，信仍算在垃圾桶。同一写法还在未读统计和 `emptyMemberTrash`（约 303、584、721、758 行）。
- 详情在 `getMessageForMember`：`state?.trashed_at ?? row.trashed_at`（142 行）。上面 136–138 行有一段空 `if (row.trashed_at !== null)`，块里只有半句注释，不参与判断。
- `POST /v1/messages/:id/restore`（app.ts 约 892–904 行）调用 `restoreMessage` 之后直接 `reply.send({ ok: true, id, trashed: false })`，没有再读有效 trash。
- 成员自己先丢再恢复、全局列是空的时候，`COALESCE` 得到 NULL，恢复是有效的。假成功只出现在全局 `messages.trashed_at` 已有值的时候。

第 4 抽 `src/db/repos/users.ts` 的 `sqlResolvedOwner`（97–116 行）和 `findWinningAllocation`（467–481 行）CASE 相同：`localpart = rawLocal` 为 1，`localpart = '*'` 为 3，其余为 2。`+tag` 基座走其余那档。

第 4 抽删除口在 `src/api/app.ts` 约 905–909 行：管理员没带 `scope` 时 `deleteMessageForViewer` 收到 `viewerOf(..., "all")`。`messages.ts` 的 `deleteMessageForViewer` 见 `visibility === "all"` 就 `deleteMessage`（约 685–686 行）。`emptyTrashForViewer` 见 `all` 就 `emptyTrash`（约 746 行）。

## 待施工

### 0. 分支

- [x] 从 `tan/studio-2` 拉 `tan/integrate`。工作区在 `C:\Users\admin\Desktop\Flytrap-integrate`。`dev` 不改这些文件。
- [x] 这支的 `package.json` 仍是 `0.8.0`。

### 1. 先补第 4 抽的洞，再搬零件

测试补在第 4 抽已有的三个场景旁边，各自独立 `test()`。这三项没绿之前，不动界面。

- [x] **删信按当前视角。** 没带 `scope` 走当前视角。`scope=all` 才全站删除。全站确认文案是「将为所有成员彻底删除」。提交 `3be7c3b`。
- [x] **三种删信测试** 在 `test/multi-user.test.ts` 的新测试里：不带 scope 的共享信还在别人那里；`scope=all` 物理删；`scope=user:<id>` 只去掉那一个人。
- [x] **清空垃圾桶走引用计数。** `scope=all` 时，还有别的持有者就清掉 owner 的 `trashed_at`，没有才物理删。
- [x] **清空测试：** owner 把只属于成员的信丢进垃圾桶，`scope=all` 清空后成员收件箱里还在，`trashed_at` 为空。
- [x] **owner 的本号垃圾桶能看见自己丢掉的共享信，不带 scope 的恢复有效。**
- [x] **没配邮箱的管理员默认「本号」。** 去掉了 `viewerOf` 里落到 `all` 的分支。
- [x] **清空文案** 改成「已处理 N 封」。
- [ ] **地址切分。** JS 的 `splitNormalized` 已改走 `normalizeAddress`，`+` 在第一位不切，和 SQL 的 `plusPos > 1` 对齐。SQL 仍用第一个 `@`。这台 SQLite 3.53.2 没有 `reverse()`，不能在 SQL 里取最后一个 `@`。`normalizeAddress` 接受的地址只有一个 `@`，两边一致。畸形的多 `@` 地址还没对齐。
- [x] **`job-parse.ts` 两段相同的 owner 分支已并成一段。**

### 2. 从第 3 抽把权限判断贴进第 4 抽已有的路由

不重写 `users.ts`，不换第 4 抽的表。从第 3 抽 `src/api/app.ts` 把这几处判断抄到第 4 抽同一类路由上：`only_owner_can_grant_admin`、`only_owner_can_manage_admin`、`cannot_delete_self`、`cannot_disable_self`。

- [x] **owner 守卫。** 协同管理员建管理员、改管理员、停用管理员、重置管理员密码、删管理员，返回 403，`reason` 是 `only_owner_can_grant_admin` 或 `only_owner_can_manage_admin`。不能停用自己（400 `cannot_disable_self`），不能删除自己（400 `cannot_delete_self`）。owner 这个 id 仍是 400。owner 做同样的管理操作成功。
- [x] **踢会话接口。** `POST /v1/users/:id/sessions/revoke` 调用第 4 抽已有的 `clearUserSessions`。管管理员时只有 owner 能调。停用、删号、管理员重置密码清会话留着。改角色也会清会话。
- [x] **自己改密码只踢其他会话。** `PUT /v1/settings/password` 用 `clearUserSessionsExcept`，当前这次留下。owner 改自己的密码同样只清掉其他 owner 会话。
- [x] **删号在一个事务里清掉会话、分配、个人状态和用户行。** 第 4 抽没有 `user_preferences` 表。信不删。删除和收回分配的确认文案写了删号不删信、历史信留在库里。
- [x] **测试** 在 `test/multi-user.test.ts`。成员带 `scope=all` 仍只看见自己的信。

### 3. 皮：挪入口，不重做成员页

第 4 抽的 `users-view.js`、视角下拉、随机口令、开户凭证、配额、`can_send` 都留着。不把第 3 抽的 `users-view.js` 整文件盖上来，两边接口不一样，盖上来就是重写。

- [x] **把第 4 抽现成的成员区块挪进设置第一区。** 左栏「成员」打开这一区，并点亮成员而不是设置。设置回到上次离开的非成员区，默认仍是域名。非管理员隐藏沿用第 4 抽 `shell.js` 已有的判断。成员自己从「专属邮箱与发信额度」看起，地址与黑名单、界面与账号留着。提交 `c9ffeb3`。
- [x] **分配文案从第 3 抽表单抄。** 精确邮箱（含 `+tag`）、前缀通配、整域接管。前缀旁写了字面起首，`team` 会匹配 `teammate`。整域旁写了没被更具体规则接住的地址，连历史信一起划走。`c9ffeb3` 时尾星先停在表单上，前缀档接上之后同一表单可以提交。
- [x] **分配冲突返回 409，界面把冲突亮出来。** `reason` 带上 `mailbox already allocated`。冲突时停在表单上，写出「这个地址已经分给别人」。
- [x] **切视角、切筛选时清掉阅读窗。** 视角、收件域名、已拦截筛选都会先清掉右边打开的信。
- [x] **换皮之后设置页仍留着「试密钥」。** 第 4 抽这份「试」按钮跟着走。
- [x] **域名页两个「生成密钥」按钮并成一个。** 收信域名卡片上留着。单独的按钮拿掉了，输入框按回车仍给未加入收信列表的域名生成密钥。

### 4. 从第 1 抽抄函数，不抄整页

第 1 抽的 `mail-view.js`、`index.html`、`palette.js` 整文件留在那一枝。星标的界面从里面抠按钮、筛选和 `S`，后端抄 `setMessageStarred` 的成员分支，接到第 4 抽的 `*ForViewer`。星标写在 `user_message_state`，不写 `messages.starred_at`。

- [x] **星标。** 提交 `6edb727`。迁移 `012` 给 `user_message_state` 加 `starred_at`。写入抄第 1 抽成员那一支，owner 和协同管理员各写自己的状态行。列表和详情读的是当前登录人的星，管理员预览别人时不改对方的星。界面是列表按钮、阅读页按钮、收件箱「星标」筛选和 `S`。
- [x] **前缀是多一档，两处 CASE 一起改。** 提交 `43c3272`。`sqlResolvedOwner` 和 `findWinningAllocation` 同一套排序：1 精确、2 基座（`localpart = baseLocal` 且 `rawLocal` 与 `baseLocal` 不同）、3 尾星前缀、4 `*`。原 `IN` 仍只放精确、基座、`*`。前缀走另一条谓词，不进 `ELSE`。`team*` 收得到 `teammate@`。发信地址的前端判断用了同一套档位。
- [x] **`can_send` 第 4 抽已有。** 管理员直通收成 owner 直通。协同管理员走 `canMemberSendFrom`，用别人的精确地址发信是 403，用自己的地址是 202。配额仍按第 4 抽，只卡在非 admin 上。
- [x] **审计列表从第 1 抽抄。** 提交 `37af5de`。`listAuditLogs` 按人和动作过滤。成员详情里有这张表，动作可以再筛一次。详情里的密钥打成 `[redacted]`，用的是第 4 抽已有的 `redactLogLine`。`writeAudit` 调用留着。读信不记审计。
- [x] **备注第 4 抽表单里已经有。** 创建、修改和成员详情都读写 `users.notes`，这次没有另加字段。
- [x] **分配的域名取自当前收信域名。** 提交 `8061263`。下拉只用当前收信域名。创建账号和再分配时，服务端再对一次当前收信列表，不在列表里是 400 `domain is not accepted`。表单上也停住并写出「这个域名不在收信列表里」。
- [x] **改角色也清会话。** 已和 owner 守卫一起做了。
- [x] **测试：** 提交 `6edb727`。两人共享一封信，一边星标、改标签、进垃圾桶、软删，另一边状态不变。owner 和协同管理员各写自己的星，预览别人时列表上的星是自己的。前缀和代发这半已经在 `test/multi-user.test.ts`：前缀成员收得到 `alerts-prod@`，收不到别人的精确地址；协同管理员用别人的精确地址发信是 403。

### 5. 从第 2 抽抄的，只有对得上缝的

黑名单按人、引用计数，第 4 抽已经有，不搬 `user_messages`。

- [x] **每人 Webhook：抄循环，改查询。** 提交 `4a57f37`。从第 2 抽抄「全局先发，再按持有者各发」和 `notified` 去重。持有者用第 4 抽的读时裁决。个人 URL、Bearer、标签、阈值写在已有的按人设置键上。链接仍是 `/#/m/<id>`。
- [x] **附件个数从第 2 抽抄。** 提交 `600c7bf`。前端芯片和后端 `attachments.max(5)` 直接拿。发信路由单独放宽请求体上限，10MB 后端同样拒绝。
- [x] **测试：** 一个人的 Webhook 不会收到只属于另一个人的信。提交 `4a57f37`。置信度不够、已进垃圾桶、已停用的持有者也不推。全局通道仍先发。
- [x] **测试：** 提交 `600c7bf`。5 个附件能入队并解析回原内容；第 6 个附件和 10MB 以上返回 400，且不落发件箱。

### 6. 抽屉和验证码，整段抄

- [x] **抽屉整段抄第 2 抽。** 提交 `73d58e3`。`#compose-sheet`、`send-view.js` 里的抽屉、对应的 `app.css`。草稿 key 和发件地址仍走 `sessionUserId` / 邮箱列表，宽屏选择记在这个浏览器，退出账号前先暂存旧草稿再清浮层内存。
- [x] **验证码提取整函数抄第 2 抽 `util.js` 的 `extractOtpCode`。** 提交 `73d58e3`。文案改成「疑似验证码」。第 4 抽已有的点按复制留着。

### 7. 壳定下来之后的旧面板事项

这些不插进上面的阶段。颜色类的等成员页和抽屉都落定再动，避免打在即将换掉的样式上。

- [x] **一键已读：** 底座已有。有未读才出现，放在「推广」左边。快捷键 `U` 已接当前信件标回未读。
- [x] **快捷键：** 底座已有。`/` 聚焦搜索，搜索框里 Esc 清空。翻信和打字保护沿用底座；`C` 随抽屉改为直接打开悬浮写信窗口。
- [x] **推广按钮：** 底座已改为低饱和雾霾蓝靛，激活态有明确边框和字重。
- [x] **分类按钮后面的颜色：** 底座已改为低饱和语义色阶。
- [x] **SPF、DKIM、DMARC 的 pass 颜色：** 底座已改为中性底加小圆点，只有 fail 才用危险色。
- [x] **加入黑名单、移入垃圾桶：** 底座已改为常驻中性色，悬停才呈现克制危险色。
- [x] **浅色模式：** 底座主色已是 `#0B57D0`。

### 8. 收尾时才做

- [x] 真库副本与空库都跑过。本地真库 73 封从旧 schema 迁到 012；host173 真库 406 封备份从 010 迁到 012，完整性 `ok`，空库冷启动完整跑 001–012。
- [x] 大库上看一眼列表。host173 副本 406 封，列表 200 次平均 0.41ms、最差 1.15ms；这个规模先不加索引。
- [x] CHANGELOG 在合 `main` 发版时一次写清。版本那时再升。已落地为 v0.9.0。
- [x] README 按实际行为写。提交 `4ef77d6`，补上四级路由、通配划走历史、删号不删信、管理员视角不脱敏、协同管理员不能代发、Webhook 按人和附件限制。
- [x] 第 1 抽 README 里「彻底杜绝身份伪造」这类句子留在那一枝。主线 README 按当时的实际行为写。

## 不做

- 不并第 1 抽的三列、命令面板整页、双主题重写、PWA 清单。星标、审计、探针按上面的条目单拆。
- 不并第 2 抽的触发器、`user_messages` 物化表、默认勾选的同步历史、非排他分配、只靠 10 分钟 30 条的发信限流。
- 不并第 3 抽的纯 OR 匹配、`COALESCE(ums.trashed_at, m.trashed_at)` 这套读法、`getMessageForMember` 里那段空 `if`、管理员单封物理删除。
- 不做 IMAP。
- 不记录管理员读信的审计。
- 不改写邮件原文来隐藏 To/Cc。

## 方向性备忘

- **多用户不是 300 行的小事。** 底座是第 4 抽整套读时隔离，再按上面的阶段嫁接。旧笔记里「加一列 user_id 就行」作废。
- **IMAP：** 不做。
- **手机：** 以后加 PWA，不在这轮。

**少用“严禁 绝不 必须”等极限词写progress.md，不要出现"你我他"，警惕先射箭后画靶**

## 超级大合并 Review 修复清单（2026-11-19 评审结果）

依据全量 6 维度代码审查结果，按优先级推进修复与加固：

### P0 数据生命周期与隔离安全
- [x] **全局清空垃圾桶补齐软删除标记**：提交 `eb26439`。`emptyGlobalTrash` 保留共享信时同步写入 Owner 的 `deleted_at`。
- [x] **Owner 软删除清理底层垃圾标记**：提交 `eb26439`。Owner 软删除共享信时清空 `messages.trashed_at`。
- [x] **前缀通配特异性长度排序**：提交 `eb26439`。SQL 与前端同一套长前缀优先排序。
- [x] **单字符账号基座切分修正**：提交 `eb26439`。JS 基座切分改为 `plus > 0`；SQL 原本按 1 位下标判断，单字符基座已正确。
- [x] **协同管理员个人视角 BCC 脱敏**：提交 `eb26439`。非 Owner 的 `mine` 视角开启收件人与 SMTP 元数据过滤。
- [x] **入站黑名单分流处理**：提交 `eb26439`。全部持有者拉黑才全局进垃圾桶；部分拉黑只写个人状态，分类与通知继续。

### P1 权限守卫与时序加固
- [x] **`sessionIsOwner` 判定收窄**：提交 `889cc03`。直接比较 session 的 `userId`，未登录不再默认 Owner。
- [x] **协同管理员个人资料自更新放行**：提交 `889cc03`。仅在成员提权为管理员时拦截，协同管理员更新自身资料不再误报。
- [x] **恢复接口校验软删除状态**：提交 `889cc03`。当前视角已软删除时返回 404，不返回假成功。
- [x] **移入垃圾桶校验当前视角访问权**：提交 `889cc03`。未带 scope 时不影响仅属于别的成员的邮件。
- [x] **强制重分类清理成员覆盖标签**：提交 `889cc03`。`force` 分类后清空该信的成员 `manual_label`。
- [x] **旧库升级发信统计兼容**：提交 `889cc03`。迁移补 Owner 回填，计数兼容历史空 `user_id`。

### P2 前端交互与细节完善
- [x] **写信抽屉补充拖拽上传事件拦截**：提交 `169d7a6`。`dragover`、`dragleave`、`drop` 全部接管，拖入附件直接走现有校验。
- [x] **写信抽屉小窗按 Esc 快捷关闭**：提交 `169d7a6`。宽屏先退回小窗，小窗直接关闭。
- [x] **验证码提取正则兼容英文常用词**：提交 `169d7a6`。兼容 `is` / `was` 连接词与中英文标点。
- [x] **协同管理员查看别的 admin 时禁用操作按钮**：提交 `169d7a6`。资料、状态、邮箱、密码与删除操作按权限禁用。

### P3 回归测试用例
- [x] 编写长前缀 vs 短前缀通配路由竞争测试。提交 `2b15020`。
- [x] 编写单字符账号 `+tag` 基座发信与收信测试。提交 `2b15020`。
- [x] 编写入站多收件人部分拉黑场景下，未拉黑成员通知与 AI 分类正常触发的测试。提交 `2b15020`。
- [x] 编写全局清空垃圾桶后 Owner 软删除与引用计数释放测试。提交 `2b15020`。

## v0.10.0 审计与实测修复清单（2026-11-25 评审结果）

依据代码审计、交叉复核及本地浏览器探索式实测结论分阶段落地，全部修复完成后通过 `npm run typecheck` 与 `npm test` 验证。

### 阶段零：基线落盘
- [x] 单独提交工作区 `scripts/android/flytrap-sms.py` 与 `scripts/android/flytrap-sms.sh` 的 `inotifyd` `:cwynd` 监听改动（提交 `47d2663`）。

### 阶段一：核心防线、短信抗毁与后端稳定性
- [x] **拉黑接口补齐当前视角访问校验**：`src/api/app.ts` `POST /v1/messages/:id/block` 在写入黑名单及 `trashMessageForViewer` 前校验 `canViewerAccessMessage`，未通过返回 404。
- [x] **个人 Webhook / Bark 出站拦截私网与保留地址**：新增 `src/notify/url-guard.ts`，在 `src/db/repos/settings.ts`、`src/notify/webhook.ts`、`src/notify/bark.ts` 与 `src/worker/job-notify.ts` 中对非 `owner` 成员强制拦截私网/回环/保留段与重定向，保留 `ALLOW_PRIVATE_WEBHOOK_URLS=true` 与 `owner` 豁免。
- [x] **日志脱敏路径补全**：`src/log.ts` 的 `REDACT_PATHS` 增加 `smsIngestToken`、`SMS_INGEST_TOKEN`、`barkUrl`、`BARK_URL`。
- [x] **短信 `messageId` 防重置撞库**：`src/ingest/sms.ts` 基于规范化发件人、毫秒时间戳与原文内容生成确定性摘要后缀，保留网络重试幂等的同时避免同设备重置 `_id` 归零撞库。
- [x] **手机端守护异常与队头阻塞加固**：`scripts/android/flytrap-sms.py` 捕获 `sqlite3.Error` 并在 `finally` 中关闭连接；两份脚本仅对 `400`/`413`/`422` 跳过推进游标，对其余失败保留游标退避并支持 `inotifyd` 异常退出自动拉起。
- [x] **Worker 与优雅停机**：`src/worker/loop.ts` 中 `notify` 死信保留记录与告警而不再覆写 `messages.error`；`src/main.ts` 的 `shutdown()` 增加 30s `.unref()` 强退兜底。

### 阶段二：前端多账号隔离与关键交互修复
- [x] **登出及切回新建表单清理开户凭证**：`src/api/public/auth.js` 与 `src/api/public/users-view.js` 清理并隐藏 `#uc-credential-box`、`#uc-credential-text`、`state.lastCreatedCredentials` 与选中/探针缓存。
- [x] **登出切号清理写信发件候选**：`src/api/public/send-view.js` 的 `resetComposeForAccount()` 清空 `#send-from-list` 与 `#send-identity-pick` 并恢复隐藏，登录进入或打开写信窗时按当前账号重建候选。
- [x] **修复前缀通配 `localpart*` 默认值与标签**：`src/api/public/send-view.js` 对前缀通配去掉尾 `*` 作为建议发件地址；`src/api/public/users-view.js` 管理员详情行对齐前缀通配展示文案。
- [x] **修复切页异步竞态与 `is-booting` 残留**：`src/api/public/dlq-view.js` 与 `src/api/public/send-view.js` 校验视图与请求令牌；`src/api/public/shell.js` 在 `finally` 中移除 `is-booting`。
- [x] **补齐成员强制下线与交互防护**：`src/api/public/users-view.js` 补充「退出该账号的登录」按钮（按 `allowSelf=false` 约束权限）；`src/api/public/app.js` 与 `ui.js` 拦截确认弹窗 `Escape` 穿透；`src/api/public/settings-view.js` 以服务端基线快照兜底 AI 配置保存失败回滚。

### 阶段三：轻量体验抛光、搜索增强与收尾
- [x] **搜索支持收件人与简单正文**：`src/db/repos/messages.ts` 扩展 `q` 查询覆盖 `to_addrs`、`envelope_to`（遵守 `redactOtherRecipients` 脱敏边界，成员不可搜别的成员 BCC 地址）、`parsed.text` 与 `ai_result.summary`；同步更新搜索框提示文案。
- [x] **高频按钮防连击与细节文案对齐**：为「全部已读」、邮箱「收回」与账号「停用/启用」增加在途禁用；`users-view.js` 审计筛选去重旧键、协同管理员默认视角改为「仅本号邮箱」；`ui.js`/`app.ts` 补齐常用业务错误提示；`send-view.js` 修复单一非法收件人校验顺序、附件并发上限复核及最小化按钮无障碍标签；`settings-view.js` 映射 `"unlabeled"` 与精简探针失败徽章；`app.js` 快捷键兼容大写锁定；`util.js` 收紧无登录态兜底。
- [x] **文档、版本字面量与测试补充**：`src/api/http.ts` 补齐 `409: "conflict"`；同步更新 `AGENT.md` `sandbox` 说明与 `docker-compose.yml`/`src/api/app.ts` 版本号；补充 `400` 边界、SSRF、BCC 搜索隔离、死信状态与 Bark 载荷测试。

### 暂时不做
- SMTP `onRcptTo` 域名缓存（SQLite 本地读取无瓶颈，不增加缓存复杂度）。
- `listUsersWithDetails` SQL 批量重写与 `countTrash` 独立计数 SQL（保持小团队场景可读性与可见性口径一致）。
- `scripts/android/` 全套 mock 单测、`PUT /v1/settings/ai` 单字段局部传参放宽及单测端口夹具微调。
