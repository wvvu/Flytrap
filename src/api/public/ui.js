// 通用界面辅助：SVG 图标注入、标题与未读同步、权限显隐、弹窗确认与轻提示。
import { VIEW_TITLES } from "./constants.js";
import { state } from "./state.js";
import {
  adminScopeSwitch,
  appEl,
  confirmCancel,
  confirmModal,
  confirmOk,
  confirmText,
  dotInbox,
  loginEl,
  markAllReadBtn,
  navDlqBtn,
  navUsersBtn,
  recipientFilterSelect,
  scopeBar,
  spamReadAllBtn,
  streamTitle,
  toastEl,
} from "./dom.js";
import { request } from "./net.js";

export function setGlyph(el, name) {
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

export function makeSvgIcon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", extraClass ? "ico " + extraClass : "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

export function setViewTitle(view) {
  let title = VIEW_TITLES[view] || "收件箱";
  if (view === "inbox" && state.inboxPromoOnly) title = "推广";
  else if (view === "inbox" && state.unreadInbox > 0) title = `收件箱 (${state.unreadInbox})`;
  document.title = state.panelTitle !== "邮箱" ? `${state.panelTitle} · ${title}` : title;

  if (streamTitle) {
    if (state.inboxPromoOnly) streamTitle.textContent = "推广";
    else if (state.unreadInbox > 0) streamTitle.textContent = `收件箱 (${state.unreadInbox})`;
    else streamTitle.textContent = "收件箱";
  }
  syncReadAllButtons();
}

export function syncReadAllButtons() {
  if (dotInbox) dotInbox.hidden = state.unreadInbox <= 0;
  if (markAllReadBtn) {
    markAllReadBtn.hidden = state.inboxPromoOnly ? false : state.unreadInbox <= 0;
    if (state.inboxPromoOnly && state.currentMessages.every((m) => m.read)) {
      markAllReadBtn.hidden = true;
    }
  }
  if (spamReadAllBtn) {
    spamReadAllBtn.hidden = state.unreadSpam <= 0;
  }
}

export async function refreshUnread() {
  try {
    const qs = state.role === "admin" && state.mailScope === "all" ? "?scope=all" : "";
    const counts = await request("/v1/unread" + qs);
    state.unreadInbox = Number(counts.inbox) || 0;
    state.unreadSpam = Number(counts.spam) || 0;
    if (appEl && !appEl.hidden) setViewTitle(state.currentView);
    else syncReadAllButtons();
  } catch {
    // 下次轮询重试
  }
}

export function applyRoleVisibility() {
  const isAdmin = state.role === "admin";
  if (navUsersBtn) navUsersBtn.hidden = !isAdmin;
  if (navDlqBtn) navDlqBtn.hidden = !isAdmin;
  if (adminScopeSwitch) adminScopeSwitch.hidden = !isAdmin;
  updateScopeBarVisibility();
}

export function updateScopeBarVisibility() {
  if (!scopeBar) return;
  const mailRoom =
    state.currentView === "inbox" ||
    state.currentView === "starred" ||
    state.currentView === "spam" ||
    state.currentView === "trash";
  if (!mailRoom) {
    scopeBar.hidden = true;
    return;
  }
  const hasRecipientOptions = Boolean(recipientFilterSelect && recipientFilterSelect.options.length > 1);
  if (recipientFilterSelect) recipientFilterSelect.hidden = !hasRecipientOptions;
  const showAdminToggle = state.role === "admin";
  scopeBar.hidden = !showAdminToggle && !hasRecipientOptions;
}

export async function copyText(text, okMsg = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    toast("复制失败");
  }
}

export function setMobilePane(pane) {
  if (appEl) appEl.dataset.pane = pane;
}

export function showApp() {
  loginEl.hidden = true;
  loginEl.style.display = "none";
  appEl.hidden = false;
  appEl.style.display = "grid";
}

export function isTypingTarget(target) {
  if (!target || target.nodeType !== 1) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function findByDataId(root, selector, id) {
  if (!root || !id) return null;
  for (const node of root.querySelectorAll(selector)) {
    if (node.dataset.id === id) return node;
  }
  return null;
}

export function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

export function askConfirm(message) {
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

export function explain(err) {
  if (err && err.status === 401) return "账号或密码不正确";
  if (err && err.status === 403) return "当前账号无此权限";
  if (err && err.status === 409) return "该名称或记录已存在";
  if (err && err.status === 429) return "请求过于频繁，请稍后再试";
  return "操作失败，请重试";
}

export function createAuthChip(label, status) {
  const value = String(status || "none").toLowerCase();
  let tone = "fail";
  if (value === "pass") tone = "pass";
  else if (value === "none" || value === "neutral") tone = "neutral";
  const chip = document.createElement("span");
  chip.className = "auth-chip " + tone;
  chip.textContent = `${label}: ${value}`;
  return chip;
}

export function formatRawHeaders(detail) {
  const lines = [];
  if (detail.messageId) lines.push(`Message-ID: ${detail.messageId}`);
  if (detail.from) lines.push(`From: ${detail.from}`);
  if (detail.envelopeFrom) lines.push(`Return-Path: <${detail.envelopeFrom}>`);
  if (detail.envelopeTo) {
    lines.push(
      `Delivered-To: ${Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo}`,
    );
  }
  if (detail.subject) lines.push(`Subject: ${detail.subject}`);
  if (detail.receivedAt) lines.push(`Date: ${new Date(detail.receivedAt).toUTCString()}`);
  if (detail.smtpMeta) lines.push(`X-Mail-Smtp: ${JSON.stringify(detail.smtpMeta)}`);
  return lines.join("\n");
}
