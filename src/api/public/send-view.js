// 悬浮可折叠写信工作台（含按账号隔离自动草稿、发件身份选择、多附件上传）与独立「已发信」邮件流。
import { DRAFT_KEY_PREFIX, LAST_FROM_KEY } from "./constants.js";
import { setOpenCompose } from "./nav.js";
import { state } from "./state.js";
import {
  btnDiscardDraft,
  composeAttachmentsEl,
  composeIdentitySelect,
  composeSheet,
  composeSheetTitle,
  draftStatusEl,
  listEl,
  mailDetailEl,
  mailEmptyEl,
  noticeEl,
  sendFilesInput,
  threadBox,
  viewMail,
} from "./dom.js";
import { request } from "./net.js";
import { explain, setMobilePane, toast } from "./ui.js";
import {
  capReplyRefs,
  extractEmail,
  formatBytes,
  formatRecipient,
  formatShortTime,
  normalizeAddress,
  normalizeClientId,
  outboxStatus,
  quoteLetter,
  readFileAsBase64,
  replyAddress,
  replySubject,
} from "./util.js";
import { openSentLetter } from "./mail-view.js";

function draftStorageKey() {
  return DRAFT_KEY_PREFIX + (state.username || "default");
}

function lastFromStorageKey() {
  return LAST_FROM_KEY + ":" + (state.username || "default");
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
    // 隐私模式忽略
  }
}

function allowedSenderSuggestions() {
  const list = [];
  const seen = new Set();
  const push = (addr, label) => {
    const clean = normalizeAddress(addr);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push({ address: clean, label: label ? `${label} <${clean}>` : clean });
  };

  for (const mb of state.userMailboxes) {
    if (!mb.canSend) continue;
    if (mb.localpart === "*") {
      const prefix = normalizeAddress(state.username)
        ? state.username.split("@")[0]
        : state.username.replace(/[^a-z0-9._-]/gi, "").toLowerCase() || "mail";
      push(`${prefix}@${mb.domain}`, mb.displayName || state.displayName || "");
    } else {
      push(`${mb.localpart}@${mb.domain}`, mb.displayName || state.displayName || "");
    }
  }

  if (state.role === "admin") {
    for (const [addr, name] of state.mailboxNames.entries()) {
      push(addr, name);
    }
    const firstDomain = state.settingsDomains[0];
    if (list.length === 0 && firstDomain) {
      const fallbackLocal = normalizeAddress(state.username)
        ? state.username.split("@")[0]
        : "admin";
      push(`${fallbackLocal}@${firstDomain}`, state.displayName || "");
    }
  }
  return list;
}

export function syncComposeIdentities() {
  const suggestions = allowedSenderSuggestions();
  const datalist = document.querySelector("#send-from-list");
  if (datalist) {
    datalist.replaceChildren();
    for (const item of suggestions) {
      const opt = document.createElement("option");
      opt.value = item.address;
      if (item.label !== item.address) opt.label = item.label;
      datalist.append(opt);
    }
  }
  if (composeIdentitySelect) {
    composeIdentitySelect.replaceChildren();
    if (suggestions.length > 1) {
      for (const item of suggestions) {
        const opt = document.createElement("option");
        opt.value = item.address;
        opt.textContent = item.label;
        composeIdentitySelect.append(opt);
      }
      composeIdentitySelect.hidden = false;
    } else {
      composeIdentitySelect.hidden = true;
    }
  }
}

function defaultFromAddress() {
  const remembered = lastUsedFrom();
  const suggestions = allowedSenderSuggestions();
  if (state.role !== "admin") {
    if (remembered && suggestions.some((s) => s.address === remembered)) return remembered;
    return suggestions[0]?.address || "";
  }
  return remembered || suggestions[0]?.address || "";
}

export function replyFromAddress(detail) {
  const to = detail && detail.envelopeTo;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  const candidates = list.map((item) => normalizeAddress(extractEmail(String(item)))).filter(Boolean);
  if (state.role === "admin") {
    return candidates[0] || defaultFromAddress();
  }
  for (const addr of candidates) {
    const [local, domain] = addr.split("@");
    const base = local.includes("+") ? local.slice(0, local.indexOf("+")) : local;
    const ok = state.userMailboxes.some(
      (mb) => mb.canSend && mb.domain === domain && (mb.localpart === "*" || mb.localpart === local || mb.localpart === base),
    );
    if (ok) return addr;
  }
  return defaultFromAddress();
}

export function openComposer(options = {}) {
  if (!composeSheet) return;
  syncComposeIdentities();
  composeSheet.hidden = false;
  composeSheet.classList.remove("is-minimized");

  if (!options.keepReply) {
    restoreSavedDraftIfEmpty();
  }

  const fromInput = document.querySelector("#send-from");
  if (fromInput && !fromInput.value.trim()) {
    fromInput.value = defaultFromAddress();
  }
  if (composeIdentitySelect && !composeIdentitySelect.hidden && fromInput) {
    const match = [...composeIdentitySelect.options].some((o) => o.value === fromInput.value.trim().toLowerCase());
    if (match) composeIdentitySelect.value = fromInput.value.trim().toLowerCase();
  }
  refreshSendNote();
  updateComposeTitle();

  const toInput = document.querySelector("#send-to");
  const textInput = document.querySelector("#send-text");
  if (options.focusBody && textInput) {
    textInput.focus();
    textInput.setSelectionRange(0, 0);
  } else if (toInput && !toInput.value.trim()) {
    toInput.focus();
  } else if (textInput) {
    textInput.focus();
  }
}

export function toggleMinimizeComposer() {
  if (!composeSheet || composeSheet.hidden) return;
  composeSheet.classList.remove("is-expanded");
  composeSheet.classList.toggle("is-minimized");
}

export function toggleExpandComposer() {
  if (!composeSheet || composeSheet.hidden) return;
  composeSheet.classList.remove("is-minimized");
  composeSheet.classList.toggle("is-expanded");
}

export function closeComposer() {
  if (!composeSheet) return;
  saveDraftNow();
  composeSheet.hidden = true;
  composeSheet.classList.remove("is-minimized", "is-expanded");
}

function updateComposeTitle() {
  if (!composeSheetTitle) return;
  const sub = document.querySelector("#send-subject")?.value.trim() || "";
  if (sub) composeSheetTitle.textContent = sub;
  else if (state.replyContext) composeSheetTitle.textContent = "回复邮件";
  else composeSheetTitle.textContent = "新邮件";
}

function collectDraftFields() {
  return {
    from: document.querySelector("#send-from")?.value || "",
    to: document.querySelector("#send-to")?.value || "",
    cc: document.querySelector("#send-cc")?.value || "",
    bcc: document.querySelector("#send-bcc")?.value || "",
    subject: document.querySelector("#send-subject")?.value || "",
    text: document.querySelector("#send-text")?.value || "",
    replyContext: state.replyContext,
  };
}

function isDraftMeaningful(draft) {
  if (!draft) return false;
  const sigOnly = state.signature ? `--\n${state.signature.trim()}` : "";
  const trimmedBody = String(draft.text || "").trim();
  const hasBody = Boolean(trimmedBody && trimmedBody !== sigOnly);
  return Boolean(
    String(draft.to || "").trim() ||
    String(draft.cc || "").trim() ||
    String(draft.bcc || "").trim() ||
    String(draft.subject || "").trim() ||
    hasBody,
  );
}

export function scheduleDraftSave() {
  updateComposeTitle();
  window.clearTimeout(state.draftTimer);
  state.draftTimer = window.setTimeout(() => {
    saveDraftNow();
  }, 260);
}

export function saveDraftNow() {
  const draft = collectDraftFields();
  try {
    if (!isDraftMeaningful(draft)) {
      localStorage.removeItem(draftStorageKey());
      paintDraftStatus(false);
      return;
    }
    localStorage.setItem(draftStorageKey(), JSON.stringify(draft));
    paintDraftStatus(true);
  } catch {
    // 存储受限时跳过
  }
}

function paintDraftStatus(hasDraft) {
  if (draftStatusEl) draftStatusEl.textContent = hasDraft ? "草稿已暂存" : "";
  if (btnDiscardDraft) btnDiscardDraft.hidden = !hasDraft;
}

function restoreSavedDraftIfEmpty() {
  const current = collectDraftFields();
  if (isDraftMeaningful(current)) {
    paintDraftStatus(true);
    return;
  }
  try {
    const raw = localStorage.getItem(draftStorageKey());
    if (!raw) {
      applyDefaultSignatureIfBlank();
      paintDraftStatus(false);
      return;
    }
    const draft = JSON.parse(raw);
    if (!isDraftMeaningful(draft)) {
      applyDefaultSignatureIfBlank();
      paintDraftStatus(false);
      return;
    }
    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (el) el.value = val || "";
    };
    if (draft.from) setVal("#send-from", draft.from);
    setVal("#send-to", draft.to);
    setVal("#send-cc", draft.cc);
    setVal("#send-bcc", draft.bcc);
    setVal("#send-subject", draft.subject);
    setVal("#send-text", draft.text);
    state.replyContext = draft.replyContext || null;
    if (draft.cc || draft.bcc) {
      const ccRow = document.querySelector("#send-cc-row");
      const bccRow = document.querySelector("#send-bcc-row");
      if (ccRow) ccRow.hidden = false;
      if (bccRow) bccRow.hidden = false;
    }
    paintDraftStatus(true);
  } catch {
    applyDefaultSignatureIfBlank();
    paintDraftStatus(false);
  }
}

function applyDefaultSignatureIfBlank() {
  const textInput = document.querySelector("#send-text");
  if (!textInput || textInput.value.trim()) return;
  if (state.signature && state.signature.trim()) {
    textInput.value = "\n\n--\n" + state.signature.trim();
  }
}

export function discardComposeDraft() {
  state.replyContext = null;
  state.composeAttachments = [];
  renderComposeAttachments();
  try {
    localStorage.removeItem(draftStorageKey());
  } catch {
    // ignore
  }
  for (const sel of ["#send-to", "#send-cc", "#send-bcc", "#send-subject", "#send-text"]) {
    const el = document.querySelector(sel);
    if (el) el.value = "";
  }
  applyDefaultSignatureIfBlank();
  paintDraftStatus(false);
  updateComposeTitle();
  toast("已清空草稿");
}

export async function handleAttachmentFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  for (const file of fileList) {
    if (state.composeAttachments.length >= 5) {
      toast("单封邮件最多添加 5 个附件");
      break;
    }
    const currentTotal = state.composeAttachments.reduce((acc, a) => acc + a.size, 0);
    if (currentTotal + file.size > 10 * 1024 * 1024) {
      toast("附件总大小不能超过 10MB");
      break;
    }
    try {
      const contentBase64 = await readFileAsBase64(file);
      state.composeAttachments.push({
        filename: file.name || "attachment.bin",
        contentType: file.type || "application/octet-stream",
        size: file.size,
        contentBase64,
      });
    } catch {
      toast("读取附件失败");
    }
  }
  if (sendFilesInput) sendFilesInput.value = "";
  renderComposeAttachments();
}

export function renderComposeAttachments() {
  if (!composeAttachmentsEl) return;
  composeAttachmentsEl.replaceChildren();
  if (state.composeAttachments.length === 0) {
    composeAttachmentsEl.hidden = true;
    return;
  }
  composeAttachmentsEl.hidden = false;
  state.composeAttachments.forEach((att, idx) => {
    const chip = document.createElement("span");
    chip.className = "compose-att-chip";
    const label = document.createElement("span");
    label.textContent = `${att.filename} (${formatBytes(att.size)})`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "compose-att-remove";
    remove.textContent = "×";
    remove.title = "移除附件";
    remove.addEventListener("click", () => {
      state.composeAttachments.splice(idx, 1);
      renderComposeAttachments();
    });
    chip.append(label, remove);
    composeAttachmentsEl.append(chip);
  });
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

  const fromInput = document.querySelector("#send-from");
  const toInput = document.querySelector("#send-to");
  const ccInput = document.querySelector("#send-cc");
  const bccInput = document.querySelector("#send-bcc");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if (fromInput) fromInput.value = replyFromAddress(detail);
  if (toInput) toInput.value = replyAddress(detail);
  if (ccInput) ccInput.value = "";
  if (bccInput) bccInput.value = "";
  if (subjectInput) subjectInput.value = replySubject(detail.subject);
  if (textInput) textInput.value = quoteLetter(detail);

  openComposer({ keepReply: true, focusBody: true });
  scheduleDraftSave();
}

export async function selectSentFromList(id) {
  if (viewMail) viewMail.hidden = false;
  if (threadBox) threadBox.hidden = true;
  document.querySelectorAll("#list .mail-item").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
  setMobilePane("detail");
  await openSentLetter(id);
}

export async function loadSendPage() {
  try {
    const qs = state.role === "admin" && state.mailScope === "all" ? "&scope=all" : "";
    const box = await request("/v1/outbox?limit=100" + qs);
    state.sentItems = Array.isArray(box.items) ? box.items : [];
    syncComposeIdentities();
    renderSentList();
    if (state.sentItems.length > 0 && window.matchMedia("(min-width: 1036px)").matches) {
      const firstId = state.readingSentId || state.sentItems[0]?.id;
      if (firstId) void selectSentFromList(firstId);
    } else {
      if (mailDetailEl) mailDetailEl.hidden = true;
      if (mailEmptyEl) mailEmptyEl.hidden = false;
    }
  } catch (err) {
    toast("读取已发信失败: " + explain(err));
  }
}

export async function refreshSentList() {
  if (state.currentView !== "send") return;
  try {
    const qs = state.role === "admin" && state.mailScope === "all" ? "&scope=all" : "";
    const box = await request("/v1/outbox?limit=100" + qs);
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

export function refreshSendNote() {
  const note = document.querySelector("#send-domain-note");
  const input = document.querySelector("#send-from");
  if (!note || !input) return;
  const from = normalizeAddress(extractEmail(input.value));
  const domain = from.includes("@") ? from.split("@")[1] : "";
  if (state.role !== "admin") {
    note.hidden = true;
    return;
  }
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
    toast("请填写有效的发件与收件地址");
    return;
  }
  if (to.length !== rawParts.length) {
    toast("收件地址格式有误");
    return;
  }
  if (to.length > 20) {
    toast("收件人数量超过上限");
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
    if (state.composeAttachments.length > 0) {
      payload.attachments = state.composeAttachments.map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        contentBase64: att.contentBase64,
      }));
    }

    const queued = await request("/v1/outbox", {
      method: "POST",
      body: payload,
    });

    rememberFrom(from);
    state.replyContext = null;
    state.composeAttachments = [];
    renderComposeAttachments();
    try {
      localStorage.removeItem(draftStorageKey());
    } catch {
      // ignore
    }
    for (const el of [toInput, ccInput, bccInput, subjectInput, textInput]) {
      if (el) el.value = "";
    }
    applyDefaultSignatureIfBlank();
    paintDraftStatus(false);
    if (composeSheet) {
      composeSheet.hidden = true;
      composeSheet.classList.remove("is-minimized", "is-expanded");
    }

    toast(queued.dkim === "signed" ? "已入队发送（已附 DKIM 签名）" : "已入队发送");
    if (state.currentView === "send") {
      await loadSendPage();
    } else if (state.selectedMailId && !state.readingSentId) {
      void import("./mail-view.js").then((m) => m.loadThread(state.selectedMailId, state.mailLoadToken));
    }
  } catch (err) {
    toast("发送失败: " + explain(err));
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
  if (state.sentItems.length === 0) noticeEl.textContent = "尚无已发邮件";
  else if (items.length === 0) noticeEl.textContent = "没有匹配的已发邮件";
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
  who.textContent = to.length ? "→ " + to.map(formatRecipient).join(", ") : "没有收件人";
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
  const bits = [outboxStatus(item), item.dkim === "signed" ? "DKIM" : "未签名"];
  if (item.error && item.status !== "sent") bits.push(item.error);
  snippet.textContent = bits.join(" · ");
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
    toast("已重新入队发送");
    await loadSendPage();
  } catch (err) {
    toast("重发失败: " + explain(err));
  }
}

setOpenCompose(openComposer);
