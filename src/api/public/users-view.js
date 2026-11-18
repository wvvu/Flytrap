// 成员与邮箱分配管理工作台（管理员专属）。
import { state } from "./state.js";
import { adminScopeSelect, listEl, noticeEl } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, copyText, explain, setMobilePane, toast } from "./ui.js";
import { formatFullTime, generateRandomPassword } from "./util.js";

export async function loadUsersPage() {
  if (!state.isAdmin) return;
  populateDomainSelect(document.querySelector("#uc-mb-domain"));
  try {
    const res = await request("/v1/users");
    state.usersList = Array.isArray(res.items) ? res.items : [];
    state.hasMembers = state.usersList.length > 0;
    syncAdminScopeOptions();
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
  if (state.currentView !== "users") return;
  listEl.replaceChildren();
  const q = state.usersQuery.trim().toLowerCase();
  const filtered = state.usersList.filter((u) => {
    if (!q) return true;
    const boxes = (u.mailboxes || []).map((b) => b.address).join(" ");
    const hay = `${u.username} ${u.displayName || ""} ${u.recoveryEmail || ""} ${boxes}`.toLowerCase();
    return hay.includes(q);
  });

  if (state.usersList.length === 0) {
    noticeEl.textContent = "尚未创建独立成员账号，右侧可直接开通。";
  } else if (filtered.length === 0) {
    noticeEl.textContent = "没有匹配的成员";
  } else {
    noticeEl.textContent = "";
  }

  for (const user of filtered) {
    listEl.append(createUserStreamCard(user));
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
  for (const el of listEl.querySelectorAll(".mail-item")) el.classList.remove("selected");
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
  for (const el of listEl.querySelectorAll(".mail-item")) {
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

  if (!username || password.length < 8) {
    toast("请填写账号且密码至少 8 位");
    return;
  }
  const quotaSendPerDay = Number.parseInt(quotaRaw, 10);
  if (Number.isNaN(quotaSendPerDay) || quotaSendPerDay < 0 || quotaSendPerDay > 10000) {
    toast("每日发信上限需在 0 到 10000 之间");
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

    const form = document.querySelector("#user-create-form");
    if (form) form.reset();
    const quotaEl = document.querySelector("#uc-quota");
    if (quotaEl) quotaEl.value = "100";

    toast("账号已创建");
    await refreshUsersDataOnly();
  } catch (err) {
    toast("创建失败: " + explain(err));
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
  renderUsersStream();
}

export function renderUserDetail(user) {
  const wrap = document.querySelector("#user-detail-wrap");
  if (!wrap) return;
  wrap.replaceChildren();

  // 1. 基本资料与状态配额卡片
  const profileBlock = document.createElement("section");
  profileBlock.className = "block";

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
  const toggleStatusBtn = document.createElement("button");
  toggleStatusBtn.type = "button";
  toggleStatusBtn.className = user.status === "active" ? "btn-sm btn-danger-ghost" : "btn-sm";
  toggleStatusBtn.textContent = user.status === "active" ? "停用账号" : "恢复启用";
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
      saveBtn.disabled = false;
    }
  });
  saveActions.append(saveBtn);

  profileBlock.append(head, nameRowEl, recRowEl, roleRowEl, notesRowEl, saveActions);

  // 2. 邮箱与整域分配卡片
  const boxBlock = document.createElement("section");
  boxBlock.className = "block";
  const boxHead = document.createElement("div");
  const boxTitle = document.createElement("h2");
  boxTitle.textContent = "已分配邮箱";
  const boxDesc = document.createElement("p");
  boxDesc.className = "muted";
  boxDesc.textContent =
    "分配具体前缀（如 alice）后自动兼容 alice+标签 子地址；填 * 代表将该域名下其余未单独分配的前缀全部划归该账号。";
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
  addBoxBtn.addEventListener("click", async () => {
    const lp = localInput.value.trim().toLowerCase();
    const dm = domainSelect.value.trim().toLowerCase();
    if (!lp || !dm) {
      toast("请填写邮箱前缀与域名");
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
      toast("分配失败: " + explain(err));
    } finally {
      addBoxBtn.disabled = false;
    }
  });
  addBoxForm.append(localInput, atSign, domainSelect, aliasInput, addBoxBtn);
  boxBlock.append(addBoxForm);

  // 3. 安全操作卡片（重置密码 + 删除账号）
  const secBlock = document.createElement("section");
  secBlock.className = "block";
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
      resetPassBtn.disabled = false;
    }
  });
  passRow.append(newPassInput, genBtn, resetPassBtn);

  const delRow = document.createElement("div");
  delRow.className = "inline-row";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn-sm btn-danger";
  delBtn.textContent = "删除此账号";
  delBtn.addEventListener("click", () => void handleRemoveUser(user));
  delRow.append(delBtn);

  secBlock.append(secHead, passRow, delRow);
  wrap.append(profileBlock, boxBlock, secBlock);
}

function createAllocationRow(user, box) {
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
  revokeBtn.addEventListener("click", async () => {
    if (!(await askConfirm(`收回 ${box.address} 的归属权？`))) return;
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
  if (!(await askConfirm(`永久删除账号 ${user.username} 并释放其全部邮箱分配？`))) return;
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
