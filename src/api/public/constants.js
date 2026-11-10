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
  send: "发信",
  spam: "已拦截",
  trash: "垃圾桶",
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
  ["names", "名称"],
  ["model", "模型"],
  ["account", "账号"],
  ["domains", "收信"],
  ["send", "发信"],
  ["mailboxes", "地址"],
  ["block", "黑名单"],
  ["notify", "提醒"],
  ["prompt", "分拣"],
  ["jobs", "失败"],
  ["logs", "日志"],
  ["machine", "概况"],
];
export const LAST_FROM_KEY = "mail_last_from";
