// 全局响应式运行状态集中管理。
import { LABEL_NAMES } from "./constants.js";

export const state = {
  // 当前登录身份与多租户上下文
  sessionUser: "",
  sessionUserId: "",
  sessionDisplayName: "",
  sessionRole: "admin",
  isOwner: true,
  quotaSendDay: 100,
  sentLast24h: 0,
  myAllocations: [],

  // 视图与列表过滤状态
  currentTab: "ai",
  currentView: "inbox",
  inboxPromoOnly: false,
  quickFilter: "all", // "all" | "unread" | "attachments"
  scopeFilter: "", // "" | "domain:example.com" | "member:<id>"
  currentDlqScope: "open",
  selectedMailId: null,
  selectedBatchIds: new Set(),
  readerExpanded: false,

  // 设置基线与缓存
  promptBaseline: "",
  notifyBaseline: "",
  attemptsBaseline: "",
  namesBaseline: "",
  settingsDomains: [],
  currentMailHtml: "",
  currentMailPlain: "",
  allowExternalImages: false,
  labelNames: { ...LABEL_NAMES },
  panelTitle: "邮箱",
  domainNames: {},
  senderMap: new Map(),
  mailboxNames: new Map(),
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

  // 徽章计数
  unreadInbox: 0,
  unreadSpam: 0,
  unreadPromo: 0,
  starredCount: 0,
  trashCount: 0,

  // 业务列表与编辑器状态
  blockedSenders: [],
  dkimKeys: [],
  sentItems: [],
  sentQuery: "",
  currentFromAddress: "",
  openDetail: null,
  replyContext: null,
  replyArmed: false,
  currentSettingsSection: "domains",
  selectedFailureKey: "",
  aiModels: [],
  aiKeyRows: [],
  aiJob: Promise.resolve(),
  namesJob: Promise.resolve(),
  domainShortNames: {},
  savedSenders: [],
  threadItems: [],
  readingSentId: null,
  resetEmail: "",
  resetLeft: 0,
  resetTimer: 0,

  // 成员管理与审计状态
  usersList: [],
  usersQuery: "",
  selectedUserId: "",
  creatingUser: false,
  lastCreatedCredentials: null,
  auditItems: [],

  // 命令面板状态
  paletteOpen: false,
  paletteIndex: 0,
  paletteFiltered: [],
};
