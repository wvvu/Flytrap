// 邮件流与详情主视图：收件箱、星标、已拦截、垃圾桶、多选批量处理、星标、未读、OTP 提取与沙箱高度调节。
import { state } from "./state.js";
import {
  attachmentCountEl,
  attachmentsList,
  authBox,
  authChips,
  batchBar,
  batchCountEl,
  btnBatchDelete,
  btnBatchRestore,
  btnBatchTrash,
  btnBlockMail,
  btnDeleteMail,
  btnDownloadEml,
  btnExpandPreview,
  btnLoadImages,
  btnReclassify,
  btnReply,
  btnRestoreMail,
  btnStarDetail,
  btnTrashMail,
  btnUnreadMail,
  detailFrom,
  detailModelVerdict,
  detailSubject,
  detailSummary,
  detailTime,
  detailTo,
  detailVerdictRow,
  detailVerdictSelect,
  emptyTrashBtn,
  filterSelect,
  labelInput,
  listEl,
  mailDetailEl,
  mailEmptyEl,
  mailLoadingEl,
  mailSandbox,
  noticeEl,
  otpBanner,
  otpCodeEl,
  plainTextBody,
  queryInput,
  rawHeaders,
  sandboxWrap,
  sectionAttachments,
  sectionSignals,
  sectionUrls,
  signalsCountEl,
  signalsList,
  threadBox,
  threadList,
  trashQueryInput,
  urlCountEl,
  urlsList,
  verdictBar,
  verdictPercent,
} from "./dom.js";
import { request } from "./net.js";
import {
  askConfirm,
  createAuthChip,
  explain,
  findByDataId,
  formatRawHeaders,
  makeSvgIcon,
  refreshUnread,
  setGlyph,
  setMobilePane,
  syncReadAllButtons,
  toast,
} from "./ui.js";
import {
  extractEmail,
  extractOtpCode,
  formatBytes,
  formatFrom,
  formatFullTime,
  formatListSender,
  formatRecipients,
  formatShortRecipient,
  formatShortTime,
  outboxStatus,
  replyAddress,
} from "./util.js";
import { showLogin } from "./auth.js";
import { labelName, renderBlockList } from "./settings-view.js";

function scopeQuerySuffix(prefix = "&") {
  return state.role === "admin" && state.mailScope === "all" ? `${prefix}scope=all` : "";
}

export function syncListLabel() {
  if (!labelInput) return;
  if (state.currentView === "inbox") {
    labelInput.value = state.inboxPromoOnly ? "unsolicited-admin" : "legit";
  } else if (state.currentView === "spam") {
    labelInput.value = filterSelect ? filterSelect.value : "not-legit";
  } else {
    labelInput.value = "";
  }
}

export function staysInList(newLabel) {
  if (state.currentView === "starred") return true;
  if (state.currentView === "inbox") return newLabel === (state.inboxPromoOnly ? "unsolicited-admin" : "legit");
  if (state.currentView !== "spam") return true;
  const filter = filterSelect ? filterSelect.value : "not-legit";
  if (!filter) return true;
  if (filter === "not-legit") return Boolean(newLabel) && newLabel !== "legit";
  return newLabel === filter;
}

export function clearSelection() {
  state.selectedIds.clear();
  state.lastCheckedId = null;
  if (listEl) {
    listEl.classList.remove("selecting");
    for (const card of listEl.querySelectorAll(".mail-item")) {
      card.classList.remove("checked");
      const box = card.querySelector(".item-check");
      if (box instanceof HTMLInputElement) box.checked = false;
    }
  }
  syncBatchBar();
}

export function selectAllVisible() {
  for (const item of state.currentMessages) {
    state.selectedIds.add(item.id);
  }
  if (listEl) {
    listEl.classList.toggle("selecting", state.selectedIds.size > 0);
    for (const card of listEl.querySelectorAll(".mail-item")) {
      const id = card.dataset.id;
      const on = Boolean(id && state.selectedIds.has(id));
      card.classList.toggle("checked", on);
      const box = card.querySelector(".item-check");
      if (box instanceof HTMLInputElement) box.checked = on;
    }
  }
  syncBatchBar();
}

export function syncBatchBar() {
  if (!batchBar) return;
  const count = state.selectedIds.size;
  const inMailStream =
    state.currentView === "inbox" ||
    state.currentView === "starred" ||
    state.currentView === "spam" ||
    state.currentView === "trash";
  if (!inMailStream || count === 0) {
    batchBar.hidden = true;
    if (listEl) listEl.classList.remove("selecting");
    return;
  }
  batchBar.hidden = false;
  if (listEl) listEl.classList.add("selecting");
  if (batchCountEl) batchCountEl.textContent = `已选 ${count} 封`;
  const isTrash = state.currentView === "trash";
  if (btnBatchTrash) btnBatchTrash.hidden = isTrash;
  if (btnBatchRestore) btnBatchRestore.hidden = !isTrash;
  if (btnBatchDelete) btnBatchDelete.hidden = !isTrash;
}

function toggleCardSelection(id, checked, shiftKey) {
  if (shiftKey && state.lastCheckedId && state.lastCheckedId !== id) {
    const ids = state.currentMessages.map((m) => m.id);
    const a = ids.indexOf(state.lastCheckedId);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [start, end] = a < b ? [a, b] : [b, a];
      for (let i = start; i <= end; i += 1) {
        const cur = ids[i];
        if (!cur) continue;
        if (checked) state.selectedIds.add(cur);
        else state.selectedIds.delete(cur);
      }
    }
  } else if (checked) {
    state.selectedIds.add(id);
  } else {
    state.selectedIds.delete(id);
  }
  state.lastCheckedId = id;
  if (listEl) {
    for (const card of listEl.querySelectorAll(".mail-item")) {
      const cid = card.dataset.id;
      const isChecked = Boolean(cid && state.selectedIds.has(cid));
      card.classList.toggle("checked", isChecked);
      const box = card.querySelector(".item-check");
      if (box instanceof HTMLInputElement) box.checked = isChecked;
    }
  }
  syncBatchBar();
}

export async function runBatchAction(action) {
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  if (action === "delete") {
    if (!(await askConfirm(`永久删除选中的 ${ids.length} 封邮件？此操作无法撤销。`))) return;
  }
  try {
    const qs = scopeQuerySuffix("?");
    const res = await request("/v1/messages/batch" + qs, {
      method: "POST",
      body: { ids, action },
    });
    clearSelection();
    toast(`已处理 ${res.count || 0} 封邮件`);
    void refreshUnread();
    if (state.currentView === "trash") await reloadTrash();
    else await reloadMessages();
  } catch (err) {
    toast("批量操作失败: " + explain(err));
  }
}

export async function handleMarkAllRead(viewMode) {
  const view =
    viewMode ||
    (state.currentView === "spam"
      ? "spam"
      : state.inboxPromoOnly
        ? "promo"
        : "inbox");
  try {
    const qs = scopeQuerySuffix("?");
    const body = { view };
    if (state.recipientFilter) body.to = state.recipientFilter;
    const res = await request("/v1/messages/read-all" + qs, {
      method: "POST",
      body,
    });
    for (const item of state.currentMessages) {
      item.read = true;
    }
    if (listEl) {
      for (const card of listEl.querySelectorAll(".mail-item")) {
        card.classList.remove("unread");
        card.querySelector(".unread-dot")?.remove();
      }
    }
    if (state.openDetail) state.openDetail.read = true;
    syncUnreadButton();
    await refreshUnread();
    toast(res.count ? `已将 ${res.count} 封邮件标为已读` : "当前列表均已读");
  } catch (err) {
    toast("操作失败: " + explain(err));
  }
}

export async function reloadMessages() {
  const token = ++state.listLoadToken;
  state.cursor = null;
  state.loadingMore = false;
  clearSelection();
  listEl.replaceChildren();
  noticeEl.textContent = "";
  const ok = await loadMessagesPage(true, token);
  if (ok === false) return false;
  if (token !== state.listLoadToken) return;
  syncReadAllButtons();
  maybeLoadMore();
}

export async function reloadTrash() {
  const token = ++state.listLoadToken;
  state.cursor = null;
  state.loadingMore = false;
  clearSelection();
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadMessagesPage(true, token);
  if (token !== state.listLoadToken) return;
  maybeLoadMore();
}

export function maybeLoadMore() {
  if (
    state.currentView !== "inbox" &&
    state.currentView !== "starred" &&
    state.currentView !== "spam" &&
    state.currentView !== "trash"
  ) {
    return;
  }
  if (!state.cursor || state.loadingMore) return;
  const remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
  if (remaining < 280) void loadMoreMessages();
}

export async function loadMoreMessages() {
  if (!state.cursor || state.loadingMore) return;
  if (
    state.currentView !== "inbox" &&
    state.currentView !== "starred" &&
    state.currentView !== "spam" &&
    state.currentView !== "trash"
  ) {
    return;
  }
  const token = state.listLoadToken;
  const previous = state.cursor;
  const beforeCount = state.currentMessages.length;
  state.loadingMore = true;
  try {
    await loadMessagesPage(false, token);
  } finally {
    if (token === state.listLoadToken) state.loadingMore = false;
  }
  if (token !== state.listLoadToken) return;
  if (state.cursor && state.cursor !== previous && state.currentMessages.length > beforeCount) maybeLoadMore();
}

export function buildStreamQueryParams(replace) {
  const params = new URLSearchParams();
  if (state.role === "admin" && state.mailScope === "all") {
    params.set("scope", "all");
  }
  if (state.recipientFilter) {
    params.set("to", state.recipientFilter);
  }
  if (state.currentView === "trash") {
    params.set("trashed", "true");
    const tq = trashQueryInput ? trashQueryInput.value.trim() : "";
    if (tq) params.set("q", tq);
  } else if (state.currentView === "starred") {
    params.set("trashed", "false");
    params.set("starred", "true");
    const q = queryInput ? queryInput.value.trim() : "";
    if (q) params.set("q", q);
  } else {
    params.set("trashed", "false");
    syncListLabel();
    if (labelInput.value) params.set("label", labelInput.value);
    const q = queryInput ? queryInput.value.trim() : "";
    if (q) params.set("q", q);
  }
  params.set("limit", "40");
  if (!replace && state.cursor) params.set("cursor", state.cursor);
  return params;
}

export async function loadMessagesPage(replace, token) {
  const params = buildStreamQueryParams(replace);
  try {
    const page = await request("/v1/messages?" + params.toString());
    if (token !== state.listLoadToken) return;
    const items = Array.isArray(page.items) ? page.items : [];
    if (replace) state.currentMessages = items;
    else state.currentMessages = state.currentMessages.concat(items);

    if (replace && items.length === 0) {
      if (state.currentView === "trash") noticeEl.textContent = "垃圾桶为空";
      else if (state.currentView === "starred") noticeEl.textContent = "暂无星标邮件";
      else noticeEl.textContent = "没有匹配的邮件";
    }

    for (const item of items) {
      listEl.append(createMailListItem(item));
    }
    state.cursor = page.nextCursor || null;

    if (replace && items.length > 0 && !state.selectedMailId && !state.skipFirstOpen) {
      if (window.matchMedia("(min-width: 1036px)").matches) {
        void selectMail(items[0].id, { keepListOnNarrow: true });
      }
    }
    return true;
  } catch (err) {
    if (err && err.status === 401) {
      showLogin();
      return false;
    }
    noticeEl.textContent = explain(err);
    return true;
  }
}

export function createMailListItem(item) {
  const card = document.createElement("div");
  card.className = "mail-item";
  card.dataset.id = item.id;
  if (!item.read) card.classList.add("unread");
  if (item.id === state.selectedMailId) card.classList.add("selected");
  if (state.selectedIds.has(item.id)) card.classList.add("checked");

  const line1 = document.createElement("div");
  line1.className = "item-line1";

  const senderGroup = document.createElement("div");
  senderGroup.className = "item-sender-group";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "item-check";
  check.checked = state.selectedIds.has(item.id);
  check.setAttribute("aria-label", "选择邮件");
  check.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleCardSelection(item.id, check.checked, ev.shiftKey);
  });
  senderGroup.append(check);

  if (!item.read) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    senderGroup.append(dot);
  }

  const from = document.createElement("span");
  from.className = "item-from";
  const rawFrom = item.from || item.envelopeFrom || "";
  from.textContent = rawFrom ? formatListSender(rawFrom) : "没有发件人";
  if (rawFrom) from.title = rawFrom;
  senderGroup.append(from);

  const rightMeta = document.createElement("div");
  rightMeta.className = "item-right-meta";

  if (item.attachmentCount && item.attachmentCount > 0) {
    const clip = document.createElement("span");
    clip.className = "item-clip";
    clip.title = `包含 ${item.attachmentCount} 个附件`;
    clip.append(makeSvgIcon("clip"));
    rightMeta.append(clip);
  }

  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(item.receivedAt);
  rightMeta.append(time);

  if (state.mailScope !== "all") {
    const starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "item-star-btn" + (item.starred ? " starred" : "");
    starBtn.title = item.starred ? "取消星标" : "标为星标";
    starBtn.append(makeSvgIcon(item.starred ? "star-fill" : "star"));
    starBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void toggleMailStar(item.id, !item.starred);
    });
    rightMeta.append(starBtn);
  }

  line1.append(senderGroup, rightMeta);

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const line3 = document.createElement("div");
  line3.className = "item-line3";

  const rcptText = item.recipient ? formatShortRecipient(item.recipient) : "";
  if (rcptText) {
    const rcptChip = document.createElement("span");
    rcptChip.className = "item-rcpt-chip";
    rcptChip.textContent = rcptText;
    rcptChip.title = item.recipient;
    line3.append(rcptChip);
  }

  const named = Boolean(item.label) && item.label !== "legit";
  const tag = document.createElement("span");
  tag.className = "verdict-tag";
  tag.dataset.label = item.label || "none";
  tag.hidden = !named;
  if (item.manualOverride) tag.dataset.manual = "1";
  tag.textContent = named ? labelName(item.label) + (item.manualOverride ? " · 已改" : "") : "";
  line3.append(tag);

  line3.hidden = !rcptText && !named;

  card.append(line1, subject, line3);
  card.addEventListener("click", () => void selectMail(item.id));
  return card;
}

export function refreshShownNames() {
  if (
    state.currentView !== "inbox" &&
    state.currentView !== "starred" &&
    state.currentView !== "spam" &&
    state.currentView !== "trash"
  ) {
    return;
  }
  if (listEl) {
    for (const card of listEl.querySelectorAll(".mail-item")) {
      const from = card.querySelector(".item-from");
      if (from instanceof HTMLElement && from.title) from.textContent = formatListSender(from.title);
      const rcpt = card.querySelector(".item-rcpt-chip");
      if (rcpt instanceof HTMLElement && rcpt.title) rcpt.textContent = formatShortRecipient(rcpt.title);
      const tag = card.querySelector(".verdict-tag");
      if (!(tag instanceof HTMLElement)) continue;
      const label = tag.dataset.label || "";
      if (!label || label === "none" || label === "legit") continue;
      tag.textContent = labelName(label) + (tag.dataset.manual ? " · 已改" : "");
    }
  }
  if (detailFrom && detailFrom.title) detailFrom.textContent = formatFrom(detailFrom.title);
  if (detailTo && state.openDetail) {
    detailTo.textContent = formatRecipients(state.openDetail.envelopeTo);
  }
}

function syncStarDetailButton(starred) {
  if (!btnStarDetail) return;
  btnStarDetail.hidden = Boolean(state.readingSentId) || state.mailScope === "all";
  btnStarDetail.classList.toggle("starred", Boolean(starred));
  setGlyph(btnStarDetail, starred ? "star-fill" : "star");
}

function syncUnreadButton() {
  if (!btnUnreadMail) return;
  if (!state.openDetail || state.readingSentId) {
    btnUnreadMail.hidden = true;
    return;
  }
  btnUnreadMail.hidden = false;
  btnUnreadMail.textContent = state.openDetail.read === false ? "标为已读" : "标为未读";
}

export async function toggleMailStar(id, nextStarred) {
  const item = state.currentMessages.find((m) => m.id === id);
  const prev = item ? Boolean(item.starred) : false;
  const target = nextStarred === undefined ? !prev : Boolean(nextStarred);

  if (item) item.starred = target;
  if (state.openDetail && state.openDetail.id === id) {
    state.openDetail.starred = target;
    syncStarDetailButton(target);
  }
  const card = findByDataId(listEl, ".mail-item", id);
  if (card) {
    const btn = card.querySelector(".item-star-btn");
    if (btn) {
      btn.classList.toggle("starred", target);
      btn.replaceChildren(makeSvgIcon(target ? "star-fill" : "star"));
    }
  }

  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/star", {
      method: "POST",
      body: { starred: target },
    });
    if (state.currentView === "starred" && !target) {
      card?.remove();
      state.currentMessages = state.currentMessages.filter((m) => m.id !== id);
    }
  } catch (err) {
    if (item) item.starred = prev;
    toast("星标更新失败: " + explain(err));
  }
}

export async function toggleSelectedReadState() {
  if (!state.selectedMailId || state.readingSentId || !state.openDetail) return;
  const id = state.selectedMailId;
  const qs = scopeQuerySuffix("?");
  const currentlyRead = state.openDetail.read !== false;
  const card = findByDataId(listEl, ".mail-item", id);
  const known = state.currentMessages.find((m) => m.id === id);

  try {
    if (currentlyRead) {
      await request("/v1/messages/" + encodeURIComponent(id) + "/unread" + qs, { method: "POST", body: {} });
      state.openDetail.read = false;
      if (known) known.read = false;
      if (card) {
        card.classList.add("unread");
        const group = card.querySelector(".item-sender-group");
        if (group && !group.querySelector(".unread-dot")) {
          const dot = document.createElement("span");
          dot.className = "unread-dot";
          const fromEl = group.querySelector(".item-from");
          if (fromEl) group.insertBefore(dot, fromEl);
          else group.append(dot);
        }
      }
      toast("已标为未读");
    } else {
      await request("/v1/messages/" + encodeURIComponent(id) + "/read" + qs, { method: "POST", body: {} });
      state.openDetail.read = true;
      if (known) known.read = true;
      if (card) {
        card.classList.remove("unread");
        card.querySelector(".unread-dot")?.remove();
      }
      toast("已标为已读");
    }
    syncUnreadButton();
    void refreshUnread();
  } catch (err) {
    toast("状态修改失败: " + explain(err));
  }
}

export function togglePreviewHeight() {
  state.previewExpanded = !state.previewExpanded;
  if (sandboxWrap) {
    sandboxWrap.classList.toggle("is-expanded", state.previewExpanded);
    if (state.previewExpanded) {
      sandboxWrap.style.height = "980px";
    } else {
      applyEstimatedSandboxHeight(state.currentMailHtml, state.currentMailPlain);
    }
  }
  if (btnExpandPreview) {
    btnExpandPreview.textContent = state.previewExpanded ? "标准高度" : "展开高度";
  }
}

function applyEstimatedSandboxHeight(html, plain) {
  if (!sandboxWrap || state.previewExpanded) return;
  const textLen = String(plain || "").trim().length;
  const htmlLen = String(html || "").trim().length;
  let px = 480;
  if (htmlLen === 0 && textLen < 220) px = 250;
  else if (htmlLen < 900 && textLen < 350) px = 320;
  else if (htmlLen > 12000 || textLen > 2400) px = 640;
  sandboxWrap.style.height = `${px}px`;
}

export async function selectMail(id, options = {}) {
  const token = ++state.mailLoadToken;
  state.selectedMailId = id;
  state.readingSentId = null;
  state.openDetail = null;
  state.currentOtpCode = "";
  state.previewExpanded = false;
  if (sandboxWrap) sandboxWrap.classList.remove("is-expanded");
  if (btnExpandPreview) btnExpandPreview.textContent = "展开高度";
  if (otpBanner) otpBanner.hidden = true;

  showInboundExtras(true);
  if (detailVerdictRow) detailVerdictRow.hidden = false;
  if (detailVerdictSelect) detailVerdictSelect.hidden = false;
  if (authBox) authBox.hidden = false;
  if (btnReply) btnReply.hidden = true;
  if (btnUnreadMail) btnUnreadMail.hidden = true;
  if (threadBox) threadBox.hidden = true;
  state.allowExternalImages = false;
  if (btnLoadImages) {
    btnLoadImages.hidden = true;
    btnLoadImages.disabled = false;
    btnLoadImages.textContent = "显示图片";
  }
  const guard = document.querySelector("#preview-guard");
  if (guard) guard.textContent = "";
  if (!options.keepListOnNarrow) setMobilePane("detail");

  if (sectionSignals) sectionSignals.open = false;
  if (sectionUrls) sectionUrls.open = false;

  document.querySelectorAll(".mail-item").forEach((el) => {
    if (el.dataset.id === id) el.classList.add("selected");
    else el.classList.remove("selected");
  });
  markOpened(id);

  mailEmptyEl.hidden = true;
  mailDetailEl.hidden = true;
  if (mailLoadingEl) mailLoadingEl.hidden = false;
  mailSandbox.removeAttribute("srcdoc");

  try {
    const qs = scopeQuerySuffix("?");
    const detail = await request("/v1/messages/" + encodeURIComponent(id) + qs);
    if (token !== state.mailLoadToken) return;
    detail.read = true;
    state.openDetail = detail;

    if (detailSubject) detailSubject.textContent = detail.subject || "(无主题)";
    syncStarDetailButton(detail.starred);

    const rawFrom = detail.from || detail.envelopeFrom || "";
    if (detailFrom) {
      detailFrom.textContent = rawFrom ? formatFrom(rawFrom) : "没有发件人";
      detailFrom.title = rawFrom;
    }
    if (detailTo) {
      detailTo.textContent = formatRecipients(detail.envelopeTo);
      detailTo.title = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo || "";
    }
    if (detailTime) detailTime.textContent = formatFullTime(detail.receivedAt);

    state.currentFromAddress = extractEmail(rawFrom);
    if (btnReply) btnReply.hidden = !replyAddress(detail);
    syncUnreadButton();

    const isTrashed = Boolean(detail.trashedAt || state.currentView === "trash");
    if (btnBlockMail) btnBlockMail.hidden = !state.currentFromAddress;
    if (btnTrashMail) btnTrashMail.hidden = isTrashed;
    if (btnRestoreMail) btnRestoreMail.hidden = !isTrashed;
    if (btnDeleteMail) btnDeleteMail.hidden = !isTrashed;
    if (btnReclassify) btnReclassify.hidden = isTrashed;

    const storedLabel = typeof detail.aiResult?.label === "string" ? detail.aiResult.label : "";
    const label = storedLabel || "legit";
    if (detailVerdictSelect) {
      detailVerdictSelect.value = label;
      detailVerdictSelect.dataset.label = label;
    }
    const confidence = typeof detail.aiResult?.confidence === "number" ? detail.aiResult.confidence : 0;
    const showProb = Boolean(storedLabel) && storedLabel !== "legit";
    const confidenceChip = document.querySelector(".confidence-chip");
    if (confidenceChip) confidenceChip.hidden = !showProb;
    if (detailModelVerdict) {
      if (detail.aiResult?.manualOverride) {
        const orig = detail.aiResult.originalLabel ? `，原为 ${labelName(detail.aiResult.originalLabel)}` : "";
        detailModelVerdict.textContent = `(已手动调整${orig})`;
      } else if (showProb) {
        detailModelVerdict.textContent = `(模型 ${Math.round(confidence * 100)}%)`;
      } else {
        detailModelVerdict.textContent = "";
      }
    }

    if (verdictBar) verdictBar.style.width = Math.round(confidence * 100) + "%";
    if (verdictPercent) verdictPercent.textContent = Math.round(confidence * 100) + "%";
    if (detailSummary) detailSummary.textContent = detail.aiResult?.summary || "尚未分类";

    const otp = extractOtpCode(detail.subject, detail.parsed?.text);
    state.currentOtpCode = otp;
    if (otpBanner && otpCodeEl) {
      otpCodeEl.textContent = otp;
      otpBanner.hidden = !otp;
    }

    const detailTags = document.querySelector("#detail-tags");
    if (detailTags) {
      detailTags.replaceChildren();
      const tags = Array.isArray(detail.aiResult?.tags) ? detail.aiResult.tags : [];
      for (const name of tags) {
        if (typeof name !== "string" || !name) continue;
        const chip = document.createElement("span");
        chip.className = "mini-tag";
        chip.textContent = name;
        detailTags.append(chip);
      }
    }

    signalsList.replaceChildren();
    const signals = detail.aiResult?.signals || [];
    if (signalsCountEl) signalsCountEl.textContent = String(signals.length);
    if (signals.length === 0) {
      const emptySig = document.createElement("span");
      emptySig.className = "muted";
      emptySig.textContent = "没有额外依据";
      signalsList.append(emptySig);
    } else {
      for (const sig of signals) {
        const chip = document.createElement("div");
        chip.className = "signal-chip";
        const sName = document.createElement("span");
        sName.className = "signal-name";
        sName.textContent = sig.name;
        const sVal = document.createElement("span");
        sVal.className = "signal-val";
        sVal.textContent = sig.value;
        chip.append(sName, sVal);
        signalsList.append(chip);
      }
    }

    urlsList.replaceChildren();
    const urls = detail.parsed?.urls || [];
    urlCountEl.textContent = String(urls.length);
    if (urls.length === 0) {
      const emptyUrl = document.createElement("span");
      emptyUrl.className = "muted";
      emptyUrl.textContent = "没有链接";
      urlsList.append(emptyUrl);
    } else {
      for (const u of urls) {
        const uItem = document.createElement("div");
        uItem.className = "url-item";
        const uLink = document.createElement("a");
        uLink.href = u;
        uLink.target = "_blank";
        uLink.rel = "noopener noreferrer";
        uLink.textContent = u;
        uItem.append(uLink);
        urlsList.append(uItem);
      }
    }

    attachmentsList.replaceChildren();
    const attachments = detail.attachments || [];
    attachmentCountEl.textContent = String(attachments.length);
    if (attachments.length === 0) {
      const emptyAtt = document.createElement("span");
      emptyAtt.className = "muted";
      emptyAtt.textContent = "没有附件";
      attachmentsList.append(emptyAtt);
    } else {
      for (const att of attachments) {
        const attItem = document.createElement("div");
        attItem.className = "attachment-item";
        const attName = document.createElement("span");
        attName.textContent = att.filename || att.sha256;
        const attDl = document.createElement("a");
        attDl.className = "btn-sm";
        attDl.href = "/v1/attachments/" + encodeURIComponent(att.sha256);
        attDl.target = "_blank";
        attDl.download = att.filename || att.sha256;
        attDl.textContent = "下载 (" + formatBytes(att.sizeBytes) + ")";
        attItem.append(attName, attDl);
        attachmentsList.append(attItem);
      }
    }

    btnDownloadEml.href = "/v1/messages/" + encodeURIComponent(id) + "/raw" + qs;
    btnDownloadEml.setAttribute("download", `${detail.sha256 || id}.eml`);

    authChips.replaceChildren();
    if (detail.authResult) {
      const auth = detail.authResult;
      authChips.append(createAuthChip("SPF", auth.spf));
      authChips.append(createAuthChip("DKIM", auth.dkim));
      authChips.append(createAuthChip("DMARC", auth.dmarc));
    }

    state.currentMailPlain = detail.parsed?.text || "";
    plainTextBody.textContent = state.currentMailPlain || "(正文为空)";
    rawHeaders.textContent = formatRawHeaders(detail);
    applyEstimatedSandboxHeight("", state.currentMailPlain);

    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailDetailEl.hidden = false;

    const htmlReady = loadMailHtml(id, token);
    void (async () => {
      const headers = await htmlReady;
      if (token !== state.mailLoadToken) return;
      if (headers && headers.trim()) {
        rawHeaders.textContent = headers;
        return;
      }
      await loadRawHeaders(id, token, detail);
    })();
    void loadThread(id, token);
  } catch (err) {
    if (token !== state.mailLoadToken) return;
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailDetailEl.hidden = false;
    if (btnReply) btnReply.hidden = true;
    if (threadBox) threadBox.hidden = true;
    if (detailSubject) detailSubject.textContent = "无法加载邮件详情";
    if (detailSummary) detailSummary.textContent = explain(err);
  }
}

export async function loadMailHtml(id, token) {
  try {
    const qs = scopeQuerySuffix("?");
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/html" + qs);
    if (token !== state.mailLoadToken) return null;
    state.currentMailHtml = res.html || "";
    applyEstimatedSandboxHeight(state.currentMailHtml, state.currentMailPlain);
    renderSandboxHtml(state.currentMailHtml);
    return typeof res.headers === "string" ? res.headers : null;
  } catch {
    if (token !== state.mailLoadToken) return null;
    state.currentMailHtml = "";
    renderSandboxHtml("");
    return null;
  }
}

export async function loadRawHeaders(id, token, detail) {
  try {
    const qs = scopeQuerySuffix("?");
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/headers" + qs);
    if (token !== state.mailLoadToken) return;
    rawHeaders.textContent = res.headers && res.headers.trim() ? res.headers : formatRawHeaders(detail);
  } catch {
    if (token !== state.mailLoadToken) return;
    rawHeaders.textContent = formatRawHeaders(detail);
  }
}

export function countRemoteImages(html) {
  if (!html) return 0;
  const patterns = [
    /\s(?:src|poster|background)\s*=\s*['"]\s*(?:https?:)?\/\//gi,
    /\s(?:src|poster|background)\s*=\s*(?:https?:)?\/\//gi,
    /\ssrcset\s*=\s*['"][^'"]*(?:https?:)?\/\//gi,
    /url\(\s*['"]?(?:https?:)?\/\//gi,
  ];
  let count = 0;
  for (const pattern of patterns) {
    const found = html.match(pattern);
    if (found) count += found.length;
  }
  return count;
}

export function stripRemoteImages(html) {
  return html
    .replace(/(\s(?:src|poster|background)\s*=\s*)(['"])\s*(?:https?:)?\/\/[^'"]*\2/gi, "$1$2$2")
    .replace(/(\s(?:src|poster|background)\s*=\s*)(?:https?:)?\/\/[^\s>]+/gi, '$1""')
    .replace(/\ssrcset\s*=\s*(['"])[^'"]*(?:https?:)?\/\/[^'"]*\1/gi, " srcset=$1$1")
    .replace(/\ssrcset\s*=\s*[^\s>]*(?:https?:)?\/\/[^\s>]+/gi, ' srcset=""')
    .replace(/url\(\s*(['"]?)(?:https?:)?\/\/[^)'"]*\1\s*\)/gi, "url('')");
}

export function openMailLinks(html) {
  const withoutBase = String(html || "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(['"]?)refresh\1[^>]*>/gi, "");
  return withoutBase.replace(/<a\b([^>]*)>/gi, (_match, attrs) => {
    const href = readAttr(attrs, "href");
    let rest = String(attrs);
    for (const name of ["href", "target", "rel"]) rest = stripAttr(rest, name);
    if (/^https?:\/\//i.test(href)) {
      return `<a${rest} href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">`;
    }
    return `<a${rest} href="#">`;
  });
}

export function readAttr(attrs, name) {
  const quoted = String(attrs).match(new RegExp("\\s" + name + "\\s*=\\s*(['\"])(.*?)\\1", "i"));
  if (quoted) return quoted[2].trim();
  const bare = String(attrs).match(new RegExp("\\s" + name + "\\s*=\\s*([^\\s>]+)", "i"));
  return bare ? bare[1].trim() : "";
}

export function stripAttr(attrs, name) {
  return String(attrs)
    .replace(new RegExp("\\s" + name + "\\s*=\\s*(['\"]).*?\\1", "gi"), "")
    .replace(new RegExp("\\s" + name + "\\s*=\\s*[^\\s>]+", "gi"), "");
}

export function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mailBringsItsOwnCanvas(html) {
  return /<style[\s>]/i.test(html) || /bgcolor\s*=/i.test(html) || /background(?:-color)?\s*:/i.test(html);
}

export async function loadThread(id, token) {
  try {
    const qs = scopeQuerySuffix("?");
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/thread" + qs);
    if (token !== state.mailLoadToken || state.selectedMailId !== id) return;
    renderThread(Array.isArray(res.items) ? res.items : []);
  } catch {
    if (token !== state.mailLoadToken || state.selectedMailId !== id) return;
    renderThread([]);
  }
}

export function renderThread(items) {
  if (!threadBox || !threadList) return;
  state.threadItems = Array.isArray(items) ? items : [];
  if (state.threadItems.length < 2) {
    threadBox.hidden = true;
    threadList.replaceChildren();
    return;
  }
  threadList.replaceChildren();
  for (const item of state.threadItems) {
    const sent = item.kind === "sent";
    const current = state.readingSentId ? sent && item.id === state.readingSentId : item.current === true;
    const row = document.createElement(current ? "div" : "button");
    if (row instanceof HTMLButtonElement) row.type = "button";
    row.className = "thread-row" + (current ? " current" : "");
    const who = document.createElement("span");
    who.className = "thread-who";
    who.textContent = item.from ? formatListSender(item.from) : sent ? "已发出" : "没有发件人";
    const subject = document.createElement("span");
    subject.className = "thread-subject";
    subject.textContent = item.subject || "(无主题)";
    const when = document.createElement("span");
    when.className = "thread-time";
    when.textContent = formatShortTime(item.at);
    row.append(who, subject, when);
    const markText = current ? "当前" : sent ? "已发出" : "";
    if (markText) {
      const mark = document.createElement("span");
      mark.className = "thread-mark";
      mark.textContent = markText;
      row.append(mark);
    }
    if (!current && item.id) {
      const targetId = item.id;
      row.addEventListener("click", () => {
        if (sent) void openSentLetter(targetId);
        else void selectMail(targetId);
      });
    }
    threadList.append(row);
  }
  threadBox.hidden = false;
}

export function showInboundExtras(show) {
  if (sectionSignals) sectionSignals.hidden = !show;
  if (sectionUrls) sectionUrls.hidden = !show;
  if (sectionAttachments) sectionAttachments.hidden = !show;
}

export async function openSentLetter(id) {
  const token = ++state.mailLoadToken;
  state.readingSentId = id;
  try {
    const letter = await request("/v1/outbox/" + encodeURIComponent(id));
    if (token !== state.mailLoadToken || state.readingSentId !== id) return;
    paintSentLetter(letter);
    renderThread(state.threadItems);
  } catch (err) {
    if (token !== state.mailLoadToken) return;
    state.readingSentId = null;
    renderThread(state.threadItems);
    toast("打开发信记录失败: " + explain(err));
  }
}

export function paintSentLetter(letter) {
  showInboundExtras(false);
  if (otpBanner) otpBanner.hidden = true;
  if (btnStarDetail) btnStarDetail.hidden = true;
  if (detailVerdictRow) detailVerdictRow.hidden = false;
  if (detailVerdictSelect) detailVerdictSelect.hidden = true;
  if (authBox) authBox.hidden = true;
  const confidenceChip = document.querySelector(".confidence-chip");
  if (confidenceChip) confidenceChip.hidden = true;
  const detailTags = document.querySelector("#detail-tags");
  if (detailTags) detailTags.replaceChildren();
  state.openDetail = null;
  if (btnReply) btnReply.hidden = true;
  if (btnUnreadMail) btnUnreadMail.hidden = true;
  if (btnReclassify) btnReclassify.hidden = true;
  if (btnBlockMail) btnBlockMail.hidden = true;
  if (btnTrashMail) btnTrashMail.hidden = true;
  if (btnRestoreMail) btnRestoreMail.hidden = true;
  if (btnDeleteMail) btnDeleteMail.hidden = true;

  const status = outboxStatus(letter);
  const dkimInfo = letter.dkim === "signed" ? " · 已签 DKIM" : " · 未签 DKIM";
  if (detailSubject) detailSubject.textContent = letter.subject || "(无主题)";
  if (detailFrom) {
    detailFrom.textContent = letter.from || "没有发件人";
    detailFrom.title = letter.from || "";
  }
  if (detailTo) {
    detailTo.textContent = formatRecipients(letter.to);
    detailTo.title = Array.isArray(letter.to) ? letter.to.join(", ") : "";
  }
  if (detailTime) detailTime.textContent = formatFullTime(letter.createdAt);
  if (detailModelVerdict) detailModelVerdict.textContent = status + dkimInfo;

  const attNote =
    Array.isArray(letter.attachments) && letter.attachments.length > 0
      ? ` · 附件：${letter.attachments.join("、")}`
      : "";
  if (detailSummary) {
    detailSummary.textContent =
      letter.error && letter.status !== "sent"
        ? `${status}${dkimInfo}${attNote}。原因：${letter.error}`
        : `${status}${dkimInfo}${attNote}`;
  }
  if (signalsList) signalsList.replaceChildren();
  if (urlsList) urlsList.replaceChildren();
  if (attachmentsList) attachmentsList.replaceChildren();
  if (authChips) authChips.replaceChildren();
  state.currentMailPlain = letter.text || "";
  state.currentMailHtml = "";
  if (plainTextBody) plainTextBody.textContent = state.currentMailPlain || "(正文为空)";
  if (rawHeaders) rawHeaders.textContent = letter.headers || "";
  if (btnDownloadEml && letter.id) {
    btnDownloadEml.href = "/v1/outbox/" + encodeURIComponent(letter.id) + "/raw";
    btnDownloadEml.setAttribute("download", "sent.eml");
  }
  state.allowExternalImages = false;
  applyEstimatedSandboxHeight("", state.currentMailPlain);
  renderSandboxHtml("");
  switchTab("ai");
  mailEmptyEl.hidden = true;
  if (mailLoadingEl) mailLoadingEl.hidden = true;
  mailDetailEl.hidden = false;
}

export function renderSandboxHtml(html) {
  const remoteCount = countRemoteImages(html);
  const shown = state.allowExternalImages && remoteCount > 0;
  const source = html && html.trim() ? html : escapeHtml(state.currentMailPlain).replace(/\n/g, "<br>");
  const body = shown ? source : stripRemoteImages(source);
  const unstyled = !mailBringsItsOwnCanvas(body);
  const imgSrc = shown ? "http: https: data: cid:" : "data: cid:";
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const pageBg = isDark ? "#121216" : "#ffffff";
  const textColor = isDark ? "#e4e4e7" : "#111827";
  const linkColor = isDark ? "#8ab4f8" : "#0b57d0";
  const trackBg = unstyled ? pageBg : isDark ? "#18181b" : "#f1f5f9";
  const thumbBg = isDark ? "#3f3f46" : "#cbd5e1";
  const thumbHover = isDark ? "#52525b" : "#94a3b8";
  const canvasCss = unstyled
    ? `html,body{background:${pageBg};color:${textColor};}a{color:${linkColor};}`
    : `html{background:${pageBg};}`;
  const scrollbarCss = `:root{color-scheme:${isDark ? "dark" : "light"};}*{scrollbar-width:thin;scrollbar-color:${thumbBg} ${trackBg};}::-webkit-scrollbar{width:9px;height:9px;}::-webkit-scrollbar-track{background:${trackBg};}::-webkit-scrollbar-thumb{background:${thumbBg};border-radius:5px;border:2px solid ${trackBg};}::-webkit-scrollbar-thumb:hover{background:${thumbHover};}::-webkit-scrollbar-corner{background:${trackBg};}`;
  const linked = openMailLinks(body);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:;">`;
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<style>${scrollbarCss}html,body{margin:0;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.65;padding:18px 20px;word-break:break-word;}${canvasCss}img{max-width:100%;height:auto;}</style></head><body>${linked}</body></html>`;
  mailSandbox.setAttribute("srcdoc", doc);
  const hint = document.querySelector("#preview-guard");
  if (hint) {
    hint.textContent = shown
      ? `共 ${remoteCount} 处外链资源已加载`
      : `共 ${remoteCount} 处外链资源未加载`;
  }
  if (btnLoadImages) {
    btnLoadImages.hidden = remoteCount === 0;
    btnLoadImages.disabled = false;
    btnLoadImages.textContent = shown ? "隐藏图片" : "显示图片";
  }
}

export function switchTab(tab) {
  if (tab === "html") tab = "ai";
  if (tab !== "ai" && tab !== "text" && tab !== "raw") return;
  state.currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    if (b.getAttribute("data-tab") === tab) b.classList.add("active");
    else b.classList.remove("active");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const activePanel = document.querySelector("#panel-" + tab);
  if (activePanel) activePanel.classList.add("active");
}

export async function reclassify(id, button) {
  if (button) button.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/reclassify", { method: "POST", body: {} });
    if (button) button.textContent = "已入队";
    setTimeout(() => {
      if (button) {
        button.textContent = "重分类";
        button.disabled = false;
      }
    }, 2000);
  } catch (err) {
    if (button) button.disabled = false;
    toast("触发重分类失败: " + explain(err));
  }
}

export function navigateMail(delta) {
  if (state.currentMessages.length === 0) return;
  const idx = state.currentMessages.findIndex((m) => m.id === state.selectedMailId);
  const nextIdx = Math.max(0, Math.min(state.currentMessages.length - 1, idx + delta));
  if (nextIdx !== idx && state.currentMessages[nextIdx]) {
    void selectMail(state.currentMessages[nextIdx].id);
  }
}

function advanceAfterRemove(id) {
  state.selectedIds.delete(id);
  syncBatchBar();
  const card = findByDataId(listEl, ".mail-item", id);
  if (card) card.remove();
  state.currentMessages = state.currentMessages.filter((m) => m.id !== id);
  const nextCard = listEl.querySelector(".mail-item");
  if (nextCard && nextCard.getAttribute("data-id")) {
    void selectMail(nextCard.getAttribute("data-id"));
  } else {
    state.selectedMailId = null;
    state.currentFromAddress = "";
    state.openDetail = null;
    mailDetailEl.hidden = true;
    mailEmptyEl.hidden = false;
    setMobilePane("list");
  }
}

export async function handleBlockMail() {
  if (!state.selectedMailId || !state.currentFromAddress) return;
  const email = state.currentFromAddress;
  const id = state.selectedMailId;
  if (!(await askConfirm(`将 ${email} 加入黑名单？此后该地址的新来信直接进入垃圾桶。`))) return;
  if (btnBlockMail) btnBlockMail.disabled = true;
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/block", { method: "POST", body: {} });
    state.blockedSenders = Array.isArray(res.blockedSenders) ? res.blockedSenders : state.blockedSenders;
    renderBlockList(state.blockedSenders);
    toast("已加入黑名单并移入垃圾桶");
    void refreshUnread();
    if (state.currentView === "trash") return;
    advanceAfterRemove(id);
  } catch (err) {
    noticeEl.textContent = "加入黑名单失败: " + explain(err);
  } finally {
    if (btnBlockMail) btnBlockMail.disabled = false;
  }
}

export async function handleTrashMail() {
  if (!state.selectedMailId || state.readingSentId) return;
  const id = state.selectedMailId;
  if (btnTrashMail) btnTrashMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/trash", { method: "POST", body: {} });
    toast("已移入垃圾桶");
    void refreshUnread();
    advanceAfterRemove(id);
  } catch (err) {
    noticeEl.textContent = "移入垃圾桶失败: " + explain(err);
  } finally {
    if (btnTrashMail) btnTrashMail.disabled = false;
  }
}

export async function handleRestoreMail() {
  if (!state.selectedMailId) return;
  const id = state.selectedMailId;
  if (btnRestoreMail) btnRestoreMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/restore", { method: "POST", body: {} });
    toast("已从垃圾桶恢复");
    void refreshUnread();
    advanceAfterRemove(id);
  } catch (err) {
    noticeEl.textContent = "恢复邮件失败: " + explain(err);
  } finally {
    if (btnRestoreMail) btnRestoreMail.disabled = false;
  }
}

export async function handleDeleteMail() {
  if (!state.selectedMailId) return;
  if (!(await askConfirm("永久删除此邮件？删除后无法恢复。"))) return;
  const id = state.selectedMailId;
  if (btnDeleteMail) btnDeleteMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id), { method: "DELETE" });
    toast("已彻底删除");
    void refreshUnread();
    advanceAfterRemove(id);
  } catch (err) {
    noticeEl.textContent = "彻底删除失败: " + explain(err);
  } finally {
    if (btnDeleteMail) btnDeleteMail.disabled = false;
  }
}

export async function handleEmptyTrash() {
  if (!(await askConfirm("确定清空垃圾桶内全部邮件？此操作无法撤销。"))) return;
  if (emptyTrashBtn) emptyTrashBtn.disabled = true;
  try {
    const qs = scopeQuerySuffix("?");
    const res = await request("/v1/messages/empty-trash" + qs, { method: "POST", body: {} });
    toast(`垃圾桶已清空（共清除 ${res.count || 0} 封）`);
    state.selectedMailId = null;
    mailDetailEl.hidden = true;
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailEmptyEl.hidden = false;
    setMobilePane("list");
    await reloadTrash();
  } catch (err) {
    noticeEl.textContent = "清空垃圾桶失败: " + explain(err);
  } finally {
    if (emptyTrashBtn) emptyTrashBtn.disabled = false;
  }
}

export function removeStaleMail(items) {
  const kept = new Set(items.map((item) => item.id));
  for (const item of state.currentMessages) {
    if (kept.has(item.id)) continue;
    state.selectedIds.delete(item.id);
    findByDataId(listEl, ".mail-item", item.id)?.remove();
  }
  state.currentMessages = state.currentMessages.filter((item) => kept.has(item.id));
  syncBatchBar();
}

export function mergeFreshMail(items) {
  const known = new Map(state.currentMessages.map((item) => [item.id, item]));
  const fresh = [];
  for (const item of items) {
    const prev = known.get(item.id);
    if (!prev) {
      fresh.push(item);
      continue;
    }
    if (prev.read && !item.read) item.read = true;
    if (
      prev.label === item.label &&
      prev.read === item.read &&
      prev.starred === item.starred
    ) {
      continue;
    }
    prev.label = item.label;
    prev.read = item.read;
    prev.starred = item.starred;
    const card = findByDataId(listEl, ".mail-item", item.id);
    card?.replaceWith(createMailListItem(item));
  }
  if (fresh.length === 0) return;
  state.currentMessages = fresh.concat(state.currentMessages);
  for (let i = fresh.length - 1; i >= 0; i -= 1) {
    listEl.prepend(createMailListItem(fresh[i]));
  }
}

export function markOpened(id) {
  const card = findByDataId(listEl, ".mail-item", id);
  const known = state.currentMessages.find((item) => item.id === id);
  const wasRead = Boolean(known && known.read) || Boolean(card && !card.classList.contains("unread"));
  if (card) {
    card.classList.remove("unread");
    card.querySelector(".unread-dot")?.remove();
  }
  if (known) known.read = true;
  const qs = scopeQuerySuffix("?");
  return request("/v1/messages/" + encodeURIComponent(id) + "/read" + qs, { method: "POST", body: {} })
    .then(() => refreshUnread())
    .catch(() => {
      if (wasRead) return;
      if (known) known.read = false;
      if (card && card.isConnected) card.classList.add("unread");
    });
}
