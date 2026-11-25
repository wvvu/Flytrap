// 发信与草稿：按账号隔离的自动草稿保存、发件身份与 DKIM 状态反馈、回复关联与已发信浏览。
import { COMPOSE_WIDE_KEY, DRAFT_KEY_PREFIX, LAST_FROM_KEY } from "./constants.js";
import { state } from "./state.js";
import {
  composeAttachmentsEl,
  composeIdentitySelect,
  composeSheet,
  composeSheetTitle,
  listEl,
  noticeEl,
  sendFilesInput,
  threadBox,
  viewMail,
} from "./dom.js";
import { request } from "./net.js";
import { askConfirm, explain, setMobilePane, toast } from "./ui.js";
import {
  capReplyRefs,
  extractEmail,
  formatBytes,
  formatRecipient,
  formatShortTime,
  memberCanSendFrom,
  normalizeAddress,
  normalizeClientId,
  outboxStatus,
  quoteLetter,
  readFileAsBase64,
  replyAddress,
  replySubject,
} from "./util.js";
import { setResetCompose } from "./nav.js";
import { loadThread, openSentLetter } from "./mail-view.js";

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

export function suggestedSenderForMailbox(box) {
  if (!box) return "";
  if (box.localpart === "*") return `mail@${box.domain}`;
  if (typeof box.localpart === "string" && box.localpart.endsWith("*")) {
    return `${box.localpart.slice(0, -1)}@${box.domain}`;
  }
  return box.address || "";
}

export function defaultSenderAddress() {
  const remembered = lastUsedFrom();
  if (remembered && memberCanSendFrom(remembered)) return remembered;
  if (state.sessionUserId && state.sessionUserId !== "owner" && state.allocatedMailboxes.length > 0) {
    const sendable = state.allocatedMailboxes.find((b) => b.canSend);
    if (sendable) {
      return suggestedSenderForMailbox(sendable);
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
  updateComposeTitle();
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

  const hasCurrentContent = [toInput, ccInput, bccInput, subjectInput, textInput].some((input) => input?.value.trim()) ||
    state.composeAttachments.length > 0 || Boolean(state.replyContext);
  if (hasCurrentContent) {
    syncReplyBanner();
    refreshSendNote();
    updateComposeTitle();
    return;
  }

  if (!draft) {
    if (fromInput && !fromInput.value.trim()) fromInput.value = defaultSenderAddress();
    if (statusEl) statusEl.hidden = true;
    if (discardBtn) discardBtn.hidden = true;
    syncReplyBanner();
    refreshSendNote();
    updateComposeTitle();
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
  updateComposeTitle();
}

export async function discardComposeDraft() {
  if (!(await askConfirm("清空当前暂存的写信草稿？"))) return;
  clearComposeFields();
  toast("草稿已清空");
}

export function clearComposeFields() {
  state.replyContext = null;
  state.replySubjectHint = "";
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
  const statusEl = document.querySelector("#draft-status");
  const discardBtn = document.querySelector("#btn-discard-draft");
  if (statusEl) statusEl.hidden = true;
  if (discardBtn) discardBtn.hidden = true;
  syncReplyBanner();
  updateComposeTitle();
}

export async function handleAttachmentFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const sessionTag = state.sessionUserId;
  for (const file of fileList) {
    if (state.composeAttachments.length >= 5) {
      toast("单封邮件最多添加 5 个附件");
      break;
    }
    const currentTotal = state.composeAttachments.reduce((total, item) => total + item.size, 0);
    if (currentTotal + file.size > 10 * 1024 * 1024) {
      toast("附件总大小不能超过 10MB");
      break;
    }
    try {
      const contentBase64 = await readFileAsBase64(file);
      if (state.sessionUserId !== sessionTag) return;
      if (state.composeAttachments.length >= 5) {
        toast("单封邮件最多添加 5 个附件");
        break;
      }
      const latestTotal = state.composeAttachments.reduce((total, item) => total + item.size, 0);
      if (latestTotal + file.size > 10 * 1024 * 1024) {
        toast("附件总大小不能超过 10MB");
        break;
      }
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
  state.composeAttachments.forEach((attachment, index) => {
    const chip = document.createElement("span");
    chip.className = "compose-att-chip";
    const label = document.createElement("span");
    label.textContent = `${attachment.filename} (${formatBytes(attachment.size)})`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "compose-att-remove";
    remove.textContent = "×";
    remove.title = "移除附件";
    remove.setAttribute("aria-label", `移除附件 ${attachment.filename}`);
    remove.addEventListener("click", () => {
      state.composeAttachments.splice(index, 1);
      renderComposeAttachments();
    });
    chip.append(label, remove);
    composeAttachmentsEl.append(chip);
  });
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

function syncComposeMinimizeBtn() {
  const btn = document.querySelector("#btn-compose-min");
  if (!btn || !composeSheet) return;
  const minimized = composeSheet.classList.contains("is-minimized");
  btn.title = minimized ? "恢复" : "最小化";
  btn.setAttribute("aria-label", minimized ? "恢复写信窗口" : "最小化写信窗口");
}

export function openComposer(options = {}) {
  if (!composeSheet) return;
  composeSheet.hidden = false;
  composeSheet.classList.remove("is-minimized");
  syncComposeMinimizeBtn();
  try {
    composeSheet.classList.toggle("is-expanded", localStorage.getItem(COMPOSE_WIDE_KEY) === "1");
  } catch {
    // 隐私窗口忽略存储异常
  }
  const fromList = document.querySelector("#send-from-list");
  if (state.sessionUserId && state.sessionUserId !== "owner" && fromList && fromList.childElementCount === 0) {
    renderFromSuggestions([]);
  }
  if (!options.keepReply) restoreDraftIfPresent();
  const fromInput = document.querySelector("#send-from");
  if (fromInput && !fromInput.value.trim()) fromInput.value = defaultSenderAddress();
  if (composeIdentitySelect && !composeIdentitySelect.hidden && fromInput) {
    const value = fromInput.value.trim().toLowerCase();
    if ([...composeIdentitySelect.options].some((option) => option.value === value)) {
      composeIdentitySelect.value = value;
    }
  }
  renderComposeQuotaHint();
  syncReplyBanner();
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
  syncComposeMinimizeBtn();
}

export function toggleExpandComposer() {
  if (!composeSheet || composeSheet.hidden) return;
  composeSheet.classList.remove("is-minimized");
  composeSheet.classList.toggle("is-expanded");
  syncComposeMinimizeBtn();
  try {
    localStorage.setItem(COMPOSE_WIDE_KEY, composeSheet.classList.contains("is-expanded") ? "1" : "0");
  } catch {
    // 隐私窗口忽略存储异常
  }
}

export function closeComposer() {
  if (!composeSheet) return;
  saveComposeDraftNow();
  composeSheet.hidden = true;
  composeSheet.classList.remove("is-minimized", "is-expanded");
  syncComposeMinimizeBtn();
}

export function collapseExpandedComposer() {
  if (!composeSheet || composeSheet.hidden || !composeSheet.classList.contains("is-expanded")) return false;
  composeSheet.classList.remove("is-expanded");
  return true;
}

export function updateComposeTitle() {
  if (!composeSheetTitle) return;
  const subject = document.querySelector("#send-subject")?.value.trim() || "";
  composeSheetTitle.textContent = subject || (state.replyContext ? "回复邮件" : "新邮件");
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

  const fromInput = document.querySelector("#send-from");
  const toInput = document.querySelector("#send-to");
  const subjectInput = document.querySelector("#send-subject");
  const textInput = document.querySelector("#send-text");
  if (fromInput) fromInput.value = replyFromAddress(detail);
  if (toInput) toInput.value = replyAddress(detail);
  if (subjectInput) subjectInput.value = replySubject(detail.subject);
  if (textInput) textInput.value = quoteLetter(detail);
  saveComposeDraftNow();

  openComposer({ keepReply: true, focusBody: true });
}

function renderComposeQuotaHint() {
  const quotaHint = document.querySelector("#send-quota-hint");
  if (!quotaHint) return;
  if (!state.isAdmin && state.quotaSendPerDay != null) {
    quotaHint.textContent = `今日发信额度 ${state.sentToday}/${state.quotaSendPerDay}。草稿自动暂存在当前浏览器，发出后清除。`;
  } else {
    quotaHint.textContent = "先存原文，再排队发出。输入内容自动暂存在当前浏览器，发出后清除。";
  }
}

export async function loadSendPage() {
  const token = ++state.sendLoadToken;
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
    if (state.currentView !== "send" || token !== state.sendLoadToken) return;
    state.sentItems = Array.isArray(box.items) ? box.items : [];
    state.settingsDomains = Array.isArray(sessionInfo.acceptDomains)
      ? sessionInfo.acceptDomains.slice()
      : state.settingsDomains;
    state.dkimDomains = Array.isArray(sessionInfo.dkimDomains) ? sessionInfo.dkimDomains.slice() : [];
    state.allocatedMailboxes = Array.isArray(sessionInfo.mailboxes) ? sessionInfo.mailboxes : [];
    state.sentToday = Number(sessionInfo.sentToday) || 0;
    state.quotaSendPerDay = sessionInfo.quotaSendPerDay;

    renderComposeQuotaHint();
    renderFromSuggestions(Array.isArray(history.items) ? history.items : []);
    restoreDraftIfPresent();
    renderSentList();
    refreshSendNote();
  } catch (err) {
    if (state.currentView !== "send" || token !== state.sendLoadToken) return;
    toast("读取发信失败: " + explain(err));
  }
}

export async function refreshSentList() {
  if (state.currentView !== "send") return;
  const token = state.sendLoadToken;
  try {
    const scopeParam =
      state.isAdmin && state.adminScope && state.adminScope !== "mine"
        ? "&scope=" + encodeURIComponent(state.adminScope)
        : "";
    const box = await request("/v1/outbox?limit=100" + scopeParam);
    if (state.currentView !== "send" || token !== state.sendLoadToken) return;
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
  const candidates = [];
  const seen = new Set();
  const add = (address) => {
    if (!address || seen.has(address)) return;
    seen.add(address);
    candidates.push(address);
  };

  if (state.sessionUserId && state.sessionUserId !== "owner") {
    for (const box of state.allocatedMailboxes) {
      if (box.canSend) add(suggestedSenderForMailbox(box));
    }
  } else {
    for (const item of items) {
      const domain = String(item.domain || "").trim().toLowerCase();
      const local = String(item.localpart || "").trim().toLowerCase();
      if (domain && local && local !== "*") add(local + "@" + domain);
    }
  }

  list.replaceChildren();
  if (composeIdentitySelect) composeIdentitySelect.replaceChildren();
  for (const address of candidates) {
    const option = document.createElement("option");
    option.value = address;
    list.append(option);
    if (composeIdentitySelect) {
      const choice = document.createElement("option");
      choice.value = address;
      choice.textContent = address;
      composeIdentitySelect.append(choice);
    }
  }
  if (composeIdentitySelect) {
    composeIdentitySelect.hidden = candidates.length < 2;
    const current = document.querySelector("#send-from")?.value.trim().toLowerCase() || "";
    if (candidates.includes(current)) composeIdentitySelect.value = current;
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
  if (!from || rawParts.length === 0) {
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
    if (state.composeAttachments.length > 0) {
      payload.attachments = state.composeAttachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        contentBase64: attachment.contentBase64,
      }));
    }
    const queued = await request("/v1/outbox", {
      method: "POST",
      body: payload,
    });
    rememberFrom(from);
    clearComposeFields();
    closeComposer();
    toast(queued.dkim === "signed" ? "已排队，并签了 DKIM" : "已排队，没有签名");
    if (state.currentView === "send") {
      await loadSendPage();
    } else {
      if (state.selectedMailId) void loadThread(state.selectedMailId, state.mailLoadToken);
      request("/v1/session").then((sessionInfo) => {
        state.sentToday = Number(sessionInfo.sentToday) || 0;
        state.quotaSendPerDay = sessionInfo.quotaSendPerDay;
        renderComposeQuotaHint();
      }).catch(() => {});
    }
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
  const domain = (state.domainFilter || "").trim().toLowerCase();
  const items = state.sentItems.filter((item) => sentMatches(item, state.sentQuery, domain));
  if (state.sentItems.length === 0) noticeEl.textContent = "还没有发出的信";
  else if (items.length === 0) noticeEl.textContent = domain && !state.sentQuery ? "该域名下还没有发出的信" : "没有符合搜索的信";
  else noticeEl.textContent = "";
  for (const item of items) listEl.append(createSentListItem(item));
}

export function sentMatches(item, needle, domain = "") {
  if (domain) {
    const fromAddr = extractEmail(item.from || "").toLowerCase();
    const fromDomain = fromAddr.includes("@") ? fromAddr.slice(fromAddr.lastIndexOf("@") + 1) : "";
    if (fromDomain !== domain) return false;
  }
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

  const line2 = document.createElement("div");
  line2.className = "item-line2";

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const badges = document.createElement("div");
  badges.className = "item-badges";

  const statusTag = document.createElement("span");
  statusTag.className = "verdict-tag sent-status-tag";
  statusTag.dataset.status = item.status || "queued";
  statusTag.textContent = outboxStatus(item);
  const bits = [outboxStatus(item), item.dkim === "signed" ? "已签名" : "未签名"];
  if (item.error && item.status !== "sent") bits.push(item.error);
  statusTag.title = bits.join(" · ");
  badges.append(statusTag);

  if (item.status === "error") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "otp-pill";
    retry.textContent = "再试";
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      void retrySent(item.id);
    });
    badges.append(retry);
  }

  line2.append(subject, badges);
  card.append(line1, line2);
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

export function resetComposeForAccount() {
  window.clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = 0;
  if (composeSheet && !composeSheet.hidden) saveComposeDraftNow();
  if (composeSheet) {
    composeSheet.hidden = true;
    composeSheet.classList.remove("is-minimized", "is-expanded");
  }
  state.replyContext = null;
  state.replySubjectHint = "";
  state.replyArmed = false;
  state.composeAttachments = [];
  for (const selector of ["#send-from", "#send-to", "#send-cc", "#send-bcc", "#send-subject", "#send-text"]) {
    const input = document.querySelector(selector);
    if (input) input.value = "";
  }
  const status = document.querySelector("#draft-status");
  const discard = document.querySelector("#btn-discard-draft");
  if (status) status.hidden = true;
  if (discard) discard.hidden = true;
  document.querySelector("#send-from-list")?.replaceChildren();
  if (composeIdentitySelect) {
    composeIdentitySelect.replaceChildren();
    composeIdentitySelect.hidden = true;
  }
  const note = document.querySelector("#send-domain-note");
  if (note) {
    note.hidden = true;
    note.textContent = "";
  }
  const badge = document.querySelector("#send-dkim-badge");
  if (badge) {
    badge.hidden = true;
    badge.textContent = "";
  }
  renderComposeAttachments();
  syncReplyBanner();
  updateComposeTitle();
  syncComposeMinimizeBtn();
}

setResetCompose(resetComposeForAccount);
