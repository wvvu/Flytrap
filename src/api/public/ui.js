// 通用 UI：提示、确认框、标题、未读数、移动端面板、详情小组件。
import { VIEW_TITLES } from "./constants.js";
import { state } from "./state.js";
import { appEl, confirmCancel, confirmModal, confirmOk, confirmText, loginEl, streamTitle, toastEl } from "./dom.js";
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

export function setViewTitle(view) {
  document.title = VIEW_TITLES[view] || "收件箱";
  if (view === "inbox" && state.inboxPromoOnly) document.title = "推广";
  else if (view === "inbox" && state.unreadInbox > 0) document.title += " (" + state.unreadInbox + ")";
  if (state.panelTitle !== "邮箱") document.title = state.panelTitle + " · " + document.title;
  if (streamTitle) streamTitle.textContent = view === "inbox" && state.inboxPromoOnly ? "推广" : state.unreadInbox > 0 ? "收件箱 (" + state.unreadInbox + ")" : "收件箱";
}

export async function refreshUnread() {
  try {
    const counts = await request("/v1/unread");
    state.unreadInbox = Number(counts.inbox) || 0;
    if (appEl && !appEl.hidden) setViewTitle(state.currentView);
  } catch {
    // The next poll tries again.
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
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
  if (err && err.status === 401) return "用户名或口令不正确";
  if (err && err.status === 429) return "请求过于频繁，请稍后再试";
  if (err && err.status === 403) return "缺少有效 CSRF 令牌";
  return "操作失败，请重试";
}

export function createAuthChip(label, status) {
  const value = String(status || "none").toLowerCase();
  const calm = value === "pass" || value === "none";
  const chip = document.createElement("span");
  chip.className = "auth-chip " + (calm ? "pass" : "fail");
  chip.textContent = `${label}: ${value}`;
  return chip;
}

export function createMetaItem(label, val) {
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

export function formatRawHeaders(detail) {
  const lines = [];
  if (detail.messageId) lines.push(`Message-ID: ${detail.messageId}`);
  if (detail.from) lines.push(`From: ${detail.from}`);
  if (detail.envelopeFrom) lines.push(`Return-Path: <${detail.envelopeFrom}>`);
  if (detail.envelopeTo) lines.push(`Delivered-To: ${Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo}`);
  if (detail.subject) lines.push(`Subject: ${detail.subject}`);
  if (detail.receivedAt) lines.push(`Date: ${new Date(detail.receivedAt).toUTCString()}`);
  if (detail.smtpMeta) lines.push(`X-Mail-Smtp: ${JSON.stringify(detail.smtpMeta)}`);
  return lines.join("\n");
}
