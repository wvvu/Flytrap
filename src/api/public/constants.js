// 共享常量：分类代号、视图标题、队列步骤、设置导航分组。
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
  dlq: "处理失败",
  users: "成员管理",
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

export const ADMIN_SETTING_SECTIONS = [
  ["users", "成员与权限", "独立账号、邮箱分配、发信配额"],
  ["domains", "域名与发信", "收信域名、短名标记、DKIM 签名"],
  ["people", "地址与黑名单", "地址备注、发件称呼、黑名单拦截"],
  ["classify", "分拣与提醒", "模型与密钥探活、提示词、推送"],
  ["status", "状态与日志", "收信统计、队列重试、审计与运行日志"],
  ["account", "界面与账号", "面板标题、分类显示名、密码修改"],
];

export const MEMBER_SETTING_SECTIONS = [
  ["my-mailboxes", "专属邮箱", "已分配邮箱规则与每日发信额度"],
  ["people", "地址与黑名单", "地址备注、发件称呼、个人黑名单"],
  ["account", "界面与账号", "工作台标题与登录密码修改"],
];

export const ROLE_LABELS = {
  owner: "根管理员",
  admin: "管理员",
  member: "成员",
};

export const ALLOCATION_KIND_LABELS = {
  exact: "精确邮箱 (+子地址)",
  prefix: "前缀通配",
  domain: "整域接管",
};

export const AUDIT_ACTION_LABELS = {
  login: "登录成功",
  login_failed: "登录失败",
  logout: "退出登录",
  password_change: "修改密码",
  password_reset_sent: "发送重置码",
  password_reset: "重置密码",
  password_reset_failed: "重置失败",
  user_create: "创建账号",
  user_update: "更新账号",
  user_delete: "删除账号",
  user_password_reset: "重置成员密码",
  user_sessions_revoke: "踢出登录会话",
  user_mailbox_add: "分配邮箱规则",
  user_mailbox_remove: "移除邮箱规则",
  send_queue: "发信入队",
  send_retry: "重发邮件",
  reclassify: "重跑分拣",
  override_label: "手改分类",
  read_all: "批量已读",
  trash: "移入垃圾桶",
  restore: "恢复邮件",
  delete: "永久删除",
  member_purge: "成员移除邮件",
  empty_trash: "清空垃圾桶",
  member_empty_trash: "清空个人垃圾桶",
  block_sender: "拉黑发件人",
  ai_key_probe: "探测密钥",
  settings_ai: "更新模型配置",
  settings_domains: "更新收信域名",
  dkim_generate: "生成 DKIM",
  dkim_remove: "移除 DKIM",
};

export const LAST_FROM_KEY = "mail_last_from";
export const DRAFT_KEY_PREFIX = "mail_compose_draft:";
