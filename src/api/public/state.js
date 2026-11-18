// 全局共享状态对象：供各原生 ES 模块读写。
import { LABEL_NAMES } from "./constants.js";

export const state = {
  // 当前登录账号与多租户上下文
  userId: "",
  username: "",
  displayName: "",
  role: "admin",
  catchAll: false,
  signature: "",
  userMailboxes: [],
  appVersion: "",
  mailScope: "mine",
  recipientFilter: "",

  // 视图与列表状态
  currentTab: "ai",
  currentView: "inbox",
  inboxPromoOnly: false,
  currentDlqScope: "open",
  selectedMailId: null,
  selectedIds: new Set(),
  lastCheckedId: null,

  // 设置基线快照
  promptBaseline: "",
  notifyBaseline: "",
  attemptsBaseline: "",
  namesBaseline: "",
  settingsDomains: [],

  // 阅读器状态
  currentMailHtml: "",
  currentMailPlain: "",
  allowExternalImages: false,
  previewExpanded: false,
  currentOtpCode: "",
  openDetail: null,
  currentFromAddress: "",
  threadItems: [],
  readingSentId: null,

  // 外观与名称映射
  labelNames: { ...LABEL_NAMES },
  panelTitle: "邮箱",
  domainNames: {},
  senderMap: new Map(),
  mailboxNames: new Map(),

  // 队列、分页与轮询
  failureCounts: { open: 0, dead: 0, failed: 0, retrying: 0, dismissed: 0, running: 0 },
  dlqQuery: "",
  cursor: null,
  loadingMore: false,
  currentJobs: [],
  currentMessages: [],
  mailLoadToken: 0,
  listLoadToken: 0,
  csrfToken: null,
  toastTimer: 0,
  currentPromptId: "classify-v1",
  skipFirstOpen: false,
  unreadInbox: 0,
  unreadSpam: 0,

  // 黑名单、DKIM、AI 池
  blockedSenders: [],
  dkimKeys: [],
  currentSettingsSection: "domains",
  selectedFailureKey: "",
  aiModels: [],
  aiKeyRows: [],
  aiJob: Promise.resolve(),
  namesJob: Promise.resolve(),
  domainShortNames: {},
  savedSenders: [],

  // 发信与草稿状态
  sentItems: [],
  sentQuery: "",
  replyContext: null,
  composeAttachments: [],
  draftTimer: 0,

  // 成员管理状态
  usersList: [],
  usersQuery: "",
  selectedUserId: "",
  lastCreatedCred: "",

  // 命令面板状态
  paletteItems: [],
  paletteIndex: 0,

  // 密码找回计时
  resetEmail: "",
  resetLeft: 0,
  resetTimer: 0,
};
