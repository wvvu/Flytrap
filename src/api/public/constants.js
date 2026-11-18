// 共享常量：分类代号、视图标题、队列步骤、设置分组与存储键名。
export const LABELS = ["legit", "spam", "phish", "malware", "gray", "unsolicited-admin"];

export const LABEL_NAMES = {
  legit: "正常",
  phish: "钓鱼",
  malware: "恶意",
  spam: "垃圾",
  "unsolicited-admin": "推广",
  gray: "待看",
};

export const VIEW_TITLES = {
  inbox: "收件箱",
  send: "发信",
  spam: "已拦截",
  trash: "垃圾桶",
  users: "成员",
  dlq: "处理失败",
  settings: "设置",
};

export const STEP_NAMES = {
  auth: "身份检查",
  parse: "拆信",
  classify: "分拣",
  notify: "提醒",
  rebuild: "重建",
  send: "发信",
};

export const STEP_ORDER = ["auth", "parse", "classify", "notify", "rebuild", "send"];

export const AUDIT_ACTION_NAMES = {
  login: "登录成功",
  login_failed: "登录失败",
  logout: "退出登录",
  password_change: "修改密码",
  password_reset_sent: "发送重置码",
  password_reset: "重置密码",
  password_reset_failed: "重置验证失败",
  profile_update: "更新资料",
  user_create: "创建账号",
  user_update: "更新账号",
  user_delete: "删除账号",
  user_password_reset: "管理员改密",
  user_sessions_revoke: "退出该账号的登录",
  user_alloc_add: "分配邮箱",
  user_alloc_update: "修改发信权限",
  user_alloc_remove: "移除邮箱分配",
  mailbox_allocate: "分配邮箱",
  mailbox_update: "修改发信权限",
  mailbox_revoke: "收回邮箱",
  mailbox_history_upsert: "记下邮箱称呼",
  send_queue: "提交发信",
  send_retry: "重发邮件",
  reclassify: "重新分拣",
  override_label: "手改分类",
  trash: "移入垃圾桶",
  restore: "恢复邮件",
  delete: "永久删除",
  member_delete: "成员移除邮件",
  empty_trash: "清空垃圾桶",
  member_empty_trash: "清空个人垃圾桶",
  mark_all_read: "全部标为已读",
  block_sender: "拉黑发件人",
  ai_probe_key: "测试模型密钥",
  settings_ai: "保存模型配置",
  settings_domains: "更新收信域名",
  settings_notify: "更新推送策略",
  settings_blocklist: "更新黑名单",
  settings_names: "更新显示名称",
  settings_jobs: "更新重试次数",
  member_settings_names: "更新个人称呼",
  dkim_generate: "生成 DKIM 密钥",
  dkim_remove: "移除 DKIM 密钥",
  prompt_update: "更新分拣提示词",
  retry_job: "重试单步任务",
  retry_message_jobs: "重试这封信的步骤",
  retry_all_dead: "重试全部死信",
  dismiss_job: "忽略失败步骤",
};

export const SETTING_SECTIONS = [
  { id: "users", label: "成员与权限", hint: "独立账号、邮箱分配、发信配额", adminOnly: true },
  { id: "my-mailboxes", label: "专属邮箱", hint: "已分配邮箱规则与每日发信额度", memberOnly: true },
  { id: "domains", label: "域名与发信", hint: "收信、短名、签名", adminOnly: true },
  { id: "people", label: "地址与黑名单", hint: "备注、称呼、拦截", adminOnly: false },
  { id: "classify", label: "分拣与提醒", hint: "模型、提示词、推送", adminOnly: true },
  { id: "status", label: "状态与日志", hint: "概况、失败、日志", adminOnly: true },
  { id: "account", label: "界面与账号", hint: "名称、资料、密码", adminOnly: false },
];

export const LAST_FROM_KEY = "mail_last_from";
export const DRAFT_KEY_PREFIX = "mail_compose_draft:";
