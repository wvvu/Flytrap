// 通用 UI 组件：提示条、确认框、未读徽章同步、SVG 图标构建、安全鉴权徽章。
import { VIEW_TITLES } from "./constants.js";
import { state } from "./state.js";
import {
  appEl,
  badgeInbox,
  badgeSpam,
  badgeStarred,
  confirmCancel,
  confirmModal,
  confirmOk,
  confirmText,
  loginEl,
  markAllReadBtn,
  promoBtn,
  spamMarkReadBtn,
  streamTitle,
  toastEl,
} from "./dom.js";
import { request } from "./net.js";

export function makeIcon(name, className = "ico") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

export function setGlyph(el, name) {
  if (!el) return;
  el.replaceChildren(makeIcon(name));
}

export function setViewTitle(view) {
  let base = VIEW_TITLES[view] || "收件箱";
  if (view === "inbox" && state.inboxPromoOnly) base = "推广";
  let pageTitle = base;
  if (view === "inbox" && !state.inboxPromoOnly && state.unreadInbox > 0) {
    pageTitle += " (" + state.unreadInbox + ")";
  }
  if (state.panelTitle && state.panelTitle !== "邮箱") {
    pageTitle = state.panelTitle + " · " + pageTitle;
  }
  document.title = pageTitle;

  if (streamTitle) {
    if (view === "inbox" && state.inboxPromoOnly) {
      streamTitle.textContent = state.unreadPromo > 0 ? `推广 (${state.unreadPromo})` : "推广";
    } else {
      streamTitle.textContent = state.unreadInbox > 0 ? `收件箱 (${state.unreadInbox})` : "收件箱";
    }
  }
  syncActionVisibility();
}

export function syncActionVisibility() {
  if (markAllReadBtn) {
    const unreadInScope = state.inboxPromoOnly ? state.unreadPromo : state.unreadInbox;
    markAllReadBtn.hidden = state.currentView !== "inbox" || unreadInScope <= 0;
  }
  if (spamMarkReadBtn) {
    spamMarkReadBtn.hidden = state.currentView !== "spam" || state.unreadSpam <= 0;
  }
  if (promoBtn) {
    promoBtn.textContent = state.unreadPromo > 0 ? `推广 ${state.unreadPromo}` : "推广";
  }
}

export function paintBadge(el, count) {
  if (!el) return;
  const n = Number(count) || 0;
  if (n > 0) {
    el.hidden = false;
    el.textContent = n > 99 ? "99+" : String(n);
  } else {
    el.hidden = true;
    el.textContent = "0";
  }
}

export async function refreshUnread() {
  try {
    const counts = await request("/v1/unread");
    state.unreadInbox = Number(counts.inbox) || 0;
    state.unreadSpam = Number(counts.spam) || 0;
    state.unreadPromo = Number(counts.promo) || 0;
    state.starredCount = Number(counts.starred) || 0;
    state.trashCount = Number(counts.trash) || 0;

    paintBadge(badgeInbox, state.unreadInbox);
    paintBadge(badgeStarred, state.starredCount);
    paintBadge(badgeSpam, state.unreadSpam);
    syncActionVisibility();

    if (appEl && !appEl.hidden) setViewTitle(state.currentView);
  } catch {
    // 下次轮询继续同步
  }
}

export async function copyText(text, label = "已复制") {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
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

export function askConfirm(message, options = {}) {
  if (!confirmModal || !confirmOk || !confirmCancel || !confirmText) {
    return Promise.resolve(false);
  }
  confirmText.textContent = message;
  confirmOk.textContent = options.okText || "确认";
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
  if (err && err.status === 401) return "账号或口令不正确，或会话已失效";
  if (err && err.status === 403) return "当前账号无权执行该操作";
  if (err && err.status === 429) return "请求过于频繁或已达发信配额上限";
  if (err && err.status === 400) return "输入格式有误或参数冲突";
  return "操作未完成，请稍后重试";
}

export function createAuthChip(label, status, compact = false) {
  const value = String(status || "none").toLowerCase();
  const tone = value === "pass" ? "pass" : value === "none" || value === "neutral" ? "neutral" : "fail";
  const chip = document.createElement("span");
  chip.className = (compact ? "auth-pill-sm " : "auth-chip ") + tone;
  chip.textContent = compact ? `${label} ${value}` : `${label}: ${value}`;
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
