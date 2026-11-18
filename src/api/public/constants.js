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
