// 通用界面组件：轻提示、确认弹窗、快捷键面板、未读徽章同步、身份胶囊与元数据单元。
import { ROLE_LABELS, VIEW_TITLES } from "./constants.js";
import { state } from "./state.js";
import {
  accountPill,
  appEl,
  badgeInbox,
  badgeSpam,
  confirmCancel,
  confirmModal,
  confirmOk,
  confirmText,
  domainFilterSelect,
  loginEl,
  markAllReadBtn,
  shortcutsModal,
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

export function makeIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

export function setViewTitle(view) {
  document.title = VIEW_TITLES[view] || "收件箱";
  if (view === "inbox" && state.inboxPromoOnly) document.title = "推广";
  else if (view === "inbox" && state.unreadInbox > 0) document.title += " (" + state.unreadInbox + ")";
  if (state.panelTitle && state.panelTitle !== "邮箱") document.title = state.panelTitle + " · " + document.title;
  if (streamTitle) {
    streamTitle.textContent =
      view === "inbox" && state.inboxPromoOnly
        ? "推广"
        : state.unreadInbox > 0
          ? "收件箱 (" + state.unreadInbox + ")"
          : "收件箱";
  }
  syncUnreadWidgets();
}

export function syncUnreadWidgets() {
  if (badgeInbox) {
    if (state.unreadInbox > 0) {
      badgeInbox.hidden = false;
      badgeInbox.textContent = state.unreadInbox > 99 ? "99+" : String(state.unreadInbox);
    } else {
      badgeInbox.hidden = true;
    }
  }
  if (badgeSpam) {
    if (state.unreadSpam > 0) {
      badgeSpam.hidden = false;
      badgeSpam.textContent = state.unreadSpam > 99 ? "99+" : String(state.unreadSpam);
    } else {
      badgeSpam.hidden = true;
    }
  }
  if (markAllReadBtn) {
    const hasUnreadInList = state.inboxPromoOnly
      ? state.currentMessages.some((m) => !m.read)
      : state.unreadInbox > 0 || state.currentMessages.some((m) => !m.read);
    markAllReadBtn.hidden = !hasUnreadInList;
  }
  if (spamReadAllBtn) {
    const hasSpamUnread = state.unreadSpam > 0 || (state.currentView === "spam" && state.currentMessages.some((m) => !m.read));
    spamReadAllBtn.hidden = !hasSpamUnread;
  }
}

export async function refreshUnread() {
  try {
    const counts = await request("/v1/unread");
    state.unreadInbox = Number(counts.inbox) || 0;
    state.unreadSpam = Number(counts.spam) || 0;
    if (appEl && !appEl.hidden) setViewTitle(state.currentView);
    else syncUnreadWidgets();
  } catch {
    // 下次轮询继续同步。
  }
}

export function renderAccountIdentity() {
  if (!accountPill) return;
  const s = state.session;
  const label = s.displayName || s.user || "账号";
  const roleText = ROLE_LABELS[s.role] || s.role;
  const initial = (label.trim()[0] || "A").toUpperCase();
  accountPill.textContent = initial;
  accountPill.dataset.role = s.role || "member";
  accountPill.title = `${label} (${s.user}) · ${roleText}`;
}

export function renderDomainFilterOptions() {
  if (!domainFilterSelect) return;
  const domains = state.session.isAdmin
    ? state.settingsDomains
    : state.session.allowedDomains;
  const list = Array.isArray(domains) ? domains.filter(Boolean) : [];
  if (list.length <= 1) {
    domainFilterSelect.hidden = true;
    if (state.selectedDomainFilter && !list.includes(state.selectedDomainFilter)) {
      state.selectedDomainFilter = "";
    }
    return;
  }
  const current = state.selectedDomainFilter;
  domainFilterSelect.replaceChildren();
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "全部域名";
  domainFilterSelect.append(allOpt);
  for (const dom of list) {
    const opt = document.createElement("option");
    opt.value = dom;
    const short = state.domainNames[dom];
    opt.textContent = short ? `${dom} (${short})` : dom;
    domainFilterSelect.append(opt);
  }
  domainFilterSelect.value = list.includes(current) ? current : "";
  state.selectedDomainFilter = domainFilterSelect.value;
  domainFilterSelect.hidden = false;
}

export async function copyText(text, successMsg = "已复制到剪贴板") {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg);
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

export function openShortcutsModal() {
  if (!shortcutsModal) return;
  shortcutsModal.hidden = false;
}

export function closeShortcutsModal() {
  if (!shortcutsModal) return;
  shortcutsModal.hidden = true;
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

const REASON_MESSAGES = {
  sender_not_allowed: "当前账号未获准使用该发件地址",
  daily_quota_exceeded: "已达到 24 小时发信额度上限",
  username_taken: "该登录名已被占用",
  allocation_conflict: "该邮箱规则已分配给别的账号",
  invalid_allocation: "邮箱规则格式无效（支持 user@domain、prefix*@domain 或 *@domain）",
  invalid_username: "登录名格式无效（2 至 64 位字母、数字、点、横线或邮箱）",
  invalid_domain: "域名格式无效",
  weak_password: "口令过于简单，请更换至少 8 位强口令",
  only_owner_can_grant_admin: "仅根管理员可授予或变更管理员角色",
  only_owner_can_manage_admin: "仅根管理员可管理协同管理员账号",
  cannot_disable_self: "不能停用当前登录账号",
  cannot_delete_self: "不能删除当前登录账号",
};

export function explain(err) {
  if (err && err.reason && REASON_MESSAGES[err.reason]) {
    return REASON_MESSAGES[err.reason];
  }
  if (err && err.status === 401) return "账号或口令不正确，或会话已失效";
  if (err && err.status === 429) return "请求过于频繁或超出配额，请稍后再试";
  if (err && err.status === 409) return "记录已存在或与既有配置冲突";
  if (err && err.status === 403) return "权限不足或缺少有效令牌";
  return "操作未完成，请检查输入后重试";
}

export function createAuthChip(label, status) {
  const value = String(status || "none").toLowerCase();
  const isPass = value === "pass";
  const isNeutral = value === "none" || value === "neutral" || value === "temperror";
  const chip = document.createElement("span");
  chip.className = "auth-chip " + (isPass ? "pass" : isNeutral ? "neutral" : "fail");
  const dot = document.createElement("span");
  dot.className = "auth-dot";
  const text = document.createElement("span");
  text.textContent = `${label} ${value}`;
  chip.append(dot, text);
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
