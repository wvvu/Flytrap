// 成员与邮箱分配管理工作台（仅管理员）：支持独立账号开通、随机强密码生成、精确邮箱与整域委托管理。
import { state } from "./state.js";
import { listEl, noticeEl } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, copyText, explain, setMobilePane, toast } from "./ui.js";
import { formatFullTime } from "./util.js";

const RAND_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeRandomPassword(len = 16) {
  const bytes = new Uint32Array(len);
  window.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += RAND_CHARS[bytes[i] % RAND_CHARS.length];
  }
  return out;
}

function populateDomainsDatalist() {
  const dl = document.querySelector("#accepted-domains-datalist");
  if (!dl) return;
  dl.replaceChildren();
  for (const domain of state.settingsDomains) {
    const opt = document.createElement("option");
    opt.value = domain;
    dl.append(opt);
  }
}

export async function loadUsersView() {
  if (state.role !== "admin") return;
  try {
    const [usersRes, settingsRes] = await Promise.all([
      request("/v1/users"),
      state.settingsDomains.length > 0 ? Promise.resolve(null) : request("/v1/settings"),
    ]);
    if (settingsRes && Array.isArray(settingsRes.acceptDomains)) {
      state.settingsDomains = settingsRes.acceptDomains.slice();
    }
    populateDomainsDatalist();
    state.usersList = Array.isArray(usersRes.items) ? usersRes.items : [];
    renderUsersList();

    const selected = state.usersList.find((u) => u.id === state.selectedUserId);
    if (selected) {
      selectUserDetail(selected, { keepListOnNarrow: true });
    } else if (state.usersList.length > 0 && window.matchMedia("(min-width: 1036px)").matches) {
      selectUserDetail(state.usersList[0], { keepListOnNarrow: true });
    } else {
      showUsersEmpty();
    }
  } catch (err) {
    toast("读取成员列表失败: " + explain(err));
  }
}

function showUsersEmpty() {
  const empty = document.querySelector("#users-empty");
  const createPane = document.querySelector("#user-create-pane");
  const detailPane = document.querySelector("#user-detail-pane");
  if (empty) empty.hidden = false;
  if (createPane) createPane.hidden = true;
  if (detailPane) detailPane.hidden = true;
}

export function openCreateUserPane() {
  populateDomainsDatalist();
  state.selectedUserId = "";
  markSelectedUserCard();
  const empty = document.querySelector("#users-empty");
  const createPane = document.querySelector("#user-create-pane");
  const detailPane = document.querySelector("#user-detail-pane");
  if (empty) empty.hidden = true;
  if (detailPane) detailPane.hidden = true;
  if (createPane) createPane.hidden = false;

  const domainInput = document.querySelector("#new-user-mb-domain");
  if (domainInput && !domainInput.value.trim() && state.settingsDomains[0]) {
    domainInput.value = state.settingsDomains[0];
  }
  const pwdInput = document.querySelector("#new-user-password");
  if (pwdInput && !pwdInput.value.trim()) {
    pwdInput.value = makeRandomPassword(14);
  }
  setMobilePane("detail");
  document.querySelector("#new-user-username")?.focus();
}

export function generateRandomPassword() {
  const pwdInput = document.querySelector("#new-user-password");
  if (pwdInput) pwdInput.value = makeRandomPassword(16);
}

export async function copyCreatedCredentials() {
  if (!state.lastCreatedCred) return;
  await copyText(state.lastCreatedCred, "登录凭据已复制");
}

export async function submitCreateUser() {
  const username = document.querySelector("#new-user-username")?.value.trim() || "";
  const displayName = document.querySelector("#new-user-display")?.value.trim() || "";
  const password = document.querySelector("#new-user-password")?.value || "";
  const recoveryEmail = document.querySelector("#new-user-recovery")?.value.trim() || "";
  const role = document.querySelector("#new-user-role")?.value === "admin" ? "admin" : "member";
  const mbLocal = document.querySelector("#new-user-mb-local")?.value.trim().toLowerCase() || "";
  const mbDomain = document.querySelector("#new-user-mb-domain")?.value.trim().toLowerCase() || "";
  const syncHistory = Boolean(document.querySelector("#new-user-sync-history")?.checked);

  if (!username || password.length < 8) {
    toast("请填写账号且初始密码至少 8 位");
    return;
  }

  const mailboxes = [];
  if (mbLocal && mbDomain) {
    mailboxes.push({
      localpart: mbLocal,
      domain: mbDomain,
      displayName: displayName || null,
      canSend: true,
    });
  }

  const btn = document.querySelector("#btn-submit-user");
  if (btn) btn.disabled = true;
  try {
    const res = await request("/v1/users", {
      method: "POST",
      body: {
        username,
        password,
        displayName: displayName || null,
        recoveryEmail: recoveryEmail || null,
        role,
        syncHistory,
        mailboxes,
      },
    });
    const created = res.user;
    const allocatedText =
      created.mailboxes && created.mailboxes.length > 0
        ? created.mailboxes.map((m) => m.address).join(", ")
        : "暂未分配";
    state.lastCreatedCred = [
      `面板地址: ${window.location.origin}`,
      `登录账号: ${created.username}`,
      `初始密码: ${password}`,
      `已分配邮箱: ${allocatedText}`,
    ].join("\n");

    const copyBtn = document.querySelector("#btn-copy-created-cred");
    if (copyBtn) copyBtn.hidden = false;
    await copyText(state.lastCreatedCred, "账号已创建，登录凭据已复制到剪贴板");

    const form = document.querySelector("#user-create-form");
    if (form) form.reset();

    state.selectedUserId = created.id;
    await loadUsersView();
  } catch (err) {
    toast("创建账号失败: " + explain(err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function renderUsersList() {
  if (state.currentView !== "users") return;
  listEl.replaceChildren();
  const needle = state.usersQuery.toLowerCase();
  const filtered = state.usersList.filter((u) => {
    if (!needle) return true;
    const mbs = (u.mailboxes || []).map((m) => m.address).join(" ");
    const hay = [u.username, u.displayName, u.recoveryEmail, mbs].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  });

  if (state.usersList.length === 0) noticeEl.textContent = "暂无账号";
  else if (filtered.length === 0) noticeEl.textContent = "没有匹配的成员";
  else noticeEl.textContent = "";

  for (const user of filtered) {
    listEl.append(createUserListItem(user));
  }
}

function createUserListItem(user) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "mail-item";
  card.dataset.userId = user.id;
  if (user.id === state.selectedUserId) card.classList.add("selected");

  const line1 = document.createElement("div");
  line1.className = "item-line1";

  const title = document.createElement("span");
  title.className = "item-from";
  title.textContent = user.displayName ? `${user.displayName} (${user.username})` : user.username;

  const badges = document.createElement("div");
  badges.className = "user-badges";
  const roleBadge = document.createElement("span");
  roleBadge.className = "role-chip" + (user.role === "admin" ? " admin" : "");
  roleBadge.textContent = user.role === "admin" ? "管理员" : "成员";
  badges.append(roleBadge);

  if (user.catchAll) {
    const caBadge = document.createElement("span");
    caBadge.className = "role-chip";
    caBadge.textContent = "兜底";
    badges.append(caBadge);
  }
  if (user.disabled) {
    const disBadge = document.createElement("span");
    disBadge.className = "role-chip disabled";
    disBadge.textContent = "已停用";
    badges.append(disBadge);
  }
  line1.append(title, badges);

  const mbSummary = document.createElement("p");
  mbSummary.className = "item-subject";
  const mbs = user.mailboxes || [];
  if (mbs.length === 0) {
    mbSummary.textContent = user.catchAll ? "接收未分配前缀的兜底来信" : "尚未分配邮箱";
  } else {
    mbSummary.textContent = mbs.map((m) => m.address).join("，");
  }

  const statsLine = document.createElement("p");
  statsLine.className = "item-snippet";
  statsLine.textContent = `收件 ${user.messageCount || 0} · 未读 ${user.unreadCount || 0} · 已发 ${user.sentCount || 0}`;

  card.append(line1, mbSummary, statsLine);
  card.addEventListener("click", () => selectUserDetail(user));
  return card;
}

function markSelectedUserCard() {
  for (const card of listEl.querySelectorAll(".mail-item")) {
    card.classList.toggle("selected", card.dataset.userId === state.selectedUserId);
  }
}

export function selectUserDetail(user, options = {}) {
  state.selectedUserId = user.id;
  markSelectedUserCard();

  const empty = document.querySelector("#users-empty");
  const createPane = document.querySelector("#user-create-pane");
  const detailPane = document.querySelector("#user-detail-pane");
  if (empty) empty.hidden = true;
  if (createPane) createPane.hidden = true;
  if (!detailPane) return;

  detailPane.replaceChildren(buildProfileBlock(user), buildMailboxesBlock(user));
  detailPane.hidden = false;
  if (!options.keepListOnNarrow) setMobilePane("detail");
}

function buildProfileBlock(user) {
  const sec = document.createElement("section");
  sec.className = "block";

  const head = document.createElement("div");
  head.className = "block-head";
  const headInfo = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = user.username;
  const sub = document.createElement("p");
  sub.className = "muted";
  const lastLogin = user.lastLoginAt ? `最近登录：${formatFullTime(user.lastLoginAt)}` : "尚未登录";
  sub.textContent = `${lastLogin} · 收件 ${user.messageCount || 0} 封 · 已发 ${user.sentCount || 0} 封`;
  headInfo.append(h2, sub);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn-fit";
  saveBtn.textContent = "保存资料";
  head.append(headInfo, saveBtn);

  const displayRow = labeledInput("显示名称", user.displayName || "", "发信默认称呼，可空", 40);
  const recoveryRow = labeledInput("找回邮箱", user.recoveryEmail || "", "用于接收重置验证码，可空", 254);

  const roleRow = document.createElement("label");
  roleRow.className = "name-row";
  const roleKey = document.createElement("span");
  roleKey.className = "name-key";
  roleKey.textContent = "角色权限";
  const roleSelect = document.createElement("select");
  const optMember = document.createElement("option");
  optMember.value = "member";
  optMember.textContent = "独立成员（仅访问分配邮箱）";
  const optAdmin = document.createElement("option");
  optAdmin.value = "admin";
  optAdmin.textContent = "管理员（拥有全局管理权限）";
  roleSelect.append(optMember, optAdmin);
  roleSelect.value = user.role;
  roleRow.append(roleKey, roleSelect);

  const catchAllWrap = document.createElement("label");
  catchAllWrap.className = "chk";
  const catchAllBox = document.createElement("input");
  catchAllBox.type = "checkbox";
  catchAllBox.checked = Boolean(user.catchAll);
  const catchAllSpan = document.createElement("span");
  catchAllSpan.textContent = "接收未被特定邮箱规则命中的兜底来信（Catch-All）";
  catchAllWrap.append(catchAllBox, catchAllSpan);
  catchAllWrap.hidden = roleSelect.value !== "admin";

  roleSelect.addEventListener("change", () => {
    catchAllWrap.hidden = roleSelect.value !== "admin";
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await request("/v1/users/" + encodeURIComponent(user.id), {
        method: "PATCH",
        body: {
          displayName: displayRow.input.value.trim() || null,
          recoveryEmail: recoveryRow.input.value.trim() || null,
          role: roleSelect.value,
          catchAll: roleSelect.value === "admin" ? catchAllBox.checked : false,
        },
      });
      toast("成员资料已保存");
      await loadUsersView();
    } catch (err) {
      toast("保存失败: " + explain(err));
    } finally {
      saveBtn.disabled = false;
    }
  });

  const pwdTitle = document.createElement("h3");
  pwdTitle.className = "field-title";
  pwdTitle.textContent = "重设登录密码";

  const pwdRow = document.createElement("div");
  pwdRow.className = "inline-row";
  const pwdInput = document.createElement("input");
  pwdInput.type = "text";
  pwdInput.maxLength = 200;
  pwdInput.placeholder = "输入至少 8 位新密码";
  const genBtn = document.createElement("button");
  genBtn.type = "button";
  genBtn.className = "btn-fit ghost";
  genBtn.textContent = "随机生成";
  genBtn.addEventListener("click", () => {
    pwdInput.value = makeRandomPassword(16);
  });
  const applyPwdBtn = document.createElement("button");
  applyPwdBtn.type = "button";
  applyPwdBtn.className = "btn-fit ghost";
  applyPwdBtn.textContent = "重设并复制凭据";
  applyPwdBtn.addEventListener("click", async () => {
    const nextPwd = pwdInput.value;
    if (nextPwd.length < 8) {
      toast("新密码至少 8 位");
      return;
    }
    applyPwdBtn.disabled = true;
    try {
      await request("/v1/users/" + encodeURIComponent(user.id), {
        method: "PATCH",
        body: { password: nextPwd },
      });
      const cred = `面板地址: ${window.location.origin}\n登录账号: ${user.username}\n最新密码: ${nextPwd}`;
      pwdInput.value = "";
      await copyText(cred, "密码已重设，最新凭据已复制");
    } catch (err) {
      toast("重设密码失败: " + explain(err));
    } finally {
      applyPwdBtn.disabled = false;
    }
  });
  pwdRow.append(pwdInput, genBtn, applyPwdBtn);

  const opsRow = document.createElement("div");
  opsRow.className = "inline-row";

  const toggleDisableBtn = document.createElement("button");
  toggleDisableBtn.type = "button";
  toggleDisableBtn.className = "btn-sm btn-danger-ghost";
  toggleDisableBtn.textContent = user.disabled ? "恢复启用账号" : "停用账号";
  toggleDisableBtn.disabled = user.id === state.userId;
  toggleDisableBtn.addEventListener("click", async () => {
    const nextDisabled = !user.disabled;
    if (nextDisabled && !(await askConfirm(`停用账号 ${user.username}？停用后其活动会话立即下线，来信仍继续安全代收。`))) {
      return;
    }
    try {
      await request("/v1/users/" + encodeURIComponent(user.id), {
        method: "PATCH",
        body: { disabled: nextDisabled },
      });
      toast(nextDisabled ? "账号已停用" : "账号已恢复启用");
      await loadUsersView();
    } catch (err) {
      toast("操作失败: " + explain(err));
    }
  });

  const delUserBtn = document.createElement("button");
  delUserBtn.type = "button";
  delUserBtn.className = "btn-sm btn-danger";
  delUserBtn.textContent = "删除账号";
  delUserBtn.disabled = user.id === state.userId;
  delUserBtn.addEventListener("click", async () => {
    if (!(await askConfirm(`确定删除账号 ${user.username}？其邮箱分配将被解除，底层共享邮件原件仍安全保留。`))) {
      return;
    }
    try {
      await request("/v1/users/" + encodeURIComponent(user.id), { method: "DELETE" });
      toast("账号已删除");
      state.selectedUserId = "";
      await loadUsersView();
    } catch (err) {
      toast("删除失败: " + explain(err));
    }
  });

  opsRow.append(toggleDisableBtn, delUserBtn);
  sec.append(head, displayRow.row, recoveryRow.row, roleRow, catchAllWrap, pwdTitle, pwdRow, opsRow);
  return sec;
}

function buildMailboxesBlock(user) {
  const sec = document.createElement("section");
  sec.className = "block";

  const head = document.createElement("div");
  head.className = "block-head";
  const info = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = "已分配邮箱与域名委托";
  const sub = document.createElement("p");
  sub.className = "muted";
  sub.textContent = "精确前缀（如 alice）自动包含加号子地址（alice+tag）；前缀填 * 表示整域委托给该成员。";
  info.append(h2, sub);
  head.append(info);
  sec.append(head);

  const listWrap = document.createElement("div");
  listWrap.className = "domain-list";
  const mbs = user.mailboxes || [];
  if (mbs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "尚未分配专属邮箱。";
    listWrap.append(empty);
  } else {
    for (const mb of mbs) {
      listWrap.append(buildMailboxRow(user, mb));
    }
  }
  sec.append(listWrap);

  const addTitle = document.createElement("h3");
  addTitle.className = "field-title";
  addTitle.textContent = "新增邮箱分配";

  const addForm = document.createElement("form");
  addForm.className = "send-form";
  const row1 = document.createElement("div");
  row1.className = "inline-row";

  const localInput = document.createElement("input");
  localInput.className = "field-narrow";
  localInput.maxLength = 64;
  localInput.required = true;
  localInput.placeholder = "前缀或 *";

  const atSpan = document.createElement("span");
  atSpan.className = "muted";
  atSpan.textContent = "@";

  const domainInput = document.createElement("input");
  domainInput.setAttribute("list", "accepted-domains-datalist");
  domainInput.maxLength = 253;
  domainInput.required = true;
  domainInput.placeholder = "域名";
  if (state.settingsDomains[0]) domainInput.value = state.settingsDomains[0];

  const dispInput = document.createElement("input");
  dispInput.maxLength = 40;
  dispInput.placeholder = "发信显示名称，可空";
  if (user.displayName) dispInput.value = user.displayName;

  row1.append(localInput, atSpan, domainInput, dispInput);

  const row2 = document.createElement("div");
  row2.className = "inline-row";
  const sendChkWrap = document.createElement("label");
  sendChkWrap.className = "chk";
  const sendChk = document.createElement("input");
  sendChk.type = "checkbox";
  sendChk.checked = true;
  const sendChkText = document.createElement("span");
  sendChkText.textContent = "允许作为发件地址";
  sendChkWrap.append(sendChk, sendChkText);

  const syncChkWrap = document.createElement("label");
  syncChkWrap.className = "chk";
  const syncChk = document.createElement("input");
  syncChk.type = "checkbox";
  syncChk.checked = true;
  const syncChkText = document.createElement("span");
  syncChkText.textContent = "回溯同步已有匹配邮件";
  syncChkWrap.append(syncChk, syncChkText);

  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.className = "btn-fit";
  addBtn.textContent = "分配邮箱";

  row2.append(sendChkWrap, syncChkWrap, addBtn);
  addForm.append(row1, row2);

  addForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    addBtn.disabled = true;
    try {
      await request("/v1/users/" + encodeURIComponent(user.id) + "/mailboxes", {
        method: "POST",
        body: {
          localpart: localInput.value.trim(),
          domain: domainInput.value.trim(),
          displayName: dispInput.value.trim() || null,
          canSend: sendChk.checked,
          syncHistory: syncChk.checked,
        },
      });
      toast("邮箱已分配");
      await loadUsersView();
    } catch (err) {
      toast("分配邮箱失败: " + explain(err));
    } finally {
      addBtn.disabled = false;
    }
  });

  sec.append(addTitle, addForm);
  return sec;
}

function buildMailboxRow(user, mb) {
  const wrap = document.createElement("div");
  wrap.className = "mailbox-alloc-row";

  const left = document.createElement("div");
  const addr = document.createElement("div");
  addr.className = "mailbox-alloc-addr";
  addr.textContent = mb.localpart === "*" ? `*@${mb.domain}（整域委托）` : mb.address;
  const hint = document.createElement("div");
  hint.className = "muted";
  hint.textContent =
    (mb.displayName ? `发信名：${mb.displayName} · ` : "") +
    (mb.canSend ? "可收可发" : "仅收信");
  left.append(addr, hint);

  const actions = document.createElement("div");
  actions.className = "step-actions";

  const toggleSendBtn = document.createElement("button");
  toggleSendBtn.type = "button";
  toggleSendBtn.className = "btn-xs";
  toggleSendBtn.textContent = mb.canSend ? "禁发信" : "开发信";
  toggleSendBtn.addEventListener("click", async () => {
    try {
      await request(
        `/v1/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(mb.id)}`,
        { method: "PATCH", body: { canSend: !mb.canSend } },
      );
      toast("发信权限已更新");
      await loadUsersView();
    } catch (err) {
      toast("更新失败: " + explain(err));
    }
  });

  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.className = "btn-xs";
  syncBtn.textContent = "同步历史";
  syncBtn.title = "将库内已有的匹配邮件关联进此账号收件箱";
  syncBtn.addEventListener("click", async () => {
    try {
      await request(
        `/v1/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(mb.id)}`,
        { method: "PATCH", body: { syncHistory: true } },
      );
      toast("历史匹配邮件已同步");
      await loadUsersView();
    } catch (err) {
      toast("同步失败: " + explain(err));
    }
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-xs btn-danger-ghost";
  removeBtn.textContent = "移除";
  removeBtn.addEventListener("click", async () => {
    if (!(await askConfirm(`解除 ${mb.address} 的归属分配？已收进收件箱的旧邮件仍会保留。`))) return;
    try {
      await request(
        `/v1/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(mb.id)}`,
        { method: "DELETE" },
      );
      toast("邮箱分配已移除");
      await loadUsersView();
    } catch (err) {
      toast("移除失败: " + explain(err));
    }
  });

  actions.append(toggleSendBtn, syncBtn, removeBtn);
  wrap.append(left, actions);
  return wrap;
}

function labeledInput(labelText, initialValue, placeholder, maxLength) {
  const row = document.createElement("label");
  row.className = "name-row";
  const key = document.createElement("span");
  key.className = "name-key";
  key.textContent = labelText;
  const input = document.createElement("input");
  input.value = initialValue;
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.autocomplete = "off";
  row.append(key, input);
  return { row, input };
}
