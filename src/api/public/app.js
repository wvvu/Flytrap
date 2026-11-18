// 入口装配：全局事件监听、键盘流快捷键、15 秒增量轮询。
import { state } from "./state.js";
import {
  adminScopeSelect,
  appEl,
  backListBtn,
  btnBlockMail,
  btnDeleteMail,
  btnExpandPreview,
  btnLoadImages,
  btnMarkUnread,
  btnReclassify,
  btnReply,
  btnRestoreMail,
  btnTrashMail,
  confirmModal,
  detailModelVerdict,
  detailOtpBtn,
  detailVerdictSelect,
  dlqRefreshBtn,
  domainFilterSelect,
  emptyTrashBtn,
  filterSelect,
  mailDetailEl,
  mailEmptyEl,
  mailLoadingEl,
  labelInput,
  listEl,
  loginForm,
  logoutBtn,
  navDlqBtn,
  navInboxBtn,
  navSendBtn,
  navSettingsBtn,
  navSpamBtn,
  navTrashBtn,
  navUsersBtn,
  newUserBtn,
  noticeEl,
  promoBtn,
  queryInput,
  readAllBtn,
  refreshBtn,
  resetModal,
  retryAllBtn,
  shortcutCloseBtn,
  shortcutModal,
  shortcutsBtn,
  spamReadAllBtn,
  spamRefreshBtn,
  themeBtn,
  trashQueryInput,
  trashRefreshBtn,
  usersQueryInput,
  usersRefreshBtn,
} from "./dom.js";
import { request } from "./net.js";
import {
  copyText,
  explain,
  findByDataId,
  isTypingTarget,
  refreshUnread,
  setMobilePane,
  toast,
  toggleShortcutModal,
} from "./ui.js";
import { debounce, hashMailId } from "./util.js";
import { initTheme, revealApp, setPromoMode, switchNav, toggleTheme } from "./shell.js";
import {
  closeReset,
  finishReset,
  savePassword,
  saveProfile,
  sendResetCode,
  showLogin,
  showResetPassword,
  signIn,
  signOut,
  startReset,
} from "./auth.js";
import {
  appendScopeParams,
  handleBlockMail,
  handleDeleteMail,
  handleEmptyTrash,
  handleMarkAllRead,
  handleMarkUnread,
  handleRestoreMail,
  handleTrashMail,
  maybeLoadMore,
  mergeFreshMail,
  navigateMail,
  reclassify,
  reloadMessages,
  reloadTrash,
  removeStaleMail,
  renderSandboxHtml,
  staysInList,
  switchTab,
  syncListLabel,
  toggleSandboxExpand,
} from "./mail-view.js";
import { loadDlqJobs, openFailedMail, renderFailureGroups, retryAllDead, updateDlqBadge } from "./dlq-view.js";
import {
  addBlocked,
  addDomain,
  addKeyRow,
  addModelRow,
  addSenderRow,
  enqueueAi,
  generateDkim,
  labelName,
  loadLogs,
  saveAttemptSettings,
  saveCurrentPrompt,
  saveMailbox,
  saveNameSettings,
  saveNotifySettings,
  syncAttemptSave,
  syncNamesSave,
  syncNotifySave,
  syncPromptSave,
} from "./settings-view.js";
import {
  copyCreatedCredentials,
  fillCreateRandomPassword,
  loadUsersPage,
  openCreateUserCard,
  renderUsersStream,
  submitCreateUser,
} from "./users-view.js";
import {
  cancelReplyLink,
  discardComposeDraft,
  loadSendPage,
  navigateSent,
  openComposer,
  refreshSendNote,
  refreshSentList,
  renderSentList,
  scheduleDraftSave,
  startReply,
  submitSend,
} from "./send-view.js";

// 登录与全局轨道事件
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void signIn();
});

logoutBtn.addEventListener("click", () => void signOut());
themeBtn.addEventListener("click", () => toggleTheme());
shortcutsBtn?.addEventListener("click", () => toggleShortcutModal());
shortcutCloseBtn?.addEventListener("click", () => toggleShortcutModal(false));
shortcutModal?.addEventListener("click", (e) => {
  if (e.target === shortcutModal) toggleShortcutModal(false);
});

navInboxBtn?.addEventListener("click", () => void switchNav("inbox"));
navSendBtn?.addEventListener("click", () => void switchNav("send"));
navSpamBtn?.addEventListener("click", () => void switchNav("spam"));
navTrashBtn?.addEventListener("click", () => void switchNav("trash"));
navUsersBtn?.addEventListener("click", () => void switchNav("users"));
navSettingsBtn?.addEventListener("click", () => {
  if (state.currentSettingsSection === "users") {
    state.currentSettingsSection = state.settingsReturnSection || (state.isAdmin ? "domains" : "my-mailboxes");
  }
  void switchNav("settings");
});
navDlqBtn?.addEventListener("click", () => void switchNav("dlq"));

// 列表头与过滤器事件
refreshBtn?.addEventListener("click", () => void reloadMessages());
readAllBtn?.addEventListener("click", () => void handleMarkAllRead("inbox"));
spamReadAllBtn?.addEventListener("click", () => void handleMarkAllRead("spam"));
promoBtn?.addEventListener("click", () => setPromoMode(!state.inboxPromoOnly));
spamRefreshBtn?.addEventListener("click", () => void reloadMessages());
trashRefreshBtn?.addEventListener("click", () => void reloadTrash());
emptyTrashBtn?.addEventListener("click", () => void handleEmptyTrash());
dlqRefreshBtn?.addEventListener("click", () => void loadDlqJobs());
retryAllBtn?.addEventListener("click", () => void retryAllDead());

function clearOpenLetter() {
  state.selectedMailId = null;
  state.readingSentId = null;
  state.openDetail = null;
  if (mailDetailEl) mailDetailEl.hidden = true;
  if (mailLoadingEl) mailLoadingEl.hidden = true;
  if (mailEmptyEl) mailEmptyEl.hidden = false;
}

adminScopeSelect?.addEventListener("change", () => {
  state.adminScope = adminScopeSelect.value || "mine";
  clearOpenLetter();
  void refreshUnread();
  if (state.currentView === "trash") void reloadTrash();
  else void reloadMessages();
});

domainFilterSelect?.addEventListener("change", () => {
  state.domainFilter = domainFilterSelect.value || "";
  clearOpenLetter();
  if (state.currentView === "trash") void reloadTrash();
  else void reloadMessages();
});

// 邮件阅读动作事件
btnReply?.addEventListener("click", () => void startReply());
btnMarkUnread?.addEventListener("click", () => void handleMarkUnread());
btnTrashMail?.addEventListener("click", () => void handleTrashMail());
btnBlockMail?.addEventListener("click", () => void handleBlockMail());
btnRestoreMail?.addEventListener("click", () => void handleRestoreMail());
btnDeleteMail?.addEventListener("click", () => void handleDeleteMail());
btnExpandPreview?.addEventListener("click", () => toggleSandboxExpand());
detailOtpBtn?.addEventListener("click", () => {
  const code = detailOtpBtn.dataset.code || "";
  if (code) void copyText(code, "验证码已复制");
});

backListBtn?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-dlq")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-settings")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-send")?.addEventListener("click", () => setMobilePane("list"));

// 成员管理页事件
newUserBtn?.addEventListener("click", () => openCreateUserCard());
usersRefreshBtn?.addEventListener("click", () => void loadUsersPage());
document.querySelector("#users-search-form")?.addEventListener("submit", (e) => e.preventDefault());
usersQueryInput?.addEventListener("input", () => {
  state.usersQuery = usersQueryInput.value || "";
  renderUsersStream();
});
document.querySelector("#btn-uc-gen-pass")?.addEventListener("click", () => fillCreateRandomPassword());
document.querySelector("#user-create-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void submitCreateUser();
});
document.querySelector("#btn-copy-credentials")?.addEventListener("click", () => copyCreatedCredentials());

// 设置与账号事件
document.querySelector("#ai-enabled")?.addEventListener("change", () => {
  const box = document.querySelector("#ai-enabled");
  if (!box) return;
  const next = box.checked;
  box.checked = !next;
  enqueueAi(() => {
    box.checked = next;
  }, next ? "分拣已开启" : "分拣已关闭");
});

document.querySelector("#ai-thinking")?.addEventListener("change", () => {
  const select = document.querySelector("#ai-thinking");
  if (!select) return;
  const next = select.value;
  select.value = select.dataset.prev || "low";
  enqueueAi(() => {
    select.value = next;
  }, "思考已保存");
});

document.querySelector("#btn-save-password")?.addEventListener("click", () => void savePassword());
document.querySelector("#btn-save-profile")?.addEventListener("click", () => void saveProfile());
document.querySelector("#btn-forgot")?.addEventListener("click", () => void startReset());
document.querySelector("#btn-reset-close")?.addEventListener("click", () => closeReset(false));
document.querySelector("#btn-reset-other")?.addEventListener("click", () => closeReset(true));
document.querySelector("#btn-reset-continue")?.addEventListener("click", () => showResetPassword());
document.querySelector("#btn-reset-save")?.addEventListener("click", () => void finishReset());
document.querySelector("#btn-reset-resend")?.addEventListener("click", () => void sendResetCode());

document.querySelector("#btn-refresh-logs")?.addEventListener("click", () => void loadLogs());
document.querySelector("#btn-add-model")?.addEventListener("click", () => addModelRow());
document.querySelector("#btn-add-key")?.addEventListener("click", () => addKeyRow());

document.querySelector("#model-add")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addModelRow();
  }
});

document.querySelector("#key-add")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addKeyRow();
  }
});

document.querySelector("#btn-save-prompt")?.addEventListener("click", () => void saveCurrentPrompt());
document.querySelector("#prompt-editor")?.addEventListener("input", syncPromptSave);
document.querySelector("#btn-save-notify")?.addEventListener("click", () => void saveNotifySettings());
document.querySelector("#notify-confidence")?.addEventListener("input", syncNotifySave);
document.querySelector("#btn-save-attempts")?.addEventListener("click", () => void saveAttemptSettings());
document.querySelector("#job-max-attempts")?.addEventListener("input", syncAttemptSave);
document.querySelector("#btn-add-domain")?.addEventListener("click", () => void addDomain());

// 发信与写信草稿事件
document.querySelector("#btn-send-refresh")?.addEventListener("click", () => void loadSendPage());
document.querySelector("#btn-compose")?.addEventListener("click", () => openComposer());
document.querySelector("#btn-discard-draft")?.addEventListener("click", () => void discardComposeDraft());
document.querySelector("#btn-cancel-reply")?.addEventListener("click", () => cancelReplyLink());
document.querySelector("#send-filters")?.addEventListener("submit", (event) => event.preventDefault());

document.querySelector("#send-q")?.addEventListener("input", () => {
  state.sentQuery = document.querySelector("#send-q")?.value.trim().toLowerCase() || "";
  renderSentList();
});

document.querySelector("#send-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitSend();
});

for (const fieldId of ["#send-from", "#send-to", "#send-cc", "#send-bcc", "#send-subject", "#send-text"]) {
  document.querySelector(fieldId)?.addEventListener("input", () => {
    if (fieldId === "#send-from") refreshSendNote();
    scheduleDraftSave();
  });
}

document.querySelector("#send-text")?.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void submitSend();
  }
});

document.querySelector("#btn-cc-toggle")?.addEventListener("click", () => {
  for (const id of ["#send-cc-row", "#send-bcc-row"]) {
    const row = document.querySelector(id);
    if (row) row.hidden = !row.hidden;
  }
});

document.querySelector("#dkim-domain")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const input = document.querySelector("#dkim-domain");
  const domain = input ? input.value.trim().toLowerCase() : "";
  if (!domain) {
    toast("请填写域名");
    return;
  }
  void generateDkim(domain);
});

document.querySelector("#btn-add-block")?.addEventListener("click", () => void addBlocked());
document.querySelector("#block-add")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addBlocked();
  }
});

document.querySelector("#domain-add")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addDomain();
  }
});

document.querySelector("#mailbox-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveMailbox();
});

document.querySelector("#btn-save-names")?.addEventListener("click", () => void saveNameSettings());
document.querySelector("#panel-title")?.addEventListener("input", syncNamesSave);
document.querySelector("#btn-add-sender")?.addEventListener("click", () => addSenderRow());

document.querySelector("#sender-address")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSenderRow();
  }
});

document.querySelector("#sender-name")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSenderRow();
  }
});

document.querySelector("#dlq-search")?.addEventListener("submit", (event) => event.preventDefault());
document.querySelector("#dlq-q")?.addEventListener("input", () => {
  state.dlqQuery = document.querySelector("#dlq-q")?.value.trim().toLowerCase() || "";
  renderFailureGroups(state.currentJobs);
});

document.querySelector("#trash-filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadTrash();
});
trashQueryInput?.addEventListener("input", debounce(() => void reloadTrash(), 350));

document.querySelector("#filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadMessages();
});
queryInput?.addEventListener("input", debounce(() => void reloadMessages(), 350));

filterSelect?.addEventListener("change", () => {
  if (state.currentView !== "spam") return;
  clearOpenLetter();
  syncListLabel();
  void reloadMessages();
});

detailVerdictSelect?.addEventListener("change", async () => {
  if (!state.selectedMailId || state.readingSentId) return;
  const newLabel = detailVerdictSelect.value;
  detailVerdictSelect.disabled = true;
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(state.selectedMailId) + "/label", {
      method: "PATCH",
      body: { label: newLabel },
    });
    detailVerdictSelect.dataset.label = newLabel;
    const confidenceChip = document.querySelector(".confidence-chip");
    if (confidenceChip) confidenceChip.hidden = newLabel === "legit";
    if (detailModelVerdict) {
      const origName = labelName(res.originalLabel);
      detailModelVerdict.textContent = `(已改分类，原先为 ${origName})`;
    }
    const listItem = findByDataId(listEl, ".mail-item", state.selectedMailId);
    if (listItem && !staysInList(newLabel)) {
      listItem.remove();
      state.currentMessages = state.currentMessages.filter((item) => item.id !== state.selectedMailId);
    } else if (listItem) {
      const tag = listItem.querySelector(".verdict-tag");
      if (tag) {
        tag.dataset.label = newLabel;
        tag.hidden = newLabel === "legit";
        tag.textContent = newLabel === "legit" ? "" : labelName(newLabel) + " 已改";
        if (tag.parentElement) {
          const hasOtp = Boolean(tag.parentElement.querySelector(".otp-pill"));
          tag.parentElement.hidden = newLabel === "legit" && !hasOtp;
        }
      }
    }
    noticeEl.textContent = "已改成 " + labelName(newLabel);
    void refreshUnread();
    setTimeout(() => {
      if (noticeEl.textContent.startsWith("已改成")) noticeEl.textContent = "";
    }, 3000);
  } catch (err) {
    noticeEl.textContent = "修改分类失败: " + explain(err);
  } finally {
    detailVerdictSelect.disabled = false;
  }
});

listEl.addEventListener("scroll", () => {
  if (state.currentView === "inbox" || state.currentView === "spam" || state.currentView === "trash") maybeLoadMore();
});

document.querySelector("#dlq-pills")?.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("button[data-dlq-status]") : null;
  if (!target) return;
  for (const btn of document.querySelectorAll("#dlq-pills button")) btn.classList.remove("active");
  target.classList.add("active");
  const st = target.getAttribute("data-dlq-status") || "open";
  state.currentDlqScope = st;
  void loadDlqJobs(st);
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    if (!tab) return;
    switchTab(tab);
  });
});

btnLoadImages?.addEventListener("click", () => {
  state.allowExternalImages = !state.allowExternalImages;
  renderSandboxHtml(state.currentMailHtml);
});

btnReclassify?.addEventListener("click", () => {
  if (state.selectedMailId && !state.readingSentId) void reclassify(state.selectedMailId, btnReclassify);
});

function activeSearchInput() {
  if (state.currentView === "inbox" || state.currentView === "spam") return queryInput;
  if (state.currentView === "trash") return trashQueryInput;
  if (state.currentView === "send") return document.querySelector("#send-q");
  if (state.currentView === "dlq") return document.querySelector("#dlq-q");
  if (state.currentView === "settings" && state.currentSettingsSection === "users") return usersQueryInput;
  return null;
}

function handleEscapeInSearch(target) {
  if (!(target instanceof HTMLInputElement) || target.type !== "search") return false;
  const hadValue = Boolean(target.value);
  target.value = "";
  target.blur();
  if (!hadValue) return true;
  if (target === queryInput) void reloadMessages();
  else if (target === trashQueryInput) void reloadTrash();
  else if (target.id === "send-q") {
    state.sentQuery = "";
    renderSentList();
  } else if (target.id === "dlq-q") {
    state.dlqQuery = "";
    renderFailureGroups(state.currentJobs);
  } else if (target === usersQueryInput) {
    state.usersQuery = "";
    renderUsersStream();
  }
  return true;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (shortcutModal && !shortcutModal.hidden) {
      e.preventDefault();
      toggleShortcutModal(false);
      return;
    }
    if (resetModal && !resetModal.hidden) {
      e.preventDefault();
      closeReset(false);
      return;
    }
    if (handleEscapeInSearch(e.target)) {
      e.preventDefault();
    }
    return;
  }

  if (appEl.hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (confirmModal && !confirmModal.hidden) return;
  if (isTypingTarget(e.target)) return;

  if (e.key === "?") {
    e.preventDefault();
    toggleShortcutModal();
    return;
  }
  if (shortcutModal && !shortcutModal.hidden) return;

  if (e.key === "/") {
    const searchEl = activeSearchInput();
    if (searchEl) {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
    return;
  }

  if (e.key === "c") {
    e.preventDefault();
    void switchNav("send");
    return;
  }

  if (e.key === "u") {
    if ((state.currentView === "inbox" || state.currentView === "spam") && state.selectedMailId && !state.readingSentId) {
      e.preventDefault();
      void handleMarkUnread();
    }
    return;
  }

  if (state.currentView === "inbox" || state.currentView === "spam") {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") void reloadMessages();
  } else if (state.currentView === "trash") {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") void reloadTrash();
  } else if (state.currentView === "send") {
    if (e.key === "j") navigateSent(1);
    else if (e.key === "k") navigateSent(-1);
    else if (e.key === "r") void loadSendPage();
  } else if (state.currentView === "dlq" && e.key === "r") {
    void loadDlqJobs();
  } else if (state.currentView === "settings" && state.currentSettingsSection === "users" && e.key === "r") {
    void loadUsersPage();
  }
});

window.addEventListener("hashchange", () => {
  const deepId = hashMailId();
  if (deepId && !appEl.hidden) void openFailedMail(deepId);
});

export async function init() {
  initTheme();
  try {
    await revealApp();
  } catch {
    showLogin();
  }
  window.setInterval(() => void pollLive(), 15000);
}

export async function pollLive() {
  if (document.hidden || appEl.hidden) return;
  if (state.isAdmin) void updateDlqBadge();
  void refreshUnread();
  if (state.currentView === "send") {
    void refreshSentList();
    return;
  }
  if (state.currentView !== "inbox" && state.currentView !== "spam" && state.currentView !== "trash") return;
  const token = state.listLoadToken;
  const longList = state.currentMessages.length > 40;
  try {
    const params = new URLSearchParams();
    params.set("trashed", state.currentView === "trash" ? "true" : "false");
    params.set("limit", "40");
    syncListLabel();
    if ((state.currentView === "inbox" || state.currentView === "spam") && labelInput.value) {
      params.set("label", labelInput.value);
    }
    const q =
      state.currentView === "trash"
        ? trashQueryInput
          ? trashQueryInput.value.trim()
          : ""
        : queryInput
          ? queryInput.value.trim()
          : "";
    if (q) params.set("q", q);
    appendScopeParams(params);
    const page = await request("/v1/messages?" + params.toString());
    if (token !== state.listLoadToken) return;
    const items = Array.isArray(page.items) ? page.items : [];
    if (longList) {
      mergeFreshMail(items);
      return;
    }
    const same =
      items.length === state.currentMessages.length &&
      items.every(
        (item, index) =>
          item.id === state.currentMessages[index]?.id &&
          item.label === state.currentMessages[index]?.label &&
          item.read === state.currentMessages[index]?.read,
      );
    if (same) return;
    if (state.currentView === "trash") await reloadTrash();
    else {
      mergeFreshMail(items);
      if (items.length < 40) removeStaleMail(items);
    }
  } catch {
    // 下轮轮询自动重试
  }
}

void init();
