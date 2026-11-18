// 面板主入口：事件装配、全局键盘工作流与 15 秒增量实时轮询。
import { state } from "./state.js";
import {
  adminScopeSwitch,
  appEl,
  backListBtn,
  btnBatchAll,
  btnBatchClear,
  btnBatchDelete,
  btnBatchRead,
  btnBatchRestore,
  btnBatchTrash,
  btnBatchUnread,
  btnBlockMail,
  btnCopyOtp,
  btnDeleteMail,
  btnDiscardDraft,
  btnEmptyCompose,
  btnExpandPreview,
  btnLoadImages,
  btnReclassify,
  btnReply,
  btnRestoreMail,
  btnStarDetail,
  btnTrashMail,
  btnUnreadMail,
  composeIdentitySelect,
  composeSheet,
  confirmModal,
  detailModelVerdict,
  detailVerdictSelect,
  dlqRefreshBtn,
  emptyTrashBtn,
  filterSelect,
  listEl,
  loginForm,
  logoutBtn,
  markAllReadBtn,
  navDlqBtn,
  navInboxBtn,
  navSendBtn,
  navSettingsBtn,
  navSpamBtn,
  navStarredBtn,
  navTrashBtn,
  navUsersBtn,
  noticeEl,
  paletteBtn,
  paletteInput,
  paletteModal,
  promoBtn,
  queryInput,
  railComposeBtn,
  recipientFilterSelect,
  refreshBtn,
  retryAllBtn,
  sendFilesInput,
  shortcutsModal,
  spamReadAllBtn,
  spamRefreshBtn,
  starredRefreshBtn,
  themeBtn,
  trashQueryInput,
  trashRefreshBtn,
} from "./dom.js";
import { request } from "./net.js";
import { copyText, explain, findByDataId, isTypingTarget, refreshUnread, setMobilePane, toast } from "./ui.js";
import { debounce, hashMailId } from "./util.js";
import { initTheme, revealApp, setMailScope, setPromoMode, switchNav, toggleTheme } from "./shell.js";
import {
  closeReset,
  finishReset,
  savePassword,
  sendResetCode,
  showLogin,
  showResetPassword,
  signIn,
  signOut,
  startReset,
} from "./auth.js";
import {
  buildStreamQueryParams,
  clearSelection,
  handleBlockMail,
  handleDeleteMail,
  handleEmptyTrash,
  handleMarkAllRead,
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
  runBatchAction,
  selectAllVisible,
  staysInList,
  switchTab,
  syncListLabel,
  toggleMailStar,
  togglePreviewHeight,
  toggleSelectedReadState,
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
  closeComposer,
  discardComposeDraft,
  handleAttachmentFiles,
  loadSendPage,
  openComposer,
  refreshSendNote,
  refreshSentList,
  renderSentList,
  scheduleDraftSave,
  startReply,
  submitSend,
  toggleExpandComposer,
  toggleMinimizeComposer,
} from "./send-view.js";
import {
  copyCreatedCredentials,
  generateRandomPassword,
  loadUsersView,
  openCreateUserPane,
  renderUsersList,
  submitCreateUser,
} from "./users-view.js";
import {
  closePalette,
  closeShortcutsModal,
  handlePaletteKeydown,
  openPalette,
  openShortcutsModal,
  renderPaletteItems,
} from "./palette.js";

// 登录与全局导航
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void signIn();
});

logoutBtn.addEventListener("click", () => void signOut());
themeBtn.addEventListener("click", () => toggleTheme());
paletteBtn?.addEventListener("click", () => openPalette());
railComposeBtn?.addEventListener("click", () => openComposer());
btnEmptyCompose?.addEventListener("click", () => openComposer());

navInboxBtn?.addEventListener("click", () => void switchNav("inbox"));
navStarredBtn?.addEventListener("click", () => void switchNav("starred"));
navSendBtn?.addEventListener("click", () => void switchNav("send"));
navSpamBtn?.addEventListener("click", () => void switchNav("spam"));
navTrashBtn?.addEventListener("click", () => void switchNav("trash"));
navUsersBtn?.addEventListener("click", () => void switchNav("users"));
navSettingsBtn?.addEventListener("click", () => void switchNav("settings"));
navDlqBtn?.addEventListener("click", () => void switchNav("dlq"));

// 邮件流刷新、一键已读与范围切换
refreshBtn?.addEventListener("click", () => void reloadMessages());
starredRefreshBtn?.addEventListener("click", () => void reloadMessages());
promoBtn?.addEventListener("click", () => setPromoMode(!state.inboxPromoOnly));
markAllReadBtn?.addEventListener("click", () => void handleMarkAllRead());
spamReadAllBtn?.addEventListener("click", () => void handleMarkAllRead("spam"));
spamRefreshBtn?.addEventListener("click", () => void reloadMessages());
trashRefreshBtn?.addEventListener("click", () => void reloadTrash());
emptyTrashBtn?.addEventListener("click", () => void handleEmptyTrash());
dlqRefreshBtn?.addEventListener("click", () => void loadDlqJobs());
retryAllBtn?.addEventListener("click", () => void retryAllDead());

adminScopeSwitch?.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest("button[data-scope]") : null;
  if (!btn) return;
  setMailScope(btn.getAttribute("data-scope") || "mine");
});

recipientFilterSelect?.addEventListener("change", () => {
  state.recipientFilter = recipientFilterSelect.value || "";
  if (state.currentView === "trash") void reloadTrash();
  else void reloadMessages();
});

// 批量操作栏
btnBatchAll?.addEventListener("click", () => selectAllVisible());
btnBatchClear?.addEventListener("click", () => clearSelection());
btnBatchRead?.addEventListener("click", () => void runBatchAction("read"));
btnBatchUnread?.addEventListener("click", () => void runBatchAction("unread"));
btnBatchTrash?.addEventListener("click", () => void runBatchAction("trash"));
btnBatchRestore?.addEventListener("click", () => void runBatchAction("restore"));
btnBatchDelete?.addEventListener("click", () => void runBatchAction("delete"));

// 详情操作栏
btnReply?.addEventListener("click", () => void startReply());
btnUnreadMail?.addEventListener("click", () => void toggleSelectedReadState());
btnStarDetail?.addEventListener("click", () => {
  if (state.selectedMailId && !state.readingSentId) {
    void toggleMailStar(state.selectedMailId);
  }
});
btnCopyOtp?.addEventListener("click", () => {
  if (state.currentOtpCode) void copyText(state.currentOtpCode, `验证码 ${state.currentOtpCode} 已复制`);
});
btnTrashMail?.addEventListener("click", () => void handleTrashMail());
btnBlockMail?.addEventListener("click", () => void handleBlockMail());
btnRestoreMail?.addEventListener("click", () => void handleRestoreMail());
btnDeleteMail?.addEventListener("click", () => void handleDeleteMail());
btnExpandPreview?.addEventListener("click", () => togglePreviewHeight());

backListBtn?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-dlq")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-users")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-settings")?.addEventListener("click", () => setMobilePane("list"));

// 成员管理绑定
document.querySelector("#btn-new-user")?.addEventListener("click", () => openCreateUserPane());
document.querySelector("#btn-users-refresh")?.addEventListener("click", () => void loadUsersView());
document.querySelector("#btn-gen-password")?.addEventListener("click", () => generateRandomPassword());
document.querySelector("#btn-copy-created-cred")?.addEventListener("click", () => void copyCreatedCredentials());
document.querySelector("#user-create-form")?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void submitCreateUser();
});
document.querySelector("#users-search")?.addEventListener("submit", (ev) => ev.preventDefault());
document.querySelector("#users-q")?.addEventListener("input", () => {
  state.usersQuery = document.querySelector("#users-q")?.value.trim() || "";
  renderUsersList();
});

// 悬浮写信抽屉与草稿绑定
document.querySelector("#btn-send-refresh")?.addEventListener("click", () => void loadSendPage());
document.querySelector("#btn-compose")?.addEventListener("click", () => openComposer());
document.querySelector("#btn-compose-min")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleMinimizeComposer();
});
document.querySelector("#btn-compose-expand")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleExpandComposer();
});
document.querySelector("#btn-compose-close")?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  closeComposer();
});
document.querySelector("#compose-head")?.addEventListener("click", (ev) => {
  if (ev.target instanceof Element && ev.target.closest(".compose-window-btns")) return;
  if (composeSheet?.classList.contains("is-minimized")) {
    toggleMinimizeComposer();
  }
});

composeIdentitySelect?.addEventListener("change", () => {
  const fromInput = document.querySelector("#send-from");
  if (fromInput && composeIdentitySelect.value) {
    fromInput.value = composeIdentitySelect.value;
    refreshSendNote();
    scheduleDraftSave();
  }
});

document.querySelector("#send-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitSend();
});

document.querySelector("#send-form")?.addEventListener("input", () => {
  scheduleDraftSave();
});

btnDiscardDraft?.addEventListener("click", () => discardComposeDraft());

document.querySelector("#btn-attach-file")?.addEventListener("click", () => {
  sendFilesInput?.click();
});

sendFilesInput?.addEventListener("change", () => {
  if (sendFilesInput.files) void handleAttachmentFiles(sendFilesInput.files);
});

document.querySelector("#btn-cc-toggle")?.addEventListener("click", () => {
  for (const id of ["#send-cc-row", "#send-bcc-row"]) {
    const row = document.querySelector(id);
    if (row) row.hidden = !row.hidden;
  }
});

document.querySelector("#send-from")?.addEventListener("input", refreshSendNote);
document.querySelector("#send-filters")?.addEventListener("submit", (event) => event.preventDefault());
document.querySelector("#send-q")?.addEventListener("input", () => {
  state.sentQuery = document.querySelector("#send-q")?.value.trim().toLowerCase() || "";
  renderSentList();
});

// 设置与密码绑定
document.querySelector("#ai-enabled")?.addEventListener("change", () => {
  const box = document.querySelector("#ai-enabled");
  if (!box) return;
  const next = box.checked;
  box.checked = !next;
  enqueueAi(() => {
    box.checked = next;
  }, next ? "自动分拣已开启" : "自动分拣已关闭");
});

document.querySelector("#ai-thinking")?.addEventListener("change", () => {
  const select = document.querySelector("#ai-thinking");
  if (!select) return;
  const next = select.value;
  select.value = select.dataset.prev || "low";
  enqueueAi(() => {
    select.value = next;
  }, "思考深度已保存");
});

document.querySelector("#btn-save-password")?.addEventListener("click", () => void savePassword());
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

document.querySelector("#btn-dkim-generate")?.addEventListener("click", () => {
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
document.querySelector("#personal-signature")?.addEventListener("input", syncNamesSave);
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

// 搜索框与筛选
document.querySelector("#dlq-search")?.addEventListener("submit", (event) => event.preventDefault());
document.querySelector("#dlq-q")?.addEventListener("input", () => {
  state.dlqQuery = document.querySelector("#dlq-q")?.value.trim().toLowerCase() || "";
  renderFailureGroups(state.currentJobs);
});

document.querySelector("#trash-filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadTrash();
});
trashQueryInput?.addEventListener("input", debounce(() => void reloadTrash(), 320));

document.querySelector("#filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadMessages();
});
queryInput?.addEventListener("input", debounce(() => void reloadMessages(), 320));

filterSelect?.addEventListener("change", () => {
  if (state.currentView !== "spam") return;
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
      const origName = res.originalLabel ? `，原为 ${labelName(res.originalLabel)}` : "";
      detailModelVerdict.textContent = `(已手动调整${origName})`;
    }
    const listItem = findByDataId(listEl, ".mail-item", state.selectedMailId);
    if (listItem && !staysInList(newLabel)) {
      listItem.remove();
      state.currentMessages = state.currentMessages.filter((item) => item.id !== state.selectedMailId);
    } else if (listItem) {
      const tag = listItem.querySelector(".verdict-tag");
      if (tag) {
        tag.dataset.label = newLabel;
        tag.dataset.manual = "1";
        tag.hidden = newLabel === "legit";
        tag.textContent = newLabel === "legit" ? "" : labelName(newLabel) + " · 已改";
        if (tag.parentElement) {
          const hasRcpt = Boolean(tag.parentElement.querySelector(".item-rcpt-chip"));
          tag.parentElement.hidden = newLabel === "legit" && !hasRcpt;
        }
      }
    }
    toast("已改为 " + labelName(newLabel));
    void refreshUnread();
  } catch (err) {
    noticeEl.textContent = "修改分类失败: " + explain(err);
  } finally {
    detailVerdictSelect.disabled = false;
  }
});

listEl.addEventListener("scroll", () => {
  if (
    state.currentView === "inbox" ||
    state.currentView === "starred" ||
    state.currentView === "spam" ||
    state.currentView === "trash"
  ) {
    maybeLoadMore();
  }
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

// 命令面板与快捷键弹窗绑定
paletteModal?.addEventListener("click", (ev) => {
  if (ev.target === paletteModal) closePalette();
});
paletteInput?.addEventListener("input", () => renderPaletteItems(paletteInput.value));
paletteInput?.addEventListener("keydown", handlePaletteKeydown);

shortcutsModal?.addEventListener("click", (ev) => {
  if (ev.target === shortcutsModal) closeShortcutsModal();
});
document.querySelector("#btn-shortcuts-close")?.addEventListener("click", () => closeShortcutsModal());

function activeSearchInput() {
  if (state.currentView === "trash") return trashQueryInput;
  if (state.currentView === "send") return document.querySelector("#send-q");
  if (state.currentView === "dlq") return document.querySelector("#dlq-q");
  if (state.currentView === "users") return document.querySelector("#users-q");
  if (state.currentView === "inbox" || state.currentView === "starred" || state.currentView === "spam") {
    return queryInput;
  }
  return null;
}

// 全局键盘快捷键
window.addEventListener("keydown", (e) => {
  if (appEl.hidden) return;
  if (confirmModal && !confirmModal.hidden) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteModal && !paletteModal.hidden) closePalette();
    else openPalette();
    return;
  }

  if (paletteModal && !paletteModal.hidden) return;

  if (shortcutsModal && !shortcutsModal.hidden) {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      closeShortcutsModal();
    }
    return;
  }

  if (e.key === "Escape") {
    const searchEl = activeSearchInput();
    if (searchEl && document.activeElement === searchEl) {
      e.preventDefault();
      const hadText = Boolean(searchEl.value);
      searchEl.value = "";
      searchEl.blur();
      if (hadText) {
        if (state.currentView === "trash") void reloadTrash();
        else if (state.currentView === "send") {
          state.sentQuery = "";
          renderSentList();
        } else if (state.currentView === "dlq") {
          state.dlqQuery = "";
          renderFailureGroups(state.currentJobs);
        } else if (state.currentView === "users") {
          state.usersQuery = "";
          renderUsersList();
        } else {
          void reloadMessages();
        }
      }
      return;
    }
    if (state.selectedIds.size > 0 && !isTypingTarget(e.target)) {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (composeSheet && !composeSheet.hidden && composeSheet.classList.contains("is-expanded")) {
      e.preventDefault();
      toggleExpandComposer();
      return;
    }
  }

  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;

  if (e.key === "/") {
    const searchEl = activeSearchInput();
    if (searchEl) {
      e.preventDefault();
      searchEl.focus();
      searchEl.select?.();
    }
    return;
  }

  if (e.key === "c" || e.key === "C") {
    e.preventDefault();
    openComposer();
    return;
  }

  if (e.key === "?") {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  const inMailStream =
    state.currentView === "inbox" ||
    state.currentView === "starred" ||
    state.currentView === "spam" ||
    state.currentView === "trash";

  if (inMailStream) {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") {
      if (state.currentView === "trash") void reloadTrash();
      else void reloadMessages();
    } else if (e.key === "a" && state.openDetail && !state.readingSentId) {
      e.preventDefault();
      void startReply();
    } else if (e.key === "u" && state.selectedMailId && !state.readingSentId) {
      void toggleSelectedReadState();
    } else if (e.key === "s" && state.selectedMailId && !state.readingSentId && state.mailScope !== "all") {
      void toggleMailStar(state.selectedMailId);
    } else if (e.key === "#" && state.currentView !== "trash" && state.selectedMailId && !state.readingSentId) {
      void handleTrashMail();
    }
  } else if (state.currentView === "dlq" && e.key === "r") {
    void loadDlqJobs();
  } else if (state.currentView === "send" && e.key === "r") {
    void loadSendPage();
  } else if (state.currentView === "users" && e.key === "r") {
    void loadUsersView();
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
  if (state.role === "admin") void updateDlqBadge();
  void refreshUnread();

  if (state.currentView === "send") {
    void refreshSentList();
    return;
  }
  if (
    state.currentView !== "inbox" &&
    state.currentView !== "starred" &&
    state.currentView !== "spam" &&
    state.currentView !== "trash"
  ) {
    return;
  }

  const token = state.listLoadToken;
  const longList = state.currentMessages.length > 40;
  try {
    const params = buildStreamQueryParams(true);
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
          item.read === state.currentMessages[index]?.read &&
          item.starred === state.currentMessages[index]?.starred,
      );
    if (same) return;
    if (state.currentView === "trash") await reloadTrash();
    else {
      mergeFreshMail(items);
      if (items.length < 40) removeStaleMail(items);
    }
  } catch {
    // 下次轮询重试
  }
}

void init();
