// 应用入口：全局事件装配、全套键盘流快捷键、15 秒增量状态轮询。
import { state } from "./state.js";
import {
  accountPill,
  appEl,
  backListBtn,
  btnBlockMail,
  btnDeleteMail,
  btnLoadImages,
  btnReclassify,
  btnReply,
  btnRestoreMail,
  btnTrashMail,
  confirmModal,
  detailFrom,
  detailModelVerdict,
  detailTo,
  detailVerdictSelect,
  dlqRefreshBtn,
  domainFilterSelect,
  emptyTrashBtn,
  filterSelect,
  labelInput,
  listEl,
  loginForm,
  logoutBtn,
  markAllReadBtn,
  navDlqBtn,
  navInboxBtn,
  navSendBtn,
  navSettingsBtn,
  navSpamBtn,
  navTrashBtn,
  navUsersBtn,
  noticeEl,
  otpBar,
  otpCopyBtn,
  promoBtn,
  queryInput,
  refreshBtn,
  resetModal,
  retryAllBtn,
  shortcutsBtn,
  shortcutsCloseBtn,
  shortcutsModal,
  spamReadAllBtn,
  spamRefreshBtn,
  themeBtn,
  trashQueryInput,
  trashRefreshBtn,
} from "./dom.js";
import { request } from "./net.js";
import {
  closeShortcutsModal,
  copyText,
  explain,
  findByDataId,
  isTypingTarget,
  openShortcutsModal,
  refreshUnread,
  setMobilePane,
  toast,
} from "./ui.js";
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
  handleBlockMail,
  handleDeleteMail,
  handleEmptyTrash,
  handleRestoreMail,
  handleTrashMail,
  markStreamAllRead,
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
  showSettingsSection,
  syncAttemptSave,
  syncNamesSave,
  syncNotifySave,
  syncPromptSave,
} from "./settings-view.js";
import {
  discardComposeDraft,
  loadSendPage,
  openComposer,
  refreshSendNote,
  refreshSentList,
  renderSentList,
  scheduleDraftSave,
  startReply,
  submitSend,
} from "./send-view.js";
import { fillRandomUserPassword, loadAuditView, renderUsersCards, submitCreateUser } from "./users-view.js";

// 登录与全局轨事件
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void signIn();
});

logoutBtn.addEventListener("click", () => void signOut());
themeBtn.addEventListener("click", () => toggleTheme());
shortcutsBtn?.addEventListener("click", () => openShortcutsModal());
shortcutsCloseBtn?.addEventListener("click", () => closeShortcutsModal());
shortcutsModal?.addEventListener("click", (e) => {
  if (e.target === shortcutsModal) closeShortcutsModal();
});

accountPill?.addEventListener("click", () => {
  state.currentSettingsSection = "account";
  void switchNav("settings").then(() => showSettingsSection("account"));
});

navInboxBtn?.addEventListener("click", () => void switchNav("inbox"));
navSendBtn?.addEventListener("click", () => void switchNav("send"));
navSpamBtn?.addEventListener("click", () => void switchNav("spam"));
navTrashBtn?.addEventListener("click", () => void switchNav("trash"));
navUsersBtn?.addEventListener("click", () => void switchNav("users"));
navSettingsBtn?.addEventListener("click", () => void switchNav("settings"));
navDlqBtn?.addEventListener("click", () => void switchNav("dlq"));

// 邮件流与动作栏事件
refreshBtn?.addEventListener("click", () => void reloadMessages());
markAllReadBtn?.addEventListener("click", () => void markStreamAllRead());
spamReadAllBtn?.addEventListener("click", () => void markStreamAllRead());
promoBtn?.addEventListener("click", () => setPromoMode(!state.inboxPromoOnly));
spamRefreshBtn?.addEventListener("click", () => void reloadMessages());
trashRefreshBtn?.addEventListener("click", () => void reloadTrash());
emptyTrashBtn?.addEventListener("click", () => void handleEmptyTrash());
dlqRefreshBtn?.addEventListener("click", () => void loadDlqJobs());
retryAllBtn?.addEventListener("click", () => void retryAllDead());

domainFilterSelect?.addEventListener("change", () => {
  state.selectedDomainFilter = domainFilterSelect.value || "";
  void reloadMessages();
});

btnReply?.addEventListener("click", () => void startReply());
btnTrashMail?.addEventListener("click", () => void handleTrashMail());
btnBlockMail?.addEventListener("click", () => void handleBlockMail());
btnRestoreMail?.addEventListener("click", () => void handleRestoreMail());
btnDeleteMail?.addEventListener("click", () => void handleDeleteMail());

detailFrom?.addEventListener("click", () => {
  const addr = detailFrom.dataset.copyAddr;
  if (addr) void copyText(addr, "发件地址已复制");
});

detailTo?.addEventListener("click", () => {
  const addr = detailTo.dataset.copyAddr;
  if (addr) void copyText(addr, "收件地址已复制");
});

otpCopyBtn?.addEventListener("click", () => {
  const code = otpBar?.dataset.code;
  if (code) void copyText(code, `验证码 ${code} 已复制`);
});

otpBar?.addEventListener("click", (e) => {
  if (e.target === otpCopyBtn) return;
  const code = otpBar.dataset.code;
  if (code) void copyText(code, `验证码 ${code} 已复制`);
});

backListBtn?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-dlq")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-back-settings")?.addEventListener("click", () => setMobilePane("list"));

// 设置与 AI 模型配置事件
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
  }, "思考等级已保存");
});

document.querySelector("#btn-save-password")?.addEventListener("click", () => void savePassword());
document.querySelector("#btn-forgot")?.addEventListener("click", () => void startReset());
document.querySelector("#btn-reset-close")?.addEventListener("click", () => closeReset(false));
document.querySelector("#btn-reset-other")?.addEventListener("click", () => closeReset(true));
document.querySelector("#btn-reset-continue")?.addEventListener("click", () => showResetPassword());
document.querySelector("#btn-reset-save")?.addEventListener("click", () => void finishReset());
document.querySelector("#btn-reset-resend")?.addEventListener("click", () => void sendResetCode());

document.querySelector("#btn-refresh-logs")?.addEventListener("click", () => void loadLogs());
document.querySelector("#btn-refresh-audit")?.addEventListener("click", () => void loadAuditView());
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

// 多用户管理表单与检索事件
document.querySelector("#btn-gen-user-pwd")?.addEventListener("click", () => fillRandomUserPassword());
document.querySelector("#create-user-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitCreateUser();
});
document.querySelector("#users-q")?.addEventListener("input", () => {
  state.usersQuery = document.querySelector("#users-q")?.value || "";
  renderUsersCards();
});

// 发信与写信草稿持久化事件
document.querySelector("#btn-send-refresh")?.addEventListener("click", () => void loadSendPage());
document.querySelector("#btn-compose")?.addEventListener("click", () => openComposer());
document.querySelector("#btn-back-send")?.addEventListener("click", () => setMobilePane("list"));
document.querySelector("#btn-discard-draft")?.addEventListener("click", () => {
  discardComposeDraft();
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

for (const selector of ["#send-from", "#send-to", "#send-cc", "#send-bcc", "#send-subject", "#send-text"]) {
  document.querySelector(selector)?.addEventListener("input", () => {
    if (selector === "#send-from") refreshSendNote();
    scheduleDraftSave();
  });
}

document.querySelector("#btn-cc-toggle")?.addEventListener("click", () => {
  for (const id of ["#send-cc-row", "#send-bcc-row"]) {
    const row = document.querySelector(id);
    if (row) row.hidden = !row.hidden;
  }
});

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

// 搜索框 Esc 清空与失焦
for (const [el, onClear] of [
  [queryInput, () => void reloadMessages()],
  [trashQueryInput, () => void reloadTrash()],
  [document.querySelector("#send-q"), () => { state.sentQuery = ""; renderSentList(); }],
  [document.querySelector("#dlq-q"), () => { state.dlqQuery = ""; renderFailureGroups(state.currentJobs); }],
  [document.querySelector("#users-q"), () => { state.usersQuery = ""; renderUsersCards(); }],
]) {
  el?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (el.value) {
        el.value = "";
        onClear();
      }
      el.blur();
    }
  });
}

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
      const origName = labelName(res.originalLabel);
      detailModelVerdict.textContent = `已手改 · 原判 ${origName}`;
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
        tag.textContent = newLabel === "legit" ? "" : labelName(newLabel) + " · 已改";
      }
    }
    noticeEl.textContent = "分类已改为 " + labelName(newLabel);
    void refreshUnread();
    setTimeout(() => {
      if (noticeEl.textContent.startsWith("分类已改为")) noticeEl.textContent = "";
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

function focusActiveSearch() {
  if (state.currentView === "inbox" || state.currentView === "spam") queryInput?.focus();
  else if (state.currentView === "trash") trashQueryInput?.focus();
  else if (state.currentView === "send") document.querySelector("#send-q")?.focus();
  else if (state.currentView === "dlq") document.querySelector("#dlq-q")?.focus();
  else if (state.currentView === "settings" && state.currentSettingsSection === "users") {
    document.querySelector("#users-q")?.focus();
  }
}

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (confirmModal && !confirmModal.hidden) return;
  if (resetModal && !resetModal.hidden) return;
  if (shortcutsModal && !shortcutsModal.hidden) {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      closeShortcutsModal();
    }
    return;
  }
  if (appEl && appEl.hidden) return;
  if (isTypingTarget(e.target)) return;

  if (e.key === "/") {
    e.preventDefault();
    focusActiveSearch();
    return;
  }
  if (e.key === "?") {
    e.preventDefault();
    openShortcutsModal();
    return;
  }
  if (e.key === "c" && state.session.canSend) {
    e.preventDefault();
    void switchNav("send").then(() => openComposer());
    return;
  }
  if (e.key === "u" && (state.currentView === "inbox" || state.currentView === "spam")) {
    e.preventDefault();
    void markStreamAllRead();
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
  } else if (state.currentView === "dlq" && e.key === "r") {
    void loadDlqJobs();
  } else if (state.currentView === "send" && e.key === "r") {
    void loadSendPage();
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
  if (state.session.isAdmin) void updateDlqBadge();
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
    if ((state.currentView === "inbox" || state.currentView === "spam") && state.selectedDomainFilter) {
      params.set("domain", state.selectedDomainFilter);
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
          item.summary === state.currentMessages[index]?.summary,
      );
    if (same) return;
    if (state.currentView === "trash") await reloadTrash();
    else {
      mergeFreshMail(items);
      if (items.length < 40) removeStaleMail(items);
    }
  } catch {
    // 下一个轮询周期自动恢复。
  }
}

void init();
