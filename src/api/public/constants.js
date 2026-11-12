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
  ["domains", "域名与发信", "收信、短名、签名"],
  ["people", "地址与黑名单", "备注、称呼、拦截"],
  ["classify", "分拣与提醒", "模型、提示词、推送"],
  ["status", "状态与日志", "概况、失败、日志"],
  ["account", "界面与账号", "名称、密码"],
];
export const LAST_FROM_KEY = "mail_last_from";
