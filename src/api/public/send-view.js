// 发信与草稿：按账号隔离的自动草稿保存、发件身份与 DKIM 状态反馈、回复关联与已发信浏览。
import { DRAFT_KEY_PREFIX, LAST_FROM_KEY } from "./constants.js";
import { state } from "./state.js";
import { listEl, noticeEl, threadBox, viewMail, viewSend } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, explain, setMobilePane, toast } from "./ui.js";
import {
  capReplyRefs,
  extractEmail,
  formatRecipient,
  formatShortTime,
  memberCanSendFrom,
  normalizeAddress,
  normalizeClientId,
  outboxStatus,
  quoteLetter,
  replyAddress,
  replySubject,
} from "./util.js";
import { switchNav } from "./nav.js";
import { openSentLetter } from "./mail-view.js";

function draftStorageKey() {
  return DRAFT_KEY_PREFIX + (state.sessionUserId || "owner");
}

function lastFromStorageKey() {
  return LAST_FROM_KEY + ":" + (state.sessionUserId || "owner");
}

export function lastUsedFrom() {
  try {
    return localStorage.getItem(lastFromStorageKey()) || localStorage.getItem(LAST_FROM_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberFrom(from) {
  try {
    if (from) localStorage.setItem(lastFromStorageKey(), from);
  } catch {
    // 隐私窗口忽略存储异常
  }
}

export function defaultSenderAddress() {
  const remembered = lastUsedFrom();
  if (remembered && memberCanSendFrom(remembered)) return remembered;
  if (state.sessionUserId && state.sessionUserId !== "owner" && state.allocatedMailboxes.length > 0) {
    const sendable = state.allocatedMailboxes.find((b) => b.canSend);
    if (sendable) {
      return sendable.localpart === "*" ? `mail@${sendable.domain}` : sendable.address;
    }
  }
  return remembered;
}

export function replyFromAddress(detail) {
  const to = detail && detail.envelopeTo;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  const candidates = list.map((item) => normalizeAddress(extractEmail(String(item)))).filter(Boolean);
  const allowed = candidates.find((addr) => memberCanSendFrom(addr));
  return allowed || defaultSenderAddress();
}

export function readStoredDraft() {
  try {
    const raw = localStorage.getItem(draftStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveComposeDraftNow() {
  const from = document.querySelector("#send-from")?.value || "";
  const to = document.querySelector("#send-to")?.value || "";
  const cc = document.querySelector("#send-cc")?.value || "";
  const bcc = document.querySelector("#send-bcc")?.value || "";
  const subject = document.querySelector("#send-subject")?.value || "";
  const text = document.querySelector("#send-text")?.value || "";
  const hasContent = Boolean(to.trim() || cc.trim() || bcc.trim() || subject.trim() || text.trim());

  const statusEl = document.querySelector("#draft-status");
  const discardBtn = document.querySelector("#btn-discard-draft");

  if (!hasContent && !state.replyContext) {
    try {
      localStorage.removeItem(draftStorageKey());
    } catch {
      // ignore
    }
    if (statusEl) statusEl.hidden = true;
    if (discardBtn) discardBtn.hidden = true;
    return;
  }

  try {
    localStorage.setItem(
      draftStorageKey(),
      JSON.stringify({
        from,
        to,
        cc,
        bcc,
        subject,
        text,
        replyContext: state.replyContext,
        replySubjectHint: state.replySubjectHint,
        savedAt: Date.now(),
      }),
    );
  } catch {
    // ignore
  }
  if (statusEl) statusEl.hidden = false;
  if (discardBtn) discardBtn.hidden = false;
}

export function scheduleDraftSave() {
  window.clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = window.setTimeout(() => saveComposeDraftNow(), 260);
}

export function restoreDraftIfPresent() {
  const draft = readStoredDraft();
  const fromInput = document.querySelector("#send-from");
  const toInput = document.querySelector("#send-to");
  const ccInput = document.querySelector("#send-cc");
  const bccInput = document.querySelector("#send-bcc");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  const ccRow = document.querySelector("#send-cc-row");
  const bccRow = document.querySelector("#send-bcc-row");
  const statusEl = document.querySelector("#draft-status");
  const discardBtn = document.querySelector("#btn-discard-draft");

  if (!draft) {
    if (fromInput && !fromInput.value.trim()) fromInput.value = defaultSenderAddress();
    if (statusEl) statusEl.hidden = true;
    if (discardBtn) discardBtn.hidden = true;
    syncReplyBanner();
    refreshSendNote();
    return;
  }

  if (fromInput) fromInput.value = draft.from || defaultSenderAddress();
  if (toInput) toInput.value = draft.to || "";
  if (ccInput) ccInput.value = draft.cc || "";
  if (bccInput) bccInput.value = draft.bcc || "";
  if (subjectInput) subjectInput.value = draft.subject || "";
  if (textInput) textInput.value = draft.text || "";
  if (draft.cc && ccRow) ccRow.hidden = false;
  if (draft.bcc && bccRow) bccRow.hidden = false;
  state.replyContext = draft.replyContext || null;
  state.replySubjectHint = draft.replySubjectHint || "";
  if (statusEl) statusEl.hidden = false;
  if (discardBtn) discardBtn.hidden = false;
  syncReplyBanner();
  refreshSendNote();
}

export async function discardComposeDraft() {
  if (!(await askConfirm("清空当前暂存的写信草稿？"))) return;
  clearComposeFields();
  toast("草稿已清空");
}

export function clearComposeFields() {
  state.replyContext = null;
  state.replySubjectHint = "";
  try {
    localStorage.removeItem(draftStorageKey());
  } catch {
    // ignore
  }
  for (const sel of ["#send-to", "#send-cc", "#send-bcc", "#send-subject", "#send-text"]) {
    const el = document.querySelector(sel);
    if (el) el.value = "";
  }
  const statusEl = document.querySelector("#draft-status");
  const discardBtn = document.querySelector("#btn-discard-draft");
  if (statusEl) statusEl.hidden = true;
  if (discardBtn) discardBtn.hidden = true;
  syncReplyBanner();
}

export function cancelReplyLink() {
  state.replyContext = null;
  state.replySubjectHint = "";
  syncReplyBanner();
  saveComposeDraftNow();
}

export function syncReplyBanner() {
  const banner = document.querySelector("#reply-banner");
  const bannerText = document.querySelector("#reply-banner-text");
  if (!banner || !bannerText) return;
  if (state.replyContext && state.replyContext.inReplyTo) {
    banner.hidden = false;
    bannerText.textContent = `关联回复：${state.replySubjectHint || "(无主题)"}`;
  } else {
    banner.hidden = true;
    bannerText.textContent = "";
  }
}

export function openComposer() {
  state.readingSentId = null;
  if (viewMail) viewMail.hidden = true;
  if (viewSend) viewSend.hidden = false;
  document.querySelectorAll("#list .mail-item").forEach((el) => el.classList.remove("selected"));
  setMobilePane("detail");
  const fromInput = document.querySelector("#send-from");
  if (fromInput && !fromInput.value.trim()) fromInput.value = defaultSenderAddress();
  syncReplyBanner();
  refreshSendNote();
  const toInput = document.querySelector("#send-to");
  if (toInput && !toInput.value.trim()) toInput.focus();
  else document.querySelector("#send-text")?.focus();
}

export async function selectSentFromList(id) {
  if (viewSend) viewSend.hidden = true;
  if (viewMail) viewMail.hidden = false;
  if (threadBox) threadBox.hidden = true;
  document.querySelectorAll("#list .mail-item").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
  setMobilePane("detail");
  await openSentLetter(id);
}

export function navigateSent(delta) {
  const visible = state.sentItems.filter((item) => sentMatches(item, state.sentQuery));
  if (visible.length === 0) return;
  const idx = visible.findIndex((item) => item.id === state.readingSentId);
  const nextIdx = idx < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, idx + delta));
  if (visible[nextIdx]) {
    void selectSentFromList(visible[nextIdx].id);
  }
}

export async function startReply() {
  const detail = state.openDetail;
  if (!detail || !replyAddress(detail)) return;
  const parent = normalizeClientId(detail.messageId);
  const prior = Array.isArray(detail.references)
    ? detail.references.map((item) => normalizeClientId(item)).filter(Boolean)
    : [];
  const references = capReplyRefs(parent ? (prior.includes(parent) ? prior : prior.concat(parent)) : prior);
  state.replyContext = parent ? { inReplyTo: parent, references } : null;
  state.replySubjectHint = detail.subject || "(无主题)";
  state.replyArmed = true;

  const fromInput = document.querySelector("#send-from");
  const toInput = document.querySelector("#send-to");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if (fromInput) fromInput.value = replyFromAddress(detail);
  if (toInput) toInput.value = replyAddress(detail);
  if (subjectInput) subjectInput.value = replySubject(detail.subject);
  if (textInput) textInput.value = quoteLetter(detail);
  saveComposeDraftNow();

  await switchNav("send");
  openComposer();
  if (textInput) {
    textInput.focus();
    textInput.setSelectionRange(0, 0);
  }
}

export async function loadSendPage() {
  try {
    const scopeParam =
      state.isAdmin && state.adminScope && state.adminScope !== "mine"
        ? "&scope=" + encodeURIComponent(state.adminScope)
        : "";
    const [box, sessionInfo, history] = await Promise.all([
      request("/v1/outbox?limit=100" + scopeParam),
      request("/v1/session"),
      request("/v1/mailbox-history"),
    ]);
    state.sentItems = Array.isArray(box.items) ? box.items : [];
    state.settingsDomains = Array.isArray(sessionInfo.acceptDomains)
      ? sessionInfo.acceptDomains.slice()
      : state.settingsDomains;
    state.dkimDomains = Array.isArray(sessionInfo.dkimDomains) ? sessionInfo.dkimDomains.slice() : [];
    state.allocatedMailboxes = Array.isArray(sessionInfo.mailboxes) ? sessionInfo.mailboxes : [];
    state.sentToday = Number(sessionInfo.sentToday) || 0;
    state.quotaSendPerDay = sessionInfo.quotaSendPerDay;

    const quotaHint = document.querySelector("#send-quota-hint");
    if (quotaHint) {
      if (!state.isAdmin && state.quotaSendPerDay != null) {
        quotaHint.textContent = `今日发信额度 ${state.sentToday}/${state.quotaSendPerDay}。草稿自动暂存在当前浏览器，发出后清除。`;
      } else {
        quotaHint.textContent = "先存原文，再排队发出。输入内容自动暂存在当前浏览器，发出后清除。";
      }
    }

    renderFromSuggestions(Array.isArray(history.items) ? history.items : []);
    if (!state.replyArmed) restoreDraftIfPresent();
    renderSentList();
    refreshSendNote();
  } catch (err) {
    toast("读取发信失败: " + explain(err));
  }
}

export async function refreshSentList() {
  if (state.currentView !== "send") return;
  try {
    const scopeParam =
      state.isAdmin && state.adminScope && state.adminScope !== "mine"
        ? "&scope=" + encodeURIComponent(state.adminScope)
        : "";
    const box = await request("/v1/outbox?limit=100" + scopeParam);
    const items = Array.isArray(box.items) ? box.items : [];
    const same =
      items.length === state.sentItems.length &&
      items.every((item, index) => {
        const prev = state.sentItems[index];
        return item.id === prev?.id && item.status === prev?.status && item.error === prev?.error;
      });
    if (same) return;
    state.sentItems = items;
    renderSentList();
  } catch {
    // 下次轮询重试
  }
}

export function renderFromSuggestions(items) {
  const list = document.querySelector("#send-from-list");
  if (!list) return;
  list.replaceChildren();
  const seen = new Set();

  if (state.sessionUserId && state.sessionUserId !== "owner") {
    for (const box of state.allocatedMailboxes) {
      if (!box.canSend) continue;
      const addr = box.localpart === "*" ? `mail@${box.domain}` : box.address;
      if (seen.has(addr)) continue;
      seen.add(addr);
      const opt = document.createElement("option");
      opt.value = addr;
      list.append(opt);
    }
    return;
  }

  for (const item of items) {
    const domain = String(item.domain || "").trim().toLowerCase();
    const local = String(item.localpart || "").trim().toLowerCase();
    if (!domain || !local || local === "*") continue;
    const address = local + "@" + domain;
    if (seen.has(address)) continue;
    seen.add(address);
    const option = document.createElement("option");
    option.value = address;
    list.append(option);
  }
}

export function refreshSendNote() {
  const note = document.querySelector("#send-domain-note");
  const badge = document.querySelector("#send-dkim-badge");
  const input = document.querySelector("#send-from");
  if (!note || !input) return;
  const from = normalizeAddress(extractEmail(input.value));
  if (!from) {
    note.hidden = true;
    if (badge) badge.hidden = true;
    return;
  }
  const domain = from.includes("@") ? from.split("@")[1] : "";

  if (state.sessionUserId && state.sessionUserId !== "owner" && !memberCanSendFrom(from)) {
    note.hidden = false;
    note.textContent = "该地址不在当前账号的发信授权范围内。";
    if (badge) {
      badge.hidden = false;
      badge.className = "from-status-chip";
      badge.textContent = "未授权";
    }
    return;
  }

  const knownDomain = state.settingsDomains.includes(domain);
  const hasDkim = state.dkimDomains.includes(domain);

  if (badge) {
    badge.hidden = false;
    if (hasDkim) {
      badge.className = "from-status-chip signed";
      badge.textContent = "DKIM 已配";
    } else if (knownDomain) {
      badge.className = "from-status-chip";
      badge.textContent = "无 DKIM";
    } else {
      badge.className = "from-status-chip";
      badge.textContent = "外部域名";
    }
  }

  if (!knownDomain && (!state.sessionUserId || state.sessionUserId === "owner")) {
    note.hidden = false;
    note.textContent = "该域名尚未加入收信域名，仍可对外发出。";
  } else {
    note.hidden = true;
  }
}

export async function submitSend() {
  const fromInput = document.querySelector("#send-from");
  const toInput = document.querySelector("#send-to");
  const ccInput = document.querySelector("#send-cc");
  const bccInput = document.querySelector("#send-bcc");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  const button = document.querySelector("#btn-send");
  const from = normalizeAddress(extractEmail(fromInput ? fromInput.value : ""));
  const rawParts = splitAddresses(toInput ? toInput.value : "");
  const to = rawParts.map((item) => normalizeAddress(extractEmail(item))).filter(Boolean);
  if (!from || to.length === 0) {
    toast("请填写发件和收件地址");
    return;
  }
  if (!memberCanSendFrom(from)) {
    toast("当前账号无权使用该发件地址");
    return;
  }
  if (to.length !== rawParts.length) {
    toast("收件地址格式有误");
    return;
  }
  if (to.length > 20) {
    toast("收件人不超过 20 个");
    return;
  }
  const ccParts = splitAddresses(ccInput ? ccInput.value : "");
  const bccParts = splitAddresses(bccInput ? bccInput.value : "");
  const cc = ccParts.map((item) => normalizeAddress(extractEmail(item))).filter(Boolean);
  const bcc = bccParts.map((item) => normalizeAddress(extractEmail(item))).filter(Boolean);
  if (cc.length !== ccParts.length || bcc.length !== bccParts.length) {
    toast("抄送或密送地址格式有误");
    return;
  }
  if (cc.length > 20 || bcc.length > 20) {
    toast("抄送或密送人数超限");
    return;
  }
  if (button) button.disabled = true;
  try {
    const payload = {
      from,
      to,
      subject: subjectInput ? subjectInput.value : "",
      text: textInput ? textInput.value : "",
    };
    if (cc.length > 0) payload.cc = cc;
    if (bcc.length > 0) payload.bcc = bcc;
    if (state.replyContext && state.replyContext.inReplyTo) {
      payload.inReplyTo = state.replyContext.inReplyTo;
      payload.references = state.replyContext.references;
    }
    const queued = await request("/v1/outbox", {
      method: "POST",
      body: payload,
    });
    rememberFrom(from);
    clearComposeFields();
    toast(queued.dkim === "signed" ? "已排队，并签了 DKIM" : "已排队，没有签名");
    await loadSendPage();
  } catch (err) {
    toast("发出失败: " + explain(err));
  } finally {
    if (button) button.disabled = false;
  }
}

export function splitAddresses(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (/[,;\uff0c\uff1b\u3001\r\n]/.test(text)) {
    return text.split(/[,;\uff0c\uff1b\u3001\r\n]+/).map((part) => part.trim()).filter(Boolean);
  }
  return text.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

export function renderSentList() {
  if (state.currentView !== "send") return;
  listEl.replaceChildren();
  const items = state.sentItems.filter((item) => sentMatches(item, state.sentQuery));
  if (state.sentItems.length === 0) noticeEl.textContent = "还没有发出的信";
  else if (items.length === 0) noticeEl.textContent = "没有符合搜索的信";
  else noticeEl.textContent = "";
  for (const item of items) listEl.append(createSentListItem(item));
}

export function sentMatches(item, needle) {
  if (!needle) return true;
  const to = Array.isArray(item.to) ? item.to.join(" ") : "";
  const haystack = [item.subject, item.from, to, item.error, outboxStatus(item)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function createSentListItem(item) {
  const card = document.createElement("div");
  card.className = "mail-item";
  card.dataset.id = item.id;
  if (item.id === state.readingSentId) card.classList.add("selected");

  const line1 = document.createElement("div");
  line1.className = "item-line1";
  const who = document.createElement("span");
  who.className = "item-from";
  const to = Array.isArray(item.to) ? item.to.filter((part) => typeof part === "string") : [];
  who.textContent = to.length ? to.map(formatRecipient).join(", ") : "没有收件人";
  if (to.length) who.title = to.join(", ");
  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(item.createdAt);
  line1.append(who, time);

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const line3 = document.createElement("div");
  line3.className = "item-line3";
  const snippet = document.createElement("span");
  snippet.className = "item-snippet";
  const bits = [outboxStatus(item), item.dkim === "signed" ? "已签名" : "未签名"];
  if (item.error && item.status !== "sent") bits.push(item.error);
  snippet.textContent = bits.join(" · ");
  line3.append(snippet);
  if (item.status === "error") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-sm";
    retry.textContent = "再试";
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      void retrySent(item.id);
    });
    line3.append(retry);
  }

  card.append(line1, subject, line3);
  card.addEventListener("click", () => void selectSentFromList(item.id));
  return card;
}

export async function retrySent(id) {
  try {
    await request("/v1/outbox/" + encodeURIComponent(id) + "/retry", { method: "POST", body: {} });
    toast("已重新排队");
    await loadSendPage();
  } catch (err) {
    toast("重试失败: " + explain(err));
  }
}
