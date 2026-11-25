// 收件箱、已拦截、垃圾桶：列表检索、自适应沙箱、验证码提取、一键已读与会话来回。
import { state } from "./state.js";
import {
  attachmentCountEl,
  attachmentsList,
  authChips,
  btnBlockMail,
  btnDeleteMail,
  btnDownloadEml,
  btnExpandPreview,
  btnLoadImages,
  btnMarkUnread,
  btnReclassify,
  btnReply,
  btnRestoreMail,
  btnStarDetail,
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
  labelInput,
  listEl,
  mailDetailEl,
  mailEmptyEl,
  mailLoadingEl,
  mailSandbox,
  noticeEl,
  plainTextBody,
  queryInput,
  rawHeaders,
  readAllBtn,
  sandboxWrap,
  sectionAttachments,
  sectionUrls,
  spamReadAllBtn,
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
  refreshUnread,
  setGlyph,
  setMobilePane,
  toast,
} from "./ui.js";
import {
  extractEmail,
  formatBytes,
  formatFrom,
  formatFullTime,
  formatOtpForCopy,
  formatRecipients,
  formatShortTime,
  outboxStatus,
  replyAddress,
  resolveListOtp,
} from "./util.js";
import { showLogin } from "./auth.js";
import { labelName, renderBlockList } from "./settings-view.js";

export function syncListLabel() {
  if (!labelInput) return;
  if (state.currentView === "inbox") {
    labelInput.value = state.inboxPromoOnly ? "unsolicited-admin" : "legit";
  } else if (state.currentView === "spam") {
    labelInput.value = filterSelect ? filterSelect.value : "not-legit";
  }
}

export function staysInList(newLabel) {
  if (state.currentView === "inbox") {
    return newLabel === (state.inboxPromoOnly ? "unsolicited-admin" : "legit");
  }
  if (state.currentView !== "spam") return true;
  const filter = filterSelect ? filterSelect.value : "not-legit";
  if (!filter) return true;
  if (filter === "not-legit") return Boolean(newLabel) && newLabel !== "legit";
  return newLabel === filter;
}

export function appendScopeParams(params) {
  if (state.isAdmin && state.adminScope && state.adminScope !== "mine") {
    params.set("scope", state.adminScope);
  }
  if (state.domainFilter) {
    params.set("domain", state.domainFilter);
  }
}

export function scopeQuerySuffix() {
  if (state.isAdmin && state.adminScope && state.adminScope !== "mine") {
    return "?scope=" + encodeURIComponent(state.adminScope);
  }
  return "";
}

export async function reloadMessages() {
  const token = ++state.listLoadToken;
  state.cursor = null;
  state.loadingMore = false;
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
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadMessagesPage(true, token);
  if (token !== state.listLoadToken) return;
  maybeLoadMore();
}

export function maybeLoadMore() {
  if (state.currentView !== "inbox" && state.currentView !== "spam" && state.currentView !== "trash") return;
  if (!state.cursor || state.loadingMore) return;
  const remaining = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
  if (remaining < 280) void loadMoreMessages();
}

export async function loadMoreMessages() {
  if (!state.cursor || state.loadingMore) return;
  if (state.currentView !== "inbox" && state.currentView !== "spam" && state.currentView !== "trash") return;
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

export async function loadMessagesPage(replace, token) {
  const params = new URLSearchParams();
  if (state.currentView === "trash") {
    params.set("trashed", "true");
    const tq = trashQueryInput ? trashQueryInput.value.trim() : "";
    if (tq) params.set("q", tq);
  } else {
    params.set("trashed", "false");
    syncListLabel();
    if (labelInput.value) params.set("label", labelInput.value);
    const q = queryInput ? queryInput.value.trim() : "";
    if (q) params.set("q", q);
  }
  appendScopeParams(params);
  if (state.starredOnly && state.currentView === "inbox") params.set("starred", "true");
  params.set("limit", "40");
  if (!replace && state.cursor) params.set("cursor", state.cursor);

  try {
    const page = await request("/v1/messages?" + params.toString());
    if (token !== state.listLoadToken) return;
    const items = Array.isArray(page.items) ? page.items : [];
    if (replace) state.currentMessages = items;
    else state.currentMessages = state.currentMessages.concat(items);

    if (replace && items.length === 0) {
      noticeEl.textContent =
        state.currentView === "trash" ? "垃圾桶空空如也" : state.starredOnly ? "没有星标邮件" : "没有匹配的邮件";
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

  const line1 = document.createElement("div");
  line1.className = "item-line1";

  const fromWrap = document.createElement("div");
  fromWrap.className = "item-from-wrap";

  const dot = document.createElement("span");
  dot.className = "unread-dot";
  dot.hidden = Boolean(item.read);

  const from = document.createElement("span");
  from.className = "item-from";
  const rawFrom = item.from || item.envelopeFrom || "";
  from.textContent = rawFrom ? formatFrom(rawFrom) : "没有发件人";
  if (rawFrom) from.title = rawFrom;

  fromWrap.append(dot, from);

  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(item.receivedAt);

  const starBtn = document.createElement("button");
  starBtn.type = "button";
  starBtn.className = "item-star-btn" + (item.starred ? " is-starred" : "");
  starBtn.title = item.starred ? "取消星标" : "设为星标";
  starBtn.setAttribute("aria-label", starBtn.title);
  setGlyph(starBtn, item.starred ? "star-fill" : "star");
  starBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const known = state.currentMessages.find((row) => row.id === item.id);
    const current = known ? Boolean(known.starred) : starBtn.classList.contains("is-starred");
    void toggleStar(item.id, !current);
  });

  line1.append(fromWrap, time, starBtn);

  const line2 = document.createElement("div");
  line2.className = "item-line2";

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const badges = document.createElement("div");
  badges.className = "item-badges";

  const otpCode = resolveListOtp(item);
  let hasOtp = false;
  if (otpCode) {
    hasOtp = true;
    const otpBtn = document.createElement("button");
    otpBtn.type = "button";
    otpBtn.className = "otp-pill";
    otpBtn.textContent = "验证码 " + otpCode;
    otpBtn.title = "点击复制验证码";
    otpBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const copyVal = formatOtpForCopy(otpCode);
      void copyText(copyVal, `验证码 ${copyVal} 已复制`);
    });
    badges.append(otpBtn);
  }

  const tag = document.createElement("span");
  tag.className = "verdict-tag";
  tag.dataset.label = item.label || "none";
  const named = Boolean(item.label) && item.label !== "legit";
  tag.hidden = !named;
  if (item.manualOverride) tag.dataset.manual = "1";
  tag.textContent = named ? labelName(item.label) + (item.manualOverride ? " 已改" : "") : "";

  badges.hidden = !named && !hasOtp;
  badges.append(tag);

  line2.append(subject, badges);
  card.append(line1, line2);
  card.addEventListener("click", () => void selectMail(item.id));
  return card;
}

export async function toggleStar(id, nextStarred) {
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/star", {
      method: "POST",
      body: { starred: Boolean(nextStarred) },
    });
    const starred = Boolean(res.starred);
    const known = state.currentMessages.find((row) => row.id === id);
    if (known) known.starred = starred;
    if (state.openDetail && state.openDetail.id === id) {
      state.openDetail.starred = starred;
      paintDetailStar(starred);
    }
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) {
      if (state.starredOnly && !starred) {
        card.remove();
        state.currentMessages = state.currentMessages.filter((row) => row.id !== id);
        if (state.selectedMailId === id) {
          const next = listEl.querySelector(".mail-item");
          if (next && next.dataset.id) void selectMail(next.dataset.id);
          else {
            state.selectedMailId = null;
            mailDetailEl.hidden = true;
            mailEmptyEl.hidden = false;
          }
        }
      } else {
        const btn = card.querySelector(".item-star-btn");
        if (btn) {
          btn.classList.toggle("is-starred", starred);
          btn.title = starred ? "取消星标" : "设为星标";
          btn.setAttribute("aria-label", btn.title);
          setGlyph(btn, starred ? "star-fill" : "star");
        }
      }
    }
  } catch (err) {
    toast("星标更新失败: " + explain(err));
  }
}

export function paintDetailStar(starred) {
  if (!btnStarDetail) return;
  btnStarDetail.classList.toggle("is-starred", Boolean(starred));
  setGlyph(btnStarDetail, starred ? "star-fill" : "star");
}

export function refreshShownNames() {
  if (state.currentView !== "inbox" && state.currentView !== "spam" && state.currentView !== "trash") return;
  if (listEl) {
    for (const card of listEl.querySelectorAll(".mail-item")) {
      const from = card.querySelector(".item-from");
      if (from instanceof HTMLElement && from.title) from.textContent = formatFrom(from.title);
      const tag = card.querySelector(".verdict-tag");
      if (!(tag instanceof HTMLElement)) continue;
      const label = tag.dataset.label || "";
      if (!label || label === "none" || label === "legit") continue;
      tag.textContent = labelName(label) + (tag.dataset.manual ? " 已改" : "");
    }
  }
  if (detailFrom && detailFrom.title) detailFrom.textContent = formatFrom(detailFrom.title);
  if (detailTo && state.openDetail) {
    detailTo.textContent = formatRecipients(state.openDetail.envelopeTo);
  }
}

export async function selectMail(id, options = {}) {
  const token = ++state.mailLoadToken;
  state.selectedMailId = id;
  state.readingSentId = null;
  state.openDetail = null;
  if (btnStarDetail) btnStarDetail.hidden = false;
  showInboundExtras(true);
  if (detailVerdictSelect) detailVerdictSelect.hidden = false;
  if (btnReply) btnReply.hidden = true;
  if (btnMarkUnread) btnMarkUnread.hidden = true;
  if (threadBox) threadBox.hidden = true;
  state.allowExternalImages = false;
  state.sandboxExpanded = false;
  if (btnExpandPreview) btnExpandPreview.textContent = "展开高度";
  if (btnLoadImages) {
    btnLoadImages.hidden = true;
    btnLoadImages.disabled = false;
    btnLoadImages.textContent = "显示图片";
  }
  const guard = document.querySelector("#preview-guard");
  if (guard) guard.textContent = "";
  if (!options.keepListOnNarrow) setMobilePane("detail");

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
    const suffix = scopeQuerySuffix();
    const detail = await request("/v1/messages/" + encodeURIComponent(id) + suffix);
    if (token !== state.mailLoadToken) return;
    if (detailSubject) detailSubject.textContent = detail.subject || "(无主题)";
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
    if (btnStarDetail) btnStarDetail.hidden = false;
    paintDetailStar(Boolean(detail.starred));

    state.currentFromAddress = extractEmail(rawFrom);
    state.openDetail = detail;
    if (btnReply) btnReply.hidden = !replyAddress(detail);
    const isTrashed = Boolean(detail.trashedAt || state.currentView === "trash");
    if (btnMarkUnread) btnMarkUnread.hidden = isTrashed;
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
        detailModelVerdict.textContent = `(已改分类，原先为 ${labelName(detail.aiResult.originalLabel)})`;
      } else if (showProb) {
        detailModelVerdict.textContent = `(模型 ${Math.round(confidence * 100)}%)`;
      } else {
        detailModelVerdict.textContent = "";
      }
    }

    if (verdictBar) verdictBar.style.width = Math.round(confidence * 100) + "%";
    if (verdictPercent) verdictPercent.textContent = Math.round(confidence * 100) + "%";
    if (detailSummary) detailSummary.textContent = detail.aiResult?.summary || "尚未分类";

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

    btnDownloadEml.href = "/v1/messages/" + encodeURIComponent(id) + "/raw";
    btnDownloadEml.setAttribute("download", `${detail.sha256 || id}.eml`);

    authChips.replaceChildren();
    if (detail.authResult) {
      const auth = detail.authResult;
      authChips.append(createAuthChip("SPF", auth.spf));
      authChips.append(createAuthChip("DKIM", auth.dkim));
      authChips.append(createAuthChip("DMARC", auth.dmarc));
    }

    const plainText = detail.parsed?.text || "";
    state.currentMailPlain = plainText;
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
    if (btnMarkUnread) btnMarkUnread.hidden = true;
    if (threadBox) threadBox.hidden = true;
    if (detailSubject) detailSubject.textContent = "无法加载邮件详情";
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
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/thread" + scopeQuerySuffix());
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
    who.textContent = item.from || (sent ? "已发出" : "没有发件人");
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
    toast("打开发出的信失败: " + explain(err));
  }
}

export function paintSentLetter(letter) {
  showInboundExtras(false);
  if (detailVerdictSelect) detailVerdictSelect.hidden = true;
  const confidenceChip = document.querySelector(".confidence-chip");
  if (confidenceChip) confidenceChip.hidden = true;
  const detailTags = document.querySelector("#detail-tags");
  if (detailTags) detailTags.replaceChildren();
  state.openDetail = null;
  if (btnReply) btnReply.hidden = true;
  if (btnMarkUnread) btnMarkUnread.hidden = true;
  if (btnReclassify) btnReclassify.hidden = true;
  if (btnBlockMail) btnBlockMail.hidden = true;
  if (btnTrashMail) btnTrashMail.hidden = true;
  if (btnRestoreMail) btnRestoreMail.hidden = true;
  if (btnDeleteMail) btnDeleteMail.hidden = true;
  if (btnStarDetail) btnStarDetail.hidden = true;
  const status = outboxStatus(letter);
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
  if (detailModelVerdict) detailModelVerdict.textContent = status;
  if (detailSummary) {
    detailSummary.textContent = letter.error && letter.status !== "sent" ? status + "。" + letter.error : status;
  }
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
  state.sandboxExpanded = false;
  renderSandboxHtml("");
  switchTab("ai");
  mailEmptyEl.hidden = true;
  if (mailLoadingEl) mailLoadingEl.hidden = true;
  mailDetailEl.hidden = false;
}

export function syncSandboxSizing(html) {
  if (!sandboxWrap) return;
  const hasRichLayout = Boolean(html && (html.length > 900 || /<table\b/i.test(html) || /<img\b/i.test(html)));
  const isShort = !hasRichLayout && (state.currentMailPlain || "").length < 360;
  sandboxWrap.classList.toggle("is-compact", isShort && !state.sandboxExpanded);
  sandboxWrap.classList.toggle("is-expanded", state.sandboxExpanded);
  if (btnExpandPreview) {
    btnExpandPreview.textContent = state.sandboxExpanded ? "收起高度" : "展开高度";
  }
}

export function toggleSandboxExpand() {
  state.sandboxExpanded = !state.sandboxExpanded;
  syncSandboxSizing(state.currentMailHtml);
}

export function renderSandboxHtml(html) {
  syncSandboxSizing(html);
  const remoteCount = countRemoteImages(html);
  const shown = state.allowExternalImages && remoteCount > 0;
  const source = html && html.trim() ? html : escapeHtml(state.currentMailPlain || "(正文为空)").replace(/\n/g, "<br>");
  const body = shown ? source : stripRemoteImages(source);
  const unstyled = !mailBringsItsOwnCanvas(body);
  const imgSrc = shown ? "http: https: data: cid:" : "data: cid:";
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const pageBg = isDark ? "#121216" : "#ffffff";
  const textColor = isDark ? "#e4e4e7" : "#111827";
  const linkColor = isDark ? "#93c5fd" : "#0b57d0";
  const trackBg = unstyled ? pageBg : isDark ? "#18181b" : "#f8fafd";
  const thumbBg = isDark ? "#3f3f46" : "#cbd5e1";
  const thumbHover = isDark ? "#52525b" : "#94a3b8";
  const canvasCss = unstyled
    ? `html,body{background:${pageBg};color:${textColor};}a{color:${linkColor};}`
    : `html{background:${pageBg};}`;
  const scrollbarCss = `:root{color-scheme:${isDark ? "dark" : "light"};}*{scrollbar-width:thin;scrollbar-color:${thumbBg} ${trackBg};}::-webkit-scrollbar{width:10px;height:10px;}::-webkit-scrollbar-track{background:${trackBg};}::-webkit-scrollbar-thumb{background:${thumbBg};border-radius:5px;border:2px solid ${trackBg};}::-webkit-scrollbar-thumb:hover{background:${thumbHover};}::-webkit-scrollbar-corner{background:${trackBg};}::-webkit-resizer{background:transparent;}`;
  const linked = openMailLinks(body);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:;">`;
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<style>${scrollbarCss}html,body{margin:0;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.62;padding:18px;word-break:break-word;}${canvasCss}img{max-width:100%;height:auto;}</style></head><body>${linked}</body></html>`;
  mailSandbox.setAttribute("srcdoc", doc);
  const hint = document.querySelector("#preview-guard");
  if (hint) {
    hint.textContent = shown
      ? "共 " + remoteCount + " 处外链资源已加载"
      : "共 " + remoteCount + " 处外链资源未加载";
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

let markingAllRead = false;

export async function handleMarkAllRead(room = "inbox") {
  if (markingAllRead) return;
  markingAllRead = true;
  if (readAllBtn) readAllBtn.disabled = true;
  if (spamReadAllBtn) spamReadAllBtn.disabled = true;
  const label =
    room === "spam"
      ? filterSelect && filterSelect.value
        ? filterSelect.value
        : "not-legit"
      : state.inboxPromoOnly
        ? "unsolicited-admin"
        : "legit";
  const body = { label };
  if (state.domainFilter) body.domain = state.domainFilter;
  if (state.isAdmin && state.adminScope && state.adminScope !== "mine") {
    body.scope = state.adminScope;
  }
  try {
    const res = await request("/v1/messages/read-all", { method: "POST", body });
    for (const item of state.currentMessages) item.read = true;
    for (const card of listEl.querySelectorAll(".mail-item")) {
      card.classList.remove("unread");
      const dot = card.querySelector(".unread-dot");
      if (dot) dot.hidden = true;
    }
    await refreshUnread();
    toast(res.count > 0 ? `已将 ${res.count} 封标为已读` : "已全部标为已读");
  } catch (err) {
    toast("操作失败: " + explain(err));
  } finally {
    markingAllRead = false;
    if (readAllBtn) readAllBtn.disabled = false;
    if (spamReadAllBtn) spamReadAllBtn.disabled = false;
  }
}

export async function handleMarkUnread() {
  if (!state.selectedMailId || state.readingSentId) return;
  const id = state.selectedMailId;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/unread" + scopeQuerySuffix(), {
      method: "POST",
      body: {},
    });
    const known = state.currentMessages.find((m) => m.id === id);
    if (known) known.read = false;
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) {
      card.classList.add("unread");
      const dot = card.querySelector(".unread-dot");
      if (dot) dot.hidden = false;
    }
    await refreshUnread();
    toast("已标为未读");
  } catch (err) {
    toast("操作失败: " + explain(err));
  }
}

export async function handleBlockMail() {
  if (!state.selectedMailId || !state.currentFromAddress) return;
  const email = state.currentFromAddress;
  const id = state.selectedMailId;
  if (!(await askConfirm(`把 ${email} 加入黑名单？之后该地址来的信直接进垃圾桶。`))) return;
  if (btnBlockMail) btnBlockMail.disabled = true;
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/block", { method: "POST", body: {} });
    state.blockedSenders = Array.isArray(res.blockedSenders) ? res.blockedSenders : state.blockedSenders;
    renderBlockList(state.blockedSenders);
    toast("已加入黑名单");
    void refreshUnread();
    if (state.currentView === "trash") return;
    advanceAfterRemove(id, "邮件已移入垃圾桶");
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
    await request("/v1/messages/" + encodeURIComponent(id) + "/trash" + scopeQuerySuffix(), {
      method: "POST",
      body: {},
    });
    void refreshUnread();
    advanceAfterRemove(id, "邮件已移入垃圾桶");
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
    await request("/v1/messages/" + encodeURIComponent(id) + "/restore" + scopeQuerySuffix(), {
      method: "POST",
      body: {},
    });
    void refreshUnread();
    advanceAfterRemove(id, "已从垃圾桶恢复");
  } catch (err) {
    noticeEl.textContent = "恢复邮件失败: " + explain(err);
  } finally {
    if (btnRestoreMail) btnRestoreMail.disabled = false;
  }
}

export async function handleDeleteMail() {
  if (!state.selectedMailId) return;
  const confirmText =
    state.isAdmin && state.adminScope === "all"
      ? "将为所有成员彻底删除。此操作无法撤销。"
      : "确定永久删除此邮件吗？此操作无法撤销。";
  if (!(await askConfirm(confirmText))) return;
  const id = state.selectedMailId;
  if (btnDeleteMail) btnDeleteMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + scopeQuerySuffix(), { method: "DELETE" });
    void refreshUnread();
    advanceAfterRemove(id, "邮件已彻底删除");
  } catch (err) {
    noticeEl.textContent = "彻底删除失败: " + explain(err);
  } finally {
    if (btnDeleteMail) btnDeleteMail.disabled = false;
  }
}

function advanceAfterRemove(id, message) {
  noticeEl.textContent = message;
  setTimeout(() => {
    if (noticeEl.textContent === message) noticeEl.textContent = "";
  }, 3000);
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
  if (!(await askConfirm("确定清空垃圾桶内全部邮件吗？此操作无法撤销。"))) return;
  if (emptyTrashBtn) emptyTrashBtn.disabled = true;
  try {
    const res = await request("/v1/messages/empty-trash" + scopeQuerySuffix(), { method: "POST", body: {} });
    noticeEl.textContent = `垃圾桶已清空 (已处理 ${res.count || 0} 封)`;
    setTimeout(() => {
      if (noticeEl.textContent.startsWith("垃圾桶已清空")) noticeEl.textContent = "";
    }, 3000);
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
    findByDataId(listEl, ".mail-item", item.id)?.remove();
  }
  state.currentMessages = state.currentMessages.filter((item) => kept.has(item.id));
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
    if (prev.read && !item.read && state.selectedMailId === item.id) item.read = true;
    if (prev.label === item.label && prev.read === item.read && Boolean(prev.starred) === Boolean(item.starred)) continue;
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
    const dot = card.querySelector(".unread-dot");
    if (dot) dot.hidden = true;
  }
  if (known) known.read = true;
  return request("/v1/messages/" + encodeURIComponent(id) + "/read" + scopeQuerySuffix(), {
    method: "POST",
    body: {},
  })
    .then(() => refreshUnread())
    .catch(() => {
      if (wasRead) return;
      if (known) known.read = false;
      if (card && card.isConnected) {
        card.classList.add("unread");
        const dot = card.querySelector(".unread-dot");
        if (dot) dot.hidden = false;
      }
    });
}
