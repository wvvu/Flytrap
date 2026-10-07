const LABELS = ["legit", "spam", "phish", "malware", "gray", "unsolicited-admin"];
const LABEL_NAMES = {
  legit: "正常",
  phish: "钓鱼",
  malware: "恶意",
  spam: "垃圾",
  "unsolicited-admin": "推广",
  gray: "待看",
};

const VIEW_TITLES = {
  inbox: "收件箱",
  spam: "Spam",
  trash: "垃圾桶",
  dlq: "处理失败",
  settings: "设置",
};
const STEP_NAMES = {
  auth: "身份检查",
  parse: "拆信",
  classify: "分拣",
  notify: "提醒",
  rebuild: "重建",
};
const STEP_ORDER = ["auth", "parse", "classify", "notify", "rebuild"];

let currentTab = "ai";
let currentView = "inbox";
let currentDlqScope = "open";
let selectedMailId = null;
let promptBaseline = "";
let notifyBaseline = "";
let attemptsBaseline = "";
let namesBaseline = "";
let settingsDomains = [];
let currentMailHtml = "";
let currentMailPlain = "";
let allowExternalImages = false;
let labelNames = { ...LABEL_NAMES };
let panelTitle = "Flytrap";
let domainNames = {};
let senderMap = new Map();
let mailboxNames = new Map();
let failureCounts = { open: 0, dead: 0, failed: 0, retrying: 0, dismissed: 0, running: 0 };
let dlqQuery = "";
let cursor = null;
let loadingMore = false;
let currentJobs = [];
let currentMessages = [];
let mailLoadToken = 0;
let csrfToken = null;
let toastTimer = 0;
let currentPromptId = "classify-v1";

// DOM 元素引用
const appEl = document.querySelector("#app");
const loginEl = document.querySelector("#login");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const logoutBtn = document.querySelector("#logout");
const themeBtn = document.querySelector("#btn-theme");
const themeIcon = document.querySelector("#theme-icon");

// 导航按钮 (收件箱, Spam, 垃圾桶, 设置)
const navInboxBtn = document.querySelector("#nav-inbox");
const navSpamBtn = document.querySelector("#nav-spam");
const navTrashBtn = document.querySelector("#nav-trash");
const navSettingsBtn = document.querySelector("#nav-settings");
const badgeDlq = document.querySelector("#badge-dlq");
const inboxLabel = document.querySelector("#inbox-label");
const spamLabel = document.querySelector("#spam-label");
const badgeInbox = document.querySelector("#badge-inbox");
const badgeSpam = document.querySelector("#badge-spam");

// 第二列流头部
const streamInboxHeader = document.querySelector("#stream-inbox-header");
const streamSpamHeader = document.querySelector("#stream-spam-header");
const streamTrashHeader = document.querySelector("#stream-trash-header");
const streamDlqHeader = document.querySelector("#stream-dlq-header");
const streamSettingsHeader = document.querySelector("#stream-settings-header");
const filtersForm = document.querySelector("#filters");
const mailEmptyCopy = document.querySelector("#mail-empty-copy");
const trashQueryInput = document.querySelector("#trash-q");
const trashRefreshBtn = document.querySelector("#btn-trash-refresh");
const emptyTrashBtn = document.querySelector("#btn-empty-trash");
const listEl = document.querySelector("#list");
const noticeEl = document.querySelector("#notice");
const queryInput = document.querySelector("#q");
const labelInput = document.querySelector("#label");
const filterSelect = document.querySelector("#filter-select");
const refreshBtn = document.querySelector("#btn-refresh");
const spamRefreshBtn = document.querySelector("#btn-spam-refresh");
const dlqRefreshBtn = document.querySelector("#btn-dlq-refresh");
const retryAllBtn = document.querySelector("#btn-retry-all");

// 第三列工作台各视图
const viewMail = document.querySelector("#view-mail");
const viewDlq = document.querySelector("#view-dlq");
const viewSettings = document.querySelector("#view-settings");
const failureDetailEl = document.querySelector("#failure-detail");
const dlqEmptyEl = document.querySelector("#dlq-empty");
const dlqNoticeEl = document.querySelector("#dlq-notice");
let currentSettingsSection = "names";
let selectedFailureKey = "";
let aiModels = [];
let aiKeyRows = [];
let aiBaseline = "";

// 邮件阅读器元素
const mailEmptyEl = document.querySelector("#mail-empty");
const mailLoadingEl = document.querySelector("#mail-loading");
const mailDetailEl = document.querySelector("#mail-detail");
const backListBtn = document.querySelector("#btn-back-list");
const toastEl = document.querySelector("#toast");
const confirmModal = document.querySelector("#confirm-modal");
const confirmText = document.querySelector("#confirm-text");
const confirmOk = document.querySelector("#confirm-ok");
const confirmCancel = document.querySelector("#confirm-cancel");
const detailSubject = document.querySelector("#detail-subject");
const detailFrom = document.querySelector("#detail-from");
const detailTo = document.querySelector("#detail-to");
const detailTime = document.querySelector("#detail-time");
const detailVerdictSelect = document.querySelector("#detail-verdict-select");
const detailModelVerdict = document.querySelector("#detail-model-verdict");
const detailSummary = document.querySelector("#detail-summary");
const verdictBar = document.querySelector("#verdict-bar");
const verdictPercent = document.querySelector("#verdict-percent");
const sectionSignals = document.querySelector("#section-signals");
const signalsCountEl = document.querySelector("#signals-count");
const signalsList = document.querySelector("#signals-list");
const sectionUrls = document.querySelector("#section-urls");
const urlCountEl = document.querySelector("#url-count");
const urlsList = document.querySelector("#urls-list");
const attachmentsList = document.querySelector("#attachments-list");
const attachmentCountEl = document.querySelector("#attachment-count");
const mailSandbox = document.querySelector("#mail-sandbox");
const plainTextBody = document.querySelector("#plain-text-body");
const rawHeaders = document.querySelector("#raw-headers");
const authChips = document.querySelector("#auth-chips");
const btnTrashMail = document.querySelector("#btn-trash-mail");
const btnRestoreMail = document.querySelector("#btn-restore-mail");
const btnDeleteMail = document.querySelector("#btn-delete-mail");
const btnReclassify = document.querySelector("#btn-reclassify");
const btnDownloadEml = document.querySelector("#btn-download-eml");
const btnLoadImages = document.querySelector("#btn-load-images");

// 事件绑定
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void signIn();
});

logoutBtn.addEventListener("click", () => void signOut());
themeBtn.addEventListener("click", () => toggleTheme());

navInboxBtn?.addEventListener("click", () => switchNav("inbox"));
navSpamBtn?.addEventListener("click", () => switchNav("spam"));
navTrashBtn?.addEventListener("click", () => switchNav("trash"));
navSettingsBtn?.addEventListener("click", () => switchNav("settings"));

refreshBtn?.addEventListener("click", () => void reloadMessages());
spamRefreshBtn?.addEventListener("click", () => void reloadMessages());
document.querySelector("#btn-open-dlq")?.addEventListener("click", () => switchNav("dlq"));
document.querySelector("#btn-dlq-back")?.addEventListener("click", () => switchNav("settings"));
trashRefreshBtn?.addEventListener("click", () => void reloadTrash());
emptyTrashBtn?.addEventListener("click", () => void handleEmptyTrash());
dlqRefreshBtn?.addEventListener("click", () => void loadDlqJobs());
retryAllBtn?.addEventListener("click", () => void retryAllDead());

btnTrashMail?.addEventListener("click", () => void handleTrashMail());
btnRestoreMail?.addEventListener("click", () => void handleRestoreMail());
btnDeleteMail?.addEventListener("click", () => void handleDeleteMail());
backListBtn?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-dlq")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-settings")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-save-ai")?.addEventListener("click", () => void saveAiSettings());
document.querySelector("#ai-enabled")?.addEventListener("change", syncAiSave);
document.querySelector("#ai-thinking")?.addEventListener("change", syncAiSave);
document.querySelector("#btn-save-password")?.addEventListener("click", () => void savePassword());
document.querySelector("#btn-refresh-logs")?.addEventListener("click", () => void loadLogs());
document.querySelector("#btn-add-model")?.addEventListener("click", () => addModelRow());
document.querySelector("#btn-add-key")?.addEventListener("click", () => addKeyRow());
document.querySelector("#model-add")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addModelRow();
  }
});
document.querySelector("#model-add")?.addEventListener("input", syncAiSave);
document.querySelector("#key-add")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addKeyRow();
  }
});
document.querySelector("#key-add")?.addEventListener("input", syncAiSave);
document.querySelector("#btn-save-prompt")?.addEventListener("click", () => void saveCurrentPrompt());
document.querySelector("#prompt-editor")?.addEventListener("input", syncPromptSave);
document.querySelector("#btn-save-notify")?.addEventListener("click", () => void saveNotifySettings());
document.querySelector("#notify-confidence")?.addEventListener("input", syncNotifySave);
document.querySelector("#btn-save-attempts")?.addEventListener("click", () => void saveAttemptSettings());
document.querySelector("#job-max-attempts")?.addEventListener("input", syncAttemptSave);
document.querySelector("#btn-add-domain")?.addEventListener("click", () => void addDomain());
document.querySelector("#domain-add")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addDomain();
  }
});
document.querySelector("#mailbox-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveMailbox();
});
document.querySelector("#btn-save-names")?.addEventListener("click", () => void saveNameSettings());
document.querySelector("#panel-title")?.addEventListener("input", syncNamesSave);
document.querySelector("#btn-add-sender")?.addEventListener("click", () => addSenderRow());
document.querySelector("#sender-address")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSenderRow();
  }
});
document.querySelector("#sender-name")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSenderRow();
  }
});
document.querySelector("#dlq-search")?.addEventListener("submit", (event) => event.preventDefault());
document.querySelector(".settings-nav")?.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
  if (!link) return;
  const href = link.getAttribute("href");
  const target = href ? document.querySelector(href) : null;
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ block: "start" });
});
document.querySelector("#dlq-q")?.addEventListener("input", () => {
  dlqQuery = document.querySelector("#dlq-q")?.value.trim().toLowerCase() || "";
  renderFailureGroups(currentJobs);
});

document.querySelector("#trash-filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadTrash();
});

trashQueryInput?.addEventListener("input", debounce(() => void reloadTrash(), 350));

document.querySelector("#filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadMessages();
});

queryInput?.addEventListener("input", debounce(() => void reloadMessages(), 350));

filterSelect?.addEventListener("change", () => {
  if (currentView !== "spam") return;
  syncListLabel();
  void reloadMessages();
});

detailVerdictSelect?.addEventListener("change", async () => {
  if (!selectedMailId) return;
  const newLabel = detailVerdictSelect.value;
  detailVerdictSelect.disabled = true;
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(selectedMailId) + "/label", {
      method: "PATCH",
      body: { label: newLabel },
    });
    detailVerdictSelect.dataset.label = newLabel;
    const confidenceChip = document.querySelector(".confidence-chip");
    if (confidenceChip) confidenceChip.hidden = newLabel === "legit";
    if (detailModelVerdict) {
      const origName = labelName(res.originalLabel);
      detailModelVerdict.textContent = `(已改分类，原先为 ${origName})`;
    }
    const listItem = findByDataId(listEl, ".mail-item", selectedMailId);
    if (listItem && !staysInList(newLabel)) {
      listItem.remove();
      currentMessages = currentMessages.filter((item) => item.id !== selectedMailId);
    } else if (listItem) {
      const tag = listItem.querySelector(".verdict-tag");
      if (tag) {
        tag.dataset.label = newLabel;
        tag.hidden = newLabel === "legit";
        tag.textContent = newLabel === "legit" ? "" : labelName(newLabel) + " 已改";
        if (tag.parentElement) tag.parentElement.hidden = newLabel === "legit";
      }
    }
    noticeEl.textContent = "已改成 " + labelName(newLabel);
    void refreshUnread();
    setTimeout(() => {
      if (noticeEl.textContent.startsWith("已改成")) noticeEl.textContent = "";
    }, 3000);
  } catch (err) {
    noticeEl.textContent = "修改分类失败: " + explain(err);
  } finally {
    detailVerdictSelect.disabled = false;
  }
});

listEl.addEventListener("scroll", () => {
  if (currentView === "inbox" || currentView === "spam" || currentView === "trash") maybeLoadMore();
});

// DLQ 状态胶囊点击
document.querySelector("#dlq-pills")?.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("button[data-dlq-status]") : null;
  if (!target) return;
  for (const btn of document.querySelectorAll("#dlq-pills button")) btn.classList.remove("active");
  target.classList.add("active");
  const st = target.getAttribute("data-dlq-status") || "open";
  currentDlqScope = st;
  void loadDlqJobs(st);
});

// 详情 Tab 切换
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    if (!tab) return;
    switchTab(tab);
  });
});

btnLoadImages?.addEventListener("click", () => {
  allowExternalImages = !allowExternalImages;
  renderSandboxHtml(currentMailHtml);
});

btnReclassify?.addEventListener("click", () => {
  if (selectedMailId) void reclassify(selectedMailId, btnReclassify);
});

// 键盘快捷键 (j: 下一封, k: 上一封, r: 刷新)
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (confirmModal && !confirmModal.hidden) return;
  if (isTypingTarget(e.target)) return;
  if (currentView === "inbox" || currentView === "spam") {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") void reloadMessages();
  } else if (currentView === "trash") {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") void reloadTrash();
  } else if (currentView === "dlq" && e.key === "r") {
    void loadDlqJobs();
  }
});

// 启动初始化
void init();

async function init() {
  initTheme();
  try {
    await request("/v1/me");
    showApp();
    await loadAppearance();
    await switchNav("inbox");
    void updateDlqBadge();
    void refreshUnread();
  } catch {
    showLogin();
  }
  window.setInterval(() => void pollLive(), 30000);
}

function setGlyph(el, name) {
  if (!el) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  el.replaceChildren(svg);
}

function initTheme() {
  const saved = localStorage.getItem("flytrap_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  setGlyph(themeIcon, saved === "dark" ? "sun" : "moon");
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("flytrap_theme", next);
  setGlyph(themeIcon, next === "dark" ? "sun" : "moon");
  if (currentMailHtml) {
    renderSandboxHtml(currentMailHtml);
  }
}

async function signIn() {
  loginError.textContent = "";
  const btn = document.querySelector("#btn-login");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "请稍候";
  }
  try {
    await request("/v1/login", {
      method: "POST",
      body: {
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value,
      },
    });
    document.querySelector("#password").value = "";
    csrfToken = null;
    showApp();
    await loadAppearance();
    await switchNav("inbox");
    void updateDlqBadge();
  } catch (err) {
    loginError.textContent = explain(err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "继续";
    }
  }
}

async function signOut() {
  try {
    await request("/v1/logout", { method: "POST", body: {} });
  } catch {
    // Session destroyed
  }
  csrfToken = null;
  showLogin();
}

function showLogin() {
  document.title = "登录";
  loginEl.hidden = false;
  loginEl.style.display = "flex";
  appEl.hidden = true;
  appEl.style.display = "none";
}

function showApp() {
  loginEl.hidden = true;
  loginEl.style.display = "none";
  appEl.hidden = false;
  appEl.style.display = "grid";
}

function setViewTitle(view) {
  document.title = VIEW_TITLES[view] || "收件箱";
  if (panelTitle !== "Flytrap") document.title = panelTitle + " · " + document.title;
}

function placeMailSearch(view) {
  if (!filtersForm) return;
  if (view === "spam" && streamSpamHeader) streamSpamHeader.append(filtersForm);
  else if (streamInboxHeader) streamInboxHeader.append(filtersForm);
}

function setEmptyCopy(view) {
  if (!mailEmptyCopy) return;
  if (view === "spam") mailEmptyCopy.textContent = "这里是 Spam。选全部才会看到正常来信。";
  else if (view === "trash") mailEmptyCopy.textContent = "这里是垃圾桶。";
  else mailEmptyCopy.textContent = "这里是收件箱，包含尚未分类的来信。其余在 Spam。";
}

function syncListLabel() {
  if (!labelInput) return;
  if (currentView === "inbox") labelInput.value = "legit";
  else if (currentView === "spam") labelInput.value = filterSelect ? filterSelect.value : "not-legit";
}

function staysInList(newLabel) {
  if (currentView === "inbox") return newLabel === "legit";
  if (currentView !== "spam") return true;
  const filter = filterSelect ? filterSelect.value : "not-legit";
  if (!filter) return true;
  if (filter === "not-legit") return Boolean(newLabel) && newLabel !== "legit";
  return newLabel === filter;
}

function paintUnread(label, badge, count) {
  const n = Number(count) || 0;
  if (label) {
    const base = label.dataset.base || "";
    label.textContent = n > 0 ? base + "(" + n + ")" : base;
  }
  if (!badge) return;
  badge.textContent = String(n);
  badge.hidden = n < 1;
}

async function refreshUnread() {
  try {
    const counts = await request("/v1/unread");
    paintUnread(inboxLabel, badgeInbox, counts.inbox);
    paintUnread(spamLabel, badgeSpam, counts.spam);
  } catch {
    // The next poll tries again.
  }
}

async function switchNav(view) {
  currentView = view;
  setViewTitle(view);
  if (appEl) delete appEl.dataset.layout;
  const navBtns = [navInboxBtn, navSpamBtn, navTrashBtn, navSettingsBtn];
  navBtns.forEach((b) => b?.classList.remove("active"));
  const viewPanels = [viewMail, viewDlq, viewSettings];
  viewPanels.forEach((p) => { if (p) p.hidden = true; });

  streamInboxHeader.hidden = true;
  if (streamSpamHeader) streamSpamHeader.hidden = true;
  if (streamTrashHeader) streamTrashHeader.hidden = true;
  if (streamDlqHeader) streamDlqHeader.hidden = true;
  if (streamSettingsHeader) streamSettingsHeader.hidden = true;
  if (dlqNoticeEl) dlqNoticeEl.hidden = view !== "dlq";
  noticeEl.hidden = view === "dlq";
  noticeEl.textContent = "";
  listEl.replaceChildren();
  cursor = null;
  loadingMore = false;
  setMobilePane("list");
  placeMailSearch(view);
  setEmptyCopy(view);

  if (view === "inbox") {
    navInboxBtn?.classList.add("active");
    streamInboxHeader.hidden = false;
    viewMail.hidden = false;
    syncListLabel();
    await reloadMessages();
  } else if (view === "spam") {
    navSpamBtn?.classList.add("active");
    if (streamSpamHeader) streamSpamHeader.hidden = false;
    viewMail.hidden = false;
    syncListLabel();
    await reloadMessages();
  } else if (view === "trash") {
    navTrashBtn?.classList.add("active");
    if (streamTrashHeader) streamTrashHeader.hidden = false;
    viewMail.hidden = false;
    await reloadTrash();
  } else if (view === "dlq") {
    navSettingsBtn?.classList.add("active");
    if (streamDlqHeader) streamDlqHeader.hidden = false;
    if (viewDlq) viewDlq.hidden = false;
    await loadDlqJobs(currentDlqScope);
  } else if (view === "settings") {
    navSettingsBtn?.classList.add("active");
    if (streamSettingsHeader) streamSettingsHeader.hidden = false;
    if (viewSettings) viewSettings.hidden = false;
    await loadSettingsPage();
    renderSettingsNav();
    showSettingsSection(currentSettingsSection, { keepListOnNarrow: true });
  }
}

// ==================== 收件箱与垃圾桶模块 ====================

async function reloadMessages() {
  cursor = null;
  loadingMore = false;
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadMessagesPage(true);
  maybeLoadMore();
}

async function reloadTrash() {
  cursor = null;
  loadingMore = false;
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadMessagesPage(true);
  maybeLoadMore();
}

function maybeLoadMore() {
  if (currentView !== "inbox" && currentView !== "spam" && currentView !== "trash") return;
  if (!cursor || loadingMore) return;
  const remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
  if (remaining < 280) void loadMoreMessages();
}

async function loadMoreMessages() {
  if (!cursor || loadingMore) return;
  if (currentView !== "inbox" && currentView !== "spam" && currentView !== "trash") return;
  const previous = cursor;
  const beforeCount = currentMessages.length;
  loadingMore = true;
  try {
    await loadMessagesPage(false);
  } finally {
    loadingMore = false;
  }
  if (cursor && cursor !== previous && currentMessages.length > beforeCount) maybeLoadMore();
}

async function loadMessagesPage(replace) {
  const params = new URLSearchParams();
  if (currentView === "trash") {
    params.set("trashed", "true");
    const tq = trashQueryInput ? trashQueryInput.value.trim() : "";
    if (tq) params.set("q", tq);
  } else {
    params.set("trashed", "false");
    syncListLabel();
    if (labelInput.value) params.set("label", labelInput.value);
    const q = queryInput ? queryInput.value.trim() : "";
    if (q) params.set("q", q);
  }
  params.set("limit", "40");
  if (!replace && cursor) params.set("cursor", cursor);

  try {
    const page = await request("/v1/messages?" + params.toString());
    const items = Array.isArray(page.items) ? page.items : [];
    if (replace) currentMessages = items;
    else currentMessages = currentMessages.concat(items);

    if (replace && items.length === 0) {
      noticeEl.textContent = currentView === "trash" ? "垃圾桶空空如也" : "没有匹配的邮件";
    }

    for (const item of items) {
      listEl.append(createMailListItem(item));
    }
    cursor = page.nextCursor || null;

    // 桌面端顺手打开第一封。窄屏留在列表，避免一进来就盖住收件流。
    if (replace && items.length > 0 && !selectedMailId) {
      void selectMail(items[0].id, { keepListOnNarrow: true });
    }
  } catch (err) {
    if (err && err.status === 401) {
      showLogin();
      return;
    }
    noticeEl.textContent = explain(err);
  }
}

function createMailListItem(item) {
  const card = document.createElement("div");
  card.className = "mail-item";
  card.dataset.id = item.id;
  if (!item.read) card.classList.add("unread");
  if (item.id === selectedMailId) card.classList.add("selected");

  const line1 = document.createElement("div");
  line1.className = "item-line1";

  const from = document.createElement("span");
  from.className = "item-from";
  const rawFrom = item.from || item.envelopeFrom || "";
  from.textContent = rawFrom ? formatFrom(rawFrom) : "没有发件人";
  if (rawFrom) from.title = rawFrom;

  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(item.receivedAt);

  line1.append(from, time);

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const line3 = document.createElement("div");
  line3.className = "item-line3";

  const snippet = document.createElement("span");
  snippet.className = "item-snippet";
  // 列表先不放摘要。需要时把下一行接回去。
  // snippet.textContent = item.summary || "";
  snippet.hidden = true;

  const tag = document.createElement("span");
  tag.className = "verdict-tag";
  tag.dataset.label = item.label || "none";
  // 列表先不显示置信度，正常也不显示标签。需要时把下面两行接回去。
  // const confText = item.manualOverride
  //   ? " 已改"
  //   : item.label && item.label !== "legit" && typeof item.confidence === "number"
  //     ? ` ${Math.round(item.confidence * 100)}%`
  //     : "";
  // tag.textContent = labelName(item.label) + confText;
  const named = Boolean(item.label) && item.label !== "legit";
  tag.hidden = !named;
  tag.textContent = named ? labelName(item.label) + (item.manualOverride ? " 已改" : "") : "";

  line3.hidden = !named;
  line3.append(snippet, tag);

  card.append(line1, subject, line3);
  card.addEventListener("click", () => void selectMail(item.id));
  return card;
}

async function selectMail(id, options = {}) {
  const token = ++mailLoadToken;
  selectedMailId = id;
  allowExternalImages = false;
  if (btnLoadImages) {
    btnLoadImages.hidden = false;
    btnLoadImages.disabled = false;
    btnLoadImages.textContent = "显示图片";
  }
  const guard = document.querySelector("#preview-guard");
  if (guard) guard.textContent = "不执行脚本。外链图片先不加载。";
  if (!options.keepListOnNarrow) setMobilePane("detail");

  // 默认折叠威胁指纹与外链
  if (sectionSignals) sectionSignals.open = false;
  if (sectionUrls) sectionUrls.open = false;

  // 更新左侧列表的高亮状态
  document.querySelectorAll(".mail-item").forEach((el) => {
    if (el.dataset.id === id) el.classList.add("selected");
    else el.classList.remove("selected");
  });

  mailEmptyEl.hidden = true;
  mailDetailEl.hidden = true;
  if (mailLoadingEl) mailLoadingEl.hidden = false;
  mailSandbox.removeAttribute("srcdoc");

  try {
    const detail = await request("/v1/messages/" + encodeURIComponent(id));
    if (token !== mailLoadToken) return;
    if (detailSubject) detailSubject.textContent = detail.subject || "(无主题)";
    const rawFrom = detail.from || detail.envelopeFrom || "";
    if (detailFrom) {
      detailFrom.textContent = rawFrom ? formatFrom(rawFrom) : "没有发件人";
      detailFrom.title = rawFrom;
    }
    if (detailTo) {
      detailTo.textContent = formatRecipients(detail.envelopeTo);
      detailTo.title = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo || "";
    }
    if (detailTime) detailTime.textContent = formatFullTime(detail.receivedAt);

    const isTrashed = Boolean(detail.trashedAt || currentView === "trash");
    if (btnTrashMail) btnTrashMail.hidden = isTrashed;
    if (btnRestoreMail) btnRestoreMail.hidden = !isTrashed;
    if (btnDeleteMail) btnDeleteMail.hidden = !isTrashed;
    if (btnReclassify) btnReclassify.hidden = isTrashed;

    const storedLabel = typeof detail.aiResult?.label === "string" ? detail.aiResult.label : "";
    const label = storedLabel || "legit";
    if (detailVerdictSelect) {
      detailVerdictSelect.value = label;
      detailVerdictSelect.dataset.label = label;
    }
    const confidence = typeof detail.aiResult?.confidence === "number" ? detail.aiResult.confidence : 0;
    const showProb = Boolean(storedLabel) && storedLabel !== "legit";
    const confidenceChip = document.querySelector(".confidence-chip");
    if (confidenceChip) confidenceChip.hidden = !showProb;
    if (detailModelVerdict) {
      if (detail.aiResult?.manualOverride) {
        detailModelVerdict.textContent = `(已改分类，原先为 ${labelName(detail.aiResult.originalLabel)})`;
      } else if (showProb) {
        detailModelVerdict.textContent = `(模型 ${Math.round(confidence * 100)}%)`;
      } else {
        detailModelVerdict.textContent = "";
      }
    }

    if (verdictBar) verdictBar.style.width = Math.round(confidence * 100) + "%";
    if (verdictPercent) verdictPercent.textContent = Math.round(confidence * 100) + "%";
    if (detailSummary) detailSummary.textContent = detail.aiResult?.summary || "尚未分类";
    const detailTags = document.querySelector("#detail-tags");
    if (detailTags) {
      detailTags.replaceChildren();
      const tags = Array.isArray(detail.aiResult?.tags) ? detail.aiResult.tags : [];
      for (const name of tags) {
        if (typeof name !== "string" || !name) continue;
        const chip = document.createElement("span");
        chip.className = "mini-tag";
        chip.textContent = name;
        detailTags.append(chip);
      }
    }

    // 威胁信号指纹
    signalsList.replaceChildren();
    const signals = detail.aiResult?.signals || [];
    if (signalsCountEl) signalsCountEl.textContent = String(signals.length);
    if (signals.length === 0) {
      const emptySig = document.createElement("span");
      emptySig.className = "text-dim";
      emptySig.textContent = "没有额外依据";
      signalsList.append(emptySig);
    } else {
      for (const sig of signals) {
        const chip = document.createElement("div");
        chip.className = "signal-chip";
        const sName = document.createElement("span");
        sName.className = "signal-name";
        sName.textContent = sig.name;
        const sVal = document.createElement("span");
        sVal.className = "signal-val";
        sVal.textContent = sig.value;
        chip.append(sName, sVal);
        signalsList.append(chip);
      }
    }

    // 正文提取外链
    urlsList.replaceChildren();
    const urls = detail.parsed?.urls || [];
    urlCountEl.textContent = String(urls.length);
    if (urls.length === 0) {
      const emptyUrl = document.createElement("span");
      emptyUrl.className = "text-dim";
      emptyUrl.textContent = "没有链接";
      urlsList.append(emptyUrl);
    } else {
      for (const u of urls) {
        const uItem = document.createElement("div");
        uItem.className = "url-item";
        const uLink = document.createElement("a");
        uLink.href = u;
        uLink.target = "_blank";
        uLink.rel = "noopener noreferrer";
        uLink.textContent = u;
        uItem.append(uLink);
        urlsList.append(uItem);
      }
    }

    // 附件清单
    attachmentsList.replaceChildren();
    const attachments = detail.attachments || [];
    attachmentCountEl.textContent = String(attachments.length);
    if (attachments.length === 0) {
      const emptyAtt = document.createElement("span");
      emptyAtt.className = "text-dim";
      emptyAtt.textContent = "没有附件";
      attachmentsList.append(emptyAtt);
    } else {
      for (const att of attachments) {
        const attItem = document.createElement("div");
        attItem.className = "attachment-item";
        const attName = document.createElement("span");
        attName.textContent = att.filename || att.sha256;
        const attDl = document.createElement("a");
        attDl.className = "btn-sm";
        attDl.href = "/v1/attachments/" + encodeURIComponent(att.sha256);
        attDl.target = "_blank";
        attDl.download = att.filename || att.sha256;
        attDl.textContent = "下载 (" + formatBytes(att.sizeBytes) + ")";
        attItem.append(attName, attDl);
        attachmentsList.append(attItem);
      }
    }

    // 下载 EML 链接
    btnDownloadEml.href = "/v1/messages/" + encodeURIComponent(id) + "/raw";
    btnDownloadEml.setAttribute("download", `${detail.sha256 || id}.eml`);

    // 邮件来源鉴权标签
    authChips.replaceChildren();
    if (detail.authResult) {
      const auth = detail.authResult;
      authChips.append(createAuthChip("SPF", auth.spf));
      authChips.append(createAuthChip("DKIM", auth.dkim));
      authChips.append(createAuthChip("DMARC", auth.dmarc));
    }

    // 纯文本正文与原始头
    currentMailPlain = detail.parsed?.text || "";
    plainTextBody.textContent = currentMailPlain || "(正文为空)";
    rawHeaders.textContent = formatRawHeaders(detail);
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailDetailEl.hidden = false;

    // 加载 HTML 与真正的 RFC822 信头
    void loadMailHtml(id, token);
    void loadRawHeaders(id, token, detail);
    markOpened(id);
  } catch (err) {
    if (token !== mailLoadToken) return;
    console.error("selectMail error:", err);
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailDetailEl.hidden = false;
    if (detailSubject) detailSubject.textContent = "无法加载邮件详情";
    if (detailSummary) detailSummary.textContent = explain(err);
  }
}

async function loadMailHtml(id, token) {
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/html");
    if (token !== mailLoadToken) return;
    currentMailHtml = res.html || "";
    renderSandboxHtml(currentMailHtml);
  } catch {
    if (token !== mailLoadToken) return;
    currentMailHtml = "<p style='color:#888;padding:20px'>没有 HTML 正文</p>";
    renderSandboxHtml(currentMailHtml);
  }
}

async function loadRawHeaders(id, token, detail) {
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/headers");
    if (token !== mailLoadToken) return;
    rawHeaders.textContent = res.headers && res.headers.trim() ? res.headers : formatRawHeaders(detail);
  } catch {
    if (token !== mailLoadToken) return;
    rawHeaders.textContent = formatRawHeaders(detail);
  }
}

function countRemoteImages(html) {
  if (!html) return 0;
  const patterns = [
    /\s(?:src|poster)\s*=\s*['"]\s*https?:\/\//gi,
    /\s(?:src|poster)\s*=\s*https?:\/\//gi,
    /\ssrcset\s*=\s*['"][^'"]*https?:\/\//gi,
    /url\(\s*['"]?https?:\/\//gi,
  ];
  let count = 0;
  for (const pattern of patterns) {
    const found = html.match(pattern);
    if (found) count += found.length;
  }
  return count;
}

function stripRemoteImages(html) {
  return html
    .replace(/(\s(?:src|poster)\s*=\s*)(['"])\s*https?:\/\/[^'"]*\2/gi, "$1$2$2")
    .replace(/(\s(?:src|poster)\s*=\s*)https?:\/\/[^\s>]+/gi, '$1""')
    .replace(/\ssrcset\s*=\s*(['"])[^'"]*https?:\/\/[^'"]*\1/gi, " srcset=$1$1")
    .replace(/\ssrcset\s*=\s*[^\s>]*https?:\/\/[^\s>]+/gi, ' srcset=""')
    .replace(/url\(\s*(['"]?)https?:\/\/[^)'"]*\1\s*\)/gi, "url('')");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mailBringsItsOwnCanvas(html) {
  return /<style[\s>]/i.test(html) || /bgcolor\s*=/i.test(html) || /background(?:-color)?\s*:/i.test(html);
}

function renderSandboxHtml(html) {
  const remoteCount = countRemoteImages(html);
  const shown = allowExternalImages && remoteCount > 0;
  const source = html && html.trim() ? html : escapeHtml(currentMailPlain).replace(/\n/g, "<br>");
  const body = shown ? source : stripRemoteImages(source);
  const unstyled = !mailBringsItsOwnCanvas(body);
  const imgSrc = shown ? "http: https: data: cid:" : "data: cid:";
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const pageBg = isDark ? "#0a0a0a" : "#ffffff";
  const textColor = isDark ? "#e5e5e5" : "#111111";
  const linkColor = isDark ? "#93c5fd" : "#1d4ed8";
  const trackBg = unstyled ? pageBg : (isDark ? "#18181b" : "#f1f5f9");
  const thumbBg = isDark ? "#52525b" : "#cbd5e1";
  const thumbHover = isDark ? "#71717a" : "#94a3b8";
  const thumbActive = isDark ? "#9ca3af" : "#64748b";
  const canvasCss = unstyled
    ? `html,body{background:${pageBg};color:${textColor};}a{color:${linkColor};}`
    : `html{background:${pageBg};}`;
  const scrollbarCss = `:root{color-scheme:${isDark ? "dark" : "light"};}*{scrollbar-width:thin;scrollbar-color:${thumbBg} ${trackBg};}::-webkit-scrollbar{width:10px;height:10px;}::-webkit-scrollbar-track{background:${trackBg};}::-webkit-scrollbar-thumb{background:${thumbBg};border-radius:5px;border:2px solid ${trackBg};}::-webkit-scrollbar-thumb:hover{background:${thumbHover};}::-webkit-scrollbar-thumb:active{background:${thumbActive};}::-webkit-scrollbar-corner{background:${trackBg};}::-webkit-resizer{background:transparent;}`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:;">`;
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<style>${scrollbarCss}html,body{margin:0;}body{font-family:sans-serif;font-size:14px;line-height:1.6;padding:16px;word-break:break-word;}${canvasCss}img{max-width:100%;height:auto;}</style></head><body>${body}</body></html>`;
  mailSandbox.setAttribute("srcdoc", doc);
  const hint = document.querySelector("#preview-guard");
  if (hint) {
    if (remoteCount === 0) hint.textContent = "不执行脚本。没有外链图片。";
    else if (shown) hint.textContent = `不执行脚本。外链图片已显示，共 ${remoteCount} 处。`;
    else hint.textContent = `不执行脚本。外链图片先不加载，共 ${remoteCount} 处。`;
  }
  if (btnLoadImages) {
    btnLoadImages.hidden = remoteCount === 0;
    btnLoadImages.disabled = false;
    btnLoadImages.textContent = shown ? "隐藏图片" : "显示图片";
  }
}

function switchTab(tab) {
  if (tab === "html") tab = "ai";
  if (tab !== "ai" && tab !== "text" && tab !== "raw") return;
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    if (b.getAttribute("data-tab") === tab) b.classList.add("active");
    else b.classList.remove("active");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const activePanel = document.querySelector("#panel-" + tab);
  if (activePanel) activePanel.classList.add("active");
}

async function reclassify(id, button) {
  if (button) button.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/reclassify", { method: "POST", body: {} });
    if (button) button.textContent = "已入队";
    setTimeout(() => {
      if (button) {
        button.textContent = "重分类";
        button.disabled = false;
      }
    }, 2000);
  } catch (err) {
    if (button) button.disabled = false;
    toast("触发重分类失败: " + explain(err));
  }
}

function navigateMail(delta) {
  if (currentMessages.length === 0) return;
  const idx = currentMessages.findIndex((m) => m.id === selectedMailId);
  const nextIdx = Math.max(0, Math.min(currentMessages.length - 1, idx + delta));
  if (nextIdx !== idx) {
    void selectMail(currentMessages[nextIdx].id);
  }
}

// ==================== 垃圾桶动作处理 ====================

async function handleTrashMail() {
  if (!selectedMailId) return;
  const id = selectedMailId;
  if (btnTrashMail) btnTrashMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/trash", { method: "POST", body: {} });
    noticeEl.textContent = "邮件已移入垃圾桶";
    void refreshUnread();
    setTimeout(() => { if (noticeEl.textContent === "邮件已移入垃圾桶") noticeEl.textContent = ""; }, 3000);
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) card.remove();
    currentMessages = currentMessages.filter((m) => m.id !== id);
    const nextCard = listEl.querySelector(".mail-item");
    if (nextCard && nextCard.getAttribute("data-id")) {
      void selectMail(nextCard.getAttribute("data-id"));
    } else {
      selectedMailId = null;
      mailDetailEl.hidden = true;
      mailEmptyEl.hidden = false;
      setMobilePane("list");
    }
  } catch (err) {
    noticeEl.textContent = "移入垃圾桶失败: " + explain(err);
  } finally {
    if (btnTrashMail) btnTrashMail.disabled = false;
  }
}

async function handleRestoreMail() {
  if (!selectedMailId) return;
  const id = selectedMailId;
  if (btnRestoreMail) btnRestoreMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/restore", { method: "POST", body: {} });
    noticeEl.textContent = "已从垃圾桶恢复";
    void refreshUnread();
    setTimeout(() => { if (noticeEl.textContent === "已从垃圾桶恢复") noticeEl.textContent = ""; }, 3000);
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) card.remove();
    currentMessages = currentMessages.filter((m) => m.id !== id);
    const nextCard = listEl.querySelector(".mail-item");
    if (nextCard && nextCard.getAttribute("data-id")) {
      void selectMail(nextCard.getAttribute("data-id"));
    } else {
      selectedMailId = null;
      mailDetailEl.hidden = true;
      mailEmptyEl.hidden = false;
      setMobilePane("list");
    }
  } catch (err) {
    noticeEl.textContent = "恢复邮件失败: " + explain(err);
  } finally {
    if (btnRestoreMail) btnRestoreMail.disabled = false;
  }
}

async function handleDeleteMail() {
  if (!selectedMailId) return;
  if (!(await askConfirm("确定永久删除此邮件吗？此操作无法撤销。"))) return;
  const id = selectedMailId;
  if (btnDeleteMail) btnDeleteMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id), { method: "DELETE" });
    noticeEl.textContent = "邮件已彻底删除";
    void refreshUnread();
    setTimeout(() => { if (noticeEl.textContent === "邮件已彻底删除") noticeEl.textContent = ""; }, 3000);
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) card.remove();
    currentMessages = currentMessages.filter((m) => m.id !== id);
    const nextCard = listEl.querySelector(".mail-item");
    if (nextCard && nextCard.getAttribute("data-id")) {
      void selectMail(nextCard.getAttribute("data-id"));
    } else {
      selectedMailId = null;
      mailDetailEl.hidden = true;
      mailEmptyEl.hidden = false;
      setMobilePane("list");
    }
  } catch (err) {
    noticeEl.textContent = "彻底删除失败: " + explain(err);
  } finally {
    if (btnDeleteMail) btnDeleteMail.disabled = false;
  }
}

async function handleEmptyTrash() {
  if (!(await askConfirm("确定清空垃圾桶内全部邮件吗？此操作无法撤销。"))) return;
  if (emptyTrashBtn) emptyTrashBtn.disabled = true;
  try {
    const res = await request("/v1/messages/empty-trash", { method: "POST", body: {} });
    noticeEl.textContent = `垃圾桶已清空 (共清除 ${res.count || 0} 封邮件)`;
    setTimeout(() => { if (noticeEl.textContent.startsWith("垃圾桶已清空")) noticeEl.textContent = ""; }, 3000);
    selectedMailId = null;
    mailDetailEl.hidden = true;
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailEmptyEl.hidden = false;
    setMobilePane("list");
    await reloadTrash();
  } catch (err) {
    noticeEl.textContent = "清空垃圾桶失败: " + explain(err);
  } finally {
    if (emptyTrashBtn) emptyTrashBtn.disabled = false;
  }
}

// ==================== 处理失败 ====================

async function loadDlqJobs(scope = currentDlqScope) {
  currentDlqScope = scope || "open";
  listEl.replaceChildren();
  if (dlqNoticeEl) dlqNoticeEl.textContent = "正在读取";
  try {
    const [res, summary] = await Promise.all([request(jobsUrl(currentDlqScope)), request("/v1/jobs/summary")]);
    currentJobs = Array.isArray(res.items) ? res.items : [];
    paintDlqCounts(summary);
    renderFailureGroups(currentJobs);
  } catch (err) {
    if (dlqNoticeEl) dlqNoticeEl.textContent = explain(err);
  }
}

function jobsUrl(scope) {
  if (scope === "stopped") return "/v1/jobs?scope=stopped";
  if (scope === "dismissed") return "/v1/jobs?status=dismissed";
  if (scope === "retrying") return "/v1/jobs?scope=retrying";
  return "/v1/jobs?scope=open";
}

function paintDlqCounts(summary) {
  failureCounts = {
    open: summary.open || 0,
    dead: summary.dead || 0,
    failed: summary.failed || 0,
    retrying: summary.retrying || 0,
    dismissed: summary.dismissed || 0,
    running: summary.running || 0,
  };
  const stopped = failureCounts.dead + failureCounts.failed;
  setPillLabel("open", "要处理", failureCounts.open);
  setPillLabel("stopped", "已放弃", stopped);
  setPillLabel("retrying", "还会再试", failureCounts.retrying);
  setPillLabel("dismissed", "已放过", failureCounts.dismissed);
  const summaryEl = document.querySelector("#dlq-summary");
  if (summaryEl) {
    const waiting = failureCounts.retrying ? `还有 ${failureCounts.retrying} 步会自己再试。` : "";
    summaryEl.textContent = stopped
      ? `停住 ${stopped} 步。再试会重新排队，放过则先不动这步。${waiting}`
      : `没有停住的步骤。${waiting}`;
  }
  if (retryAllBtn) retryAllBtn.disabled = stopped === 0;
}

function setPillLabel(status, label, count) {
  const button = document.querySelector(`#dlq-pills button[data-dlq-status="${status}"]`);
  if (!button) return;
  const active = button.classList.contains("active");
  button.textContent = count > 0 ? `${label} ${count}` : label;
  if (active) button.classList.add("active");
}

function renderFailureGroups(jobs) {
  listEl.replaceChildren();
  const needle = dlqQuery;
  const groups = new Map();
  for (const job of jobs) {
    if (needle && !jobMatches(job, needle)) continue;
    const key = job.messageId || job.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  if (dlqNoticeEl) {
    if (jobs.length === 0) dlqNoticeEl.textContent = emptyDlqCopy(currentDlqScope);
    else if (groups.size === 0) dlqNoticeEl.textContent = "没有符合搜索的记录";
    else dlqNoticeEl.textContent = "";
  }
  let matched = null;
  for (const [key, group] of groups) {
    group.sort((a, b) => stepRank(a.type) - stepRank(b.type));
    if (key === selectedFailureKey) matched = group;
    listEl.append(createFailureListItem(key, group));
  }
  if (matched) renderFailureDetail(matched);
  else if (groups.size > 0 && window.matchMedia("(min-width: 901px)").matches) {
    const first = groups.entries().next().value;
    if (first) selectFailure(first[0], first[1], { keepListOnNarrow: true });
  } else {
    clearFailureDetail();
  }
}

function createFailureListItem(key, jobs) {
  const first = jobs[0] || {};
  const card = document.createElement("button");
  card.type = "button";
  card.className = "mail-item";
  card.dataset.failureKey = key;
  if (key === selectedFailureKey) card.classList.add("selected");
  const line1 = document.createElement("div");
  line1.className = "item-line1";
  const subject = document.createElement("span");
  subject.className = "item-from";
  subject.textContent = first.messageSubject || "（无主题）";
  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(first.updatedAt);
  line1.append(subject, time);
  const who = document.createElement("p");
  who.className = "item-subject";
  const from = first.messageFrom ? formatFrom(first.messageFrom) : "";
  who.textContent = from || first.messageTo || "地址尚未解析";
  const steps = document.createElement("p");
  steps.className = "item-snippet";
  steps.textContent = jobs.map((job) => STEP_NAMES[job.type] || job.type).join(" · ");
  card.append(line1, who, steps);
  card.addEventListener("click", () => selectFailure(key, jobs));
  return card;
}

function selectFailure(key, jobs, options = {}) {
  selectedFailureKey = key;
  markFailureSelection();
  renderFailureDetail(jobs);
  if (!options.keepListOnNarrow) setMobilePane("detail");
}

function markFailureSelection() {
  for (const card of listEl.querySelectorAll(".mail-item")) {
    card.classList.toggle("selected", card.dataset.failureKey === selectedFailureKey);
  }
}

function clearFailureDetail() {
  selectedFailureKey = "";
  if (failureDetailEl) {
    failureDetailEl.replaceChildren();
    failureDetailEl.hidden = true;
  }
  if (dlqEmptyEl) dlqEmptyEl.hidden = false;
}

function renderFailureDetail(jobs) {
  if (!failureDetailEl) return;
  failureDetailEl.replaceChildren(createFailureLetter(jobs));
  failureDetailEl.hidden = false;
  if (dlqEmptyEl) dlqEmptyEl.hidden = true;
  markFailureSelection();
}

function jobMatches(job, needle) {
  const haystack = [job.messageSubject, job.messageFrom, job.messageTo, job.lastError, STEP_NAMES[job.type] || job.type]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function emptyDlqCopy(scope) {
  if (scope === "stopped") return "没有已经放弃的步骤";
  if (scope === "retrying") return "没有还在等的步骤";
  if (scope === "dismissed") return "没有放过的步骤";
  return "没有要处理的任务";
}

function stepRank(type) {
  const index = STEP_ORDER.indexOf(type);
  return index === -1 ? STEP_ORDER.length : index;
}

function createFailureLetter(jobs) {
  const first = jobs[0] || {};
  const article = document.createElement("article");
  article.className = "letter";

  const head = document.createElement("div");
  head.className = "letter-head";
  const subjectText = first.messageSubject || "（无主题）";
  if (first.messageId) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "letter-open";
    open.textContent = subjectText;
    open.title = "打开邮件";
    open.addEventListener("click", () => void openFailedMail(first.messageId));
    head.append(open);
  } else {
    const subject = document.createElement("p");
    subject.className = "letter-subject";
    subject.textContent = subjectText;
    head.append(subject);
  }
  const stopped = jobs.filter((job) => job.status === "dead" || job.status === "failed");
  if (stopped.length > 1 && first.messageId) {
    const retryLetter = document.createElement("button");
    retryLetter.type = "button";
    retryLetter.className = "btn-fit";
    retryLetter.textContent = "整封重试";
    retryLetter.addEventListener("click", () => void retryMessage(first.messageId));
    head.append(retryLetter);
  }

  const who = document.createElement("p");
  who.className = "muted";
  const from = first.messageFrom ? formatFrom(first.messageFrom) : "";
  const to = first.messageTo ? formatRecipients(first.messageTo) : "";
  who.textContent = from || to ? [from || "发件人尚未解析", to].filter(Boolean).join(" → ") : "地址尚未解析";

  article.append(head, who);
  for (const job of jobs) article.append(createFailureStep(job));
  return article;
}

function createFailureStep(job) {
  const row = document.createElement("div");
  row.className = "step-row";

  const copy = document.createElement("div");
  copy.className = "step-copy";
  const name = document.createElement("strong");
  name.textContent = STEP_NAMES[job.type] || job.type;
  const error = document.createElement("p");
  error.className = "step-error";
  error.textContent = job.lastError || "没有错误说明";
  const state = document.createElement("p");
  state.className = "muted";
  state.textContent = stepState(job);
  copy.append(name, error, state);

  const actions = document.createElement("div");
  actions.className = "step-actions";
  const stopped = job.status === "dead" || job.status === "failed";
  const dismissed = job.status === "dismissed";
  if (stopped || dismissed) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-fit";
    retry.textContent = "再试一次";
    retry.addEventListener("click", () => void retrySingleJob(job.id));
    actions.append(retry);
  }
  if (stopped) {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn-fit ghost";
    dismiss.textContent = "放过";
    dismiss.addEventListener("click", () => void dismissJob(job.id));
    actions.append(dismiss);
  }
  if (job.lastError) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-fit ghost";
    copyBtn.textContent = "复制错误";
    copyBtn.addEventListener("click", () => void copyText(job.lastError));
    actions.append(copyBtn);
  }

  row.append(copy, actions);
  return row;
}

function stepState(job) {
  const when = job.updatedAt ? ` · ${formatFullTime(job.updatedAt)}` : "";
  if (job.status === "dismissed") return `已放过 · 试了 ${job.attempts}/${job.maxAttempts} 次${when}`;
  if (job.status === "dead" || job.status === "failed") {
    return `已放弃 · 试了 ${job.attempts}/${job.maxAttempts} 次${when}`;
  }
  if (job.status === "running") return "正在跑";
  if (job.status === "queued" && job.runAfter) {
    return `还会再试 · 下次 ${formatFullTime(job.runAfter)}`;
  }
  return "还会再试";
}

async function openFailedMail(id) {
  selectedMailId = id;
  await switchNav("inbox");
  await selectMail(id);
}

async function retrySingleJob(id) {
  try {
    await request("/v1/jobs/" + encodeURIComponent(id) + "/retry", { method: "POST", body: {} });
    toast("已重新排队");
    await loadDlqJobs(currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("任务重试失败: " + explain(err));
  }
}

async function dismissJob(id) {
  if (!(await askConfirm("此步骤不再自动执行。邮件仍保留，之后可以重试。"))) return;
  try {
    await request("/v1/jobs/" + encodeURIComponent(id) + "/dismiss", { method: "POST", body: {} });
    toast("已放过");
    await loadDlqJobs(currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("操作失败: " + explain(err));
  }
}

async function retryMessage(messageId) {
  try {
    const res = await request("/v1/jobs/retry-message", { method: "POST", body: { messageId } });
    toast(`已重新排队 ${res.count || 0} 步`);
    await loadDlqJobs(currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("重试失败: " + explain(err));
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    toast("复制失败");
  }
}

async function retryAllDead() {
  if (!(await askConfirm("重新执行全部已停止的任务？已放过的任务保持不变。"))) return;
  try {
    const res = await request("/v1/jobs/retry-all", { method: "POST", body: {} });
    toast(`已重新排队 ${res.count || 0} 个`);
    await loadDlqJobs(currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("批量重试失败: " + explain(err));
  }
}

async function updateDlqBadge() {
  try {
    const res = await request("/v1/jobs/summary");
    const count = (res.dead || 0) + (res.failed || 0);
    if (count > 0) {
      badgeDlq.hidden = false;
      badgeDlq.textContent = String(count);
    } else {
      badgeDlq.hidden = true;
    }
    if (currentView === "dlq") paintDlqCounts(res);
  } catch {
    // ignore
  }
}

// ==================== 设置 ====================

async function loadSettingsPage() {
  try {
    const settings = await request("/v1/settings");
    applyAppearance(settings);
    renderNameEditors(settings);
    renderNotify(settings);
    renderDomains(settings.acceptDomains || []);
    const attempts = document.querySelector("#job-max-attempts");
    if (attempts) {
      attempts.value = String(settings.jobMaxAttempts ?? 5);
      attemptsBaseline = attempts.value;
      syncAttemptSave();
    }
    const aiLine = document.querySelector("#ai-status-line");
    if (aiLine) aiLine.textContent = describeAi(settings.ai);
    const channels = document.querySelector("#notify-channels");
    if (channels) channels.textContent = describeChannels(settings.channels);

    const promptsRes = await request("/v1/prompts");
    currentPromptId = promptsRes.defaultPromptId || "classify-v1";
    const detail = await request("/v1/prompts/" + encodeURIComponent(currentPromptId));
    const editor = document.querySelector("#prompt-editor");
    if (editor) {
      editor.value = detail.content || "";
      promptBaseline = editor.value;
      syncPromptSave();
    }
    await loadMailboxesView();
    await loadMachineLine();
    const enabled = document.querySelector("#ai-enabled");
    if (enabled) enabled.checked = settings.aiEnabled !== false;
    const thinking = document.querySelector("#ai-thinking");
    if (thinking) thinking.value = settings.aiThinking || "low";
    renderAiEditors(settings.aiPool || {});
    renderSettingsNav();
  } catch (err) {
    toast(explain(err));
  }
}

const SETTING_SECTIONS = [
  ["names", "名称"],
  ["model", "模型"],
  ["account", "账号"],
  ["domains", "收信"],
  ["mailboxes", "地址"],
  ["notify", "提醒"],
  ["prompt", "分拣"],
  ["jobs", "失败"],
  ["logs", "日志"],
  ["machine", "概况"],
];

function renderSettingsNav() {
  if (currentView !== "settings") return;
  listEl.replaceChildren();
  for (const [id, label] of SETTING_SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mail-item";
    button.dataset.section = id;
    if (id === currentSettingsSection) button.classList.add("selected");
    const title = document.createElement("span");
    title.className = "item-from";
    title.textContent = label;
    button.append(title);
    button.addEventListener("click", () => showSettingsSection(id));
    listEl.append(button);
  }
}

function showSettingsSection(id, options = {}) {
  currentSettingsSection = id;
  for (const block of document.querySelectorAll("#view-settings .block")) {
    block.hidden = block.id !== `set-${id}`;
  }
  for (const button of listEl.querySelectorAll(".mail-item")) {
    button.classList.toggle("selected", button.dataset.section === id);
  }
  if (!options.keepListOnNarrow) setMobilePane("detail");
  if (id === "logs") void loadLogs();
}

function describeAi(ai) {
  if (!ai || ai.classifier === "fake" || !ai.model) return "尚未配置模型。提示词会在模型可用后用于新邮件。";
  const keys = Number(ai.keyCount) === 1 ? "1 个密钥可用" : `${ai.keyCount || 0} 个密钥可用`;
  return `${ai.model} · ${keys}`;
}

function describeChannels(channels) {
  const telegram = channels && channels.telegram ? "Telegram 已配置" : "Telegram 未配置";
  const webhook = channels && channels.webhook ? "Webhook 已配置" : "Webhook 未配置";
  return `${telegram} · ${webhook}`;
}

function renderNotify(settings) {
  const host = document.querySelector("#notify-labels");
  if (!host) return;
  host.replaceChildren();
  const selected = new Set(settings.notifyLabels || []);
  for (const label of LABELS) {
    const wrap = document.createElement("label");
    wrap.className = "chk";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = label;
    input.checked = selected.has(label);
    input.addEventListener("change", syncNotifySave);
    const text = document.createElement("span");
    text.textContent = labelName(label);
    wrap.append(input, text);
    host.append(wrap);
  }
  const confidence = document.querySelector("#notify-confidence");
  if (confidence) confidence.value = String(settings.notifyMinConfidence ?? 0.6);
  notifyBaseline = notifySnapshot();
  syncNotifySave();
}

function notifySnapshot() {
  const labels = [];
  document.querySelectorAll("#notify-labels input").forEach((input) => {
    if (input.checked) labels.push(input.value);
  });
  const confidence = document.querySelector("#notify-confidence");
  return JSON.stringify({ labels, confidence: confidence ? confidence.value.trim() : "" });
}

function syncNotifySave() {
  const button = document.querySelector("#btn-save-notify");
  if (button) button.disabled = notifySnapshot() === notifyBaseline;
}

function syncPromptSave() {
  const editor = document.querySelector("#prompt-editor");
  const button = document.querySelector("#btn-save-prompt");
  if (button) button.disabled = !editor || editor.value === promptBaseline;
}

function syncAttemptSave() {
  const input = document.querySelector("#job-max-attempts");
  const button = document.querySelector("#btn-save-attempts");
  if (button) button.disabled = !input || input.value.trim() === attemptsBaseline;
}

function renderDomains(domains) {
  settingsDomains = Array.isArray(domains) ? domains.slice() : [];
  const host = document.querySelector("#domain-list");
  if (!host) return;
  host.replaceChildren();
  for (const domain of settingsDomains) {
    const row = document.createElement("div");
    row.className = "domain-row";
    const input = document.createElement("input");
    input.value = domain;
    input.readOnly = true;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-fit ghost";
    button.textContent = "移除";
    button.addEventListener("click", () => void removeDomain(domain));
    row.append(input, button);
    host.append(row);
  }
}

async function saveNotifySettings() {
  const confidence = Number(document.querySelector("#notify-confidence")?.value);
  const labels = [];
  document.querySelectorAll("#notify-labels input").forEach((input) => {
    if (input.checked) labels.push(input.value);
  });
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    toast("置信度要在 0 到 1 之间");
    return;
  }
  try {
    await request("/v1/settings/notify", { method: "PUT", body: { labels, minConfidence: confidence } });
    notifyBaseline = notifySnapshot();
    syncNotifySave();
    toast("提醒已保存");
  } catch (err) {
    toast("保存提醒失败: " + explain(err));
  }
}

async function addDomain() {
  const input = document.querySelector("#domain-add");
  const domain = input ? input.value.trim() : "";
  if (!domain) return;
  try {
    const res = await request("/v1/settings/domains", {
      method: "PUT",
      body: { domains: settingsDomains.concat([domain]) },
    });
    if (input) input.value = "";
    renderDomains(res.acceptDomains || []);
    renderDomainNameRows(res.acceptDomains || [], collectDomainNames());
    syncNamesSave();
    toast("域名已添加");
  } catch (err) {
    toast("添加域名失败: " + explain(err));
  }
}

async function removeDomain(domain) {
  if (settingsDomains.length <= 1) {
    toast("至少保留一个域名");
    return;
  }
  if (!(await askConfirm(`停止接收 ${domain}？`))) return;
  try {
    const res = await request("/v1/settings/domains", {
      method: "PUT",
      body: { domains: settingsDomains.filter((item) => item !== domain) },
    });
    renderDomains(res.acceptDomains || []);
    const names = collectDomainNames();
    delete names[domain];
    renderDomainNameRows(res.acceptDomains || [], names);
    syncNamesSave();
    toast("已移除 " + domain);
  } catch (err) {
    toast("移除域名失败: " + explain(err));
  }
}

async function saveAttemptSettings() {
  const raw = document.querySelector("#job-max-attempts")?.value.trim() || "";
  const maxAttempts = Number(raw);
  if (!/^\d+$/.test(raw) || maxAttempts < 1 || maxAttempts > 20) {
    toast("次数要是 1 到 20 的整数");
    return;
  }
  try {
    await request("/v1/settings/jobs", { method: "PUT", body: { maxAttempts } });
    attemptsBaseline = String(maxAttempts);
    syncAttemptSave();
    toast("之后的新任务会在达到该次数后停止");
  } catch (err) {
    toast("保存失败: " + explain(err));
  }
}

async function loadMailboxesView() {
  try {
    const res = await request("/v1/mailbox-history");
    const items = res.items || [];
    const tbody = document.querySelector("#mailboxes-tbody");
    if (!tbody) return;
    tbody.replaceChildren();
    rememberMailboxes(items);
    for (const item of items) {
      const tr = document.createElement("tr");
      const tdAddr = document.createElement("td");
      tdAddr.textContent = `${item.localpart}@${item.domain}`;
      const tdName = document.createElement("td");
      tdName.textContent = item.displayName || "—";
      const tdNotes = document.createElement("td");
      tdNotes.textContent = item.notes || "无备注";
      const tdEdit = document.createElement("td");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn-fit ghost";
      edit.textContent = "改";
      edit.addEventListener("click", () => fillMailboxForm(item));
      tdEdit.append(edit);
      tr.append(tdAddr, tdName, tdNotes, tdEdit);
      tbody.append(tr);
    }
  } catch (err) {
    toast("地址列表读取失败: " + explain(err));
  }
}

async function loadMachineLine() {
  try {
    const health = await request("/healthz");
    const stats = await request("/v1/stats");
    const today = stats.today || {};
    const sum = Object.values(today).reduce((acc, n) => acc + (typeof n === "number" ? n : 0), 0);
    const line = document.querySelector("#machine-line");
    const dbText = health.db === "ok" ? "SQLite 正常" : "数据库异常";
    if (line) line.textContent = `在线 · ${dbText} · 今天收了 ${sum} 封`;
    renderTrend(Array.isArray(stats.daily) ? stats.daily : []);
  } catch (err) {
    const line = document.querySelector("#machine-line");
    if (line) line.textContent = explain(err);
  }
}

function renderTrend(days) {
  const host = document.querySelector("#stat-trend");
  if (!host) return;
  host.replaceChildren();
  const max = Math.max(1, ...days.map((day) => day.total || 0));
  for (const day of days) {
    const col = document.createElement("div");
    col.className = "trend-col";
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    const total = day.total || 0;
    bar.style.height = Math.max(2, Math.round((total / max) * 100)) + "%";
    const labelNameOf = (key) => labelName(key);
    const parts = Object.entries(day.labels || {})
      .filter(([, n]) => n > 0)
      .map(([key, n]) => `${labelNameOf(key)} ${n}`);
    bar.title = `${day.day} 共 ${total} 封` + (parts.length ? " · " + parts.join("，") : "");
    const caption = document.createElement("span");
    caption.className = "trend-label";
    caption.textContent = String(day.day || "").slice(5);
    col.append(bar, caption);
    host.append(col);
  }
}

async function saveCurrentPrompt() {
  const editor = document.querySelector("#prompt-editor");
  try {
    await request("/v1/prompts/" + encodeURIComponent(currentPromptId), {
      method: "PUT",
      body: { content: editor ? editor.value : "" },
    });
    promptBaseline = editor ? editor.value : "";
    syncPromptSave();
    toast("提示词已保存，之后的新邮件会使用这份");
  } catch (err) {
    toast("保存提示词失败: " + explain(err));
  }
}

function fillMailboxForm(item) {
  const domain = document.querySelector("#mb-domain");
  const localpart = document.querySelector("#mb-localpart");
  const name = document.querySelector("#mb-name");
  const notes = document.querySelector("#mb-notes");
  if (domain) domain.value = item.domain || "";
  if (localpart) localpart.value = item.localpart || "";
  if (name) name.value = item.displayName || "";
  if (notes) notes.value = item.notes || "";
  domain?.focus();
}

async function saveMailbox() {
  try {
    await request("/v1/mailbox-history", {
      method: "POST",
      body: {
        domain: document.querySelector("#mb-domain").value,
        localpart: document.querySelector("#mb-localpart").value,
        notes: document.querySelector("#mb-notes").value,
        displayName: document.querySelector("#mb-name")?.value || "",
      },
    });
    toast("地址已保存");
    const form = document.querySelector("#mailbox-form");
    if (form) form.reset();
    await loadMailboxesView();
  } catch (err) {
    toast("保存地址失败: " + explain(err));
  }
}

async function loadAppearance() {
  try {
    const settings = await request("/v1/settings");
    applyAppearance(settings);
    const history = await request("/v1/mailbox-history");
    rememberMailboxes(history.items || []);
  } catch {
    // Built-in names still work if this read fails.
  }
}

function applyAppearance(settings) {
  panelTitle = (settings && settings.panelTitle) || "Flytrap";
  labelNames = { ...LABEL_NAMES, ...(settings && settings.labelNames ? settings.labelNames : {}) };
  domainNames = (settings && settings.domainNames) || {};
  senderMap = new Map(
    ((settings && settings.senderNames) || [])
      .filter((item) => item && item.address)
      .map((item) => [String(item.address).toLowerCase(), item.name]),
  );
  const mark = document.querySelector("#rail-mark");
  if (mark) mark.title = panelTitle;
  const eyebrow = document.querySelector("#panel-name");
  if (eyebrow) {
    const custom = panelTitle !== "Flytrap";
    eyebrow.hidden = !custom;
    eyebrow.textContent = custom ? panelTitle : "";
  }
  for (const select of [filterSelect, detailVerdictSelect]) {
    if (!select) continue;
    for (const option of select.options) {
      if (!option.value || !LABEL_NAMES[option.value]) continue;
      option.textContent = labelName(option.value);
    }
  }
  if (currentView && !appEl.hidden) setViewTitle(currentView);
}

function rememberMailboxes(items) {
  mailboxNames = new Map();
  for (const item of items) {
    if (!item || !item.displayName) continue;
    mailboxNames.set(`${item.localpart}@${item.domain}`.toLowerCase(), item.displayName);
  }
}

function labelName(id) {
  if (!id) return "未分类";
  return labelNames[id] || LABEL_NAMES[id] || id;
}

function renderNameEditors(settings) {
  const title = document.querySelector("#panel-title");
  if (title) title.value = settings.panelTitle || "Flytrap";
  const labels = document.querySelector("#label-names");
  if (labels) {
    labels.replaceChildren();
    for (const id of LABELS) {
      labels.append(nameRow(id, labelName(id), "label"));
    }
  }
  renderDomainNameRows(settings.acceptDomains || [], settings.domainNames || {});
  renderSenderRows(settings.senderNames || []);
  namesBaseline = JSON.stringify(collectNames());
  syncNamesSave();
}

function renderDomainNameRows(domains, names) {
  const host = document.querySelector("#domain-names");
  if (!host) return;
  host.replaceChildren();
  const list = Array.isArray(domains) ? domains : [];
  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "请先添加收信域名。";
    host.append(empty);
    return;
  }
  for (const domain of list) {
    host.append(nameRow(domain, (names && names[domain]) || "", "domain"));
  }
}

function renderSenderRows(senders) {
  const host = document.querySelector("#sender-names");
  if (!host) return;
  host.replaceChildren();
  for (const item of senders) host.append(senderRow(item.address, item.name));
}

function nameRow(key, value, kind) {
  const row = document.createElement("label");
  row.className = "name-row";
  const caption = document.createElement("span");
  caption.className = "name-key";
  caption.textContent = key;
  caption.title = key;
  const input = document.createElement("input");
  input.value = value || "";
  input.maxLength = kind === "label" ? 16 : 24;
  input.autocomplete = "off";
  input.dataset.nameKey = key;
  input.dataset.nameKind = kind;
  input.placeholder = kind === "label" ? LABEL_NAMES[key] || "" : "短名，可空";
  input.addEventListener("input", syncNamesSave);
  row.append(caption, input);
  return row;
}

function senderRow(address, name) {
  const row = document.createElement("div");
  row.className = "name-row with-action";
  const addressInput = document.createElement("input");
  addressInput.value = address;
  addressInput.readOnly = true;
  addressInput.dataset.senderAddress = address;
  const nameInput = document.createElement("input");
  nameInput.value = name || "";
  nameInput.maxLength = 40;
  nameInput.dataset.senderName = "1";
  nameInput.placeholder = "名称";
  nameInput.addEventListener("input", syncNamesSave);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-fit ghost";
  remove.textContent = "移除";
  remove.addEventListener("click", () => {
    row.remove();
    syncNamesSave();
  });
  row.append(addressInput, nameInput, remove);
  return row;
}

function addSenderRow() {
  const addressInput = document.querySelector("#sender-address");
  const nameInput = document.querySelector("#sender-name");
  const address = normalizeAddress(addressInput ? addressInput.value : "");
  const name = nameInput ? nameInput.value.trim() : "";
  if (!address) {
    toast("发件地址无效");
    return;
  }
  if (!name) {
    toast("请填写名称");
    return;
  }
  const existing = document.querySelector(`#sender-names input[data-sender-address="${cssEscape(address)}"]`);
  if (existing) {
    const row = existing.closest(".name-row");
    const field = row ? row.querySelector("input[data-sender-name]") : null;
    if (field) field.value = name;
  } else {
    document.querySelector("#sender-names")?.append(senderRow(address, name));
  }
  if (addressInput) addressInput.value = "";
  if (nameInput) nameInput.value = "";
  syncNamesSave();
}

function collectNames() {
  const labelNamesOut = {};
  document.querySelectorAll('#label-names input[data-name-kind="label"]').forEach((input) => {
    labelNamesOut[input.dataset.nameKey] = input.value.trim();
  });
  const senderNames = [];
  document.querySelectorAll("#sender-names .name-row").forEach((row) => {
    const address = row.querySelector("input[data-sender-address]")?.value.trim() || "";
    const name = row.querySelector("input[data-sender-name]")?.value.trim() || "";
    if (address && name) senderNames.push({ address, name });
  });
  return {
    panelTitle: document.querySelector("#panel-title")?.value.trim() || "",
    labelNames: labelNamesOut,
    domainNames: collectDomainNames(),
    senderNames,
  };
}

function collectDomainNames() {
  const domainNamesOut = {};
  document.querySelectorAll('#domain-names input[data-name-kind="domain"]').forEach((input) => {
    domainNamesOut[input.dataset.nameKey] = input.value.trim();
  });
  return domainNamesOut;
}

function syncNamesSave() {
  const button = document.querySelector("#btn-save-names");
  if (!button) return;
  const draft = collectNames();
  button.disabled = !draft.panelTitle || JSON.stringify(draft) === namesBaseline;
}

async function saveNameSettings() {
  const draft = collectNames();
  if (!draft.panelTitle) {
    toast("面板名称不能为空");
    return;
  }
  try {
    const saved = await request("/v1/settings/names", { method: "PUT", body: draft });
    applyAppearance(saved);
    renderNameEditors({
      panelTitle: saved.panelTitle,
      labelNames: saved.labelNames,
      domainNames: saved.domainNames,
      senderNames: saved.senderNames,
      acceptDomains: settingsDomains,
    });
    const notifyHost = document.querySelector("#notify-labels");
    if (notifyHost) {
      notifyHost.querySelectorAll("label.chk").forEach((wrap) => {
        const input = wrap.querySelector("input");
        const text = wrap.querySelector("span");
        if (input && text) text.textContent = labelName(input.value);
      });
    }
    toast("名称已保存");
  } catch (err) {
    toast("保存名称失败: " + explain(err));
  }
}

function renderAiEditors(pool) {
  aiModels = Array.isArray(pool.models) ? pool.models.slice() : [];
  aiKeyRows = (Array.isArray(pool.keys) ? pool.keys : []).map((item) => ({
    id: item.id,
    tail: item.tail || "",
  }));
  paintAiEditors();
  aiBaseline = aiSnapshot();
  syncAiSave();
}

function paintAiEditors() {
  const models = document.querySelector("#model-list");
  const keys = document.querySelector("#key-list");
  if (models) {
    models.replaceChildren();
    aiModels.forEach((model, index) => models.append(orderRow(model, index, aiModels.length, "model")));
  }
  if (keys) {
    keys.replaceChildren();
    if (aiKeyRows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "没有密钥。";
      keys.append(empty);
    }
    aiKeyRows.forEach((row, index) => keys.append(orderRow(maskKey(row.tail), index, aiKeyRows.length, "key")));
  }
}

function maskKey(tail) {
  return tail ? `····${tail}` : "已保存";
}

function orderRow(label, index, total, kind) {
  const row = document.createElement("div");
  row.className = "name-row order-row";
  const text = document.createElement("input");
  text.value = label;
  text.readOnly = true;
  const actions = document.createElement("div");
  actions.className = "step-actions";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "btn-fit ghost";
  up.textContent = "上移";
  up.disabled = index === 0;
  up.addEventListener("click", () => moveAiRow(kind, index, -1));
  const down = document.createElement("button");
  down.type = "button";
  down.className = "btn-fit ghost";
  down.textContent = "下移";
  down.disabled = index === total - 1;
  down.addEventListener("click", () => moveAiRow(kind, index, 1));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-fit ghost";
  remove.textContent = "移除";
  remove.addEventListener("click", () => removeAiRow(kind, index));
  actions.append(up, down, remove);
  row.append(text, actions);
  return row;
}

function moveAiRow(kind, index, delta) {
  const list = kind === "model" ? aiModels : aiKeyRows;
  const next = index + delta;
  if (next < 0 || next >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(next, 0, item);
  paintAiEditors();
  syncAiSave();
}

function removeAiRow(kind, index) {
  if (kind === "model") aiModels.splice(index, 1);
  else aiKeyRows.splice(index, 1);
  paintAiEditors();
  syncAiSave();
}

function addModelRow() {
  const input = document.querySelector("#model-add");
  const model = input ? input.value.trim() : "";
  if (!model) {
    toast("请输入模型名称");
    return false;
  }
  if (!/^[A-Za-z0-9._:@/-]{1,80}$/.test(model)) {
    toast("模型名称无效");
    return false;
  }
  if (!aiModels.includes(model)) aiModels.push(model);
  if (input) input.value = "";
  paintAiEditors();
  syncAiSave();
  return true;
}

function addKeyRow() {
  const input = document.querySelector("#key-add");
  const secret = input ? input.value.trim() : "";
  if (!secret) {
    toast("请输入密钥");
    return false;
  }
  if (secret.length < 8 || secret.length > 512 || /\s/.test(secret)) {
    toast("密钥无效");
    return false;
  }
  const tail = secret.length >= 12 ? secret.slice(-4) : "";
  aiKeyRows.push({ secret, tail });
  if (input) input.value = "";
  paintAiEditors();
  syncAiSave();
  return true;
}

function aiSnapshot() {
  const enabled = document.querySelector("#ai-enabled");
  const thinking = document.querySelector("#ai-thinking");
  return JSON.stringify({
    models: aiModels,
    keys: aiKeyRows.map((row) => (row.secret ? { secret: row.tail, pending: true } : { id: row.id, tail: row.tail })),
    enabled: enabled ? enabled.checked : true,
    thinking: thinking ? thinking.value : "low",
  });
}

function syncAiSave() {
  const button = document.querySelector("#btn-save-ai");
  if (!button) return;
  const pendingModel = document.querySelector("#model-add")?.value.trim();
  const pendingKey = document.querySelector("#key-add")?.value.trim();
  button.disabled = aiSnapshot() === aiBaseline && !pendingModel && !pendingKey;
}

async function saveAiSettings() {
  const modelInput = document.querySelector("#model-add");
  const pendingModel = modelInput ? modelInput.value.trim() : "";
  if (pendingModel) {
    if (!addModelRow()) return;
  }
  const keyInput = document.querySelector("#key-add");
  const pendingKey = keyInput ? keyInput.value.trim() : "";
  if (pendingKey) {
    if (!addKeyRow()) return;
  }
  const keys = aiKeyRows.map((row) => (row.secret ? { secret: row.secret } : { id: row.id }));
  const enabled = document.querySelector("#ai-enabled");
  const thinking = document.querySelector("#ai-thinking");
  try {
    const saved = await request("/v1/settings/ai", {
      method: "PUT",
      body: {
        models: aiModels,
        keys,
        enabled: enabled ? enabled.checked : true,
        thinking: thinking ? thinking.value : "low",
      },
    });
    for (const row of aiKeyRows) delete row.secret;
    renderAiEditors(saved.aiPool || {});
    const status = await request("/v1/ai/status");
    const aiLine = document.querySelector("#ai-status-line");
    if (aiLine) aiLine.textContent = saved.aiEnabled === false ? "分拣已关" : describeAi(status);
    toast("模型已保存");
  } catch (err) {
    toast("保存模型失败: " + explain(err));
  }
}

function extractEmail(raw) {
  if (!raw) return "";
  const text = String(raw).trim().toLowerCase();
  const angled = text.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : text).trim();
  return candidate.includes("@") ? candidate : "";
}

function formatFrom(raw) {
  const email = extractEmail(raw);
  const named = email ? senderMap.get(email) : "";
  if (named && email) return `${named} · ${email}`;
  return raw || "没有发件人";
}

function formatRecipients(value) {
  const list = Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (list.length === 0) return "";
  return list.map(formatRecipient).join(", ");
}

function formatRecipient(raw) {
  const email = extractEmail(raw);
  if (!email) return raw;
  const named = mailboxNames.get(email);
  if (named) return `${named} · ${email}`;
  const domain = email.split("@")[1];
  if (domain && domainNames[domain]) return `${email}（${domainNames[domain]}）`;
  return raw;
}

function normalizeAddress(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(text)) return "";
  return text;
}

function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ==================== 通用网络与工具函数 ====================

async function request(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const send = async (force) => {
    const headers = new Headers();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      headers.set("x-csrf-token", await fetchCsrf(force));
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
    });
  };
  let response = await send(false);
  if (response.status === 403 && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    await response.text().catch(() => "");
    csrfToken = null;
    response = await send(true);
  }
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const error = new Error("request_failed");
    error.status = response.status;
    throw error;
  }
  return data || {};
}

async function fetchCsrf(force) {
  if (csrfToken && !force) return csrfToken;
  const response = await fetch("/v1/csrf", { credentials: "same-origin" });
  if (!response.ok) {
    const error = new Error("csrf");
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  csrfToken = data.token;
  return csrfToken;
}

async function pollLive() {
  if (document.hidden || appEl.hidden) return;
  void updateDlqBadge();
  void refreshUnread();
  if (currentView !== "inbox" && currentView !== "spam" && currentView !== "trash") return;
  if (currentMessages.length > 40) return;
  try {
    const params = new URLSearchParams();
    params.set("trashed", currentView === "trash" ? "true" : "false");
    params.set("limit", "40");
    syncListLabel();
    if ((currentView === "inbox" || currentView === "spam") && labelInput.value) params.set("label", labelInput.value);
    const q = currentView === "trash" ? (trashQueryInput ? trashQueryInput.value.trim() : "") : (queryInput ? queryInput.value.trim() : "");
    if (q) params.set("q", q);
    const page = await request("/v1/messages?" + params.toString());
    const items = Array.isArray(page.items) ? page.items : [];
    const same =
      items.length === currentMessages.length &&
      items.every((item, index) => item.id === currentMessages[index]?.id && item.label === currentMessages[index]?.label && item.read === currentMessages[index]?.read);
    if (same) return;
    if (currentView === "trash") await reloadTrash();
    else await reloadMessages();
  } catch {
    // The next tick tries again.
  }
}

function setMobilePane(pane) {
  if (appEl) appEl.dataset.pane = pane;
}

function isTypingTarget(target) {
  if (!target || target.nodeType !== 1) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function findByDataId(root, selector, id) {
  if (!root || !id) return null;
  for (const node of root.querySelectorAll(selector)) {
    if (node.dataset.id === id) return node;
  }
  return null;
}

function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

function askConfirm(message) {
  if (!confirmModal || !confirmOk || !confirmCancel || !confirmText) {
    return Promise.resolve(false);
  }
  confirmText.textContent = message;
  confirmModal.hidden = false;
  confirmOk.focus();
  return new Promise((resolve) => {
    const finish = (ok) => {
      confirmModal.hidden = true;
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
      else if (event.key === "Enter") finish(true);
    };
    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

function explain(err) {
  if (err && err.status === 401) return "用户名或口令不正确";
  if (err && err.status === 429) return "请求过于频繁，请稍后再试";
  if (err && err.status === 403) return "缺少有效 CSRF 令牌";
  return "操作失败，请重试";
}

function formatShortTime(val) {
  if (!val) return "";
  const d = new Date(val);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatFullTime(val) {
  if (!val) return "";
  return new Date(val).toLocaleString();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function markOpened(id) {
  const card = findByDataId(listEl, ".mail-item", id);
  if (card) card.classList.remove("unread");
  const known = currentMessages.find((item) => item.id === id);
  if (known) known.read = true;
  void request("/v1/messages/" + encodeURIComponent(id) + "/read", { method: "POST", body: {} })
    .then(() => refreshUnread())
    .catch(() => undefined);
}

async function savePassword() {
  const current = document.querySelector("#password-current");
  const next = document.querySelector("#password-next");
  const currentValue = current ? current.value : "";
  const nextValue = next ? next.value : "";
  if (nextValue.length < 8) {
    toast("新密码至少 8 位");
    return;
  }
  try {
    await request("/v1/settings/password", { method: "PUT", body: { current: currentValue, next: nextValue } });
    if (current) current.value = "";
    if (next) next.value = "";
    toast("密码已更新");
  } catch {
    toast("密码未更新");
  }
}

async function loadLogs() {
  const view = document.querySelector("#log-view");
  if (!view) return;
  try {
    const res = await request("/v1/logs");
    const lines = Array.isArray(res.lines) ? res.lines : [];
    view.textContent = lines.length ? lines.join("\n") : "还没有记录";
  } catch (err) {
    view.textContent = explain(err);
  }
}

function createAuthChip(label, status) {
  const value = String(status || "none").toLowerCase();
  const calm = value === "pass" || value === "none";
  const chip = document.createElement("span");
  chip.className = "auth-chip " + (calm ? "pass" : "fail");
  chip.textContent = `${label}: ${value}`;
  return chip;
}

function createMetaItem(label, val) {
  const item = document.createElement("div");
  item.className = "meta-item";
  const l = document.createElement("span");
  l.className = "meta-label";
  l.textContent = label + "：";
  const v = document.createElement("span");
  v.className = "meta-val";
  v.textContent = val;
  item.append(l, v);
  return item;
}

function formatRawHeaders(detail) {
  const lines = [];
  if (detail.messageId) lines.push(`Message-ID: ${detail.messageId}`);
  if (detail.from) lines.push(`From: ${detail.from}`);
  if (detail.envelopeFrom) lines.push(`Return-Path: <${detail.envelopeFrom}>`);
  if (detail.envelopeTo) lines.push(`Delivered-To: ${Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo}`);
  if (detail.subject) lines.push(`Subject: ${detail.subject}`);
  if (detail.receivedAt) lines.push(`Date: ${new Date(detail.receivedAt).toUTCString()}`);
  if (detail.smtpMeta) lines.push(`X-Flytrap-Smtp: ${JSON.stringify(detail.smtpMeta)}`);
  return lines.join("\n");
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
