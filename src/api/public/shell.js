// 应用外壳：主题管理、会话与角色感知编排、栏目切换、范围过滤器与首次引导。
import { setRevealApp, setSwitchNav } from "./nav.js";
import { state } from "./state.js";
import {
  appEl,
  dlqNoticeEl,
  filtersForm,
  inboxScopeSelect,
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
  navStarredBtn,
  navTrashBtn,
  navUsersBtn,
  noticeEl,
  promoBtn,
  streamDlqHeader,
  streamInboxHeader,
  streamSendHeader,
  streamSettingsHeader,
  streamSpamHeader,
  streamStarredHeader,
  streamTrashHeader,
  streamUsersHeader,
  themeIcon,
  userAvatarEl,
  userChipBtn,
  userRoleDotEl,
  viewDlq,
  viewMail,
  viewSend,
  viewSettings,
  viewUsers,
} from "./dom.js";
import { request } from "./net.js";
import { refreshUnread, setGlyph, setMobilePane, setViewTitle, showApp } from "./ui.js";
import { avatarInitial, hashMailId } from "./util.js";
import {
  clearBatchSelection,
  refreshShownNames,
  reloadMessages,
  reloadTrash,
  renderSandboxHtml,
  selectMail,
  syncListLabel,
} from "./mail-view.js";
import { loadDlqJobs, updateDlqBadge } from "./dlq-view.js";
import { loadAppearance, loadSettingsPage, renderSettingsNav, showSettingsSection } from "./settings-view.js";
import { clearReplyDraft, loadSendPage } from "./send-view.js";
import { loadUsersPage } from "./users-view.js";

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

export function placeMailSearch(view) {
  if (!filtersForm) return;
  if (view === "spam" && streamSpamHeader) streamSpamHeader.append(filtersForm);
  else if (streamInboxHeader) streamInboxHeader.insertBefore(filtersForm, document.querySelector("#inbox-quick-bar"));
}

export function setEmptyCopy(view) {
  if (!mailEmptyCopy) return;
  if (view === "spam") mailEmptyCopy.textContent = "这里是已拦截分类，切换筛选下拉框可浏览细分类型。";
  else if (view === "starred") mailEmptyCopy.textContent = "尚未添加星标邮件，在列表或阅读页点亮星标即可置顶收藏。";
  else if (view === "trash") mailEmptyCopy.textContent = "垃圾桶内的邮件可随时恢复或彻底清除。";
  else if (view === "inbox" && state.inboxPromoOnly) mailEmptyCopy.textContent = "当前处于推广视图，展示订阅通讯与商业动态。";
  else mailEmptyCopy.textContent = "这里是收件箱，包含正常与待分拣来信，其余分类位于已拦截。按 Ctrl+K 呼出全局速达。";
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

export function paintRoleControls() {
  const isAdmin = state.sessionRole === "admin";
  if (navUsersBtn) navUsersBtn.hidden = !isAdmin;
  if (navDlqBtn) navDlqBtn.hidden = !isAdmin;
  if (userAvatarEl) {
    userAvatarEl.textContent = avatarInitial(state.sessionDisplayName || state.sessionUser || "U");
  }
  if (userRoleDotEl) {
    userRoleDotEl.className = "user-role-dot " + (isAdmin ? "is-admin" : "is-member");
  }
  if (userChipBtn) {
    const roleLabel = isAdmin ? (state.isOwner ? "根管理员" : "管理员") : "成员";
    userChipBtn.title = `${state.sessionDisplayName || state.sessionUser}（${roleLabel}）· 点击进入账号设置`;
  }
}

export async function refreshScopeDropdown() {
  if (!inboxScopeSelect) return;
  const previous = state.scopeFilter || inboxScopeSelect.value || "";
  inboxScopeSelect.replaceChildren();
  const baseOpt = document.createElement("option");
  baseOpt.value = "";
  baseOpt.textContent = "全部信箱";
  inboxScopeSelect.append(baseOpt);

  if (state.sessionRole === "admin") {
    try {
      const [settingsRes, usersRes] = await Promise.all([request("/v1/settings"), request("/v1/users")]);
      const domains = Array.isArray(settingsRes.acceptDomains) ? settingsRes.acceptDomains : [];
      const users = (Array.isArray(usersRes.items) ? usersRes.items : []).filter((u) => !u.isOwner && u.role === "member");
      state.usersList = Array.isArray(usersRes.items) ? usersRes.items : [];
      state.settingsDomains = domains;

      if (domains.length > 1) {
        const grpDom = document.createElement("optgroup");
        grpDom.label = "按收信域名";
        for (const d of domains) {
          const o = document.createElement("option");
          o.value = `domain:${d}`;
          o.textContent = `@${d}`;
          grpDom.append(o);
        }
        inboxScopeSelect.append(grpDom);
      }
      if (users.length > 0) {
        const grpUser = document.createElement("optgroup");
        grpUser.label = "按成员信箱";
        for (const u of users) {
          const o = document.createElement("option");
          o.value = `member:${u.id}`;
          o.textContent = u.displayName ? `${u.displayName} (${u.username})` : u.username;
          grpUser.append(o);
        }
        inboxScopeSelect.append(grpUser);
      }
      inboxScopeSelect.hidden = inboxScopeSelect.options.length <= 1;
    } catch {
      inboxScopeSelect.hidden = true;
    }
  } else {
    const domains = [...new Set(state.myAllocations.map((a) => a.domain))];
    const exacts = state.myAllocations.filter((a) => a.kind === "exact");
    if (exacts.length > 1) {
      for (const a of exacts) {
        const o = document.createElement("option");
        o.value = `to:${a.localpart}@${a.domain}`;
        o.textContent = `${a.localpart}@${a.domain}`;
        inboxScopeSelect.append(o);
      }
    } else if (domains.length > 1) {
      for (const d of domains) {
        const o = document.createElement("option");
        o.value = `domain:${d}`;
        o.textContent = `@${d}`;
        inboxScopeSelect.append(o);
      }
    }
    inboxScopeSelect.hidden = inboxScopeSelect.options.length <= 1;
  }

  if (previous && [...inboxScopeSelect.options].some((o) => o.value === previous)) {
    inboxScopeSelect.value = previous;
  } else {
    inboxScopeSelect.value = "";
    state.scopeFilter = "";
  }
}

export async function switchNav(view, options = {}) {
  if ((view === "users" || view === "dlq") && state.sessionRole !== "admin") {
    view = "inbox";
  }
  const keepReply = state.replyArmed;
  state.replyArmed = false;

  if (state.inboxPromoOnly) {
    state.inboxPromoOnly = false;
    paintPromoBtn();
  }

  if (options.scopeFilter !== undefined) {
    state.scopeFilter = options.scopeFilter;
    if (inboxScopeSelect) inboxScopeSelect.value = options.scopeFilter;
  }

  if (view === "send" && !keepReply && state.replyContext) clearReplyDraft(false);
  state.currentView = view;
  clearBatchSelection();
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

  const viewPanels = [viewMail, viewDlq, viewSend, viewUsers, viewSettings];
  viewPanels.forEach((p) => {
    if (p) p.hidden = true;
  });

  const headers = [
    streamInboxHeader,
    streamStarredHeader,
    streamSendHeader,
    streamSpamHeader,
    streamTrashHeader,
    streamUsersHeader,
    streamDlqHeader,
    streamSettingsHeader,
  ];
  headers.forEach((h) => {
    if (h) h.hidden = true;
  });

  if (dlqNoticeEl) dlqNoticeEl.hidden = view !== "dlq";
  noticeEl.hidden = view === "dlq";
  noticeEl.textContent = "";
  listEl.replaceChildren();
  state.cursor = null;
  state.loadingMore = false;

  if (view === "inbox" || view === "starred" || view === "spam" || view === "trash") {
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

  if (view === "inbox") {
    navInboxBtn?.classList.add("active");
    if (streamInboxHeader) streamInboxHeader.hidden = false;
    viewMail.hidden = false;
    syncListLabel();
    return reloadMessages();
  } else if (view === "starred") {
    navStarredBtn?.classList.add("active");
    if (streamStarredHeader) streamStarredHeader.hidden = false;
    viewMail.hidden = false;
    await reloadMessages();
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
  } else if (view === "users") {
    navUsersBtn?.classList.add("active");
    if (streamUsersHeader) streamUsersHeader.hidden = false;
    if (viewUsers) viewUsers.hidden = false;
    await loadUsersPage();
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
  const sessionInfo = await request("/v1/session");
  state.sessionUser = sessionInfo.user || "";
  state.sessionUserId = sessionInfo.id || "";
  state.sessionDisplayName = sessionInfo.displayName || "";
  state.sessionRole = sessionInfo.role === "member" ? "member" : "admin";
  state.isOwner = Boolean(sessionInfo.isOwner);
  state.quotaSendDay = Number(sessionInfo.quotaSendDay) || 100;
  state.sentLast24h = Number(sessionInfo.sentLast24h) || 0;
  state.myAllocations = Array.isArray(sessionInfo.allocations) ? sessionInfo.allocations : [];
  state.currentSettingsSection = state.sessionRole === "member" ? "my-mailboxes" : "domains";

  paintRoleControls();

  const deepId = hashMailId();
  state.skipFirstOpen = Boolean(deepId);
  const appearance = loadAppearance();

  showApp();
  if (appEl) appEl.classList.add("is-booting");
  let listed;
  try {
    listed = await switchNav("inbox", { scopeFilter: "" });
  } finally {
    state.skipFirstOpen = false;
  }
  if (listed === false) return;
  if (deepId) void selectMail(deepId);
  if (appEl) appEl.classList.remove("is-booting");
  void appearance.then(() => refreshShownNames());
  void refreshScopeDropdown();
  if (state.sessionRole === "admin") void updateDlqBadge();
  void refreshUnread();
}

setSwitchNav(switchNav);
setRevealApp(revealApp);
