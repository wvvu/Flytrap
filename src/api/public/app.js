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
  trash: "垃圾桶",
  dlq: "失败",
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
let settingsDomains = [];
let currentMailHtml = "";
let allowExternalImages = false;
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

// 导航按钮 (收件箱, 垃圾桶, 死信队列, 系统设置)
const navInboxBtn = document.querySelector("#nav-inbox");
const navTrashBtn = document.querySelector("#nav-trash");
const navDlqBtn = document.querySelector("#nav-dlq");
const navSettingsBtn = document.querySelector("#nav-settings");
const badgeDlq = document.querySelector("#badge-dlq");

// 第二列流头部
const streamInboxHeader = document.querySelector("#stream-inbox-header");
const streamTrashHeader = document.querySelector("#stream-trash-header");
const trashQueryInput = document.querySelector("#trash-q");
const trashRefreshBtn = document.querySelector("#btn-trash-refresh");
const emptyTrashBtn = document.querySelector("#btn-empty-trash");
const listEl = document.querySelector("#list");
const noticeEl = document.querySelector("#notice");
const queryInput = document.querySelector("#q");
const labelInput = document.querySelector("#label");
const filterSelect = document.querySelector("#filter-select");
const refreshBtn = document.querySelector("#btn-refresh");
const dlqRefreshBtn = document.querySelector("#btn-dlq-refresh");
const retryAllBtn = document.querySelector("#btn-retry-all");

// 第三列工作台各视图
const viewMail = document.querySelector("#view-mail");
const viewDlq = document.querySelector("#view-dlq");
const viewSettings = document.querySelector("#view-settings");
const failureListEl = document.querySelector("#failure-list");
const dlqNoticeEl = document.querySelector("#dlq-notice");

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
navTrashBtn?.addEventListener("click", () => switchNav("trash"));
navDlqBtn?.addEventListener("click", () => switchNav("dlq"));
navSettingsBtn?.addEventListener("click", () => switchNav("settings"));

refreshBtn?.addEventListener("click", () => void reloadMessages());
trashRefreshBtn?.addEventListener("click", () => void reloadTrash());
emptyTrashBtn?.addEventListener("click", () => void handleEmptyTrash());
dlqRefreshBtn?.addEventListener("click", () => void loadDlqJobs());
retryAllBtn?.addEventListener("click", () => void retryAllDead());

btnTrashMail?.addEventListener("click", () => void handleTrashMail());
btnRestoreMail?.addEventListener("click", () => void handleRestoreMail());
btnDeleteMail?.addEventListener("click", () => void handleDeleteMail());
backListBtn?.addEventListener("click", () => setMobilePane("list"));
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
  labelInput.value = filterSelect.value;
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
    if (detailModelVerdict) {
      const origName = LABEL_NAMES[res.originalLabel] || res.originalLabel || "未分类";
      const origConf = typeof res.originalConfidence === "number" ? " " + Math.round(res.originalConfidence * 100) + "%" : "";
      detailModelVerdict.textContent = `(模型先看成 ${origName}${origConf}，你改过)`;
    }
    const listItem = findByDataId(listEl, ".mail-item", selectedMailId);
    if (listItem) {
      const tag = listItem.querySelector(".verdict-tag");
      if (tag) {
        tag.dataset.label = newLabel;
        tag.textContent = (LABEL_NAMES[newLabel] || newLabel) + " (你改过)";
      }
    }
    noticeEl.textContent = "已改成 " + (LABEL_NAMES[newLabel] || newLabel);
    setTimeout(() => {
      if (noticeEl.textContent.startsWith("已改成")) noticeEl.textContent = "";
    }, 3000);
  } catch (err) {
    noticeEl.textContent = "改分类失败: " + explain(err);
  } finally {
    detailVerdictSelect.disabled = false;
  }
});

listEl.addEventListener("scroll", () => {
  if (currentView === "inbox" || currentView === "trash") maybeLoadMore();
});

// DLQ 状态胶囊点击
document.querySelector("#dlq-pills")?.addEventListener("click", (e) => {
  const target = e.target;
  if (!target || !target.matches("button[data-dlq-status]")) return;
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
  allowExternalImages = true;
  renderSandboxHtml(currentMailHtml);
  if (btnLoadImages) {
    btnLoadImages.textContent = "图片已显示";
    btnLoadImages.disabled = true;
  }
});

btnReclassify?.addEventListener("click", () => {
  if (selectedMailId) void reclassify(selectedMailId, btnReclassify);
});

// 键盘快捷键 (j: 下一封, k: 上一封, r: 刷新)
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (confirmModal && !confirmModal.hidden) return;
  if (isTypingTarget(e.target)) return;
  if (currentView === "inbox") {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") void reloadMessages();
  } else if (currentView === "trash") {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") void reloadTrash();
  }
});

// 启动初始化
void init();

async function init() {
  initTheme();
  try {
    await request("/v1/me");
    showApp();
    await switchNav("inbox");
    void updateDlqBadge();
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

async function switchNav(view) {
  currentView = view;
  document.title = VIEW_TITLES[view] || "收件箱";
  if (appEl) {
    if (view === "settings" || view === "dlq") appEl.dataset.layout = "page";
    else delete appEl.dataset.layout;
  }
  const navBtns = [navInboxBtn, navTrashBtn, navDlqBtn, navSettingsBtn];
  navBtns.forEach((b) => b?.classList.remove("active"));
  const viewPanels = [viewMail, viewDlq, viewSettings];
  viewPanels.forEach((p) => { if (p) p.hidden = true; });

  streamInboxHeader.hidden = true;
  if (streamTrashHeader) streamTrashHeader.hidden = true;
  noticeEl.textContent = "";
  listEl.replaceChildren();
  cursor = null;
  loadingMore = false;
  setMobilePane("list");

  if (view === "inbox") {
    navInboxBtn?.classList.add("active");
    streamInboxHeader.hidden = false;
    viewMail.hidden = false;
    await reloadMessages();
  } else if (view === "trash") {
    navTrashBtn?.classList.add("active");
    if (streamTrashHeader) streamTrashHeader.hidden = false;
    viewMail.hidden = false;
    await reloadTrash();
  } else if (view === "dlq") {
    navDlqBtn?.classList.add("active");
    if (viewDlq) viewDlq.hidden = false;
    await loadDlqJobs(currentDlqScope);
  } else if (view === "settings") {
    navSettingsBtn?.classList.add("active");
    if (viewSettings) viewSettings.hidden = false;
    await loadSettingsPage();
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
  if (currentView !== "inbox" && currentView !== "trash") return;
  if (!cursor || loadingMore) return;
  const remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
  if (remaining < 280) void loadMoreMessages();
}

async function loadMoreMessages() {
  if (!cursor || loadingMore) return;
  if (currentView !== "inbox" && currentView !== "trash") return;
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
  if (item.id === selectedMailId) card.classList.add("selected");

  const line1 = document.createElement("div");
  line1.className = "item-line1";

  const from = document.createElement("span");
  from.className = "item-from";
  from.textContent = item.from || item.envelopeFrom || "没有发件人";

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
  snippet.textContent = item.summary || "";

  const tag = document.createElement("span");
  tag.className = "verdict-tag";
  tag.dataset.label = item.label || "none";
  const confText = item.manualOverride
    ? " (你改过)"
    : (typeof item.confidence === "number" ? ` ${Math.round(item.confidence * 100)}%` : "");
  tag.textContent = (LABEL_NAMES[item.label] || item.label || "未分类") + confText;

  line3.append(snippet, tag);

  card.append(line1, subject, line3);
  card.addEventListener("click", () => void selectMail(item.id));
  return card;
}

async function selectMail(id, options = {}) {
  const token = ++mailLoadToken;
  selectedMailId = id;
  allowExternalImages = false;
  btnLoadImages.textContent = "显示图片";
  btnLoadImages.disabled = false;
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
    if (detailFrom) detailFrom.textContent = detail.from || detail.envelopeFrom || "没有发件人";
    if (detailTo) detailTo.textContent = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo || "";
    if (detailTime) detailTime.textContent = formatFullTime(detail.receivedAt);

    const isTrashed = Boolean(detail.trashedAt || currentView === "trash");
    if (btnTrashMail) btnTrashMail.hidden = isTrashed;
    if (btnRestoreMail) btnRestoreMail.hidden = !isTrashed;
    if (btnDeleteMail) btnDeleteMail.hidden = !isTrashed;
    if (btnReclassify) btnReclassify.hidden = isTrashed;

    const label = detail.aiResult?.label || detail.label || "gray";
    if (detailVerdictSelect) {
      detailVerdictSelect.value = label;
      detailVerdictSelect.dataset.label = label;
    }
    const confidence = typeof detail.aiResult?.confidence === "number" ? detail.aiResult.confidence : 0;
    if (detailModelVerdict) {
      if (detail.aiResult?.manualOverride) {
        const origName = LABEL_NAMES[detail.aiResult.originalLabel] || detail.aiResult.originalLabel || "未分类";
        const origConf = typeof detail.aiResult.originalConfidence === "number" ? ` ${Math.round(detail.aiResult.originalConfidence * 100)}%` : "";
        detailModelVerdict.textContent = `(模型先看成 ${origName}${origConf}，你改过)`;
      } else {
        detailModelVerdict.textContent = `(模型 ${Math.round(confidence * 100)}%)`;
      }
    }

    if (verdictBar) verdictBar.style.width = Math.round(confidence * 100) + "%";
    if (verdictPercent) verdictPercent.textContent = Math.round(confidence * 100) + "%";
    if (detailSummary) detailSummary.textContent = detail.aiResult?.summary || "这封还没分拣";
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
    plainTextBody.textContent = detail.parsed?.text || "(正文为空)";
    rawHeaders.textContent = formatRawHeaders(detail);
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailDetailEl.hidden = false;

    // 加载 HTML 与真正的 RFC822 信头
    void loadMailHtml(id, token);
    void loadRawHeaders(id, token, detail);
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
    currentMailHtml = "<p style='color:#888;padding:20px'>这封没有 HTML 正文</p>";
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

function renderSandboxHtml(html) {
  const csp = allowExternalImages
    ? "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src * data: cid:; font-src data:;\">"
    : "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; font-src data:;\">";
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<style>body{font-family:sans-serif;font-size:14px;line-height:1.6;color:#111;padding:16px;word-break:break-word;}img{max-width:100%;height:auto;}</style></head><body>${html}</body></html>`;
  mailSandbox.setAttribute("srcdoc", doc);
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
    noticeEl.textContent = "邮件已恢复至收件箱";
    setTimeout(() => { if (noticeEl.textContent === "邮件已恢复至收件箱") noticeEl.textContent = ""; }, 3000);
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
  if (failureListEl) failureListEl.replaceChildren();
  if (dlqNoticeEl) dlqNoticeEl.textContent = "正在读取";
  try {
    const url = jobsUrl(currentDlqScope);
    const res = await request(url);
    currentJobs = Array.isArray(res.items) ? res.items : [];
    if (dlqNoticeEl) dlqNoticeEl.textContent = currentJobs.length === 0 ? "没有要处理的任务" : "";
    renderFailureGroups(currentJobs);
  } catch (err) {
    if (dlqNoticeEl) dlqNoticeEl.textContent = explain(err);
  }
}

function jobsUrl(scope) {
  if (scope === "dead") return "/v1/jobs?status=dead";
  if (scope === "retrying") return "/v1/jobs?scope=retrying";
  return "/v1/jobs?scope=open";
}

function renderFailureGroups(jobs) {
  if (!failureListEl) return;
  failureListEl.replaceChildren();
  const groups = new Map();
  for (const job of jobs) {
    const key = job.messageId || job.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => stepRank(a.type) - stepRank(b.type));
    failureListEl.append(createFailureLetter(group));
  }
}

function stepRank(type) {
  const index = STEP_ORDER.indexOf(type);
  return index === -1 ? STEP_ORDER.length : index;
}

function createFailureLetter(jobs) {
  const first = jobs[0] || {};
  const article = document.createElement("article");
  article.className = "letter";

  const subject = document.createElement("p");
  subject.className = "letter-subject";
  subject.textContent = first.messageSubject || "（无主题）";

  const who = document.createElement("p");
  who.className = "muted";
  const from = first.messageFrom || "";
  const to = first.messageTo || "";
  who.textContent = from || to ? [from || "发件人还没解析出来", to].filter(Boolean).join(" → ") : "这封信的地址还没解析出来";

  article.append(subject, who);
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

  const stopped = job.status === "dead" || job.status === "failed";
  const button = document.createElement("button");
  button.type = "button";
  button.className = stopped ? "btn-fit" : "btn-fit ghost";
  button.textContent = stopped ? "再试一次" : "等它自己试";
  button.disabled = !stopped;
  if (stopped) button.addEventListener("click", () => void retrySingleJob(job.id));

  row.append(copy, button);
  return row;
}

function stepState(job) {
  if (job.status === "dead" || job.status === "failed") {
    return `已放弃 · 试了 ${job.attempts}/${job.maxAttempts} 次`;
  }
  if (job.status === "queued" && job.runAfter) {
    return `还会再试 · 下次 ${formatFullTime(job.runAfter)}`;
  }
  return "还会再试";
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

async function retryAllDead() {
  if (!(await askConfirm("把已经停掉的任务全部再跑一遍？"))) return;
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
    const res = await request("/v1/jobs/count?status=dead");
    const count = typeof res.count === "number" ? res.count : 0;
    if (count > 0) {
      badgeDlq.hidden = false;
      badgeDlq.textContent = String(count);
    } else {
      badgeDlq.hidden = true;
    }
  } catch {
    // ignore
  }
}

// ==================== 设置 ====================

async function loadSettingsPage() {
  try {
    const settings = await request("/v1/settings");
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
  } catch (err) {
    toast(explain(err));
  }
}

function describeAi(ai) {
  if (!ai || ai.classifier === "fake" || !ai.model) return "还没接模型。提示词先存着，接上之后新来的信按这份分。";
  const keys = Number(ai.keyCount) === 1 ? "1 个 Key 可用" : `${ai.keyCount || 0} 个 Key 可用`;
  return `${ai.model} · ${keys}`;
}

function describeChannels(channels) {
  const telegram = channels && channels.telegram ? "Telegram 已接上" : "Telegram 没接";
  const webhook = channels && channels.webhook ? "Webhook 已接上" : "Webhook 没接";
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
    text.textContent = LABEL_NAMES[label] || label;
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
    button.textContent = "去掉";
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
    toast("把握要在 0 到 1 之间");
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
    toast("域名已加上");
  } catch (err) {
    toast("加上域名失败: " + explain(err));
  }
}

async function removeDomain(domain) {
  if (settingsDomains.length <= 1) {
    toast("至少留一个域名");
    return;
  }
  if (!(await askConfirm(`不再收下 ${domain}？`))) return;
  try {
    const res = await request("/v1/settings/domains", {
      method: "PUT",
      body: { domains: settingsDomains.filter((item) => item !== domain) },
    });
    renderDomains(res.acceptDomains || []);
    toast("已去掉 " + domain);
  } catch (err) {
    toast("去掉域名失败: " + explain(err));
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
    toast("之后新来的任务，试满这次数就停");
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
    for (const item of items) {
      const tr = document.createElement("tr");
      const tdAddr = document.createElement("td");
      tdAddr.textContent = `${item.localpart}@${item.domain}`;
      const tdNotes = document.createElement("td");
      tdNotes.textContent = item.notes || "没写备注";
      tr.append(tdAddr, tdNotes);
      tbody.append(tr);
    }
  } catch (err) {
    toast("地址备注没读出来: " + explain(err));
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
    const labelName = (key) => LABEL_NAMES[key] || key;
    const parts = Object.entries(day.labels || {})
      .filter(([, n]) => n > 0)
      .map(([key, n]) => `${labelName(key)} ${n}`);
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
    toast("提示词已保存，下次分类会用这份");
  } catch (err) {
    toast("保存提示词失败: " + explain(err));
  }
}

async function saveMailbox() {
  try {
    await request("/v1/mailbox-history", {
      method: "POST",
      body: {
        domain: document.querySelector("#mb-domain").value,
        localpart: document.querySelector("#mb-localpart").value,
        notes: document.querySelector("#mb-notes").value,
      },
    });
    toast("备注已保存");
    await loadMailboxesView();
  } catch (err) {
    toast("保存备注失败: " + explain(err));
  }
}

// ==================== 通用网络与工具函数 ====================

async function request(url, options = {}) {
  const send = async (force) => {
    const headers = new Headers();
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      headers.set("x-csrf-token", await fetchCsrf(force));
    }
    return fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
    });
  };
  let response = await send(false);
  if (response.status === 403 && options.body !== undefined) {
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
  if (currentView !== "inbox" && currentView !== "trash") return;
  if (currentMessages.length > 40) return;
  try {
    const params = new URLSearchParams();
    params.set("trashed", currentView === "trash" ? "true" : "false");
    params.set("limit", "40");
    if (currentView === "inbox" && labelInput.value) params.set("label", labelInput.value);
    const q = currentView === "trash" ? (trashQueryInput ? trashQueryInput.value.trim() : "") : (queryInput ? queryInput.value.trim() : "");
    if (q) params.set("q", q);
    const page = await request("/v1/messages?" + params.toString());
    const items = Array.isArray(page.items) ? page.items : [];
    const same =
      items.length === currentMessages.length &&
      items.every((item, index) => item.id === currentMessages[index]?.id && item.label === currentMessages[index]?.label);
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

function createAuthChip(label, status) {
  const chip = document.createElement("span");
  chip.className = "auth-chip " + (status === "pass" ? "pass" : "fail");
  chip.textContent = `${label}: ${status || "none"}`;
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
