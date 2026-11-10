// 发信：写信、已发列表、重发、回复草稿。
import { LAST_FROM_KEY } from "./constants.js";
import { state } from "./state.js";
import { listEl, noticeEl, threadBox, viewMail, viewSend } from "./dom.js";
import { request } from "./net.js";
import { explain, setMobilePane, toast } from "./ui.js";
import { capReplyRefs, extractEmail, formatRecipient, formatShortTime, normalizeAddress, normalizeClientId, outboxStatus, quoteLetter, replyAddress, replySubject } from "./util.js";
import { switchNav } from "./nav.js";
import { openSentLetter } from "./mail-view.js";

export function lastUsedFrom() {
  try {
    return localStorage.getItem(LAST_FROM_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberFrom(from) {
  try {
    if (from) localStorage.setItem(LAST_FROM_KEY, from);
  } catch {
    // Private mode or storage off: the next compose just starts blank.
  }
}

export function replyFromAddress(detail) {
  const to = detail && detail.envelopeTo;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  const first = list.map((item) => normalizeAddress(extractEmail(String(item)))).find(Boolean);
  return first || lastUsedFrom();
}

export function openComposer() {
  state.readingSentId = null;
  if (viewMail) viewMail.hidden = true;
  if (viewSend) viewSend.hidden = false;
  document.querySelectorAll("#list .mail-item").forEach((el) => el.classList.remove("selected"));
  setMobilePane("detail");
  const fromInput = document.querySelector("#send-from");
  if (fromInput && !fromInput.value.trim()) fromInput.value = lastUsedFrom();
  document.querySelector("#send-from")?.focus();
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
  await switchNav("send");
  openComposer();
  if (textInput) {
    textInput.focus();
    textInput.setSelectionRange(0, 0);
  }
}

export async function loadSendPage() {
  try {
    const [box, settings, history] = await Promise.all([
      request("/v1/outbox?limit=100"),
      request("/v1/settings"),
      request("/v1/mailbox-history"),
    ]);
    state.sentItems = Array.isArray(box.items) ? box.items : [];
    state.settingsDomains = Array.isArray(settings.acceptDomains) ? settings.acceptDomains.slice() : state.settingsDomains;
    renderFromSuggestions(Array.isArray(history.items) ? history.items : []);
    renderSentList();
    refreshSendNote();
  } catch (err) {
    toast("读取发信失败: " + explain(err));
  }
}

export async function refreshSentList() {
  if (state.currentView !== "send") return;
  try {
    const box = await request("/v1/outbox?limit=100");
    const items = Array.isArray(box.items) ? box.items : [];
    const same = items.length === state.sentItems.length && items.every((item, index) => {
      const prev = state.sentItems[index];
      return item.id === prev?.id && item.status === prev?.status && item.error === prev?.error;
    });
    if (same) return;
    state.sentItems = items;
    renderSentList();
  } catch {
    // The next poll tries again.
  }
}

export function renderFromSuggestions(items) {
  const list = document.querySelector("#send-from-list");
  if (!list) return;
  list.replaceChildren();
  const seen = new Set();
  for (const item of items) {
    const domain = String(item.domain || "").trim().toLowerCase();
    const local = String(item.localpart || "").trim().toLowerCase();
    if (!domain || !local) continue;
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
  const input = document.querySelector("#send-from");
  if (!note || !input) return;
  const from = normalizeAddress(extractEmail(input.value));
  const domain = from.includes("@") ? from.split("@")[1] : "";
  note.hidden = !from || state.settingsDomains.includes(domain);
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
    toast("请填写发件和收件");
    return;
  }
  if (to.length !== rawParts.length) {
    toast("收件地址格式有误");
    return;
  }
  if (to.length > 20) {
    toast("收件太多");
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
    toast("抄送或密送太多");
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
    state.replyContext = null;
    rememberFrom(from);
    if (toInput) toInput.value = "";
    if (ccInput) ccInput.value = "";
    if (bccInput) bccInput.value = "";
    if (subjectInput) subjectInput.value = "";
    if (textInput) textInput.value = "";
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
  const haystack = [item.subject, item.from, to, item.error, outboxStatus(item)].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(needle);
}

export function createSentListItem(item) {
  const card = document.createElement("div");
  card.className = "mail-item";
  card.dataset.id = item.id;

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
