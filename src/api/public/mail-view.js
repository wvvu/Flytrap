// 邮件流与阅读舞台：收件箱、星标、已拦截、垃圾桶、多选批处理、星标/未读切换、智能验证码提取与安全沙箱渲染。
import { state } from "./state.js";
import {
  attachmentCountEl,
  attachmentsList,
  authChips,
  batchBarEl,
  batchCountEl,
  btnBlockMail,
  btnDeleteMail,
  btnDownloadEml,
  btnExpandReader,
  btnForward,
  btnLoadImages,
  btnReclassify,
  btnReply,
  btnReplyAll,
  btnRestoreMail,
  btnStarDetail,
  btnToggleUnread,
  btnTrashMail,
  detailFrom,
  detailModelVerdict,
  detailSubject,
  detailSummary,
  detailTime,
  detailTo,
  detailVerdictSelect,
  emptyTrashBtn,
  filterSelect,
  headerAuthStrip,
  inboxScopeSelect,
  labelInput,
  listEl,
  mailDetailEl,
  mailEmptyEl,
  mailLoadingEl,
  mailSandbox,
  noticeEl,
  otpBanner,
  otpCodeText,
  plainTextBody,
  queryInput,
  rawHeaders,
  sandboxWrap,
  sectionAttachments,
  sectionSignals,
  sectionUrls,
  signalsCountEl,
  signalsList,
  starredQueryInput,
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
  copyText,
  createAuthChip,
  explain,
  findByDataId,
  formatRawHeaders,
  makeIcon,
  refreshUnread,
  setGlyph,
  setMobilePane,
  toast,
} from "./ui.js";
import {
  avatarInitial,
  avatarToneIndex,
  extractEmail,
  extractVerificationCode,
  formatBytes,
  formatFrom,
  formatFromCompact,
  formatFullTime,
  formatRecipients,
  formatShortTime,
  outboxStatus,
  replyAddress,
} from "./util.js";
import { showLogin } from "./auth.js";
import { labelName, renderBlockList } from "./settings-view.js";

export function isMailStreamView(view = state.currentView) {
  return view === "inbox" || view === "starred" || view === "spam" || view === "trash";
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
  if (state.currentView === "starred" || state.currentView === "trash") return true;
  if (state.currentView === "inbox") return newLabel === (state.inboxPromoOnly ? "unsolicited-admin" : "legit");
  if (state.currentView !== "spam") return true;
  const filter = filterSelect ? filterSelect.value : "not-legit";
  if (!filter) return true;
  if (filter === "not-legit") return Boolean(newLabel) && newLabel !== "legit";
  return newLabel === filter;
}

export function clearBatchSelection() {
  state.selectedBatchIds.clear();
  syncBatchBar();
  for (const box of listEl.querySelectorAll(".mail-select-chk")) {
    if (box instanceof HTMLInputElement) box.checked = false;
  }
  for (const card of listEl.querySelectorAll(".mail-item")) {
    card.classList.remove("batch-checked");
  }
}

export function toggleSelectAllBatch() {
  const allIds = state.currentMessages.map((m) => m.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => state.selectedBatchIds.has(id));
  state.selectedBatchIds.clear();
  if (!allSelected) {
    for (const id of allIds) state.selectedBatchIds.add(id);
  }
  for (const card of listEl.querySelectorAll(".mail-item")) {
    const id = card.dataset.id || "";
    const checked = state.selectedBatchIds.has(id);
    card.classList.toggle("batch-checked", checked);
    const box = card.querySelector(".mail-select-chk");
    if (box instanceof HTMLInputElement) box.checked = checked;
  }
  syncBatchBar();
}

export function syncBatchBar() {
  if (!batchBarEl) return;
  const n = state.selectedBatchIds.size;
  if (!isMailStreamView() || n === 0) {
    batchBarEl.hidden = true;
    return;
  }
  batchBarEl.hidden = false;
  if (batchCountEl) batchCountEl.textContent = `已选 ${n}`;
  const isTrash = state.currentView === "trash";
  const trashBtn = document.querySelector("#btn-batch-trash");
  const restoreBtn = document.querySelector("#btn-batch-restore");
  const deleteBtn = document.querySelector("#btn-batch-delete");
  if (trashBtn) trashBtn.hidden = isTrash;
  if (restoreBtn) restoreBtn.hidden = !isTrash;
  if (deleteBtn) deleteBtn.hidden = !isTrash;
}

export async function runBatchAction(action) {
  const ids = [...state.selectedBatchIds];
  if (ids.length === 0) return;
  if (action === "delete") {
    const ok = await askConfirm(`确定彻底移除选中的 ${ids.length} 封邮件吗？此操作不可恢复。`, { okText: "彻底移除" });
    if (!ok) return;
  }
  try {
    const res = await request("/v1/messages/batch", {
      method: "POST",
      body: { ids, action },
    });
    clearBatchSelection();
    toast(`已处理 ${res.count || 0} 封邮件`);
    void refreshUnread();
    if (state.currentView === "trash") await reloadTrash();
    else await reloadMessages();
  } catch (err) {
    toast("批量操作失败: " + explain(err));
  }
}

export async function handleMarkAllRead(scopeOverride) {
  const scope =
    scopeOverride ||
    (state.currentView === "spam" ? "spam" : state.inboxPromoOnly ? "promo" : "inbox");
  try {
    const res = await request("/v1/messages/mark-all-read", {
      method: "POST",
      body: { scope },
    });
    for (const item of state.currentMessages) item.read = true;
    for (const card of listEl.querySelectorAll(".mail-item.unread")) {
      card.classList.remove("unread");
    }
    toast(`已将 ${res.count || 0} 封邮件标为已读`);
    await refreshUnread();
  } catch (err) {
    toast("操作失败: " + explain(err));
  }
}

export async function reloadMessages() {
  const token = ++state.listLoadToken;
  state.cursor = null;
  state.loadingMore = false;
  clearBatchSelection();
  listEl.replaceChildren();
  noticeEl.textContent = "";
  const ok = await loadMessagesPage(true, token);
  if (ok === false) return false;
  if (token !== state.listLoadToken) return;
  maybeLoadMore();
}

export async function reloadTrash() {
  const token = ++state.listLoadToken;
  state.cursor = null;
  state.loadingMore = false;
  clearBatchSelection();
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadMessagesPage(true, token);
  if (token !== state.listLoadToken) return;
  maybeLoadMore();
}

export function maybeLoadMore() {
  if (!isMailStreamView()) return;
  if (!state.cursor || state.loadingMore) return;
  const remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
  if (remaining < 280) void loadMoreMessages();
}

export async function loadMoreMessages() {
  if (!state.cursor || state.loadingMore) return;
  if (!isMailStreamView()) return;
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
  if (state.currentView === "trash") {
    params.set("trashed", "true");
    const tq = trashQueryInput ? trashQueryInput.value.trim() : "";
    if (tq) params.set("q", tq);
  } else if (state.currentView === "starred") {
    params.set("trashed", "false");
    params.set("starred", "true");
    const sq = starredQueryInput ? starredQueryInput.value.trim() : "";
    if (sq) params.set("q", sq);
  } else {
    params.set("trashed", "false");
    syncListLabel();
    if (labelInput && labelInput.value) params.set("label", labelInput.value);
    const q = queryInput ? queryInput.value.trim() : "";
    if (q) params.set("q", q);

    if (state.currentView === "inbox") {
      if (state.quickFilter === "unread") params.set("unread", "true");
      else if (state.quickFilter === "attachments") params.set("hasAttachments", "true");

      const scope = inboxScopeSelect ? inboxScopeSelect.value : state.scopeFilter;
      if (scope && scope.startsWith("domain:")) {
        params.set("domain", scope.slice("domain:".length));
      } else if (scope && scope.startsWith("member:")) {
        params.set("memberId", scope.slice("member:".length));
      } else if (scope && scope.startsWith("to:")) {
        params.set("to", scope.slice("to:".length));
      }
    }
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
      else noticeEl.textContent = "暂无符合当前筛选条件的来信";
    }

    for (const item of items) {
      listEl.append(createMailListItem(item));
    }
    state.cursor = page.nextCursor || null;

    if (replace && items.length > 0 && !state.selectedMailId && !state.skipFirstOpen) {
      void selectMail(items[0].id, { keepListOnNarrow: true });
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
  if (state.selectedBatchIds.has(item.id)) card.classList.add("batch-checked");

  const rowWrap = document.createElement("div");
  rowWrap.className = "mail-item-inner";

  // 左侧头像或勾选框叠加区
  const lead = document.createElement("div");
  lead.className = "mail-lead";
  const rawFrom = item.from || item.envelopeFrom || "";
  const avatar = document.createElement("span");
  avatar.className = `mail-avatar tone-${avatarToneIndex(rawFrom)}`;
  avatar.textContent = avatarInitial(rawFrom);

  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.className = "mail-select-chk";
  chk.checked = state.selectedBatchIds.has(item.id);
  chk.title = "勾选批量操作";
  chk.addEventListener("click", (e) => {
    e.stopPropagation();
    if (chk.checked) state.selectedBatchIds.add(item.id);
    else state.selectedBatchIds.delete(item.id);
    card.classList.toggle("batch-checked", chk.checked);
    syncBatchBar();
  });
  lead.append(avatar, chk);

  // 右侧三行正文区
  const main = document.createElement("div");
  main.className = "mail-main";

  const line1 = document.createElement("div");
  line1.className = "item-line1";

  const fromWrap = document.createElement("div");
  fromWrap.className = "item-from-wrap";
  if (!item.read) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    fromWrap.append(dot);
  }
  const from = document.createElement("span");
  from.className = "item-from";
  from.textContent = rawFrom ? formatFromCompact(rawFrom) : "未知发件方";
  if (rawFrom) from.title = formatFrom(rawFrom);
  fromWrap.append(from);

  const rightMeta = document.createElement("div");
  rightMeta.className = "item-meta-right";
  if (item.attachmentCount > 0) {
    const clip = document.createElement("span");
    clip.className = "item-clip";
    clip.title = `${item.attachmentCount} 个附件`;
    clip.append(makeIcon("clip", "ico-xs"));
    rightMeta.append(clip);
  }
  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(item.receivedAt);

  const starBtn = document.createElement("button");
  starBtn.type = "button";
  starBtn.className = "item-star-btn" + (item.starred ? " is-starred" : "");
  starBtn.title = item.starred ? "取消星标" : "设为星标";
  starBtn.append(makeIcon(item.starred ? "star-fill" : "star", "ico-xs"));
  starBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleStar(item.id, !item.starred);
  });

  rightMeta.append(time, starBtn);
  line1.append(fromWrap, rightMeta);

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const line3 = document.createElement("div");
  line3.className = "item-line3";

  const snippet = document.createElement("span");
  snippet.className = "item-snippet";
  snippet.textContent = item.summary || (Array.isArray(item.envelopeTo) ? item.envelopeTo[0] || "" : "");

  const tag = document.createElement("span");
  tag.className = "verdict-tag";
  tag.dataset.label = item.label || "none";
  const named = Boolean(item.label) && item.label !== "legit";
  tag.hidden = !named;
  if (item.manualOverride) tag.dataset.manual = "1";
  tag.textContent = named ? labelName(item.label) + (item.manualOverride ? " · 手改" : "") : "";

  line3.append(snippet, tag);
  line3.hidden = !snippet.textContent && !named;

  main.append(line1, subject, line3);
  rowWrap.append(lead, main);
  card.append(rowWrap);
  card.addEventListener("click", () => void selectMail(item.id));
  return card;
}

export function refreshShownNames() {
  if (!isMailStreamView()) return;
  if (listEl) {
    for (const card of listEl.querySelectorAll(".mail-item")) {
      const id = card.dataset.id;
      const known = state.currentMessages.find((m) => m.id === id);
      const from = card.querySelector(".item-from");
      if (from instanceof HTMLElement && known) {
        const raw = known.from || known.envelopeFrom || "";
        from.textContent = raw ? formatFromCompact(raw) : "未知发件方";
        from.title = formatFrom(raw);
      }
      const tag = card.querySelector(".verdict-tag");
      if (!(tag instanceof HTMLElement)) continue;
      const label = tag.dataset.label || "";
      if (!label || label === "none" || label === "legit") continue;
      tag.textContent = labelName(label) + (tag.dataset.manual ? " · 手改" : "");
    }
  }
  if (detailFrom && detailFrom.dataset.raw) detailFrom.textContent = formatFrom(detailFrom.dataset.raw);
  if (detailTo && state.openDetail) {
    detailTo.textContent = formatRecipients(state.openDetail.envelopeTo);
  }
}

export async function toggleStar(id, nextStarred) {
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/star", {
      method: "POST",
      body: { starred: Boolean(nextStarred) },
    });
    const starred = Boolean(res.starred);
    const known = state.currentMessages.find((m) => m.id === id);
    if (known) known.starred = starred;
    if (state.openDetail && state.openDetail.id === id) {
      state.openDetail.starred = starred;
      paintDetailStar(starred);
    }
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) {
      if (state.currentView === "starred" && !starred) {
        card.remove();
        state.currentMessages = state.currentMessages.filter((m) => m.id !== id);
      } else {
        const btn = card.querySelector(".item-star-btn");
        if (btn) {
          btn.classList.toggle("is-starred", starred);
          btn.replaceChildren(makeIcon(starred ? "star-fill" : "star", "ico-xs"));
        }
      }
    }
    void refreshUnread();
  } catch (err) {
    toast("星标更新失败: " + explain(err));
  }
}

export function paintDetailStar(starred) {
  if (!btnStarDetail) return;
  btnStarDetail.classList.toggle("is-starred", Boolean(starred));
  setGlyph(btnStarDetail, starred ? "star-fill" : "star");
}

export async function toggleCurrentUnread() {
  const id = state.selectedMailId;
  if (!id || state.readingSentId) return;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/unread", {
      method: "POST",
      body: {},
    });
    const known = state.currentMessages.find((m) => m.id === id);
    if (known) known.read = false;
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) {
      card.classList.add("unread");
      const wrap = card.querySelector(".item-from-wrap");
      if (wrap && !wrap.querySelector(".unread-dot")) {
        const dot = document.createElement("span");
        dot.className = "unread-dot";
        wrap.prepend(dot);
      }
    }
    toast("已标为未读");
    void refreshUnread();
  } catch (err) {
    toast("操作失败: " + explain(err));
  }
}

export function toggleReaderHeight() {
  state.readerExpanded = !state.readerExpanded;
  if (sandboxWrap) sandboxWrap.classList.toggle("expanded", state.readerExpanded);
  if (btnExpandReader) btnExpandReader.textContent = state.readerExpanded ? "收起高度" : "展开高度";
}

export async function selectMail(id, options = {}) {
  const token = ++state.mailLoadToken;
  state.selectedMailId = id;
  state.readingSentId = null;
  state.openDetail = null;
  showInboundExtras(true);
  if (detailVerdictSelect) detailVerdictSelect.hidden = false;
  if (btnStarDetail) btnStarDetail.hidden = false;
  if (btnToggleUnread) btnToggleUnread.hidden = false;
  if (btnReply) btnReply.hidden = true;
  if (btnReplyAll) btnReplyAll.hidden = true;
  if (btnForward) btnForward.hidden = true;
  if (otpBanner) otpBanner.hidden = true;
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
    const detail = await request("/v1/messages/" + encodeURIComponent(id));
    if (token !== state.mailLoadToken) return;
    if (detailSubject) detailSubject.textContent = detail.subject || "(无主题)";
    const rawFrom = detail.from || detail.envelopeFrom || "";
    if (detailFrom) {
      detailFrom.textContent = rawFrom ? formatFrom(rawFrom) : "未知发件方";
      detailFrom.dataset.raw = rawFrom;
      detailFrom.dataset.copy = extractEmail(rawFrom) || rawFrom;
    }
    if (detailTo) {
      const toRaw = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo || "";
      detailTo.textContent = formatRecipients(detail.envelopeTo) || "未知收件方";
      detailTo.dataset.copy = toRaw;
    }
    if (detailTime) detailTime.textContent = formatFullTime(detail.receivedAt);

    state.currentFromAddress = extractEmail(rawFrom);
    state.openDetail = detail;
    paintDetailStar(Boolean(detail.starred));

    const canReply = Boolean(replyAddress(detail));
    if (btnReply) btnReply.hidden = !canReply;
    if (btnReplyAll) {
      const envCount = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.length : 0;
      const toCount = Array.isArray(detail.to) ? detail.to.length : 0;
      btnReplyAll.hidden = !canReply || (envCount <= 1 && toCount <= 1);
    }
    if (btnForward) btnForward.hidden = false;

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
        detailModelVerdict.textContent = `手改（原判 ${labelName(detail.aiResult.originalLabel)}）`;
      } else if (showProb) {
        detailModelVerdict.textContent = `${Math.round(confidence * 100)}%`;
      } else {
        detailModelVerdict.textContent = "";
      }
    }

    if (verdictBar) verdictBar.style.width = Math.round(confidence * 100) + "%";
    if (verdictPercent) verdictPercent.textContent = Math.round(confidence * 100) + "%";
    if (detailSummary) detailSummary.textContent = detail.aiResult?.summary || "正在等待分拣或分拣已关闭。";

    const detailTags = document.querySelector("#detail-tags");
    if (detailTags) {
      detailTags.replaceChildren();
      const tags = Array.isArray(detail.aiResult?.tags) ? detail.aiResult.tags : [];
      detailTags.hidden = tags.length === 0;
      for (const name of tags) {
        if (typeof name !== "string" || !name) continue;
        const chip = document.createElement("span");
        chip.className = "mini-tag";
        chip.textContent = name;
        detailTags.append(chip);
      }
    }

    // 智能验证码检测
    const code = extractVerificationCode(detail.subject, detail.parsed?.text);
    if (otpBanner && otpCodeText) {
      if (code) {
        otpCodeText.textContent = code;
        otpBanner.hidden = false;
      } else {
        otpBanner.hidden = true;
      }
    }

    // 分拣信号
    signalsList.replaceChildren();
    const signals = detail.aiResult?.signals || [];
    if (signalsCountEl) signalsCountEl.textContent = String(signals.length);
    if (sectionSignals) sectionSignals.hidden = signals.length === 0;
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

    // 提取外链
    urlsList.replaceChildren();
    const urls = detail.parsed?.urls || [];
    urlCountEl.textContent = String(urls.length);
    if (sectionUrls) sectionUrls.hidden = urls.length === 0;
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

    // 附件清单
    attachmentsList.replaceChildren();
    const attachments = detail.attachments || [];
    attachmentCountEl.textContent = String(attachments.length);
    if (sectionAttachments) sectionAttachments.hidden = attachments.length === 0;
    for (const att of attachments) {
      const attItem = document.createElement("div");
      attItem.className = "attachment-item";
      const left = document.createElement("div");
      left.className = "attachment-meta";
      left.append(makeIcon("clip", "ico-xs"));
      const attName = document.createElement("span");
      attName.textContent = att.filename || att.sha256.slice(0, 16);
      const attSize = document.createElement("span");
      attSize.className = "muted";
      attSize.textContent = formatBytes(att.sizeBytes);
      left.append(attName, attSize);

      const attDl = document.createElement("a");
      attDl.className = "btn-sm";
      attDl.href = "/v1/attachments/" + encodeURIComponent(att.sha256);
      attDl.target = "_blank";
      attDl.download = att.filename || att.sha256;
      attDl.textContent = "下载附件";
      attItem.append(left, attDl);
      attachmentsList.append(attItem);
    }

    btnDownloadEml.href = "/v1/messages/" + encodeURIComponent(id) + "/raw";
    btnDownloadEml.setAttribute("download", `${detail.sha256 || id}.eml`);

    // 邮件头鉴权胶囊（顶部紧凑条 + 信头页完整展示）
    authChips.replaceChildren();
    if (headerAuthStrip) headerAuthStrip.replaceChildren();
    if (detail.authResult) {
      const auth = detail.authResult;
      authChips.append(
        createAuthChip("SPF", auth.spf, false),
        createAuthChip("DKIM", auth.dkim, false),
        createAuthChip("DMARC", auth.dmarc, false),
      );
      if (auth.arc && auth.arc !== "none") {
        authChips.append(createAuthChip("ARC", auth.arc, false));
      }
      if (headerAuthStrip) {
        headerAuthStrip.append(
          createAuthChip("SPF", auth.spf, true),
          createAuthChip("DKIM", auth.dkim, true),
          createAuthChip("DMARC", auth.dmarc, true),
        );
      }
    }

    state.currentMailPlain = detail.parsed?.text || "";
    plainTextBody.textContent = state.currentMailPlain || "(正文为空)";
    rawHeaders.textContent = formatRawHeaders(detail);
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
    if (detailSubject) detailSubject.textContent = "无法载入邮件详情";
    if (detailSummary) detailSummary.textContent = explain(err);
  }
}

export async function loadMailHtml(id, token) {
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/html");
    if (token !== state.mailLoadToken) return null;
    state.currentMailHtml = res.html || "";
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
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/headers");
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
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/thread");
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
    who.textContent = item.from ? formatFromCompact(item.from) : sent ? "已发出" : "未知发件方";
    const subject = document.createElement("span");
    subject.className = "thread-subject";
    subject.textContent = item.subject || "(无主题)";
    const when = document.createElement("span");
    when.className = "thread-time";
    when.textContent = formatShortTime(item.at);
    row.append(who, subject, when);
    const markText = current ? "当前阅读" : sent ? "已发出" : "";
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
    toast("打开已发邮件失败: " + explain(err));
  }
}

export function paintSentLetter(letter) {
  showInboundExtras(false);
  if (detailVerdictSelect) detailVerdictSelect.hidden = true;
  if (btnStarDetail) btnStarDetail.hidden = true;
  if (btnToggleUnread) btnToggleUnread.hidden = true;
  if (otpBanner) otpBanner.hidden = true;
  if (headerAuthStrip) headerAuthStrip.replaceChildren();
  const confidenceChip = document.querySelector(".confidence-chip");
  if (confidenceChip) confidenceChip.hidden = true;
  const detailTags = document.querySelector("#detail-tags");
  if (detailTags) detailTags.replaceChildren();
  state.openDetail = null;
  if (btnReply) btnReply.hidden = true;
  if (btnReplyAll) btnReplyAll.hidden = true;
  if (btnForward) btnForward.hidden = true;
  if (btnReclassify) btnReclassify.hidden = true;
  if (btnBlockMail) btnBlockMail.hidden = true;
  if (btnTrashMail) btnTrashMail.hidden = true;
  if (btnRestoreMail) btnRestoreMail.hidden = true;
  if (btnDeleteMail) btnDeleteMail.hidden = true;

  const status = outboxStatus(letter);
  if (detailSubject) detailSubject.textContent = letter.subject || "(无主题)";
  if (detailFrom) {
    detailFrom.textContent = letter.from || "未知发件方";
    detailFrom.dataset.copy = letter.from || "";
  }
  if (detailTo) {
    detailTo.textContent = formatRecipients(letter.to);
    detailTo.dataset.copy = Array.isArray(letter.to) ? letter.to.join(", ") : "";
  }
  if (detailTime) detailTime.textContent = formatFullTime(letter.createdAt);
  if (detailModelVerdict) detailModelVerdict.textContent = status;
  if (detailSummary) {
    const dkimText = letter.dkim === "signed" ? "已附带 DKIM 签名" : "未附带 DKIM 签名";
    detailSummary.textContent =
      letter.error && letter.status !== "sent"
        ? `${status} · ${dkimText} · ${letter.error}`
        : `${status} · ${dkimText}`;
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
  renderSandboxHtml("");
  switchTab("ai");
  mailEmptyEl.hidden = true;
  if (mailLoadingEl) mailLoadingEl.hidden = true;
  mailDetailEl.hidden = false;
}

export function renderSandboxHtml(html) {
  const remoteCount = countRemoteImages(html);
  const shown = state.allowExternalImages && remoteCount > 0;
  const source =
    html && html.trim()
      ? html
      : `<div style="white-space:pre-wrap;font-size:15px;line-height:1.7">${escapeHtml(state.currentMailPlain || "(正文为空)")}</div>`;
  const body = shown ? source : stripRemoteImages(source);
  const unstyled = !mailBringsItsOwnCanvas(body);
  const imgSrc = shown ? "http: https: data: cid:" : "data: cid:";
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const pageBg = isDark ? "#13151a" : "#ffffff";
  const textColor = isDark ? "#e4e4e7" : "#18181b";
  const linkColor = isDark ? "#93c5fd" : "#0b57d0";
  const trackBg = unstyled ? pageBg : isDark ? "#18181b" : "#f1f5f9";
  const thumbBg = isDark ? "#3f3f46" : "#cbd5e1";
  const thumbHover = isDark ? "#52525b" : "#94a3b8";
  const canvasCss = unstyled
    ? `html,body{background:${pageBg};color:${textColor};}a{color:${linkColor};}`
    : `html{background:${pageBg};}`;
  const scrollbarCss = `:root{color-scheme:${isDark ? "dark" : "light"};}*{scrollbar-width:thin;scrollbar-color:${thumbBg} ${trackBg};}::-webkit-scrollbar{width:8px;height:8px;}::-webkit-scrollbar-track{background:${trackBg};}::-webkit-scrollbar-thumb{background:${thumbBg};border-radius:4px;}::-webkit-scrollbar-thumb:hover{background:${thumbHover};}`;
  const linked = openMailLinks(body);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:;">`;
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<style>${scrollbarCss}html,body{margin:0;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;font-size:15px;line-height:1.65;padding:22px 24px;word-break:break-word;}${canvasCss}img{max-width:100%;height:auto;}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid rgba(148,163,184,0.35);}</style></head><body>${linked}</body></html>`;
  mailSandbox.setAttribute("srcdoc", doc);

  const hint = document.querySelector("#preview-guard");
  if (hint) {
    hint.textContent =
      remoteCount === 0
        ? "无外部图片引用"
        : shown
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
        button.textContent = "重分拣";
        button.disabled = false;
      }
    }, 2000);
  } catch (err) {
    if (button) button.disabled = false;
    toast("触发重分拣失败: " + explain(err));
  }
}

export function navigateMail(delta) {
  if (state.currentMessages.length === 0) return;
  const idx = state.currentMessages.findIndex((m) => m.id === state.selectedMailId);
  const nextIdx = Math.max(0, Math.min(state.currentMessages.length - 1, idx + delta));
  if (nextIdx !== idx) {
    void selectMail(state.currentMessages[nextIdx].id);
  }
}

export async function handleBlockMail() {
  if (!state.selectedMailId || !state.currentFromAddress) return;
  const email = state.currentFromAddress;
  const id = state.selectedMailId;
  if (!(await askConfirm(`将 ${email} 加入拦截黑名单？后续该地址来信将直接进入垃圾桶。`))) return;
  if (btnBlockMail) btnBlockMail.disabled = true;
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/block", { method: "POST", body: {} });
    state.blockedSenders = Array.isArray(res.blockedSenders) ? res.blockedSenders : state.blockedSenders;
    renderBlockList(state.blockedSenders);
    toast("已加入黑名单并移入垃圾桶");
    void refreshUnread();
    if (state.currentView === "trash") return;
    removeMailFromStream(id);
  } catch (err) {
    noticeEl.textContent = "加入黑名单失败: " + explain(err);
  } finally {
    if (btnBlockMail) btnBlockMail.disabled = false;
  }
}

export async function handleTrashMail() {
  if (!state.selectedMailId) return;
  const id = state.selectedMailId;
  if (btnTrashMail) btnTrashMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/trash", { method: "POST", body: {} });
    toast("已移入垃圾桶");
    void refreshUnread();
    removeMailFromStream(id);
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
    removeMailFromStream(id);
  } catch (err) {
    noticeEl.textContent = "恢复邮件失败: " + explain(err);
  } finally {
    if (btnRestoreMail) btnRestoreMail.disabled = false;
  }
}

export async function handleDeleteMail() {
  if (!state.selectedMailId) return;
  if (!(await askConfirm("确定彻底移除该封邮件吗？此操作无法撤销。", { okText: "彻底删除" }))) return;
  const id = state.selectedMailId;
  if (btnDeleteMail) btnDeleteMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id), { method: "DELETE" });
    toast("邮件已彻底移除");
    void refreshUnread();
    removeMailFromStream(id);
  } catch (err) {
    noticeEl.textContent = "删除失败: " + explain(err);
  } finally {
    if (btnDeleteMail) btnDeleteMail.disabled = false;
  }
}

function removeMailFromStream(id) {
  state.selectedBatchIds.delete(id);
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
    mailDetailEl.hidden = true;
    mailEmptyEl.hidden = false;
    setMobilePane("list");
  }
}

export async function handleEmptyTrash() {
  if (!(await askConfirm("确定清空垃圾桶内全部邮件吗？此操作不可撤销。", { okText: "确认清空" }))) return;
  if (emptyTrashBtn) emptyTrashBtn.disabled = true;
  try {
    const res = await request("/v1/messages/empty-trash", { method: "POST", body: {} });
    toast(`垃圾桶已清空（共移除 ${res.count || 0} 封）`);
    state.selectedMailId = null;
    mailDetailEl.hidden = true;
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailEmptyEl.hidden = false;
    setMobilePane("list");
    void refreshUnread();
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
    findByDataId(listEl, ".mail-item", item.id)?.remove();
    state.selectedBatchIds.delete(item.id);
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
    if (prev.label === item.label && prev.read === item.read && prev.starred === item.starred) continue;
    prev.label = item.label;
    prev.read = item.read;
    prev.starred = item.starred;
    const card = findByDataId(listEl, ".mail-item", item.id);
    card?.replaceWith(createMailListItem(item));
  }
  if (fresh.length === 0) return;
  state.currentMessages = fresh.concat(state.currentMessages);
  for (let i = fresh.length - 1; i >= 0; i -= 1) listEl.prepend(createMailListItem(fresh[i]));
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
  return request("/v1/messages/" + encodeURIComponent(id) + "/read", { method: "POST", body: {} })
    .then(() => refreshUnread())
    .catch(() => {
      if (wasRead) return;
      if (known) known.read = false;
      if (card && card.isConnected) card.classList.add("unread");
    });
}
