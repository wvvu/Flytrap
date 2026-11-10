// 应用外壳：主题、栏目切换、推广模式、视图标题与空列表文案，
// 外加登录后引导（revealApp：它编排各视图，本就属于外壳层）。
import { setRevealApp, setSwitchNav } from "./nav.js";
import { state } from "./state.js";
import { appEl, dlqNoticeEl, filtersForm, listEl, mailDetailEl, mailEmptyCopy, mailEmptyEl, mailLoadingEl, navInboxBtn, navSendBtn, navSettingsBtn, navSpamBtn, navTrashBtn, noticeEl, promoBtn, streamDlqHeader, streamInboxHeader, streamSendHeader, streamSettingsHeader, streamSpamHeader, streamTrashHeader, themeIcon, viewDlq, viewMail, viewSend, viewSettings } from "./dom.js";
import { refreshUnread, setGlyph, setMobilePane, setViewTitle, showApp } from "./ui.js";
import { reloadMessages, reloadTrash, renderSandboxHtml, selectMail, syncListLabel } from "./mail-view.js";
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
  if (state.currentMailHtml) {
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
  if (view === "spam") mailEmptyCopy.textContent = "这里是已拦截。选全部才会看到正常来信。";
  else if (view === "trash") mailEmptyCopy.textContent = "这里是垃圾桶。";
  else if (view === "inbox" && state.inboxPromoOnly) mailEmptyCopy.textContent = "这里是推广。没有推广信。";
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

export async function switchNav(view) {
  const keepReply = state.replyArmed;
  state.replyArmed = false;
  // 切走别的栏目、或从左栏再点一次收件箱，推广模式都回到正常，避免状态藏着。
  if (state.inboxPromoOnly) {
    state.inboxPromoOnly = false;
    paintPromoBtn();
  }
  if (view === "send" && !keepReply && state.replyContext) clearReplyDraft();
  state.currentView = view;
  setViewTitle(view);
  if (appEl) delete appEl.dataset.layout;
  const navBtns = [navInboxBtn, navSendBtn, navSpamBtn, navTrashBtn, navSettingsBtn];
  navBtns.forEach((b) => b?.classList.remove("active"));
  const viewPanels = [viewMail, viewDlq, viewSend, viewSettings];
  viewPanels.forEach((p) => { if (p) p.hidden = true; });

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
  setEmptyCopy(view);

  if (view === "inbox") {
    navInboxBtn?.classList.add("active");
    streamInboxHeader.hidden = false;
    viewMail.hidden = false;
    syncListLabel();
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
  } else if (view === "dlq") {
    navSettingsBtn?.classList.add("active");
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
  state.holdBoot = true;
  appEl.classList.add("is-booting");
  showApp();
  try {
    await loadAppearance();
    const deepId = hashMailId();
    await switchNav("inbox");
    if (deepId) await selectMail(deepId);
    await Promise.all([updateDlqBadge(), refreshUnread()]);
  } finally {
    state.holdBoot = false;
    appEl.classList.remove("is-booting");
  }
}

setSwitchNav(switchNav);
setRevealApp(revealApp);
