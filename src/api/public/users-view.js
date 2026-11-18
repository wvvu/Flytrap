// 成员与邮箱分配管理工作台（管理员专属）。
import { AUDIT_ACTION_NAMES } from "./constants.js";
import { state } from "./state.js";
import { adminScopeSelect } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, copyText, explain, setMobilePane, toast } from "./ui.js";
import { formatFullTime, formatShortTime, generateRandomPassword } from "./util.js";

const ALLOC_HINT =
  "精确邮箱（含 +tag）、前缀通配、整域接管。前缀按字面起首，team 会匹配 teammate。整域接住没被更具体规则分走的地址，连历史信一起划走。";

function setFormError(el, message) {
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function userCards() {
  return document.querySelectorAll("#users-cards-host .mail-item");
}

function usersSectionOpen() {
  return state.currentView === "settings" && state.currentSettingsSection === "users";
}

export async function loadUsersPage() {
  if (!state.isAdmin) return;
  populateDomainSelect(document.querySelector("#uc-mb-domain"));
  try {
    const res = await request("/v1/users");
    state.usersList = Array.isArray(res.items) ? res.items : [];
    state.hasMembers = state.usersList.length > 0;
    syncAdminScopeOptions();
    if (!usersSectionOpen()) return;
    renderUsersStream();
    if (!state.creatingUser && state.selectedUserId) {
      const found = state.usersList.find((u) => u.id === state.selectedUserId);
      if (found) {
        renderUserDetail(found);
        return;
      }
    }
    if (state.usersList.length > 0 && !state.creatingUser) {
      selectUser(state.usersList[0].id, { keepListOnNarrow: true });
    } else {
      openCreateUserCard({ keepListOnNarrow: true });
    }
  } catch (err) {
    toast("读取成员列表失败: " + explain(err));
  }
}

export function syncAdminScopeOptions() {
  if (!adminScopeSelect) return;
  const prev = state.adminScope || "mine";
  adminScopeSelect.replaceChildren();
  const optMine = document.createElement("option");
  optMine.value = "mine";
  optMine.textContent = "视角：本号与未分配";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "视角：全站全部邮件";
  adminScopeSelect.append(optMine, optAll);

  for (const user of state.usersList) {
    const opt = document.createElement("option");
    opt.value = "user:" + user.id;
    const label = user.displayName ? `${user.displayName} (${user.username})` : user.username;
    opt.textContent = `成员：${label}`;
    adminScopeSelect.append(opt);
  }

  const exists = [...adminScopeSelect.options].some((o) => o.value === prev);
  state.adminScope = exists ? prev : "mine";
  adminScopeSelect.value = state.adminScope;
}

function populateDomainSelect(selectEl) {
  if (!selectEl) return;
  const current = selectEl.value;
  selectEl.replaceChildren();
  for (const domain of state.settingsDomains) {
    const opt = document.createElement("option");
    opt.value = domain;
    opt.textContent = domain;
    selectEl.append(opt);
  }
  if (current && state.settingsDomains.includes(current)) {
    selectEl.value = current;
  }
}

export function renderUsersStream() {
  const host = document.querySelector("#users-cards-host");
  const note = document.querySelector("#users-list-note");
  if (!host) return;
  if (state.currentView !== "settings" || state.currentSettingsSection !== "users") return;
  host.replaceChildren();
  const q = state.usersQuery.trim().toLowerCase();
  const filtered = state.usersList.filter((u) => {
    if (!q) return true;
    const boxes = (u.mailboxes || []).map((b) => b.address).join(" ");
    const hay = `${u.username} ${u.displayName || ""} ${u.recoveryEmail || ""} ${boxes}`.toLowerCase();
    return hay.includes(q);
  });

  if (note) {
    if (state.usersList.length === 0) {
      note.hidden = false;
      note.textContent = "尚未创建独立成员账号，下方可直接开通。";
    } else if (filtered.length === 0) {
      note.hidden = false;
      note.textContent = "没有匹配的成员";
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }

  for (const user of filtered) {
    host.append(createUserStreamCard(user));
  }
}

export function renderMemberMailboxes() {
  const host = document.querySelector("#member-allocations-host");
  const quotaEl = document.querySelector("#member-quota-line");
  if (!host) return;
  const quota = state.quotaSendPerDay;
  if (quotaEl) {
    if (quota == null) quotaEl.textContent = "今日发信额度随账号设置。";
    else if (quota <= 0) quotaEl.textContent = "今日发信额度是 0，这个账号只收信。";
    else quotaEl.textContent = `今日已发 ${state.sentToday}/${quota}。额度按 UTC 日计算。`;
  }
  host.replaceChildren();
  const boxes = Array.isArray(state.allocatedMailboxes) ? state.allocatedMailboxes : [];
  if (boxes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "还没有分到邮箱。";
    host.append(empty);
    return;
  }
  for (const box of boxes) {
    const row = document.createElement("div");
    row.className = "alloc-row";
    const left = document.createElement("div");
    left.className = "step-copy";
    const addr = document.createElement("span");
    addr.className = "alloc-addr";
    addr.textContent = box.address || `${box.localpart}@${box.domain}`;
    const meta = document.createElement("span");
    meta.className = "muted";
    const send = box.canSend !== false ? "可收发" : "仅收信";
    let kind = `精确邮箱（含 ${box.localpart}+tag）`;
    if (box.localpart === "*") kind = "整域接管。没被更具体规则接住的地址，连历史信一起划走";
    else if (typeof box.localpart === "string" && box.localpart.endsWith("*")) {
      kind = "前缀通配。字面起首，team 会匹配 teammate";
    }
    meta.textContent = `${kind} · ${send}`;
    left.append(addr, meta);
    row.append(left);
    host.append(row);
  }
}

function createUserStreamCard(user) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "mail-item";
  card.dataset.id = user.id;
  if (!state.creatingUser && user.id === state.selectedUserId) {
    card.classList.add("selected");
  }

  const line1 = document.createElement("div");
  line1.className = "item-line1";
  const nameSpan = document.createElement("span");
  nameSpan.className = "item-from";
  nameSpan.textContent = user.displayName ? `${user.displayName} · ${user.username}` : user.username;

  const badgeWrap = document.createElement("div");
  badgeWrap.className = "step-actions";
  const rolePill = document.createElement("span");
  rolePill.className = "role-pill" + (user.role === "admin" ? " is-admin" : "");
  rolePill.textContent = user.role === "admin" ? "管理员" : "成员";
  badgeWrap.append(rolePill);
  if (user.status === "disabled") {
    const disPill = document.createElement("span");
    disPill.className = "role-pill is-disabled";
    disPill.textContent = "已停用";
    badgeWrap.append(disPill);
  }
  line1.append(nameSpan, badgeWrap);

  const line2 = document.createElement("p");
  line2.className = "item-subject";
  const boxes = Array.isArray(user.mailboxes) ? user.mailboxes : [];
  line2.textContent =
    boxes.length > 0 ? boxes.map((b) => b.address).join(", ") : "尚未分配邮箱";

  const line3 = document.createElement("div");
  line3.className = "item-line3";
  const stats = user.stats || { totalMessages: 0, unreadMessages: 0, sentToday: 0 };
  const statLine = document.createElement("span");
  statLine.className = "item-snippet";
  statLine.textContent = `收件 ${stats.totalMessages}（未读 ${stats.unreadMessages}） · 今日已发 ${stats.sentToday}/${user.quotaSendPerDay}`;
  line3.append(statLine);

  card.append(line1, line2, line3);
  card.addEventListener("click", () => selectUser(user.id));
  return card;
}

export function openCreateUserCard(options = {}) {
  state.creatingUser = true;
  state.selectedUserId = "";
  const createCard = document.querySelector("#user-create-card");
  const detailWrap = document.querySelector("#user-detail-wrap");
  if (createCard) createCard.hidden = false;
  if (detailWrap) detailWrap.hidden = true;
  populateDomainSelect(document.querySelector("#uc-mb-domain"));
  for (const el of userCards()) el.classList.remove("selected");
  if (!options.keepListOnNarrow) setMobilePane("detail");
}

export function selectUser(userId, options = {}) {
  const user = state.usersList.find((u) => u.id === userId);
  if (!user) return;
  state.creatingUser = false;
  state.selectedUserId = userId;
  const createCard = document.querySelector("#user-create-card");
  const detailWrap = document.querySelector("#user-detail-wrap");
  if (createCard) createCard.hidden = true;
  if (detailWrap) detailWrap.hidden = false;
  for (const el of userCards()) {
    el.classList.toggle("selected", el.dataset.id === userId);
  }
  renderUserDetail(user);
  if (!options.keepListOnNarrow) setMobilePane("detail");
}

export function fillCreateRandomPassword() {
  const input = document.querySelector("#uc-password");
  if (input) input.value = generateRandomPassword(14);
}

export async function submitCreateUser() {
  const username = document.querySelector("#uc-username")?.value.trim() || "";
  const displayName = document.querySelector("#uc-display-name")?.value.trim() || "";
  const password = document.querySelector("#uc-password")?.value || "";
  const role = document.querySelector("#uc-role")?.value === "admin" ? "admin" : "member";
  const quotaRaw = document.querySelector("#uc-quota")?.value.trim() || "100";
  const recoveryEmail = document.querySelector("#uc-recovery")?.value.trim() || "";
  const mbLocal = document.querySelector("#uc-mb-local")?.value.trim().toLowerCase() || "";
  const mbDomain = document.querySelector("#uc-mb-domain")?.value.trim().toLowerCase() || "";
  const notes = document.querySelector("#uc-notes")?.value.trim() || "";

  const errEl = document.querySelector("#uc-form-error");
  setFormError(errEl, "");
  if (!username || password.length < 8) {
    const message = "请填写账号且密码至少 8 位";
    setFormError(errEl, message);
    toast(message);
    return;
  }
  const quotaSendPerDay = Number.parseInt(quotaRaw, 10);
  if (Number.isNaN(quotaSendPerDay) || quotaSendPerDay < 0 || quotaSendPerDay > 10000) {
    const message = "每日发信上限需在 0 到 10000 之间";
    setFormError(errEl, message);
    toast(message);
    return;
  }

  const payload = {
    username,
    password,
    displayName: displayName || null,
    recoveryEmail: recoveryEmail || null,
    role,
    quotaSendPerDay,
    notes: notes || null,
  };
  if (mbDomain && !state.settingsDomains.includes(mbDomain)) {
    const message = "这个域名不在收信列表里";
    setFormError(errEl, message);
    toast(message);
    return;
  }
  if (mbLocal && mbDomain) {
    payload.initialMailbox = {
      localpart: mbLocal,
      domain: mbDomain,
      displayName: displayName || null,
      canSend: true,
    };
  }

  const btn = document.querySelector("#btn-uc-submit");
  if (btn) btn.disabled = true;
  try {
    const res = await request("/v1/users", { method: "POST", body: payload });
    const created = res.user;
    const allocatedLine =
      created.mailboxes && created.mailboxes.length > 0
        ? `专属邮箱：${created.mailboxes.map((b) => b.address).join(", ")}`
        : "专属邮箱：待分配";
    state.lastCreatedCredentials = [
      `登录地址：${window.location.origin}`,
      `登录账号：${created.username}`,
      `初始密码：${password}`,
      allocatedLine,
    ].join("\n");

    const credBox = document.querySelector("#uc-credential-box");
    const credText = document.querySelector("#uc-credential-text");
    if (credText) credText.textContent = state.lastCreatedCredentials;
    if (credBox) credBox.hidden = false;

    setFormError(document.querySelector("#uc-form-error"), "");
    const form = document.querySelector("#user-create-form");
    if (form) form.reset();
    const quotaEl = document.querySelector("#uc-quota");
    if (quotaEl) quotaEl.value = "100";

    toast("账号已创建");
    await refreshUsersDataOnly();
  } catch (err) {
    const message = "创建失败: " + explain(err);
    setFormError(document.querySelector("#uc-form-error"), message);
    toast(message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function copyCreatedCredentials() {
  if (!state.lastCreatedCredentials) return;
  void copyText(state.lastCreatedCredentials, "开户凭证已复制");
}

async function refreshUsersDataOnly() {
  const res = await request("/v1/users");
  state.usersList = Array.isArray(res.items) ? res.items : [];
  state.hasMembers = state.usersList.length > 0;
  syncAdminScopeOptions();
  if (!usersSectionOpen()) return;
  renderUsersStream();
}

function requiresOwnerForUser(user) {
  return user.role === "admin" && state.sessionUserId !== "owner" && user.id !== state.sessionUserId;
}

export function renderUserDetail(user) {
  const wrap = document.querySelector("#user-detail-wrap");
  if (!wrap) return;
  wrap.replaceChildren();

  // 1. 基本资料与状态配额卡片
  const profileBlock = document.createElement("section");
  profileBlock.className = "block";
  profileBlock.dataset.group = "users";

  const head = document.createElement("div");
  head.className = "block-head";
  const headText = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = user.displayName ? `${user.displayName} (${user.username})` : user.username;
  const sub = document.createElement("p");
  sub.className = "muted";
  const lastSeen = user.lastLoginAt ? `最近登录 ${formatFullTime(user.lastLoginAt)}` : "尚未登录";
  const stats = user.stats || { totalMessages: 0, unreadMessages: 0, sentToday: 0, totalSent: 0 };
  sub.textContent = `${lastSeen} · 收件 ${stats.totalMessages} 封 · 累计发出 ${stats.totalSent} 封`;
  headText.append(h2, sub);

  const headTools = document.createElement("div");
  headTools.className = "page-tools";
  const ownerOnly = requiresOwnerForUser(user);
  const toggleStatusBtn = document.createElement("button");
  toggleStatusBtn.type = "button";
  toggleStatusBtn.className = user.status === "active" ? "btn-sm btn-danger-ghost" : "btn-sm";
  toggleStatusBtn.textContent = user.status === "active" ? "停用账号" : "恢复启用";
  toggleStatusBtn.disabled = ownerOnly;
  if (ownerOnly) toggleStatusBtn.title = "仅主管理员可管理协同管理员";
  toggleStatusBtn.addEventListener("click", () => void toggleUserStatus(user));
  headTools.append(toggleStatusBtn);
  head.append(headText, headTools);

  const nameRowEl = fieldRow("显示名称");
  const nameInput = document.createElement("input");
  nameInput.value = user.displayName || "";
  nameInput.maxLength = 40;
  nameInput.placeholder = "发信默认称呼，可空";
  nameRowEl.append(nameInput);

  const recRowEl = fieldRow("密保邮箱");
  const recInput = document.createElement("input");
  recInput.value = user.recoveryEmail || "";
  recInput.maxLength = 254;
  recInput.placeholder = "接收重置密码验证码，可空";
  recRowEl.append(recInput);

  const roleRowEl = fieldRow("角色与配额");
  const roleInline = document.createElement("div");
  roleInline.className = "inline-row";
  const roleSelect = document.createElement("select");
  roleSelect.className = "field-select-fit";
  const optMember = document.createElement("option");
  optMember.value = "member";
  optMember.textContent = "普通成员";
  const optAdmin = document.createElement("option");
  optAdmin.value = "admin";
  optAdmin.textContent = "管理员";
  roleSelect.append(optMember, optAdmin);
  roleSelect.value = user.role;

  const quotaCaption = document.createElement("span");
  quotaCaption.className = "muted";
  quotaCaption.textContent = "每日发信上限";
  const quotaInput = document.createElement("input");
  quotaInput.className = "field-narrow";
  quotaInput.inputMode = "numeric";
  quotaInput.value = String(user.quotaSendPerDay ?? 100);
  roleInline.append(roleSelect, quotaCaption, quotaInput);
  roleRowEl.append(roleInline);

  const notesRowEl = fieldRow("备注");
  const notesInput = document.createElement("input");
  notesInput.value = user.notes || "";
  notesInput.maxLength = 500;
  notesInput.placeholder = "管理备注，可空";
  notesRowEl.append(notesInput);

  const saveActions = document.createElement("div");
  saveActions.className = "inline-row";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn-fit";
  saveBtn.textContent = "保存资料";
  saveBtn.disabled = ownerOnly;
  if (ownerOnly) saveBtn.title = "仅主管理员可管理协同管理员";
  saveBtn.addEventListener("click", async () => {
    const qVal = Number.parseInt(quotaInput.value.trim(), 10);
    if (Number.isNaN(qVal) || qVal < 0 || qVal > 10000) {
      toast("每日发信上限无效");
      return;
    }
    saveBtn.disabled = true;
    try {
      const res = await request("/v1/users/" + encodeURIComponent(user.id), {
        method: "PATCH",
        body: {
          displayName: nameInput.value.trim() || null,
          recoveryEmail: recInput.value.trim() || null,
          role: roleSelect.value === "admin" ? "admin" : "member",
          quotaSendPerDay: qVal,
          notes: notesInput.value.trim() || null,
        },
      });
      toast("成员资料已更新");
      await refreshUsersDataOnly();
      renderUserDetail(res.user);
    } catch (err) {
      toast("更新失败: " + explain(err));
    } finally {
      saveBtn.disabled = ownerOnly;
    }
  });
  saveActions.append(saveBtn);

  profileBlock.append(head, nameRowEl, recRowEl, roleRowEl, notesRowEl, saveActions);

  // 2. 邮箱与整域分配卡片
  const boxBlock = document.createElement("section");
  boxBlock.className = "block";
  boxBlock.dataset.group = "users";
  const boxHead = document.createElement("div");
  const boxTitle = document.createElement("h2");
  boxTitle.textContent = "已分配邮箱";
  const boxDesc = document.createElement("p");
  boxDesc.className = "muted";
  boxDesc.textContent = ALLOC_HINT + " 填 * 做整域。";
  boxHead.append(boxTitle, boxDesc);
  boxBlock.append(boxHead);

  const boxes = Array.isArray(user.mailboxes) ? user.mailboxes : [];
  if (boxes.length === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "muted";
    emptyP.textContent = "暂未分配邮箱。";
    boxBlock.append(emptyP);
  } else {
    for (const box of boxes) {
      boxBlock.append(createAllocationRow(user, box));
    }
  }

  const addBoxForm = document.createElement("div");
  addBoxForm.className = "inline-row";
  const localInput = document.createElement("input");
  localInput.className = "field-narrow";
  localInput.placeholder = "前缀或 *";
  localInput.maxLength = 64;
  const atSign = document.createElement("span");
  atSign.className = "muted";
  atSign.textContent = "@";
  const domainSelect = document.createElement("select");
  domainSelect.className = "field-select-fit";
  populateDomainSelect(domainSelect);
  const aliasInput = document.createElement("input");
  aliasInput.placeholder = "发件称呼，可空";
  aliasInput.maxLength = 40;
  const addBoxBtn = document.createElement("button");
  addBoxBtn.type = "button";
  addBoxBtn.className = "btn-fit";
  addBoxBtn.textContent = "分配";
  addBoxBtn.disabled = ownerOnly;
  if (ownerOnly) addBoxBtn.title = "仅主管理员可管理协同管理员";
  const allocError = document.createElement("p");
  allocError.className = "form-error";
  allocError.hidden = true;
  addBoxBtn.addEventListener("click", async () => {
    const lp = localInput.value.trim().toLowerCase();
    const dm = domainSelect.value.trim().toLowerCase();
    setFormError(allocError, "");
    if (!lp || !dm) {
      const message = "请填写邮箱前缀与域名";
      setFormError(allocError, message);
      toast(message);
      return;
    }
    if (!state.settingsDomains.includes(dm)) {
      const message = "这个域名不在收信列表里";
      setFormError(allocError, message);
      toast(message);
      return;
    }
    addBoxBtn.disabled = true;
    try {
      await request("/v1/users/" + encodeURIComponent(user.id) + "/mailboxes", {
        method: "POST",
        body: {
          localpart: lp,
          domain: dm,
          displayName: aliasInput.value.trim() || null,
          canSend: true,
        },
      });
      localInput.value = "";
      aliasInput.value = "";
      toast("邮箱已分配");
      await refreshUsersDataOnly();
      const refreshed = state.usersList.find((u) => u.id === user.id);
      if (refreshed) renderUserDetail(refreshed);
    } catch (err) {
      const message = "分配失败: " + explain(err);
      setFormError(allocError, message);
      toast(message);
    } finally {
      addBoxBtn.disabled = ownerOnly;
    }
  });
  addBoxForm.append(localInput, atSign, domainSelect, aliasInput, addBoxBtn);
  boxBlock.append(addBoxForm, allocError);

  // 3. 安全操作卡片（重置密码 + 删除账号）
  const secBlock = document.createElement("section");
  secBlock.className = "block";
  secBlock.dataset.group = "users";
  const secHead = document.createElement("div");
  const secTitle = document.createElement("h2");
  secTitle.textContent = "安全与清理";
  const secDesc = document.createElement("p");
  secDesc.className = "muted";
  secDesc.textContent = "重置密码或删除账号会立即退出该成员在所有设备上的登录态。删除账号不会销毁磁盘上的历史原始邮件。";
  secHead.append(secTitle, secDesc);

  const passRow = document.createElement("div");
  passRow.className = "inline-row";
  const newPassInput = document.createElement("input");
  newPassInput.type = "text";
  newPassInput.placeholder = "输入至少 8 位新密码";
  newPassInput.maxLength = 200;
  const genBtn = document.createElement("button");
  genBtn.type = "button";
  genBtn.className = "btn-fit ghost";
  genBtn.textContent = "随机生成";
  genBtn.addEventListener("click", () => {
    newPassInput.value = generateRandomPassword(14);
  });
  const resetPassBtn = document.createElement("button");
  resetPassBtn.type = "button";
  resetPassBtn.className = "btn-fit";
  resetPassBtn.textContent = "重置密码";
  resetPassBtn.disabled = ownerOnly;
  if (ownerOnly) resetPassBtn.title = "仅主管理员可管理协同管理员";
  resetPassBtn.addEventListener("click", async () => {
    const val = newPassInput.value;
    if (val.length < 8) {
      toast("新密码至少 8 位");
      return;
    }
    resetPassBtn.disabled = true;
    try {
      await request("/v1/users/" + encodeURIComponent(user.id) + "/password", {
        method: "PUT",
        body: { next: val },
      });
      await copyText(val, "密码已重置并复制到剪贴板");
      newPassInput.value = "";
    } catch (err) {
      toast("重置密码失败: " + explain(err));
    } finally {
      resetPassBtn.disabled = ownerOnly;
    }
  });
  passRow.append(newPassInput, genBtn, resetPassBtn);

  const delRow = document.createElement("div");
  delRow.className = "inline-row";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn-sm btn-danger";
  delBtn.textContent = "删除此账号";
  delBtn.disabled = ownerOnly;
  if (ownerOnly) delBtn.title = "仅主管理员可管理协同管理员";
  delBtn.addEventListener("click", () => void handleRemoveUser(user));
  delRow.append(delBtn);

  secBlock.append(secHead, passRow, delRow);

  const auditBlock = document.createElement("section");
  auditBlock.className = "block";
  auditBlock.dataset.group = "users";
  const auditHead = document.createElement("div");
  auditHead.className = "block-head";
  const auditText = document.createElement("div");
  const auditTitle = document.createElement("h2");
  auditTitle.textContent = "操作记录";
  const auditDesc = document.createElement("p");
  auditDesc.className = "muted";
  auditDesc.textContent = "这个账号做过的登录、发信和设置变更。";
  auditText.append(auditTitle, auditDesc);
  const actionSelect = document.createElement("select");
  actionSelect.className = "field-select-fit";
  actionSelect.title = "按动作筛选";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "全部动作";
  actionSelect.append(allOpt);
  for (const [action, label] of Object.entries(AUDIT_ACTION_NAMES)) {
    const opt = document.createElement("option");
    opt.value = action;
    opt.textContent = label;
    actionSelect.append(opt);
  }
  auditHead.append(auditText, actionSelect);
  const wrapTable = document.createElement("div");
  wrapTable.className = "audit-table-wrap";
  const table = document.createElement("table");
  table.className = "data-table compact-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["时间", "操作账号", "动作", "目标 / 详情"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);
  wrapTable.append(table);
  auditBlock.append(auditHead, wrapTable);
  actionSelect.addEventListener("change", () => {
    void loadMemberAudit(user.username, actionSelect.value, tbody);
  });

  wrap.append(profileBlock, boxBlock, secBlock, auditBlock);
  void loadMemberAudit(user.username, "", tbody);
}

function renderAuditTable(tbody, items) {
  tbody.replaceChildren();
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "暂无审计记录";
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const row of list) {
    const tr = document.createElement("tr");
    const tdAt = document.createElement("td");
    tdAt.className = "mono-cell";
    tdAt.textContent = formatShortTime(row.at);
    tdAt.title = formatFullTime(row.at);

    const tdActor = document.createElement("td");
    tdActor.textContent = row.actor || "—";

    const tdAct = document.createElement("td");
    tdAct.textContent = AUDIT_ACTION_NAMES[row.action] || row.action;

    const tdTarget = document.createElement("td");
    tdTarget.className = "muted mono-cell";
    const detailClean = row.detail ? String(row.detail).replace(/^"|"$/g, "") : "";
    tdTarget.textContent = [row.target, detailClean].filter(Boolean).join(" · ") || "—";

    tr.append(tdAt, tdActor, tdAct, tdTarget);
    tbody.append(tr);
  }
}

async function loadMemberAudit(username, action, tbody) {
  if (state.sessionRole !== "admin") return;
  try {
    const params = new URLSearchParams();
    params.set("actor", username);
    params.set("limit", "60");
    if (action) params.set("action", action);
    const res = await request("/v1/audit?" + params.toString());
    if (!tbody.isConnected) return;
    renderAuditTable(tbody, res.items);
  } catch (err) {
    if (!tbody.isConnected) return;
    toast("刷新审计记录失败: " + explain(err));
  }
}

function createAllocationRow(user, box) {
  const ownerOnly = requiresOwnerForUser(user);
  const row = document.createElement("div");
  row.className = "alloc-row";

  const left = document.createElement("div");
  left.className = "step-copy";
  const addr = document.createElement("span");
  addr.className = "alloc-addr";
  addr.textContent = box.address;
  const meta = document.createElement("span");
  meta.className = "muted";
  const scopeNote = box.localpart === "*" ? "整域接收" : `含 ${box.localpart}+* 子地址`;
  const dkimNote = box.dkimSigned ? "已配 DKIM" : "未配 DKIM";
  const nameNote = box.displayName ? `称呼：${box.displayName}` : "未设专属称呼";
  meta.textContent = `${scopeNote} · ${dkimNote} · ${nameNote}`;
  left.append(addr, meta);

  const right = document.createElement("div");
  right.className = "step-actions";

  const sendLabel = document.createElement("label");
  sendLabel.className = "chk";
  const sendChk = document.createElement("input");
  sendChk.type = "checkbox";
  sendChk.checked = box.canSend !== false;
  sendChk.disabled = ownerOnly;
  sendChk.addEventListener("change", async () => {
    try {
      await request(
        `/v1/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(box.id)}`,
        { method: "PATCH", body: { canSend: sendChk.checked } },
      );
      toast(sendChk.checked ? "已允许发信" : "已禁止对外发信");
      await refreshUsersDataOnly();
    } catch (err) {
      sendChk.checked = !sendChk.checked;
      toast("修改失败: " + explain(err));
    }
  });
  const sendSpan = document.createElement("span");
  sendSpan.textContent = "可发信";
  sendLabel.append(sendChk, sendSpan);

  const revokeBtn = document.createElement("button");
  revokeBtn.type = "button";
  revokeBtn.className = "btn-sm btn-danger-ghost";
  revokeBtn.textContent = "收回";
  revokeBtn.disabled = ownerOnly;
  revokeBtn.addEventListener("click", async () => {
    if (!(await askConfirm(`收回 ${box.address} 的归属权？已看见的历史信留在库里。`))) return;
    try {
      await request(
        `/v1/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(box.id)}`,
        { method: "DELETE" },
      );
      toast("已收回 " + box.address);
      await refreshUsersDataOnly();
      const refreshed = state.usersList.find((u) => u.id === user.id);
      if (refreshed) renderUserDetail(refreshed);
    } catch (err) {
      toast("收回失败: " + explain(err));
    }
  });

  right.append(sendLabel, revokeBtn);
  row.append(left, right);
  return row;
}

async function toggleUserStatus(user) {
  const nextStatus = user.status === "active" ? "disabled" : "active";
  if (
    nextStatus === "disabled" &&
    !(await askConfirm(`停用账号 ${user.username}？停用后立即断开其会话且无法登录或发信，名下历史邮件保留。`))
  ) {
    return;
  }
  try {
    const res = await request("/v1/users/" + encodeURIComponent(user.id), {
      method: "PATCH",
      body: { status: nextStatus },
    });
    toast(nextStatus === "disabled" ? "账号已停用" : "账号已恢复启用");
    await refreshUsersDataOnly();
    renderUserDetail(res.user);
  } catch (err) {
    toast("状态修改失败: " + explain(err));
  }
}

async function handleRemoveUser(user) {
  if (!(await askConfirm(`删除账号 ${user.username}。删号不删信，分配会释放，已经看见的历史信留在库里。`))) return;
  try {
    await request("/v1/users/" + encodeURIComponent(user.id), { method: "DELETE" });
    toast("已删除账号 " + user.username);
    state.selectedUserId = "";
    await loadUsersPage();
  } catch (err) {
    toast("删除失败: " + explain(err));
  }
}

function fieldRow(label) {
  const row = document.createElement("label");
  row.className = "name-row";
  const key = document.createElement("span");
  key.className = "name-key";
  key.textContent = label;
  row.append(key);
  return row;
}
