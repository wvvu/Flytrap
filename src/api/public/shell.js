// 应用主壳：会话角色引导、深浅色主题、栏目切换、域名与视角过滤联动。
import { setRevealApp, setSwitchNav } from "./nav.js";
import { state } from "./state.js";
import {
  accountHubBtn,
  adminScopeSelect,
  appEl,
  btnEmptyCompose,
  dlqNoticeEl,
  domainFilterSelect,
  filtersForm,
  listEl,
  mailDetailEl,
  mailEmptyCopy,
  mailEmptyEl,
  mailLoadingEl,
  navInboxBtn,
  navSendBtn,
  navSettingsBtn,
  navSpamBtn,
  navTrashBtn,
  navUsersBtn,
  noticeEl,
  promoBtn,
  starredFilterBtn,
  streamDlqHeader,
  streamInboxHeader,
  streamSendHeader,
  streamSettingsHeader,
  streamSpamHeader,
  streamSubfilters,
  streamTrashHeader,
  themeIcon,
  viewDlq,
  viewMail,
  viewSettings,
} from "./dom.js";
import { request } from "./net.js";
import { applyRoleUI, refreshUnread, setGlyph, setMobilePane, setViewTitle, showApp } from "./ui.js";
import { refreshShownNames, reloadMessages, reloadTrash, renderSandboxHtml, selectMail, syncListLabel } from "./mail-view.js";
import { loadDlqJobs, updateDlqBadge } from "./dlq-view.js";
import { loadAppearance, loadSettingsPage, renderSettingsNav, showSettingsSection } from "./settings-view.js";
import { syncAdminScopeOptions } from "./users-view.js";
import { loadSendPage } from "./send-view.js";
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
  if (state.currentMailHtml || state.selectedMailId) {
    renderSandboxHtml(state.currentMailHtml);
  }
}

export function syncSubfiltersBar(view) {
  if (!streamSubfilters) return;
  const inMailRoom = view === "inbox" || view === "spam" || view === "send" || view === "trash";
  if (!inMailRoom) {
    streamSubfilters.hidden = true;
    return;
  }

  const targetHeader =
    view === "spam"
      ? streamSpamHeader
      : view === "send"
        ? streamSendHeader
        : view === "trash"
          ? streamTrashHeader
          : streamInboxHeader;
  if (targetHeader) {
    const searchForm = targetHeader.querySelector("form.search-box");
    if (searchForm) {
      if (streamSubfilters.parentElement !== targetHeader || streamSubfilters.nextElementSibling !== searchForm) {
        targetHeader.insertBefore(streamSubfilters, searchForm);
      }
    } else if (streamSubfilters.parentElement !== targetHeader) {
      targetHeader.append(streamSubfilters);
    }
  }

  const showScope = state.isAdmin && state.hasMembers;
  if (adminScopeSelect) adminScopeSelect.hidden = !showScope;

  const domains = state.settingsDomains || [];
  const showDomain = domains.length > 1;
  if (domainFilterSelect) {
    domainFilterSelect.hidden = !showDomain;
    if (showDomain) {
      const current = state.domainFilter || "";
      domainFilterSelect.replaceChildren();
      const allOpt = document.createElement("option");
      allOpt.value = "";
      allOpt.textContent = "全部域名";
      domainFilterSelect.append(allOpt);
      for (const d of domains) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = state.domainNames[d] ? `${d} (${state.domainNames[d]})` : d;
        domainFilterSelect.append(opt);
      }
      domainFilterSelect.value = domains.includes(current) ? current : "";
    }
  }

  streamSubfilters.hidden = !showScope && !showDomain;
}

export function placeMailSearch(view) {
  if (!filtersForm) return;
  if (view === "spam" && streamSpamHeader) {
    const filterBar = streamSpamHeader.querySelector(".stream-filter-bar");
    if (filterBar) streamSpamHeader.insertBefore(filtersForm, filterBar);
    else streamSpamHeader.append(filtersForm);
  } else if (streamInboxHeader) {
    streamInboxHeader.append(filtersForm);
  }
}

export function setEmptyCopy(view) {
  if (btnEmptyCompose) btnEmptyCompose.hidden = view !== "send";
  if (!mailEmptyCopy) return;
  if (view === "send") mailEmptyCopy.textContent = "选择一封已发信，或写新邮件。";
  else if (view === "spam") mailEmptyCopy.textContent = "这里是已拦截。选全部才会看到正常来信。";
  else if (view === "trash") mailEmptyCopy.textContent = "这里是垃圾桶。";
  else if (view === "inbox" && state.starredOnly) mailEmptyCopy.textContent = "这里是星标，当前没有星标信。";
  else if (view === "inbox" && state.inboxPromoOnly) mailEmptyCopy.textContent = "这里是推广，当前没有推广信。";
  else mailEmptyCopy.textContent = "这里是收件箱，包含尚未分类的来信。其余在已拦截。";
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

export function paintStarredBtn() {
  if (!starredFilterBtn) return;
  starredFilterBtn.classList.toggle("active", state.starredOnly);
  starredFilterBtn.setAttribute("aria-pressed", state.starredOnly ? "true" : "false");
}

export function setStarredMode(on) {
  if (state.currentView !== "inbox" || state.starredOnly === on) return;
  state.starredOnly = on;
  paintStarredBtn();
  state.selectedMailId = null;
  state.readingSentId = null;
  state.openDetail = null;
  if (mailDetailEl) mailDetailEl.hidden = true;
  if (mailLoadingEl) mailLoadingEl.hidden = true;
  if (mailEmptyEl) mailEmptyEl.hidden = false;
  setViewTitle("inbox");
  setEmptyCopy("inbox");
  void reloadMessages();
}

export async function switchNav(view) {
  if (view === "users") {
    if (!state.isAdmin) view = "inbox";
    else {
      state.currentSettingsSection = "users";
      view = "settings";
    }
  }
  if (view === "dlq" && !state.isAdmin) view = "inbox";
  if (state.inboxPromoOnly) {
    state.inboxPromoOnly = false;
    paintPromoBtn();
  }
  if (state.starredOnly) {
    state.starredOnly = false;
    paintStarredBtn();
  }
  state.currentView = view;
  setViewTitle(view);
  if (appEl) delete appEl.dataset.layout;

  const navBtns = [navInboxBtn, navSendBtn, navSpamBtn, navTrashBtn, navUsersBtn, navSettingsBtn, accountHubBtn];
  navBtns.forEach((b) => b?.classList.remove("active"));
  const viewPanels = [viewMail, viewDlq, viewSettings];
  viewPanels.forEach((p) => {
    if (p) p.hidden = true;
  });

  streamInboxHeader.hidden = true;
  if (streamSendHeader) streamSendHeader.hidden = true;
  if (streamSpamHeader) streamSpamHeader.hidden = true;
  if (streamTrashHeader) streamTrashHeader.hidden = true;
  if (streamDlqHeader) streamDlqHeader.hidden = true;
  if (streamSettingsHeader) streamSettingsHeader.hidden = true;
  if (dlqNoticeEl) dlqNoticeEl.hidden = view !== "dlq";
  noticeEl.hidden = view === "dlq";
  noticeEl.textContent = "";
  listEl.replaceChildren();
  state.cursor = null;
  state.loadingMore = false;

  if (view === "inbox" || view === "spam" || view === "trash") {
    state.selectedMailId = null;
    state.readingSentId = null;
    state.openDetail = null;
    if (mailDetailEl) mailDetailEl.hidden = true;
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    if (mailEmptyEl) mailEmptyEl.hidden = false;
  }

  setMobilePane("list");
  placeMailSearch(view);
  syncSubfiltersBar(view);
  setEmptyCopy(view);

  if (view === "inbox") {
    navInboxBtn?.classList.add("active");
    streamInboxHeader.hidden = false;
    viewMail.hidden = false;
    syncListLabel();
    return reloadMessages();
  } else if (view === "send") {
    navSendBtn?.classList.add("active");
    if (streamSendHeader) streamSendHeader.hidden = false;
    viewMail.hidden = false;
    state.readingSentId = null;
    state.openDetail = null;
    if (mailDetailEl) mailDetailEl.hidden = true;
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    if (mailEmptyEl) mailEmptyEl.hidden = false;
    await loadSendPage();
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
    accountHubBtn?.classList.add("active");
    if (streamDlqHeader) streamDlqHeader.hidden = false;
    if (viewDlq) viewDlq.hidden = false;
    await loadDlqJobs(state.currentDlqScope);
  } else if (view === "settings") {
    const onUsers = state.isAdmin && state.currentSettingsSection === "users";
    (onUsers ? navUsersBtn : navSettingsBtn)?.classList.add("active");
    if (streamSettingsHeader) streamSettingsHeader.hidden = false;
    if (viewSettings) viewSettings.hidden = false;
    renderSettingsNav();
    showSettingsSection(state.currentSettingsSection, { keepListOnNarrow: !onUsers });
    await loadSettingsPage();
  }
}

export async function loadSessionContext() {
  const sess = await request("/v1/session");
  state.sessionUser = sess.user || "";
  state.sessionUserId = sess.userId || "owner";
  state.sessionRole = sess.role === "member" ? "member" : "admin";
  state.isAdmin = state.sessionRole === "admin";
  state.displayName = sess.displayName || "";
  state.recoveryEmail = sess.recoveryEmail || "";
  state.quotaSendPerDay = sess.quotaSendPerDay;
  state.sentToday = Number(sess.sentToday) || 0;
  state.allocatedMailboxes = Array.isArray(sess.mailboxes) ? sess.mailboxes : [];
  state.settingsDomains = Array.isArray(sess.acceptDomains) ? sess.acceptDomains : [];
  state.dkimDomains = Array.isArray(sess.dkimDomains) ? sess.dkimDomains : [];
  state.hasMembers = Boolean(sess.hasMembers);
  state.appVersion = sess.version || "";
  if (
    !state.isAdmin &&
    (state.currentSettingsSection === "domains" ||
      state.currentSettingsSection === "users" ||
      state.currentSettingsSection === "classify" ||
      state.currentSettingsSection === "status")
  ) {
    state.currentSettingsSection = "my-mailboxes";
  }
  applyRoleUI();

  if (state.isAdmin && state.hasMembers) {
    request("/v1/users")
      .then((res) => {
        state.usersList = Array.isArray(res.items) ? res.items : [];
        syncAdminScopeOptions();
        syncSubfiltersBar(state.currentView);
      })
      .catch(() => {});
  } else {
    state.usersList = [];
    syncAdminScopeOptions();
  }
}

export async function revealApp() {
  await loadSessionContext();
  const deepId = hashMailId();
  state.skipFirstOpen = Boolean(deepId);
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
    syncSubfiltersBar(state.currentView);
    refreshShownNames();
  });
  if (state.isAdmin) void updateDlqBadge();
  void refreshUnread();
}

setSwitchNav(switchNav);
setRevealApp(revealApp);
