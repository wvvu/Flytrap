// 发信工作台：撰写邮件、本地自动草稿、发件身份胶囊、DKIM 状态提示、全部回复与转发、已发队列。
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
  forwardBody,
  forwardSubject,
  normalizeAddress,
  normalizeClientId,
  outboxStatus,
  quoteLetter,
  replyAddress,
  replyAllAddresses,
  replySubject,
} from "./util.js";
import { switchNav } from "./nav.js";
import { openSentLetter } from "./mail-view.js";

function draftStorageKey() {
  return DRAFT_KEY_PREFIX + (state.sessionUser || "default");
}

export function lastUsedFrom() {
  try {
    return localStorage.getItem(LAST_FROM_KEY + ":" + (state.sessionUser || "")) || localStorage.getItem(LAST_FROM_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberFrom(from) {
  try {
    if (from) localStorage.setItem(LAST_FROM_KEY + ":" + (state.sessionUser || ""), from);
  } catch {
    // 隐私窗口忽略存储失败
  }
}

export function saveComposeDraft() {
  const from = document.querySelector("#send-from")?.value || "";
  const to = document.querySelector("#send-to")?.value || "";
  const cc = document.querySelector("#send-cc")?.value || "";
  const bcc = document.querySelector("#send-bcc")?.value || "";
  const subject = document.querySelector("#send-subject")?.value || "";
  const text = document.querySelector("#send-text")?.value || "";
  const badge = document.querySelector("#draft-status");

  if (!to.trim() && !cc.trim() && !bcc.trim() && !subject.trim() && !text.trim()) {
    removeStoredDraft();
    if (badge) badge.hidden = true;
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
        savedAt: Date.now(),
      }),
    );
    if (badge) {
      badge.hidden = false;
      badge.textContent = "草稿已自动保存";
    }
  } catch {
    // 忽略配额异常
  }
}

export function restoreComposeDraftIfEmpty() {
  const toInput = document.querySelector("#send-to");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if ((toInput && toInput.value.trim()) || (subjectInput && subjectInput.value.trim()) || (textInput && textInput.value.trim())) {
    return;
  }
  try {
    const raw = localStorage.getItem(draftStorageKey());
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== "object") return;
    const fromInput = document.querySelector("#send-from");
    const ccInput = document.querySelector("#send-cc");
    const bccInput = document.querySelector("#send-bcc");
    if (fromInput && draft.from) fromInput.value = draft.from;
    if (toInput && draft.to) toInput.value = draft.to;
    if (ccInput && draft.cc) {
      ccInput.value = draft.cc;
      const ccRow = document.querySelector("#send-cc-row");
      if (ccRow) ccRow.hidden = false;
    }
    if (bccInput && draft.bcc) {
      bccInput.value = draft.bcc;
      const bccRow = document.querySelector("#send-bcc-row");
      if (bccRow) bccRow.hidden = false;
    }
    if (subjectInput && draft.subject) subjectInput.value = draft.subject;
    if (textInput && draft.text) textInput.value = draft.text;
    if (draft.replyContext) state.replyContext = draft.replyContext;
    const badge = document.querySelector("#draft-status");
    if (badge) {
      badge.hidden = false;
      badge.textContent = "已恢复上次草稿";
    }
  } catch {
    // 忽略损坏草稿
  }
}

export function removeStoredDraft() {
  try {
    localStorage.removeItem(draftStorageKey());
  } catch {
    // 忽略
  }
}

export function clearReplyDraft(clearStorage = false) {
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
  const badge = document.querySelector("#draft-status");
  if (badge) badge.hidden = true;
  if (clearStorage) removeStoredDraft();
}

export function defaultFromCandidate() {
  const remembered = lastUsedFrom();
  if (remembered) return remembered;
  for (const alloc of state.myAllocations) {
    if (!alloc.canSend) continue;
    if (alloc.kind === "exact") return `${alloc.localpart}@${alloc.domain}`;
    if (alloc.kind === "prefix") return `${alloc.localpart.replace(/\*$/, "")}mail@${alloc.domain}`;
    if (alloc.kind === "domain") {
      const handle = state.sessionUser && !state.sessionUser.includes("@") ? state.sessionUser : "hello";
      return `${handle}@${alloc.domain}`;
    }
  }
  return "";
}

export function replyFromAddress(detail) {
  const to = detail && detail.envelopeTo;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  const first = list.map((item) => normalizeAddress(extractEmail(String(item)))).find(Boolean);
  return first || defaultFromCandidate();
}

export function openComposer() {
  state.readingSentId = null;
  if (viewMail) viewMail.hidden = true;
  if (viewSend) viewSend.hidden = false;
  document.querySelectorAll("#list .mail-item").forEach((el) => el.classList.remove("selected"));
  setMobilePane("detail");
  restoreComposeDraftIfEmpty();
  const fromInput = document.querySelector("#send-from");
  if (fromInput && !fromInput.value.trim()) fromInput.value = defaultFromCandidate();
  refreshSendNote();
  document.querySelector("#send-to")?.focus();
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

export async function startReply(includeAll = false) {
  const detail = state.openDetail;
  if (!detail || !replyAddress(detail)) return;
  const parent = normalizeClientId(detail.messageId);
  const prior = Array.isArray(detail.references)
    ? detail.references.map((item) => normalizeClientId(item)).filter(Boolean)
    : [];
  const references = capReplyRefs(parent ? (prior.includes(parent) ? prior : prior.concat(parent)) : prior);
  state.replyContext = parent ? { inReplyTo: parent, references } : null;
  state.replyArmed = true;

  const chosenFrom = replyFromAddress(detail);
  const recipients = includeAll ? replyAllAddresses(detail, chosenFrom) : { to: replyAddress(detail), cc: [] };

  const fromInput = document.querySelector("#send-from");
  const toInput = document.querySelector("#send-to");
  const ccInput = document.querySelector("#send-cc");
  const ccRow = document.querySelector("#send-cc-row");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if (fromInput) fromInput.value = chosenFrom;
  if (toInput) toInput.value = recipients.to;
  if (ccInput) ccInput.value = recipients.cc.join(", ");
  if (ccRow && recipients.cc.length > 0) ccRow.hidden = false;
  if (subjectInput) subjectInput.value = replySubject(detail.subject);
  if (textInput) textInput.value = quoteLetter(detail);
  saveComposeDraft();
  await switchNav("send");
  openComposer();
  if (textInput) {
    textInput.focus();
    textInput.setSelectionRange(0, 0);
  }
}

export async function startForward() {
  const detail = state.openDetail;
  if (!detail) return;
  state.replyContext = null;
  state.replyArmed = true;
  const fromInput = document.querySelector("#send-from");
  const toInput = document.querySelector("#send-to");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if (fromInput) fromInput.value = replyFromAddress(detail);
  if (toInput) toInput.value = "";
  if (subjectInput) subjectInput.value = forwardSubject(detail.subject);
  if (textInput) textInput.value = forwardBody(detail);
  saveComposeDraft();
  await switchNav("send");
  openComposer();
  toInput?.focus();
}

export async function loadSendPage() {
  try {
    const [box, settings, history, dkimRes, sessionRes] = await Promise.all([
      request("/v1/outbox?limit=100"),
      request("/v1/settings"),
      request("/v1/mailbox-history"),
      request("/v1/dkim"),
      request("/v1/session"),
    ]);
    state.sentItems = Array.isArray(box.items) ? box.items : [];
    state.settingsDomains = Array.isArray(settings.acceptDomains) ? settings.acceptDomains.slice() : state.settingsDomains;
    state.dkimKeys = Array.isArray(dkimRes.items) ? dkimRes.items : [];
    if (sessionRes && Array.isArray(sessionRes.allocations)) {
      state.myAllocations = sessionRes.allocations;
      state.quotaSendDay = Number(sessionRes.quotaSendDay) || 100;
      state.sentLast24h = Number(sessionRes.sentLast24h) || 0;
    }

    const quotaPill = document.querySelector("#send-quota-pill");
    if (quotaPill) {
      if (state.sessionRole === "member") {
        quotaPill.hidden = false;
        quotaPill.textContent = `24h 配额 ${state.sentLast24h} / ${state.quotaSendDay}`;
      } else {
        quotaPill.hidden = true;
      }
    }

    renderFromSuggestions(Array.isArray(history.items) ? history.items : []);
    renderIdentityChips(Array.isArray(history.items) ? history.items : []);
    renderSentList();
    restoreComposeDraftIfEmpty();
    const fromInput = document.querySelector("#send-from");
    if (fromInput && !fromInput.value.trim()) fromInput.value = defaultFromCandidate();
    refreshSendNote();
  } catch (err) {
    toast("读取发信队列失败: " + explain(err));
  }
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
    // 下次轮询重试
  }
}

export function collectCandidateIdentities(historyItems) {
  const candidates = [];
  const seen = new Set();
  const push = (addr) => {
    const clean = normalizeAddress(addr);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    candidates.push(clean);
  };

  for (const alloc of state.myAllocations) {
    if (!alloc.canSend) continue;
    if (alloc.kind === "exact") push(`${alloc.localpart}@${alloc.domain}`);
  }
  for (const item of historyItems) {
    const domain = String(item.domain || "").trim().toLowerCase();
    const local = String(item.localpart || "").trim().toLowerCase();
    if (!domain || !local) continue;
    const addr = `${local}@${domain}`;
    if (state.sessionRole === "member") {
      const ok = state.myAllocations.some(
        (a) =>
          a.canSend &&
          a.domain === domain &&
          (a.localpart === "*" ||
            a.localpart === local ||
            local.startsWith(a.localpart + "+") ||
            (a.localpart.endsWith("*") && local.startsWith(a.localpart.slice(0, -1)))),
      );
      if (!ok) continue;
    }
    push(addr);
  }
  for (const alloc of state.myAllocations) {
    if (!alloc.canSend) continue;
    if (alloc.kind === "domain") {
      const handle = state.sessionUser && !state.sessionUser.includes("@") ? state.sessionUser : "hello";
      push(`${handle}@${alloc.domain}`);
    }
  }
  return candidates.slice(0, 16);
}

export function renderFromSuggestions(items) {
  const list = document.querySelector("#send-from-list");
  if (!list) return;
  list.replaceChildren();
  for (const address of collectCandidateIdentities(items)) {
    const option = document.createElement("option");
    option.value = address;
    list.append(option);
  }
}

export function renderIdentityChips(items) {
  const host = document.querySelector("#send-identity-chips");
  if (!host) return;
  host.replaceChildren();
  const candidates = collectCandidateIdentities(items).slice(0, 6);
  if (candidates.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const addr of candidates) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pill pill-xs";
    chip.textContent = addr;
    chip.addEventListener("click", () => {
      const input = document.querySelector("#send-from");
      if (input) {
        input.value = addr;
        refreshSendNote();
        saveComposeDraft();
      }
    });
    host.append(chip);
  }
}

export function refreshSendNote() {
  const note = document.querySelector("#send-domain-note");
  const dkimBadge = document.querySelector("#send-dkim-badge");
  const input = document.querySelector("#send-from");
  if (!input) return;
  const from = normalizeAddress(extractEmail(input.value));
  const domain = from.includes("@") ? from.split("@")[1] : "";

  if (note) {
    if (state.sessionRole === "member") {
      note.hidden = true;
    } else {
      note.hidden = !from || state.settingsDomains.includes(domain);
    }
  }

  if (dkimBadge) {
    if (!domain) {
      dkimBadge.hidden = true;
    } else {
      dkimBadge.hidden = false;
      const hasDkim = state.dkimKeys.some((k) => k.domain === domain);
      dkimBadge.textContent = hasDkim ? "DKIM 已就绪" : "未配 DKIM";
      dkimBadge.className = hasDkim ? "pill pill-xs pill-ok" : "pill pill-xs";
    }
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
    toast("请完整填写发件身份与收件地址");
    return;
  }
  if (to.length !== rawParts.length) {
    toast("收件地址格式存在错误");
    return;
  }
  if (to.length > 20) {
    toast("单封收件地址最多 20 个");
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
    toast("抄送或密送地址过多");
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
    clearReplyDraft(true);
    toast(queued.dkim === "signed" ? "已入队投递（已附带 DKIM 签名）" : "已入队投递（无 DKIM 签名）");
    await loadSendPage();
  } catch (err) {
    toast("提交发信失败: " + explain(err));
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
  if (state.sentItems.length === 0) noticeEl.textContent = "尚无外发邮件记录";
  else if (items.length === 0) noticeEl.textContent = "没有符合搜索条件的已发邮件";
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
  who.textContent = to.length ? to.map(formatRecipient).join(", ") : "无收件方";
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
  const bits = [outboxStatus(item), item.dkim === "signed" ? "DKIM" : "无签名", item.from];
  if (item.error && item.status !== "sent") bits.push(item.error);
  snippet.textContent = bits.filter(Boolean).join(" · ");
  line3.append(snippet);

  if (item.status === "error") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-xs";
    retry.textContent = "重发";
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
    toast("重发失败: " + explain(err));
  }
}
