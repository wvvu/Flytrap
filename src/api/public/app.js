// 应用入口：事件绑定、全套快捷键、15 秒增量轮询。
import { state } from "./state.js";
import {
  appEl,
  backListBtn,
  btnBlockMail,
  btnCopyOtp,
  btnDeleteMail,
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
  confirmModal,
  detailFrom,
  detailModelVerdict,
  detailTo,
  detailVerdictSelect,
  dlqRefreshBtn,
  emptyTrashBtn,
  filterSelect,
  inboxScopeSelect,
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
  otpCodeText,
  paletteBtn,
  paletteInput,
  paletteModal,
  promoBtn,
  queryInput,
  refreshBtn,
  retryAllBtn,
  shortcutsModal,
  spamMarkReadBtn,
  spamRefreshBtn,
  starredQueryInput,
  starredRefreshBtn,
  themeBtn,
  trashQueryInput,
  trashRefreshBtn,
  userChipBtn,
} from "./dom.js";
import { request } from "./net.js";
import { copyText, explain, findByDataId, isTypingTarget, refreshUnread, setMobilePane, toast } from "./ui.js";
import { debounce, hashMailId } from "./util.js";
import { initTheme, revealApp, setPromoMode, switchNav, toggleTheme } from "./shell.js";
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
  clearBatchSelection,
  handleBlockMail,
  handleDeleteMail,
  handleEmptyTrash,
  handleMarkAllRead,
  handleRestoreMail,
  handleTrashMail,
  isMailStreamView,
  maybeLoadMore,
  mergeFreshMail,
  navigateMail,
  reclassify,
  reloadMessages,
  reloadTrash,
  removeStaleMail,
  renderSandboxHtml,
  runBatchAction,
  staysInList,
  switchTab,
  syncListLabel,
  toggleCurrentUnread,
  toggleReaderHeight,
  toggleSelectAllBatch,
  toggleStar,
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
  testDraftAiKey,
} from "./settings-view.js";
import {
  clearReplyDraft,
  loadSendPage,
  openComposer,
  refreshSendNote,
  refreshSentList,
  renderSentList,
  saveComposeDraft,
  startForward,
  startReply,
  submitSend,
} from "./send-view.js";
import {
  fillGeneratedPassword,
  loadUsersPage,
  refreshAuditLogs,
  renderUsersStream,
  showCreateUserPanel,
  showUsersEmpty,
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

// --- 登录与全局导航 ---
loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void signIn();
});

logoutBtn?.addEventListener("click", () => void signOut());
themeBtn?.addEventListener("click", () => toggleTheme());
paletteBtn?.addEventListener("click", () => openPalette());

userChipBtn?.addEventListener("click", () => {
  state.currentSettingsSection = "account";
  void switchNav("settings");
});

navInboxBtn?.addEventListener("click", () => void switchNav("inbox", { scopeFilter: "" }));
navStarredBtn?.addEventListener("click", () => void switchNav("starred"));
navSendBtn?.addEventListener("click", () => void switchNav("send"));
navSpamBtn?.addEventListener("click", () => void switchNav("spam"));
navTrashBtn?.addEventListener("click", () => void switchNav("trash"));
navUsersBtn?.addEventListener("click", () => void switchNav("users"));
navSettingsBtn?.addEventListener("click", () => void switchNav("settings"));
navDlqBtn?.addEventListener("click", () => void switchNav("dlq"));

// --- 列表过滤、搜索与一键已读 ---
refreshBtn?.addEventListener("click", () => void reloadMessages());
starredRefreshBtn?.addEventListener("click", () => void reloadMessages());
spamRefreshBtn?.addEventListener("click", () => void reloadMessages());
trashRefreshBtn?.addEventListener("click", () => void reloadTrash());
promoBtn?.addEventListener("click", () => setPromoMode(!state.inboxPromoOnly));

markAllReadBtn?.addEventListener("click", () => void handleMarkAllRead());
spamMarkReadBtn?.addEventListener("click", () => void handleMarkAllRead("spam"));

document.querySelector("#quick-filter-pills")?.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("button[data-qf]") : null;
  if (!btn) return;
  const qf = btn.getAttribute("data-qf") || "all";
  if (state.quickFilter === qf) return;
  state.quickFilter = qf;
  for (const b of document.querySelectorAll("#quick-filter-pills button")) {
    b.classList.toggle("active", b.getAttribute("data-qf") === qf);
  }
  void reloadMessages();
});

inboxScopeSelect?.addEventListener("change", () => {
  state.scopeFilter = inboxScopeSelect.value || "";
  void reloadMessages();
});

document.querySelector("#filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadMessages();
});
queryInput?.addEventListener("input", debounce(() => void reloadMessages(), 300));

document.querySelector("#starred-filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadMessages();
});
starredQueryInput?.addEventListener("input", debounce(() => void reloadMessages(), 300));

document.querySelector("#trash-filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadTrash();
});
trashQueryInput?.addEventListener("input", debounce(() => void reloadTrash(), 300));

filterSelect?.addEventListener("change", () => {
  if (state.currentView !== "spam") return;
  syncListLabel();
  void reloadMessages();
});

// --- 批量操作栏 ---
document.querySelector("#btn-batch-all")?.addEventListener("click", () => toggleSelectAllBatch());
document.querySelector("#btn-batch-read")?.addEventListener("click", () => void runBatchAction("read"));
document.querySelector("#btn-batch-unread")?.addEventListener("click", () => void runBatchAction("unread"));
document.querySelector("#btn-batch-trash")?.addEventListener("click", () => void runBatchAction("trash"));
document.querySelector("#btn-batch-restore")?.addEventListener("click", () => void runBatchAction("restore"));
document.querySelector("#btn-batch-delete")?.addEventListener("click", () => void runBatchAction("delete"));
document.querySelector("#btn-batch-clear")?.addEventListener("click", () => clearBatchSelection());

// --- 邮件阅读器动作 ---
emptyTrashBtn?.addEventListener("click", () => void handleEmptyTrash());
dlqRefreshBtn?.addEventListener("click", () => void loadDlqJobs());
retryAllBtn?.addEventListener("click", () => void retryAllDead());

btnStarDetail?.addEventListener("click", () => {
  if (!state.selectedMailId || state.readingSentId) return;
  const cur = Boolean(state.openDetail?.starred);
  void toggleStar(state.selectedMailId, !cur);
});

btnToggleUnread?.addEventListener("click", () => void toggleCurrentUnread());
btnExpandReader?.addEventListener("click", () => toggleReaderHeight());
btnReply?.addEventListener("click", () => void startReply(false));
btnReplyAll?.addEventListener("click", () => void startReply(true));
btnForward?.addEventListener("click", () => void startForward());
btnTrashMail?.addEventListener("click", () => void handleTrashMail());
btnBlockMail?.addEventListener("click", () => void handleBlockMail());
btnRestoreMail?.addEventListener("click", () => void handleRestoreMail());
btnDeleteMail?.addEventListener("click", () => void handleDeleteMail());

btnCopyOtp?.addEventListener("click", () => {
  const code = otpCodeText?.textContent?.trim() || "";
  if (code) void copyText(code, `验证码 ${code} 已复制`);
});

detailFrom?.addEventListener("click", () => {
  if (detailFrom.dataset.copy) void copyText(detailFrom.dataset.copy, "发件地址已复制");
});

detailTo?.addEventListener("click", () => {
  if (detailTo.dataset.copy) void copyText(detailTo.dataset.copy, "收件地址已复制");
});

backListBtn?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-dlq")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-settings")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-users")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-send")?.addEventListener("click", () => setMobilePane("list"));

// --- 发信与草稿自动保存 ---
document.querySelector("#btn-send-refresh")?.addEventListener("click", () => void loadSendPage());
document.querySelector("#btn-compose")?.addEventListener("click", () => openComposer());
document.querySelector("#btn-clear-draft")?.addEventListener("click", () => {
  clearReplyDraft(true);
  toast("草稿已清空");
});

document.querySelector("#send-filters")?.addEventListener("submit", (event) => event.preventDefault());
document.querySelector("#send-q")?.addEventListener("input", () => {
  state.sentQuery = document.querySelector("#send-q")?.value.trim().toLowerCase() || "";
  renderSentList();
});

document.querySelector("#send-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitSend();
});

const draftDebounced = debounce(() => saveComposeDraft(), 350);
for (const sel of ["#send-from", "#send-to", "#send-cc", "#send-bcc", "#send-subject", "#send-text"]) {
  document.querySelector(sel)?.addEventListener("input", draftDebounced);
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

document.querySelector("#send-from")?.addEventListener("input", refreshSendNote);

// --- 成员管理与审计 ---
document.querySelector("#btn-new-user")?.addEventListener("click", () => showCreateUserPanel());
document.querySelector("#btn-users-refresh")?.addEventListener("click", () => void loadUsersPage());
document.querySelector("#users-search-form")?.addEventListener("submit", (e) => e.preventDefault());
document.querySelector("#users-q")?.addEventListener("input", () => {
  state.usersQuery = document.querySelector("#users-q")?.value || "";
  renderUsersStream();
});
document.querySelector("#btn-gen-password")?.addEventListener("click", () => fillGeneratedPassword());
document.querySelector("#user-create-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void submitCreateUser();
});
document.querySelector("#btn-cancel-new-user")?.addEventListener("click", () => {
  state.creatingUser = false;
  if (state.selectedUserId) {
    const u = state.usersList.find((item) => item.id === state.selectedUserId);
    if (u) void loadUsersPage();
    else showUsersEmpty();
  } else {
    showUsersEmpty();
  }
});
document.querySelector("#btn-copy-cred")?.addEventListener("click", () => {
  const text = document.querySelector("#created-cred-text")?.textContent || "";
  if (text) void copyText(text, "登录凭证已复制");
});
document.querySelector("#btn-refresh-audit")?.addEventListener("click", () => void refreshAuditLogs());

// --- 设置面板交互 ---
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
document.querySelector("#btn-test-new-key")?.addEventListener("click", () => void testDraftAiKey());

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
      detailModelVerdict.textContent = `手改（原判 ${origName}）`;
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
        tag.dataset.manual = "1";
        tag.textContent = newLabel === "legit" ? "" : labelName(newLabel) + " · 手改";
        if (tag.parentElement) tag.parentElement.hidden = false;
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

listEl?.addEventListener("scroll", () => {
  if (isMailStreamView()) maybeLoadMore();
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
    if (tab) switchTab(tab);
  });
});

btnLoadImages?.addEventListener("click", () => {
  state.allowExternalImages = !state.allowExternalImages;
  renderSandboxHtml(state.currentMailHtml);
});

btnReclassify?.addEventListener("click", () => {
  if (state.selectedMailId && !state.readingSentId) void reclassify(state.selectedMailId, btnReclassify);
});

// --- 命令速达面板与快捷键弹窗 ---
paletteInput?.addEventListener("input", () => renderPaletteItems(paletteInput.value));
paletteInput?.addEventListener("keydown", handlePaletteKeydown);
paletteModal?.addEventListener("click", (e) => {
  if (e.target === paletteModal) closePalette();
});

document.querySelector("#btn-shortcuts-close")?.addEventListener("click", () => closeShortcutsModal());
shortcutsModal?.addEventListener("click", (e) => {
  if (e.target === shortcutsModal) closeShortcutsModal();
});

// 搜索框内按 Escape 清空并失焦
for (const searchEl of [queryInput, starredQueryInput, trashQueryInput]) {
  searchEl?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (searchEl.value) {
        searchEl.value = "";
        if (state.currentView === "trash") void reloadTrash();
        else void reloadMessages();
      } else {
        searchEl.blur();
      }
    }
  });
}

// --- 全局键盘快捷键 ---
window.addEventListener("keydown", (e) => {
  if (appEl?.hidden) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (state.paletteOpen) closePalette();
    else openPalette();
    return;
  }

  if (state.paletteOpen) return;
  if (shortcutsModal && !shortcutsModal.hidden && e.key === "Escape") {
    closeShortcutsModal();
    return;
  }
  if (confirmModal && !confirmModal.hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;

  if (e.key === "/") {
    const activeSearch =
      state.currentView === "trash"
        ? trashQueryInput
        : state.currentView === "starred"
          ? starredQueryInput
          : state.currentView === "send"
            ? document.querySelector("#send-q")
            : state.currentView === "users"
              ? document.querySelector("#users-q")
              : queryInput;
    if (activeSearch instanceof HTMLElement) {
      e.preventDefault();
      activeSearch.focus();
    }
    return;
  }

  if (e.key === "c") {
    e.preventDefault();
    void (async () => {
      await switchNav("send");
      openComposer();
    })();
    return;
  }

  if (e.key === "?") {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  if (isMailStreamView()) {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") {
      if (state.currentView === "trash") void reloadTrash();
      else void reloadMessages();
    } else if (e.key === "s" && state.selectedMailId && !state.readingSentId) {
      const cur = Boolean(state.openDetail?.starred);
      void toggleStar(state.selectedMailId, !cur);
    } else if (e.key === "u" && state.selectedMailId && !state.readingSentId) {
      void toggleCurrentUnread();
    } else if (e.key === "e" && state.selectedMailId && state.currentView !== "trash" && !state.readingSentId) {
      void handleTrashMail();
    }
  } else if (state.currentView === "dlq" && e.key === "r") {
    void loadDlqJobs();
  } else if (state.currentView === "send" && e.key === "r") {
    void loadSendPage();
  } else if (state.currentView === "users" && e.key === "r") {
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
  if (state.sessionRole === "admin") void updateDlqBadge();
  void refreshUnread();
  if (state.currentView === "send") {
    void refreshSentList();
    return;
  }
  if (!isMailStreamView()) return;
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
