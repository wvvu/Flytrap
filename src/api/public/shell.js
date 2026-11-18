// 工作台外壳编排：会话加载、角色导航裁剪、深浅主题、栏目切换与首屏引导。
import { setRevealApp, setSwitchNav } from "./nav.js";
import { state } from "./state.js";
import {
  appEl,
  dlqNoticeEl,
  domainFilterSelect,
  filtersForm,
  listEl,
  mailDetailEl,
  mailEmptyCopy,
  mailEmptyEl,
  mailLoadingEl,
  navDlqBtn,
  navInboxBtn,
  navSendBtn,
  navSettingsBtn,
  navSpamBtn,
  navTrashBtn,
  navUsersBtn,
  noticeEl,
  promoBtn,
  streamDlqHeader,
  streamInboxHeader,
  streamSendHeader,
  streamSettingsHeader,
  streamSpamHeader,
  streamTrashHeader,
  themeIcon,
  viewDlq,
  viewMail,
  viewSend,
  viewSettings,
} from "./dom.js";
import { request } from "./net.js";
import {
  refreshUnread,
  renderAccountIdentity,
  renderDomainFilterOptions,
  setGlyph,
  setMobilePane,
  setViewTitle,
  showApp,
} from "./ui.js";
import { refreshShownNames, reloadMessages, reloadTrash, renderSandboxHtml, selectMail, syncListLabel } from "./mail-view.js";
import { loadDlqJobs, updateDlqBadge } from "./dlq-view.js";
import { loadAppearance, loadSettingsPage, renderSettingsNav, showSettingsSection } from "./settings-view.js";
import { clearReplyDraft, loadSendPage } from "./send-view.js";
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

export function placeMailSearch(view) {
  if (!filtersForm) return;
  if (view === "spam" && streamSpamHeader) streamSpamHeader.append(filtersForm);
  else if (streamInboxHeader) streamInboxHeader.append(filtersForm);
}

export function setEmptyCopy(view) {
  if (!mailEmptyCopy) return;
  if (view === "spam") mailEmptyCopy.textContent = "已拦截邮件区。切换上方筛选可按分类单独查看。";
  else if (view === "trash") mailEmptyCopy.textContent = "垃圾桶区域。此处邮件可恢复或彻底移除。";
  else if (view === "inbox" && state.inboxPromoOnly) mailEmptyCopy.textContent = "当前没有推广类来信。";
  else mailEmptyCopy.textContent = "收件箱展示正常与待分拣来信，其余分类位于已拦截。";
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

export function applySessionRoleChrome() {
  const isAdmin = Boolean(state.session.isAdmin);
  if (navUsersBtn) navUsersBtn.hidden = !isAdmin;
  if (navDlqBtn) navDlqBtn.hidden = !isAdmin;
  if (!isAdmin) {
    const badge = document.querySelector("#badge-dlq");
    if (badge) badge.hidden = true;
  }
  renderAccountIdentity();
  renderDomainFilterOptions();
}

export async function switchNav(view) {
  if ((view === "dlq" || view === "users") && !state.session.isAdmin) {
    view = "inbox";
  }
  const keepReply = state.replyArmed;
  state.replyArmed = false;

  if (state.inboxPromoOnly) {
    state.inboxPromoOnly = false;
    paintPromoBtn();
  }
  if (view === "send" && !keepReply && state.replyContext) clearReplyDraft();

  const targetSettingsUsers = view === "users";
  state.currentView = targetSettingsUsers ? "settings" : view;
  if (targetSettingsUsers) {
    state.currentSettingsSection = "users";
  } else if (view === "settings" && state.session.isAdmin && state.currentSettingsSection === "users") {
    state.currentSettingsSection = "domains";
  }

  setViewTitle(view);
  if (appEl) delete appEl.dataset.layout;

  const navBtns = [navInboxBtn, navSendBtn, navSpamBtn, navTrashBtn, navUsersBtn, navSettingsBtn, navDlqBtn];
  navBtns.forEach((b) => b?.classList.remove("active"));
  const viewPanels = [viewMail, viewDlq, viewSend, viewSettings];
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

  setMobilePane(targetSettingsUsers ? "detail" : "list");
  placeMailSearch(view);
  if (domainFilterSelect) {
    renderDomainFilterOptions();
  }
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
    if (viewSend) viewSend.hidden = false;
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
    navDlqBtn?.classList.add("active");
    if (streamDlqHeader) streamDlqHeader.hidden = false;
    if (viewDlq) viewDlq.hidden = false;
    await loadDlqJobs(state.currentDlqScope);
  } else if (view === "settings" || targetSettingsUsers) {
    if (targetSettingsUsers) navUsersBtn?.classList.add("active");
    else navSettingsBtn?.classList.add("active");
    if (streamSettingsHeader) streamSettingsHeader.hidden = false;
    if (viewSettings) viewSettings.hidden = false;
    renderSettingsNav();
    showSettingsSection(state.currentSettingsSection, { keepListOnNarrow: !targetSettingsUsers });
    await loadSettingsPage();
  }
}

export async function revealApp() {
  const sessionData = await request("/v1/session");
  state.session = {
    ...state.session,
    ...sessionData,
  };
  state.selectedDomainFilter = "";
  state.currentSettingsSection = state.session.isAdmin ? "domains" : "my-mailboxes";
  applySessionRoleChrome();

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
  void appearance.then(() => refreshShownNames());
  if (state.session.isAdmin) void updateDlqBadge();
  void refreshUnread();
}

setSwitchNav(switchNav);
setRevealApp(revealApp);
