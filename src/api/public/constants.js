// 共享常量：分类映射、视图标题、处理步骤、角色化设置分组与快捷键清单。
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
  starred: "星标",
  send: "已发信",
  spam: "已拦截",
  trash: "垃圾桶",
  users: "成员与邮箱",
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
  ["people", "地址与黑名单", "收件名称、发件称呼、拦截"],
  ["classify", "分拣与提醒", "模型、密钥实测、提示词、推送"],
  ["status", "状态与日志", "运行概况、队列重试、进程日志"],
  ["account", "界面与账号", "标题、签名、分类名称、密码"],
];

export const MEMBER_SETTING_SECTIONS = [
  ["people", "地址与黑名单", "已分配邮箱称呼、发件称呼、黑名单"],
  ["classify", "提醒推送", "个人分类推送与 Webhook"],
  ["account", "界面与账号", "面板标题、发信签名、分类名称、密码"],
];

export const SHORTCUT_ITEMS = [
  ["Ctrl / Cmd + K", "打开命令面板"],
  ["/", "聚焦当前列表搜索框"],
  ["Esc", "清空搜索或关闭浮层"],
  ["C", "打开悬浮写信窗口"],
  ["J / K", "切换下一封 / 上一封"],
  ["R", "刷新当前视图"],
  ["A", "回复当前打开的来信"],
  ["U", "切换当前来信已读 / 未读"],
  ["S", "切换当前来信星标"],
  ["#", "将当前来信移入垃圾桶"],
  ["?", "查看键盘快捷键"],
];

export const LAST_FROM_KEY = "mail_last_from";
export const DRAFT_KEY_PREFIX = "mail_compose_draft:";
