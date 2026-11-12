// 收件箱、已拦截、垃圾桶：列表、详情面板、线程、分类、拦截与删除。
import { state } from "./state.js";
import { attachmentCountEl, attachmentsList, authChips, btnBlockMail, btnDeleteMail, btnDownloadEml, btnLoadImages, btnReclassify, btnReply, btnRestoreMail, btnTrashMail, detailFrom, detailModelVerdict, detailSubject, detailSummary, detailTime, detailTo, detailVerdictSelect, emptyTrashBtn, filterSelect, labelInput, listEl, mailDetailEl, mailEmptyEl, mailLoadingEl, mailSandbox, noticeEl, plainTextBody, queryInput, rawHeaders, sectionAttachments, sectionSignals, sectionUrls, signalsCountEl, signalsList, threadBox, threadList, trashQueryInput, urlCountEl, urlsList, verdictBar, verdictPercent } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, createAuthChip, explain, findByDataId, formatRawHeaders, refreshUnread, setMobilePane, toast } from "./ui.js";
import { extractEmail, formatBytes, formatFrom, formatFullTime, formatRecipients, formatShortTime, outboxStatus, replyAddress } from "./util.js";
import { showLogin } from "./auth.js";
import { labelName, renderBlockList } from "./settings-view.js";

export function syncListLabel() {
  if (!labelInput) return;
  if (state.currentView === "inbox") labelInput.value = state.inboxPromoOnly ? "unsolicited-admin" : "legit";
  else if (state.currentView === "spam") labelInput.value = filterSelect ? filterSelect.value : "not-legit";
}

export function staysInList(newLabel) {
  if (state.currentView === "inbox") return newLabel === (state.inboxPromoOnly ? "unsolicited-admin" : "legit");
  if (state.currentView !== "spam") return true;
  const filter = filterSelect ? filterSelect.value : "not-legit";
  if (!filter) return true;
  if (filter === "not-legit") return Boolean(newLabel) && newLabel !== "legit";
  return newLabel === filter;
}

export async function reloadMessages() {
  const token = ++state.listLoadToken;
  state.cursor = null;
  state.loadingMore = false;
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadMessagesPage(true, token);
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
  params.set("limit", "40");
  if (!replace && state.cursor) params.set("cursor", state.cursor);

  try {
    const page = await request("/v1/messages?" + params.toString());
    if (token !== state.listLoadToken) return;
    const items = Array.isArray(page.items) ? page.items : [];
    if (replace) state.currentMessages = items;
    else state.currentMessages = state.currentMessages.concat(items);

    if (replace && items.length === 0) {
      noticeEl.textContent = state.currentView === "trash" ? "垃圾桶空空如也" : "没有匹配的邮件";
    }

    for (const item of items) {
      listEl.append(createMailListItem(item));
    }
    state.cursor = page.nextCursor || null;

    // 桌面端顺手打开第一封。窄屏留在列表，避免一进来就盖住收件流。
    if (replace && items.length > 0 && !state.selectedMailId) {
      const opening = selectMail(items[0].id, { keepListOnNarrow: true });
      if (state.holdBoot) await opening;
      else void opening;
    }
  } catch (err) {
    if (err && err.status === 401) {
      showLogin();
      return;
    }
    noticeEl.textContent = explain(err);
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

  const from = document.createElement("span");
  from.className = "item-from";
  const rawFrom = item.from || item.envelopeFrom || "";
  from.textContent = rawFrom ? formatFrom(rawFrom) : "没有发件人";
  if (rawFrom) from.title = rawFrom;

  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(item.receivedAt);

  line1.append(from, time);

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const line3 = document.createElement("div");
  line3.className = "item-line3";

  const snippet = document.createElement("span");
  snippet.className = "item-snippet";
  // 列表先不放摘要。需要时把下一行接回去。
  // snippet.textContent = item.summary || "";
  snippet.hidden = true;

  const tag = document.createElement("span");
  tag.className = "verdict-tag";
  tag.dataset.label = item.label || "none";
  // 列表先不显示置信度，正常也不显示标签。需要时把下面两行接回去。
  // const confText = item.manualOverride
  //   ? " 已改"
  //   : item.label && item.label !== "legit" && typeof item.confidence === "number"
  //     ? ` ${Math.round(item.confidence * 100)}%`
  //     : "";
  // tag.textContent = labelName(item.label) + confText;
  const named = Boolean(item.label) && item.label !== "legit";
  tag.hidden = !named;
  tag.textContent = named ? labelName(item.label) + (item.manualOverride ? " 已改" : "") : "";

  line3.hidden = !named;
  line3.append(snippet, tag);

  card.append(line1, subject, line3);
  card.addEventListener("click", () => void selectMail(item.id));
  return card;
}

export async function selectMail(id, options = {}) {
  const token = ++state.mailLoadToken;
  state.selectedMailId = id;
  state.readingSentId = null;
  state.openDetail = null;
  showInboundExtras(true);
  if (detailVerdictSelect) detailVerdictSelect.hidden = false;
  if (btnReply) btnReply.hidden = true;
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

  // 默认折叠威胁指纹与外链
  if (sectionSignals) sectionSignals.open = false;
  if (sectionUrls) sectionUrls.open = false;

  // 更新左侧列表的高亮状态。已读先改列表，不等正文；已拦截的信往往更大，不该把已读拖在正文后面。
  document.querySelectorAll(".mail-item").forEach((el) => {
    if (el.dataset.id === id) el.classList.add("selected");
    else el.classList.remove("selected");
  });
  const opened = markOpened(id);

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
      detailFrom.textContent = rawFrom ? formatFrom(rawFrom) : "没有发件人";
      detailFrom.title = rawFrom;
    }
    if (detailTo) {
      detailTo.textContent = formatRecipients(detail.envelopeTo);
      detailTo.title = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo || "";
    }
    if (detailTime) detailTime.textContent = formatFullTime(detail.receivedAt);

    state.currentFromAddress = extractEmail(rawFrom);
    state.openDetail = detail;
    if (btnReply) btnReply.hidden = !replyAddress(detail);
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

    // 威胁信号指纹
    signalsList.replaceChildren();
    const signals = detail.aiResult?.signals || [];
    if (signalsCountEl) signalsCountEl.textContent = String(signals.length);
    if (signals.length === 0) {
      const emptySig = document.createElement("span");
      emptySig.className = "text-dim";
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

    // 正文提取外链
    urlsList.replaceChildren();
    const urls = detail.parsed?.urls || [];
    urlCountEl.textContent = String(urls.length);
    if (urls.length === 0) {
      const emptyUrl = document.createElement("span");
      emptyUrl.className = "text-dim";
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

    // 附件清单
    attachmentsList.replaceChildren();
    const attachments = detail.attachments || [];
    attachmentCountEl.textContent = String(attachments.length);
    if (attachments.length === 0) {
      const emptyAtt = document.createElement("span");
      emptyAtt.className = "text-dim";
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

    // 下载 EML 链接
    btnDownloadEml.href = "/v1/messages/" + encodeURIComponent(id) + "/raw";
    btnDownloadEml.setAttribute("download", `${detail.sha256 || id}.eml`);

    // 邮件来源鉴权标签
    authChips.replaceChildren();
    if (detail.authResult) {
      const auth = detail.authResult;
      authChips.append(createAuthChip("SPF", auth.spf));
      authChips.append(createAuthChip("DKIM", auth.dkim));
      authChips.append(createAuthChip("DMARC", auth.dmarc));
    }

    // 纯文本正文与原始头
    state.currentMailPlain = detail.parsed?.text || "";
    plainTextBody.textContent = state.currentMailPlain || "(正文为空)";
    rawHeaders.textContent = formatRawHeaders(detail);
    if (mailLoadingEl) mailLoadingEl.hidden = true;
    mailDetailEl.hidden = false;

    // 加载 HTML 与真正的 RFC822 信头。信头随 HTML 一起回来，省一次请求；
    // 只有 HTML 里没带信头时才单独拉一次。带会话进来时等这一封画完再揭开，避免连闪。
    const htmlReady = loadMailHtml(id, token);
    const headersReady = (async () => {
      const headers = await htmlReady;
      if (token !== state.mailLoadToken) return;
      if (headers && headers.trim()) {
        rawHeaders.textContent = headers;
        return;
      }
      await loadRawHeaders(id, token, detail);
    })();
    const threadReady = loadThread(id, token);
    if (state.holdBoot) await Promise.all([htmlReady, headersReady, threadReady, opened]);
  } catch (err) {
    if (token !== state.mailLoadToken) return;
    console.error("selectMail error:", err);
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
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/html");
    if (token !== state.mailLoadToken) return null;
    state.currentMailHtml = res.html || "";
    renderSandboxHtml(state.currentMailHtml);
    return typeof res.headers === "string" ? res.headers : null;
  } catch {
    if (token !== state.mailLoadToken) return null;
    state.currentMailHtml = "<p style='color:#888;padding:20px'>没有 HTML 正文</p>";
    renderSandboxHtml(state.currentMailHtml);
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
  if (btnReclassify) btnReclassify.hidden = true;
  if (btnBlockMail) btnBlockMail.hidden = true;
  if (btnTrashMail) btnTrashMail.hidden = true;
  if (btnRestoreMail) btnRestoreMail.hidden = true;
  if (btnDeleteMail) btnDeleteMail.hidden = true;
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
  const source = html && html.trim() ? html : escapeHtml(state.currentMailPlain).replace(/\n/g, "<br>");
  const body = shown ? source : stripRemoteImages(source);
  const unstyled = !mailBringsItsOwnCanvas(body);
  const imgSrc = shown ? "http: https: data: cid:" : "data: cid:";
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const pageBg = isDark ? "#0a0a0a" : "#ffffff";
  const textColor = isDark ? "#e5e5e5" : "#111111";
  const linkColor = isDark ? "#93c5fd" : "#1d4ed8";
  const trackBg = unstyled ? pageBg : (isDark ? "#18181b" : "#f1f5f9");
  const thumbBg = isDark ? "#52525b" : "#cbd5e1";
  const thumbHover = isDark ? "#71717a" : "#94a3b8";
  const thumbActive = isDark ? "#9ca3af" : "#64748b";
  const canvasCss = unstyled
    ? `html,body{background:${pageBg};color:${textColor};}a{color:${linkColor};}`
    : `html{background:${pageBg};}`;
  const scrollbarCss = `:root{color-scheme:${isDark ? "dark" : "light"};}*{scrollbar-width:thin;scrollbar-color:${thumbBg} ${trackBg};}::-webkit-scrollbar{width:10px;height:10px;}::-webkit-scrollbar-track{background:${trackBg};}::-webkit-scrollbar-thumb{background:${thumbBg};border-radius:5px;border:2px solid ${trackBg};}::-webkit-scrollbar-thumb:hover{background:${thumbHover};}::-webkit-scrollbar-thumb:active{background:${thumbActive};}::-webkit-scrollbar-corner{background:${trackBg};}::-webkit-resizer{background:transparent;}`;
  const linked = openMailLinks(body);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:;">`;
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<style>${scrollbarCss}html,body{margin:0;}body{font-family:sans-serif;font-size:16px;line-height:1.6;padding:18px;word-break:break-word;}${canvasCss}img{max-width:100%;height:auto;}</style></head><body>${linked}</body></html>`;
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
  if (nextIdx !== idx) {
    void selectMail(state.currentMessages[nextIdx].id);
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
    noticeEl.textContent = "邮件已移入垃圾桶";
    setTimeout(() => { if (noticeEl.textContent === "邮件已移入垃圾桶") noticeEl.textContent = ""; }, 3000);
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
    noticeEl.textContent = "邮件已移入垃圾桶";
    void refreshUnread();
    setTimeout(() => { if (noticeEl.textContent === "邮件已移入垃圾桶") noticeEl.textContent = ""; }, 3000);
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) card.remove();
    state.currentMessages = state.currentMessages.filter((m) => m.id !== id);
    const nextCard = listEl.querySelector(".mail-item");
    if (nextCard && nextCard.getAttribute("data-id")) {
      void selectMail(nextCard.getAttribute("data-id"));
    } else {
      state.selectedMailId = null;
      mailDetailEl.hidden = true;
      mailEmptyEl.hidden = false;
      setMobilePane("list");
    }
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
    noticeEl.textContent = "已从垃圾桶恢复";
    void refreshUnread();
    setTimeout(() => { if (noticeEl.textContent === "已从垃圾桶恢复") noticeEl.textContent = ""; }, 3000);
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) card.remove();
    state.currentMessages = state.currentMessages.filter((m) => m.id !== id);
    const nextCard = listEl.querySelector(".mail-item");
    if (nextCard && nextCard.getAttribute("data-id")) {
      void selectMail(nextCard.getAttribute("data-id"));
    } else {
      state.selectedMailId = null;
      mailDetailEl.hidden = true;
      mailEmptyEl.hidden = false;
      setMobilePane("list");
    }
  } catch (err) {
    noticeEl.textContent = "恢复邮件失败: " + explain(err);
  } finally {
    if (btnRestoreMail) btnRestoreMail.disabled = false;
  }
}

export async function handleDeleteMail() {
  if (!state.selectedMailId) return;
  if (!(await askConfirm("确定永久删除此邮件吗？此操作无法撤销。"))) return;
  const id = state.selectedMailId;
  if (btnDeleteMail) btnDeleteMail.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id), { method: "DELETE" });
    noticeEl.textContent = "邮件已彻底删除";
    void refreshUnread();
    setTimeout(() => { if (noticeEl.textContent === "邮件已彻底删除") noticeEl.textContent = ""; }, 3000);
    const card = findByDataId(listEl, ".mail-item", id);
    if (card) card.remove();
    state.currentMessages = state.currentMessages.filter((m) => m.id !== id);
    const nextCard = listEl.querySelector(".mail-item");
    if (nextCard && nextCard.getAttribute("data-id")) {
      void selectMail(nextCard.getAttribute("data-id"));
    } else {
      state.selectedMailId = null;
      mailDetailEl.hidden = true;
      mailEmptyEl.hidden = false;
      setMobilePane("list");
    }
  } catch (err) {
    noticeEl.textContent = "彻底删除失败: " + explain(err);
  } finally {
    if (btnDeleteMail) btnDeleteMail.disabled = false;
  }
}

export async function handleEmptyTrash() {
  if (!(await askConfirm("确定清空垃圾桶内全部邮件吗？此操作无法撤销。"))) return;
  if (emptyTrashBtn) emptyTrashBtn.disabled = true;
  try {
    const res = await request("/v1/messages/empty-trash", { method: "POST", body: {} });
    noticeEl.textContent = `垃圾桶已清空 (共清除 ${res.count || 0} 封邮件)`;
    setTimeout(() => { if (noticeEl.textContent.startsWith("垃圾桶已清空")) noticeEl.textContent = ""; }, 3000);
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
    // A list response that left before the read landed still says unread. Keep the row read.
    if (prev.read && !item.read) item.read = true;
    if (prev.label === item.label && prev.read === item.read) continue;
    prev.label = item.label;
    prev.read = item.read;
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
  if (card) card.classList.remove("unread");
  if (known) known.read = true;
  return request("/v1/messages/" + encodeURIComponent(id) + "/read", { method: "POST", body: {} })
    .then(() => refreshUnread())
    .catch(() => {
      if (wasRead) return;
      if (known) known.read = false;
      if (card && card.isConnected) card.classList.add("unread");
    });
}
