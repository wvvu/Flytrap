// 应用主壳层：主题、登录画像装配、范围与地址过滤条、八大栏目路由切换。
import { setRevealApp, setSwitchNav } from "./nav.js";
import { state } from "./state.js";
import {
  adminScopeSwitch,
  appEl,
  btnEmptyCompose,
  dlqNoticeEl,
  filtersForm,
  listEl,
  mailDetailEl,
  mailEmptyCopy,
  mailEmptyEl,
  mailEmptyTitle,
  mailLoadingEl,
  navDlqBtn,
  navInboxBtn,
  navSendBtn,
  navSettingsBtn,
  navSpamBtn,
  navStarredBtn,
  navTrashBtn,
  navUsersBtn,
  noticeEl,
  promoBtn,
  recipientFilterSelect,
  streamDlqHeader,
  streamInboxHeader,
  streamSendHeader,
  streamSettingsHeader,
  streamSpamHeader,
  streamStarredHeader,
  streamTrashHeader,
  streamUsersHeader,
  themeIcon,
  viewDlq,
  viewMail,
  viewSettings,
  viewUsers,
} from "./dom.js";
import { request } from "./net.js";
import {
  applyRoleVisibility,
  refreshUnread,
  setGlyph,
  setMobilePane,
  setViewTitle,
  showApp,
  updateScopeBarVisibility,
} from "./ui.js";
import {
  clearSelection,
  refreshShownNames,
  reloadMessages,
  reloadTrash,
  renderSandboxHtml,
  selectMail,
  syncListLabel,
} from "./mail-view.js";
import { loadDlqJobs, updateDlqBadge } from "./dlq-view.js";
import {
  loadAppearance,
  loadSettingsPage,
  renderSettingsNav,
  showSettingsSection,
} from "./settings-view.js";
import { loadSendPage, syncComposeIdentities } from "./send-view.js";
import { loadUsersView } from "./users-view.js";
import { hashMailId } from "./util.js";

export function initTheme() {
  const legacy = localStorage.getItem("flytrap_theme");
  const saved = localStorage.getItem("mail_theme") || legacy || "dark";
  if (legacy) {
    localStorage.setItem("mail_theme", saved);
    localStorage.removeItem("flytrap_theme");
  }
  document.documentElement.setAttribute("data-theme", saved);
  setGlyph(themeIcon, saved === "dark" ? "sun" : "moon");
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("mail_theme", next);
  setGlyph(themeIcon, next === "dark" ? "sun" : "moon");
  if (state.currentMailHtml || state.currentMailPlain) {
    renderSandboxHtml(state.currentMailHtml);
  }
}

export async function loadProfile() {
  const profile = await request("/v1/profile");
  state.userId = profile.id || "";
  state.username = profile.username || "";
  state.displayName = profile.displayName || "";
  state.role = profile.role === "admin" ? "admin" : "member";
  state.catchAll = Boolean(profile.catchAll);
  state.signature = typeof profile.signature === "string" ? profile.signature : "";
  state.userMailboxes = Array.isArray(profile.mailboxes) ? profile.mailboxes : [];
  state.settingsDomains = Array.isArray(profile.acceptDomains) ? profile.acceptDomains : state.settingsDomains;
  state.appVersion = profile.version || "";

  if (state.role !== "admin") {
    state.mailScope = "mine";
  }
  populateRecipientFilter();
  applyRoleVisibility();
  syncComposeIdentities();
  paintScopeButtons();
}

export function populateRecipientFilter() {
  if (!recipientFilterSelect) return;
  const previous = state.recipientFilter;
  recipientFilterSelect.replaceChildren();
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "全部收件地址";
  recipientFilterSelect.append(allOpt);

  const seen = new Set();
  for (const mb of state.userMailboxes) {
    if (!mb || mb.localpart === "*") continue;
    const addr = `${mb.localpart}@${mb.domain}`.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    const opt = document.createElement("option");
    opt.value = addr;
    opt.textContent = mb.displayName ? `${mb.displayName} (${addr})` : addr;
    recipientFilterSelect.append(opt);
  }
  for (const addr of state.mailboxNames.keys()) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    const opt = document.createElement("option");
    opt.value = addr;
    const named = state.mailboxNames.get(addr);
    opt.textContent = named ? `${named} (${addr})` : addr;
    recipientFilterSelect.append(opt);
  }

  if (previous && seen.has(previous)) {
    recipientFilterSelect.value = previous;
  } else {
    state.recipientFilter = "";
    recipientFilterSelect.value = "";
  }
  updateScopeBarVisibility();
}

export function paintScopeButtons() {
  if (!adminScopeSwitch) return;
  for (const btn of adminScopeSwitch.querySelectorAll(".scope-seg-btn")) {
    btn.classList.toggle("active", btn.getAttribute("data-scope") === state.mailScope);
  }
}

export function setMailScope(scope) {
  if (state.role !== "admin") return;
  if (scope !== "mine" && scope !== "all") return;
  if (state.mailScope === scope) return;
  state.mailScope = scope;
  paintScopeButtons();
  void refreshUnread();
  if (state.currentView === "send") void loadSendPage();
  else if (state.currentView === "trash") void reloadTrash();
  else void reloadMessages();
}

export function placeMailSearch(view) {
  if (!filtersForm) return;
  if (view === "spam" && streamSpamHeader) streamSpamHeader.append(filtersForm);
  else if (view === "starred" && streamStarredHeader) streamStarredHeader.append(filtersForm);
  else if (streamInboxHeader) streamInboxHeader.append(filtersForm);
}

export function setEmptyCopy(view) {
  if (btnEmptyCompose) btnEmptyCompose.hidden = view !== "send";
  if (mailEmptyTitle) {
    mailEmptyTitle.textContent = view === "send" ? "选择或撰写邮件" : "选一封信";
  }
  if (!mailEmptyCopy) return;
  if (view === "spam") mailEmptyCopy.textContent = "这里是已拦截分类邮件。下拉选「全部」可查看全部分类。";
  else if (view === "starred") mailEmptyCopy.textContent = "这里是已加星标的重点邮件。按 S 可快速标星或取消。";
  else if (view === "send") mailEmptyCopy.textContent = "左侧展示已发出的邮件与送达状态，按 C 可随时打开写信窗口。";
  else if (view === "trash") mailEmptyCopy.textContent = "这里是垃圾桶。";
  else if (view === "inbox" && state.inboxPromoOnly) mailEmptyCopy.textContent = "这里是推广与订阅来信。";
  else mailEmptyCopy.textContent = "这里是收件箱，包含正常来信与尚未分拣的新信。其余在已拦截。";
}

export function paintPromoBtn() {
  if (!promoBtn) return;
  promoBtn.classList.toggle("active", state.inboxPromoOnly);
  promoBtn.setAttribute("aria-pressed", state.inboxPromoOnly ? "true" : "false");
}

export function setPromoMode(on) {
  if (state.currentView !== "inbox" || state.inboxPromoOnly === on) return;
  state.inboxPromoOnly = on;
  paintPromoBtn();
  setViewTitle("inbox");
  setEmptyCopy("inbox");
  void reloadMessages();
}

export async function switchNav(view) {
  if ((view === "users" || view === "dlq") && state.role !== "admin") {
    view = "inbox";
  }

  if (state.inboxPromoOnly) {
    state.inboxPromoOnly = false;
    paintPromoBtn();
  }
  clearSelection();
  state.currentView = view;
  setViewTitle(view);
  if (appEl) delete appEl.dataset.layout;

  const navBtns = [
    navInboxBtn,
    navStarredBtn,
    navSendBtn,
    navSpamBtn,
    navTrashBtn,
    navUsersBtn,
    navSettingsBtn,
    navDlqBtn,
  ];
  navBtns.forEach((b) => b?.classList.remove("active"));

  const viewPanels = [viewMail, viewDlq, viewUsers, viewSettings];
  viewPanels.forEach((p) => {
    if (p) p.hidden = true;
  });

  if (streamInboxHeader) streamInboxHeader.hidden = true;
  if (streamStarredHeader) streamStarredHeader.hidden = true;
  if (streamSendHeader) streamSendHeader.hidden = true;
  if (streamSpamHeader) streamSpamHeader.hidden = true;
  if (streamTrashHeader) streamTrashHeader.hidden = true;
  if (streamDlqHeader) streamDlqHeader.hidden = true;
  if (streamUsersHeader) streamUsersHeader.hidden = true;
  if (streamSettingsHeader) streamSettingsHeader.hidden = true;

  if (dlqNoticeEl) dlqNoticeEl.hidden = view !== "dlq";
  noticeEl.hidden = view === "dlq";
  noticeEl.textContent = "";
  listEl.replaceChildren();
  state.cursor = null;
  state.loadingMore = false;

  if (
    view === "inbox" ||
    view === "starred" ||
    view === "spam" ||
    view === "trash" ||
    view === "send"
  ) {
    state.selectedMailId = null;
    state.readingSentId = null;
    state.openDetail = null;
    if (mailDetailEl) mailDetailEl.hidden = true;
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    if (mailEmptyEl) mailEmptyEl.hidden = false;
  }

  setMobilePane("list");
  placeMailSearch(view);
  setEmptyCopy(view);
  updateScopeBarVisibility();

  if (view === "inbox") {
    navInboxBtn?.classList.add("active");
    if (streamInboxHeader) streamInboxHeader.hidden = false;
    if (viewMail) viewMail.hidden = false;
    syncListLabel();
    return reloadMessages();
  } else if (view === "starred") {
    navStarredBtn?.classList.add("active");
    if (streamStarredHeader) streamStarredHeader.hidden = false;
    if (viewMail) viewMail.hidden = false;
    syncListLabel();
    await reloadMessages();
  } else if (view === "send") {
    navSendBtn?.classList.add("active");
    if (streamSendHeader) streamSendHeader.hidden = false;
    if (viewMail) viewMail.hidden = false;
    await loadSendPage();
  } else if (view === "spam") {
    navSpamBtn?.classList.add("active");
    if (streamSpamHeader) streamSpamHeader.hidden = false;
    if (viewMail) viewMail.hidden = false;
    syncListLabel();
    await reloadMessages();
  } else if (view === "trash") {
    navTrashBtn?.classList.add("active");
    if (streamTrashHeader) streamTrashHeader.hidden = false;
    if (viewMail) viewMail.hidden = false;
    await reloadTrash();
  } else if (view === "users") {
    navUsersBtn?.classList.add("active");
    if (streamUsersHeader) streamUsersHeader.hidden = false;
    if (viewUsers) viewUsers.hidden = false;
    await loadUsersView();
  } else if (view === "dlq") {
    navDlqBtn?.classList.add("active");
    if (streamDlqHeader) streamDlqHeader.hidden = false;
    if (viewDlq) viewDlq.hidden = false;
    await loadDlqJobs(state.currentDlqScope);
  } else if (view === "settings") {
    navSettingsBtn?.classList.add("active");
    if (streamSettingsHeader) streamSettingsHeader.hidden = false;
    if (viewSettings) viewSettings.hidden = false;
    renderSettingsNav();
    showSettingsSection(state.currentSettingsSection, { keepListOnNarrow: true });
    await loadSettingsPage();
  }
}

export async function revealApp() {
  const deepId = hashMailId();
  state.skipFirstOpen = Boolean(deepId);

  await loadProfile();
  const appearance = loadAppearance();

  showApp();
  if (appEl) appEl.classList.add("is-booting");
  let listed;
  try {
    listed = await switchNav("inbox");
  } finally {
    state.skipFirstOpen = false;
  }
  if (listed === false) return;
  if (deepId) void selectMail(deepId);
  if (appEl) appEl.classList.remove("is-booting");

  void appearance.then(() => {
    populateRecipientFilter();
    refreshShownNames();
  });
  if (state.role === "admin") void updateDlqBadge();
  void refreshUnread();
}

setSwitchNav(switchNav);
setRevealApp(revealApp);
