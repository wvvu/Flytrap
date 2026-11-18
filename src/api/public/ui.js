// 通用界面辅助：通知条、确认框、快捷键面板、角色化显隐、未读数同步。
import { VIEW_TITLES } from "./constants.js";
import { state } from "./state.js";
import {
  appEl,
  confirmCancel,
  confirmModal,
  confirmOk,
  confirmText,
  loginEl,
  logoutBtn,
  navDlqBtn,
  navUsersBtn,
  readAllBtn,
  shortcutModal,
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

export function setViewTitle(view) {
  document.title = VIEW_TITLES[view] || "收件箱";
  const count = state.inboxPromoOnly ? state.unreadPromo : state.unreadInbox;
  if (view === "inbox" && state.starredOnly) {
    document.title = "星标";
  } else if (view === "inbox" && state.inboxPromoOnly) {
    document.title = count > 0 ? `推广 (${count})` : "推广";
  } else if (view === "inbox" && state.unreadInbox > 0) {
    document.title += " (" + state.unreadInbox + ")";
  }
  if (state.panelTitle !== "邮箱") document.title = state.panelTitle + " · " + document.title;
  if (streamTitle) {
    if (view === "inbox" && state.starredOnly) {
      streamTitle.textContent = "星标";
    } else if (view === "inbox" && state.inboxPromoOnly) {
      streamTitle.textContent = count > 0 ? `推广 (${count})` : "推广";
    } else {
      streamTitle.textContent = state.unreadInbox > 0 ? "收件箱 (" + state.unreadInbox + ")" : "收件箱";
    }
  }
  syncReadAllButtons();
}

export function syncReadAllButtons() {
  if (readAllBtn) {
    const activeUnread = state.inboxPromoOnly ? state.unreadPromo : state.unreadInbox;
    readAllBtn.hidden = activeUnread <= 0;
  }
  if (spamReadAllBtn) {
    spamReadAllBtn.hidden = state.unreadSpam <= 0;
  }
}

export function applyRoleUI() {
  if (navUsersBtn) navUsersBtn.hidden = !state.isAdmin;
  if (navDlqBtn) navDlqBtn.hidden = !state.isAdmin;
  if (logoutBtn) {
    const roleLabel = state.isAdmin ? "管理员" : "成员";
    logoutBtn.title = state.sessionUser ? `退出 (${state.sessionUser} · ${roleLabel})` : "退出";
  }
  const verEl = document.querySelector("#settings-version");
  if (verEl) verEl.textContent = state.appVersion ? `v${state.appVersion}` : "";
}

export async function refreshUnread() {
  try {
    const params = new URLSearchParams();
    if (state.isAdmin && state.adminScope && state.adminScope !== "mine") {
      params.set("scope", state.adminScope);
    }
    const qs = params.toString();
    const counts = await request("/v1/unread" + (qs ? "?" + qs : ""));
    state.unreadInbox = Number(counts.inbox) || 0;
    state.unreadSpam = Number(counts.spam) || 0;
    state.unreadPromo = Number(counts.promo) || 0;
    if (appEl && !appEl.hidden) setViewTitle(state.currentView);
    else syncReadAllButtons();
  } catch {
    // 下轮轮询自动重试
  }
}

export async function copyText(text, message = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
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

export function toggleShortcutModal(force) {
  if (!shortcutModal) return;
  const next = typeof force === "boolean" ? force : shortcutModal.hidden;
  shortcutModal.hidden = !next;
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

const CONFLICT_TEXT = {
  "mailbox already allocated": "这个地址已经分给别人",
  "username already exists": "这个账号已经有了",
  "username or mailbox already exists": "账号或邮箱已被占用",
  "username is reserved": "这个账号名留给了环境变量里的管理员",
};

export function explain(err) {
  if (err && err.status === 401) return "账号或口令不正确";
  if (err && err.status === 403) return "当前账号无权执行此操作";
  if (err && err.status === 400 && err.reason === "domain is not accepted") return "这个域名不在收信列表里";
  if (err && err.status === 400 && err.reason === "invalid webhook url") return "这个 Webhook 地址不是 http 或 https";
  if (err && err.status === 409) return CONFLICT_TEXT[err.reason] || "账号或邮箱已被占用";
  if (err && err.status === 429) return "请求过于频繁或已达今日发信上限";
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
