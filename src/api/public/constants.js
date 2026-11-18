// 共享常量：标签、视图标题、处理步骤、设置分区。
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
  starred: "星标邮件",
  send: "发信",
  spam: "已拦截",
  trash: "垃圾桶",
  users: "成员与分配",
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

export const ADMIN_SETTING_SECTIONS = [
  ["domains", "域名与发信", "收信域名、短名、DKIM 签名"],
  ["people", "地址与黑名单", "收件备注、发件称呼、自动拦截"],
  ["classify", "分拣与提醒", "模型池、密钥测通、提示词、推送"],
  ["status", "状态与日志", "流量趋势、重试上限、运行日志"],
  ["account", "界面与安全", "面板命名、分类显示名、改密"],
];

export const MEMBER_SETTING_SECTIONS = [
  ["my-mailboxes", "专属邮箱", "已分配收发地址、子地址规则与备注"],
  ["people", "称呼与黑名单", "个人发件人备注名称与自动拦截"],
  ["status", "用量概况", "个人收件统计与近 14 天趋势"],
  ["account", "账号安全", "登录口令修改与配额查看"],
];

export const SETTING_SECTIONS = ADMIN_SETTING_SECTIONS;

export const LAST_FROM_KEY = "mail_last_from";
export const DRAFT_KEY_PREFIX = "mail_compose_draft:";

export const AUDIT_ACTION_NAMES = {
  login: "登录成功",
  login_failed: "登录失败",
  logout: "退出登录",
  password_change: "修改密码",
  password_reset_sent: "发送重置码",
  password_reset: "重置密码",
  password_reset_failed: "重置验证失败",
  user_create: "创建账号",
  user_update: "更新账号",
  user_delete: "删除账号",
  user_password_reset: "管理员改密",
  user_alloc_add: "分配邮箱",
  user_alloc_update: "修改发信权限",
  user_alloc_remove: "移除邮箱分配",
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
  member_settings_names: "更新个人称呼",
  dkim_generate: "生成 DKIM 密钥",
  dkim_remove: "移除 DKIM 密钥",
  prompt_update: "更新分拣提示词",
  retry_job: "重试单步任务",
  retry_all_dead: "重试全部死信",
  dismiss_job: "忽略失败步骤",
};
