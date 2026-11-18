// 发信工作台：写信草稿本地自动持久化、快捷发件地址胶囊、DKIM 状态提示、已发列表与失败重发。
import { DRAFT_KEY_PREFIX, LAST_FROM_KEY } from "./constants.js";
import { state } from "./state.js";
import { listEl, noticeEl, threadBox, viewMail, viewSend } from "./dom.js";
import { request } from "./net.js";
import { explain, setMobilePane, toast } from "./ui.js";
import {
  capReplyRefs,
  extractEmail,
  formatRecipient,
  formatShortTime,
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
  return DRAFT_KEY_PREFIX + (state.session.user || "default");
}

export function lastUsedFrom() {
  try {
    return localStorage.getItem(LAST_FROM_KEY + ":" + (state.session.user || "")) || localStorage.getItem(LAST_FROM_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberFrom(from) {
  try {
    if (from) {
      localStorage.setItem(LAST_FROM_KEY + ":" + (state.session.user || ""), from);
      localStorage.setItem(LAST_FROM_KEY, from);
    }
  } catch {
    // 隐私模式下忽略本地存储异常。
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
  try {
    if (!hasContent) {
      localStorage.removeItem(draftStorageKey());
      if (statusEl) statusEl.textContent = "";
      if (discardBtn) discardBtn.hidden = true;
      return;
    }
    const payload = {
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      replyContext: state.replyContext,
      savedAt: Date.now(),
    };
    localStorage.setItem(draftStorageKey(), JSON.stringify(payload));
    if (statusEl) statusEl.textContent = "草稿已暂存本地";
    if (discardBtn) discardBtn.hidden = false;
  } catch {
    // 本地存储满或禁用时不打断输入。
  }
}

export function scheduleDraftSave() {
  window.clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = window.setTimeout(() => saveComposeDraftNow(), 260);
}

export function restoreComposeDraftIfEmpty() {
  const toInput = document.querySelector("#send-to");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if (!toInput || !subjectInput || !textInput) return;
  if (toInput.value.trim() || subjectInput.value.trim() || textInput.value.trim()) return;
  try {
    const raw = localStorage.getItem(draftStorageKey());
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return;
    const fromInput = document.querySelector("#send-from");
    const ccInput = document.querySelector("#send-cc");
    const bccInput = document.querySelector("#send-bcc");
    if (fromInput && saved.from && !fromInput.value.trim()) fromInput.value = saved.from;
    if (saved.to) toInput.value = saved.to;
    if (ccInput && saved.cc) {
      ccInput.value = saved.cc;
      const ccRow = document.querySelector("#send-cc-row");
      if (ccRow) ccRow.hidden = false;
    }
    if (bccInput && saved.bcc) {
      bccInput.value = saved.bcc;
      const bccRow = document.querySelector("#send-bcc-row");
      if (bccRow) bccRow.hidden = false;
    }
    if (saved.subject) subjectInput.value = saved.subject;
    if (saved.text) textInput.value = saved.text;
    if (saved.replyContext) state.replyContext = saved.replyContext;
    const statusEl = document.querySelector("#draft-status");
    const discardBtn = document.querySelector("#btn-discard-draft");
    if (statusEl) statusEl.textContent = "已恢复未发出的草稿";
    if (discardBtn) discardBtn.hidden = false;
  } catch {
    // 忽略损坏草稿。
  }
}

export function discardComposeDraft() {
  clearReplyDraft();
  try {
    localStorage.removeItem(draftStorageKey());
  } catch {
    // ignore
  }
  const statusEl = document.querySelector("#draft-status");
  const discardBtn = document.querySelector("#btn-discard-draft");
  if (statusEl) statusEl.textContent = "";
  if (discardBtn) discardBtn.hidden = true;
}

export function replyFromAddress(detail) {
  const to = detail && detail.envelopeTo;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  const first = list.map((item) => normalizeAddress(extractEmail(String(item)))).find(Boolean);
  return first || lastUsedFrom() || state.session.suggestedFrom?.[0] || "";
}

export function openComposer() {
  state.readingSentId = null;
  if (viewMail) viewMail.hidden = true;
  if (viewSend) viewSend.hidden = false;
  document.querySelectorAll("#list .mail-item").forEach((el) => el.classList.remove("selected"));
  setMobilePane("detail");
  restoreComposeDraftIfEmpty();
  const fromInput = document.querySelector("#send-from");
  if (fromInput && !fromInput.value.trim()) {
    fromInput.value = lastUsedFrom() || state.session.suggestedFrom?.[0] || "";
  }
  refreshSendNote();
  const focusTarget = fromInput && !fromInput.value.trim() ? fromInput : document.querySelector("#send-to");
  focusTarget?.focus();
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

export function clearReplyDraft() {
  state.replyContext = null;
  const toInput = document.querySelector("#send-to");
  const ccInput = document.querySelector("#send-cc");
  const bccInput = document.querySelector("#send-bcc");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if (toInput) toInput.value = "";
  if (ccInput) ccInput.value = "";
  if (bccInput) bccInput.value = "";
  if (subjectInput) subjectInput.value = "";
  if (textInput) textInput.value = "";
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
    const [box, settings, history, dkim, sessionRes] = await Promise.all([
      request("/v1/outbox?limit=100"),
      request("/v1/settings"),
      request("/v1/mailbox-history"),
      request("/v1/dkim").catch(() => ({ items: [] })),
      request("/v1/session").catch(() => null),
    ]);
    if (sessionRes) state.session = { ...state.session, ...sessionRes };
    state.sentItems = Array.isArray(box.items) ? box.items : [];
    state.settingsDomains = Array.isArray(settings.acceptDomains) ? settings.acceptDomains.slice() : state.settingsDomains;
    state.dkimKeys = Array.isArray(dkim.items) ? dkim.items : state.dkimKeys;
    renderFromSuggestions(Array.isArray(history.items) ? history.items : []);
    renderComposeQuotaBanner();
    restoreComposeDraftIfEmpty();
    const fromInput = document.querySelector("#send-from");
    if (fromInput && !fromInput.value.trim()) {
      fromInput.value = lastUsedFrom() || state.session.suggestedFrom?.[0] || "";
    }
    renderSentList();
    refreshSendNote();
  } catch (err) {
    toast("读取发信失败: " + explain(err));
  }
}

function renderComposeQuotaBanner() {
  const quotaEl = document.querySelector("#send-quota-hint");
  const sendBtn = document.querySelector("#btn-send");
  if (!quotaEl) return;
  const s = state.session;
  if (s.isAdmin) {
    quotaEl.textContent = "先落盘原件再异步直投收件域 MX，配置了 DKIM 的域名会自动签名。";
    if (sendBtn) sendBtn.disabled = false;
    return;
  }
  if (!s.canSend || s.dailySendLimit <= 0) {
    quotaEl.textContent = "当前账号未开启外发邮件权限。";
    if (sendBtn) sendBtn.disabled = true;
    return;
  }
  quotaEl.textContent = `24 小时发信额度：已用 ${s.sentLast24h || 0} / ${s.dailySendLimit} 封`;
  if (sendBtn) sendBtn.disabled = s.sentLast24h >= s.dailySendLimit;
}

export async function refreshSentList() {
  if (state.currentView !== "send") return;
  try {
    const box = await request("/v1/outbox?limit=100");
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
    // 下次轮询重试。
  }
}

export function renderFromSuggestions(items) {
  const list = document.querySelector("#send-from-list");
  const quickHost = document.querySelector("#send-from-quick");
  if (list) list.replaceChildren();
  if (quickHost) quickHost.replaceChildren();

  const seen = new Set();
  const candidates = [];

  for (const suggested of state.session.suggestedFrom || []) {
    if (suggested && !seen.has(suggested)) {
      seen.add(suggested);
      candidates.push(suggested);
    }
  }
  for (const item of items) {
    const domain = String(item.domain || "").trim().toLowerCase();
    const local = String(item.localpart || "").trim().toLowerCase();
    if (!domain || !local) continue;
    const address = local + "@" + domain;
    if (seen.has(address)) continue;
    seen.add(address);
    candidates.push(address);
  }

  for (const address of candidates) {
    if (list) {
      const option = document.createElement("option");
      option.value = address;
      list.append(option);
    }
  }

  if (quickHost) {
    const top = candidates.slice(0, 5);
    quickHost.hidden = top.length === 0;
    for (const addr of top) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "quick-addr-chip";
      chip.textContent = addr;
      chip.addEventListener("click", () => {
        const fromInput = document.querySelector("#send-from");
        if (fromInput) {
          fromInput.value = addr;
          refreshSendNote();
          scheduleDraftSave();
        }
      });
      quickHost.append(chip);
    }
  }
}

export function refreshSendNote() {
  const note = document.querySelector("#send-domain-note");
  const input = document.querySelector("#send-from");
  if (!note || !input) return;
  const from = normalizeAddress(extractEmail(input.value));
  if (!from) {
    note.hidden = true;
    return;
  }
  const domain = from.split("@")[1] || "";
  const hasDkim = state.dkimKeys.some((k) => k.domain === domain);
  const inAccept = state.settingsDomains.includes(domain);

  if (!state.session.isAdmin) {
    const allowed = (state.session.allocations || []).some((a) => a.canSend && matchesClientAlloc(from, a));
    if (!allowed) {
      note.className = "send-note warn";
      note.textContent = "该地址不在当前账号获准发信的规则范围内。";
      note.hidden = false;
      return;
    }
  }

  if (!inAccept) {
    note.className = "send-note warn";
    note.textContent = hasDkim
      ? "该域名不在收信列表，但已配置 DKIM，发出时将签名。"
      : "该域名尚未加入收信列表且无 DKIM，仍可尝试发出。";
    note.hidden = false;
    return;
  }

  note.className = hasDkim ? "send-note ok" : "send-note";
  note.textContent = hasDkim ? `将使用 ${domain} 的 DKIM 密钥自动签名投递` : `${domain} 尚未配置 DKIM，将以无签名模式投递`;
  note.hidden = false;
}

function matchesClientAlloc(addr, alloc) {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (domain !== alloc.domain) return false;
  if (alloc.kind === "domain") return true;
  if (alloc.kind === "prefix") return local.startsWith(alloc.localpart);
  const plus = local.indexOf("+");
  const base = plus > 0 ? local.slice(0, plus) : local;
  return local === alloc.localpart || base === alloc.localpart;
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
    toast("请填写发件地址与收件地址");
    return;
  }
  if (to.length !== rawParts.length) {
    toast("收件地址格式有误");
    return;
  }
  if (to.length > 20) {
    toast("收件地址最多 20 个");
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
    toast("抄送或密送最多 20 个");
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
    discardComposeDraft();
    toast(queued.dkim === "signed" ? "已入队投递（DKIM 已签名）" : "已入队投递（未配置 DKIM）");
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
    return text
      .split(/[,;\uff0c\uff1b\u3001\r\n]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return text
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function renderSentList() {
  if (state.currentView !== "send") return;
  listEl.replaceChildren();
  const items = state.sentItems.filter((item) => sentMatches(item, state.sentQuery));
  if (state.sentItems.length === 0) noticeEl.textContent = "尚无发信记录";
  else if (items.length === 0) noticeEl.textContent = "没有符合搜索的发信记录";
  else noticeEl.textContent = "";
  for (const item of items) listEl.append(createSentListItem(item));
}

export function sentMatches(item, needle) {
  if (!needle) return true;
  const to = Array.isArray(item.to) ? item.to.join(" ") : "";
  const haystack = [item.subject, item.from, to, item.error, outboxStatus(item)].filter(Boolean).join(" ").toLowerCase();
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
  const bits = [outboxStatus(item), item.dkim === "signed" ? "DKIM" : "无签名"];
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
    toast("已重新入队投递");
    await loadSendPage();
  } catch (err) {
    toast("重试失败: " + explain(err));
  }
}
