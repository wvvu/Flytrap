// 成员与邮箱分配管控中心（管理员专属）：独立开户、邮箱/前缀/整域分配、配额与启停管控、实时审计。
import { AUDIT_ACTION_NAMES } from "./constants.js";
import { state } from "./state.js";
import { listEl, noticeEl } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, copyText, explain, setMobilePane, toast } from "./ui.js";
import { avatarInitial, avatarToneIndex, formatFullTime, formatShortTime, generateStrongPassword } from "./util.js";
import { switchNav } from "./nav.js";

export async function loadUsersPage() {
  if (state.sessionRole !== "admin") return;
  try {
    const [usersRes, settingsRes, auditRes] = await Promise.all([
      request("/v1/users"),
      request("/v1/settings"),
      request("/v1/audit?limit=60"),
    ]);
    state.usersList = Array.isArray(usersRes.items) ? usersRes.items : [];
    state.settingsDomains = Array.isArray(settingsRes.acceptDomains)
      ? settingsRes.acceptDomains.slice()
      : state.settingsDomains;
    state.auditItems = Array.isArray(auditRes.items) ? auditRes.items : [];

    populateDomainSelect("#new-user-alloc-domain", state.settingsDomains);
    renderUsersStream();
    renderAuditTable(state.auditItems);

    if (state.creatingUser) {
      showCreateUserPanel();
    } else if (state.selectedUserId) {
      const found = state.usersList.find((u) => u.id === state.selectedUserId);
      if (found) renderSelectedUser(found);
      else selectFirstAvailableUser();
    } else {
      selectFirstAvailableUser();
    }
  } catch (err) {
    toast("加载成员信息失败: " + explain(err));
  }
}

function selectFirstAvailableUser() {
  const nonOwner = state.usersList.find((u) => !u.isOwner);
  const target = nonOwner || state.usersList[0];
  if (target) {
    state.selectedUserId = target.id;
    renderUsersStream();
    renderSelectedUser(target);
  } else {
    showUsersEmpty();
  }
}

export function populateDomainSelect(selector, domains) {
  const sel = document.querySelector(selector);
  if (!sel) return;
  sel.replaceChildren();
  for (const domain of domains) {
    const opt = document.createElement("option");
    opt.value = domain;
    opt.textContent = `@${domain}`;
    sel.append(opt);
  }
}

export function renderUsersStream() {
  if (state.currentView !== "users") return;
  listEl.replaceChildren();
  const needle = state.usersQuery.trim().toLowerCase();
  const filtered = state.usersList.filter((user) => {
    if (!needle) return true;
    const allocStr = (user.allocations || []).map((a) => a.pattern).join(" ");
    const hay = [user.username, user.displayName, user.notes, user.role, allocStr]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  });

  if (filtered.length === 0) {
    noticeEl.textContent = "没有匹配的成员账号";
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
  card.dataset.userId = user.id;
  if (!state.creatingUser && user.id === state.selectedUserId) {
    card.classList.add("selected");
  }

  const wrap = document.createElement("div");
  wrap.className = "mail-item-inner";

  const lead = document.createElement("div");
  lead.className = "mail-lead";
  const avatar = document.createElement("span");
  avatar.className = `mail-avatar tone-${avatarToneIndex(user.username)}`;
  avatar.textContent = avatarInitial(user.displayName || user.username);
  lead.append(avatar);

  const main = document.createElement("div");
  main.className = "mail-main";

  const line1 = document.createElement("div");
  line1.className = "item-line1";
  const nameEl = document.createElement("span");
  nameEl.className = "item-from";
  nameEl.textContent = user.displayName ? `${user.displayName} (${user.username})` : user.username;

  const badge = document.createElement("span");
  if (user.status === "disabled") {
    badge.className = "pill pill-xs pill-danger";
    badge.textContent = "已停用";
  } else if (user.isOwner) {
    badge.className = "pill pill-xs pill-ok";
    badge.textContent = "根管理员";
  } else if (user.role === "admin") {
    badge.className = "pill pill-xs pill-ok";
    badge.textContent = "管理员";
  } else {
    badge.className = "pill pill-xs";
    badge.textContent = "成员";
  }
  line1.append(nameEl, badge);

  const line2 = document.createElement("p");
  line2.className = "item-subject";
  const allocs = Array.isArray(user.allocations) ? user.allocations : [];
  line2.textContent =
    allocs.length === 0
      ? "尚未分配邮箱"
      : allocs.slice(0, 2).map((a) => a.pattern).join(" · ") + (allocs.length > 2 ? ` 等 ${allocs.length} 项` : "");

  const line3 = document.createElement("div");
  line3.className = "item-line3";
  const statsSpan = document.createElement("span");
  statsSpan.className = "item-snippet";
  statsSpan.textContent = `收件 ${user.messageCount || 0}（未读 ${user.unreadCount || 0}）· 24h 发信 ${user.sentLast24h || 0}`;
  line3.append(statsSpan);

  main.append(line1, line2, line3);
  wrap.append(lead, main);
  card.append(wrap);

  card.addEventListener("click", () => {
    state.creatingUser = false;
    state.selectedUserId = user.id;
    renderUsersStream();
    renderSelectedUser(user);
    setMobilePane("detail");
  });
  return card;
}

export function showUsersEmpty() {
  const empty = document.querySelector("#users-empty");
  const createPanel = document.querySelector("#user-create-panel");
  const detailPanel = document.querySelector("#user-detail-panel");
  if (empty) empty.hidden = false;
  if (createPanel) createPanel.hidden = true;
  if (detailPanel) detailPanel.hidden = true;
}

export function showCreateUserPanel() {
  state.creatingUser = true;
  renderUsersStream();
  const empty = document.querySelector("#users-empty");
  const createPanel = document.querySelector("#user-create-panel");
  const detailPanel = document.querySelector("#user-detail-panel");
  const credCard = document.querySelector("#created-cred-card");
  if (empty) empty.hidden = true;
  if (detailPanel) detailPanel.hidden = true;
  if (credCard) credCard.hidden = true;
  if (createPanel) createPanel.hidden = false;

  populateDomainSelect("#new-user-alloc-domain", state.settingsDomains);
  const pwdInput = document.querySelector("#new-user-password");
  if (pwdInput && !pwdInput.value) pwdInput.value = generateStrongPassword(14);
  setMobilePane("detail");
  document.querySelector("#new-user-username")?.focus();
}

export function fillGeneratedPassword() {
  const pwdInput = document.querySelector("#new-user-password");
  if (pwdInput) pwdInput.value = generateStrongPassword(14);
}

export async function submitCreateUser() {
  const username = document.querySelector("#new-user-username")?.value.trim() || "";
  const displayName = document.querySelector("#new-user-display")?.value.trim() || "";
  const password = document.querySelector("#new-user-password")?.value || "";
  const role = document.querySelector("#new-user-role")?.value === "admin" ? "admin" : "member";
  const quotaRaw = Number(document.querySelector("#new-user-quota")?.value ?? 100);
  const localRaw = document.querySelector("#new-user-alloc-local")?.value.trim() || "";
  const domainRaw = document.querySelector("#new-user-alloc-domain")?.value || "";
  const notes = document.querySelector("#new-user-notes")?.value.trim() || "";

  if (!username || password.length < 8) {
    toast("请填写账号名且口令不少于 8 位");
    return;
  }

  const allocations = [];
  if (localRaw && domainRaw) {
    allocations.push({ localpart: localRaw, domain: domainRaw, canSend: true });
  } else if (username.includes("@")) {
    allocations.push({ address: username, canSend: true });
  }

  const submitBtn = document.querySelector("#btn-submit-new-user");
  if (submitBtn) submitBtn.disabled = true;
  try {
    const res = await request("/v1/users", {
      method: "POST",
      body: {
        username,
        displayName: displayName || null,
        password,
        role,
        quotaSendDay: Number.isInteger(quotaRaw) ? quotaRaw : 100,
        notes: notes || null,
        allocations,
      },
    });
    const created = res.user;
    state.creatingUser = false;
    state.selectedUserId = created.id;
    state.lastCreatedCredentials = {
      username: created.username,
      password,
      role: created.role,
      allocations: (created.allocations || []).map((a) => a.pattern),
    };
    const form = document.querySelector("#user-create-form");
    if (form instanceof HTMLFormElement) form.reset();
    toast(`已创建账号 ${created.username}`);
    await loadUsersPage();
    paintCreatedCredentialBanner();
  } catch (err) {
    toast("创建账号失败: " + explain(err));
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

export function paintCreatedCredentialBanner() {
  const card = document.querySelector("#created-cred-card");
  const pre = document.querySelector("#created-cred-text");
  const cred = state.lastCreatedCredentials;
  if (!card || !pre || !cred) return;
  const origin = window.location.origin;
  const lines = [
    `登录入口: ${origin}`,
    `登录账号: ${cred.username}`,
    `初始口令: ${cred.password}`,
    `角色权限: ${cred.role === "admin" ? "协同管理员" : "独立邮箱成员"}`,
    `专属邮箱: ${cred.allocations.length ? cred.allocations.join(", ") : "待分配"}`,
  ];
  pre.textContent = lines.join("\n");
  card.hidden = false;
}

export function renderSelectedUser(user) {
  const empty = document.querySelector("#users-empty");
  const createPanel = document.querySelector("#user-create-panel");
  const detailPanel = document.querySelector("#user-detail-panel");
  const credCard = document.querySelector("#created-cred-card");
  if (empty) empty.hidden = true;
  if (createPanel) createPanel.hidden = true;
  if (credCard && state.lastCreatedCredentials?.username !== user.username) {
    credCard.hidden = true;
  }
  if (!detailPanel) return;
  detailPanel.hidden = false;
  detailPanel.replaceChildren();

  // 1. 顶部身份概览与快捷管控卡片
  const overview = document.createElement("section");
  overview.className = "block";

  const head = document.createElement("div");
  head.className = "block-head";
  const titleBox = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = user.displayName ? `${user.displayName} · ${user.username}` : user.username;
  const sub = document.createElement("p");
  sub.className = "muted";
  const lastSeen = user.lastLoginAt ? `最近登录 ${formatFullTime(user.lastLoginAt)}` : "尚未登录过";
  sub.textContent = user.isOwner
    ? "系统根管理员（由环境变量定义，拥有全部域名收发与全局管控权）"
    : `${user.status === "disabled" ? "当前已停用" : "运行正常"} · ${lastSeen}`;
  titleBox.append(h2, sub);

  const actions = document.createElement("div");
  actions.className = "inline-row";

  if (!user.isOwner && user.role === "member") {
    const viewMailBtn = document.createElement("button");
    viewMailBtn.type = "button";
    viewMailBtn.className = "btn-sm btn-accent-soft";
    viewMailBtn.textContent = "在收件箱查阅该成员来信";
    viewMailBtn.addEventListener("click", () => {
      void switchNav("inbox", { scopeFilter: "member:" + user.id });
    });
    actions.append(viewMailBtn);
  }

  if (!user.isOwner) {
    const toggleStatusBtn = document.createElement("button");
    toggleStatusBtn.type = "button";
    toggleStatusBtn.className = user.status === "disabled" ? "btn-sm btn-accent-soft" : "btn-sm btn-subtle-warn";
    toggleStatusBtn.textContent = user.status === "disabled" ? "恢复启用" : "停用并踢下线";
    toggleStatusBtn.addEventListener("click", () => void toggleUserStatus(user));
    actions.append(toggleStatusBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-sm btn-danger-ghost";
    delBtn.textContent = "删除账号";
    delBtn.addEventListener("click", () => void handleDeleteUser(user));
    actions.append(delBtn);
  }

  head.append(titleBox, actions);

  // 指标卡组
  const metrics = document.createElement("div");
  metrics.className = "user-kpi-grid";
  metrics.append(
    miniKpi("收件总量", String(user.messageCount || 0)),
    miniKpi("当前未读", String(user.unreadCount || 0)),
    miniKpi("24h 已发 / 日配额", user.isOwner ? `${user.sentLast24h || 0} / 无上限` : `${user.sentLast24h || 0} / ${user.quotaSendDay}`),
    miniKpi("分配规则数", String((user.allocations || []).length)),
  );

  overview.append(head, metrics);
  detailPanel.append(overview);

  // 2. 邮箱与域名分配规则卡片
  const allocBlock = document.createElement("section");
  allocBlock.className = "block";
  const allocHead = document.createElement("div");
  allocHead.className = "block-head";
  const allocTitleWrap = document.createElement("div");
  const allocH2 = document.createElement("h2");
  allocH2.textContent = "邮箱与域名授权规则";
  const allocSub = document.createElement("p");
  allocSub.className = "muted";
  allocSub.textContent = user.isOwner
    ? "根管理员默认接管系统全部收信域名。"
    : "精确邮箱（如 alice@domain）自动包含 alice+任意标签@domain；前缀以 * 结尾（如 shop-*@domain）按前缀匹配；* 代表整域分配。";
  allocTitleWrap.append(allocH2, allocSub);
  allocHead.append(allocTitleWrap);
  allocBlock.append(allocHead);

  const allocList = document.createElement("div");
  allocList.className = "domain-cards";
  const allocs = Array.isArray(user.allocations) ? user.allocations : [];
  if (allocs.length === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "muted";
    emptyP.textContent = "尚未分配任何邮箱规则，该成员收件箱目前为空。";
    allocList.append(emptyP);
  } else {
    for (const alloc of allocs) {
      allocList.append(createAllocationRow(user, alloc));
    }
  }
  allocBlock.append(allocList);

  if (!user.isOwner) {
    const addForm = document.createElement("form");
    addForm.className = "inline-row";
    const modeSelect = document.createElement("select");
    modeSelect.className = "field-auto";
    for (const [val, text] of [
      ["exact", "精确邮箱（含 +子地址）"],
      ["prefix", "前缀通配（自动补 *）"],
      ["domain", "整域接管 (*@域名)"],
    ]) {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = text;
      modeSelect.append(o);
    }

    const localInput = document.createElement("input");
    localInput.placeholder = "邮箱前缀，如 alice";
    localInput.autocomplete = "off";

    modeSelect.addEventListener("change", () => {
      if (modeSelect.value === "domain") {
        localInput.value = "*";
        localInput.disabled = true;
      } else {
        localInput.disabled = false;
        if (localInput.value === "*") localInput.value = "";
        localInput.placeholder = modeSelect.value === "prefix" ? "前缀，如 team-" : "邮箱前缀，如 alice";
      }
    });

    const domainSelect = document.createElement("select");
    domainSelect.className = "field-auto";
    for (const d of state.settingsDomains) {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = `@${d}`;
      domainSelect.append(o);
    }

    const canSendLabel = document.createElement("label");
    canSendLabel.className = "chk";
    const canSendChk = document.createElement("input");
    canSendChk.type = "checkbox";
    canSendChk.checked = true;
    const canSendText = document.createElement("span");
    canSendText.textContent = "允许发信";
    canSendLabel.append(canSendChk, canSendText);

    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.className = "btn-fit";
    addBtn.textContent = "添加分配";

    addForm.append(modeSelect, localInput, domainSelect, canSendLabel, addBtn);
    addForm.addEventListener("submit", (e) => {
      e.preventDefault();
      let lp = localInput.value.trim().toLowerCase();
      if (modeSelect.value === "domain") lp = "*";
      else if (modeSelect.value === "prefix" && lp && !lp.endsWith("*")) lp += "*";
      if (!lp || !domainSelect.value) {
        toast("请填写前缀并选择域名");
        return;
      }
      void addAllocationForUser(user.id, lp, domainSelect.value, canSendChk.checked);
    });
    allocBlock.append(addForm);
  }
  detailPanel.append(allocBlock);

  // 3. 资料、配额与口令重置卡片（仅托管账号可编辑）
  if (!user.isOwner) {
    const editBlock = document.createElement("section");
    editBlock.className = "block";

    const editHead = document.createElement("div");
    editHead.className = "block-head";
    const editH2 = document.createElement("h2");
    editH2.textContent = "属性、配额与口令管理";
    const saveProfileBtn = document.createElement("button");
    saveProfileBtn.type = "button";
    saveProfileBtn.className = "btn-fit";
    saveProfileBtn.textContent = "保存属性修改";
    editHead.append(editH2, saveProfileBtn);

    const dispRow = labeledInput("显示名称", user.displayName || "", "发信默认称呼，可空");
    const quotaRow = labeledInput("24h 发信上限", String(user.quotaSendDay ?? 100), "0 表示禁止外发");
    quotaRow.input.type = "number";
    quotaRow.input.min = "0";
    quotaRow.input.max = "100000";

    const roleRow = document.createElement("label");
    roleRow.className = "name-row";
    const roleCap = document.createElement("span");
    roleCap.className = "name-key";
    roleCap.textContent = "权限角色";
    const roleSel = document.createElement("select");
    for (const [val, label] of [
      ["member", "普通成员（仅限分配邮箱，严格隔离）"],
      ["admin", "协同管理员（全局查阅与系统配置）"],
    ]) {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = label;
      if (user.role === val) o.selected = true;
      roleSel.append(o);
    }
    roleRow.append(roleCap, roleSel);

    const notesRow = labeledInput("管理员备注", user.notes || "", "仅管理员可见");

    saveProfileBtn.addEventListener("click", () => {
      void saveUserProfile(user.id, {
        displayName: dispRow.input.value.trim() || null,
        role: roleSel.value === "admin" ? "admin" : "member",
        quotaSendDay: Number(quotaRow.input.value),
        notes: notesRow.input.value.trim() || null,
      });
    });

    const pwdTitle = document.createElement("h3");
    pwdTitle.className = "field-title";
    pwdTitle.textContent = "重置登录口令";

    const pwdRow = document.createElement("div");
    pwdRow.className = "inline-row";
    const pwdInput = document.createElement("input");
    pwdInput.type = "text";
    pwdInput.placeholder = "输入至少 8 位新口令";
    pwdInput.autocomplete = "off";
    const genBtn = document.createElement("button");
    genBtn.type = "button";
    genBtn.className = "btn-fit ghost";
    genBtn.textContent = "随机生成";
    genBtn.addEventListener("click", () => {
      pwdInput.value = generateStrongPassword(14);
    });
    const applyPwdBtn = document.createElement("button");
    applyPwdBtn.type = "button";
    applyPwdBtn.className = "btn-fit ghost";
    applyPwdBtn.textContent = "重置并踢出旧会话";
    applyPwdBtn.addEventListener("click", () => void resetManagedUserPassword(user, pwdInput.value));
    pwdRow.append(pwdInput, genBtn, applyPwdBtn);

    editBlock.append(editHead, dispRow.row, roleRow, quotaRow.row, notesRow.row, pwdTitle, pwdRow);
    detailPanel.append(editBlock);
  }
}

function miniKpi(label, val) {
  const box = document.createElement("div");
  box.className = "mini-kpi";
  const v = document.createElement("div");
  v.className = "mini-kpi-val";
  v.textContent = val;
  const l = document.createElement("div");
  l.className = "mini-kpi-label";
  l.textContent = label;
  box.append(v, l);
  return box;
}

function labeledInput(label, value, placeholder) {
  const row = document.createElement("label");
  row.className = "name-row";
  const span = document.createElement("span");
  span.className = "name-key";
  span.textContent = label;
  const input = document.createElement("input");
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  row.append(span, input);
  return { row, input };
}

function createAllocationRow(user, alloc) {
  const row = document.createElement("div");
  row.className = "alloc-row";

  const info = document.createElement("div");
  info.className = "alloc-info";
  const pattern = document.createElement("strong");
  pattern.className = "alloc-pattern";
  pattern.textContent = alloc.pattern;
  const kindTag = document.createElement("span");
  kindTag.className = "pill pill-xs";
  kindTag.textContent =
    alloc.kind === "domain" ? "整域" : alloc.kind === "prefix" ? "前缀通配" : "精确 + 子地址";
  info.append(pattern, kindTag);

  const actions = document.createElement("div");
  actions.className = "inline-row";
  if (user.isOwner) {
    const fixed = document.createElement("span");
    fixed.className = "pill pill-xs pill-ok";
    fixed.textContent = "全局可收可发";
    actions.append(fixed);
  } else {
    const sendToggle = document.createElement("button");
    sendToggle.type = "button";
    sendToggle.className = alloc.canSend ? "pill pill-xs pill-ok" : "pill pill-xs";
    sendToggle.textContent = alloc.canSend ? "允许发信" : "仅限收信";
    sendToggle.title = "点击切换发信权限";
    sendToggle.addEventListener("click", () => void toggleAllocationSend(user.id, alloc.id, !alloc.canSend));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-xs btn-danger-ghost";
    removeBtn.textContent = "移除";
    removeBtn.addEventListener("click", () => void removeAllocation(user.id, alloc.id));
    actions.append(sendToggle, removeBtn);
  }

  row.append(info, actions);
  return row;
}

async function addAllocationForUser(userId, localpart, domain, canSend) {
  try {
    await request(`/v1/users/${encodeURIComponent(userId)}/allocations`, {
      method: "POST",
      body: { localpart, domain, canSend },
    });
    toast(`已分配 ${localpart}@${domain}`);
    await loadUsersPage();
  } catch (err) {
    toast("添加分配失败: " + explain(err));
  }
}

async function toggleAllocationSend(userId, allocId, nextCanSend) {
  try {
    await request(`/v1/users/${encodeURIComponent(userId)}/allocations/${encodeURIComponent(allocId)}`, {
      method: "PATCH",
      body: { canSend: nextCanSend },
    });
    toast(nextCanSend ? "已开启外发权限" : "已改为仅收信");
    await loadUsersPage();
  } catch (err) {
    toast("更新失败: " + explain(err));
  }
}

async function removeAllocation(userId, allocId) {
  try {
    await request(`/v1/users/${encodeURIComponent(userId)}/allocations/${encodeURIComponent(allocId)}`, {
      method: "DELETE",
    });
    toast("邮箱授权已移除");
    await loadUsersPage();
  } catch (err) {
    toast("移除失败: " + explain(err));
  }
}

async function saveUserProfile(userId, body) {
  if (!Number.isInteger(body.quotaSendDay) || body.quotaSendDay < 0) {
    toast("配额需为非负整数");
    return;
  }
  try {
    await request(`/v1/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body,
    });
    toast("成员配置已更新");
    await loadUsersPage();
  } catch (err) {
    toast("更新失败: " + explain(err));
  }
}

async function toggleUserStatus(user) {
  const nextStatus = user.status === "disabled" ? "active" : "disabled";
  if (nextStatus === "disabled") {
    const ok = await askConfirm(`确定停用账号 ${user.username} 吗？该账号在线会话将立即失效。`);
    if (!ok) return;
  }
  try {
    await request(`/v1/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: { status: nextStatus },
    });
    toast(nextStatus === "disabled" ? "账号已停用并吊销会话" : "账号已恢复启用");
    await loadUsersPage();
  } catch (err) {
    toast("状态切换失败: " + explain(err));
  }
}

async function resetManagedUserPassword(user, nextPassword) {
  if (!nextPassword || nextPassword.length < 8) {
    toast("新口令至少需要 8 位");
    return;
  }
  try {
    await request(`/v1/users/${encodeURIComponent(user.id)}/password`, {
      method: "PUT",
      body: { password: nextPassword },
    });
    state.lastCreatedCredentials = {
      username: user.username,
      password: nextPassword,
      role: user.role,
      allocations: (user.allocations || []).map((a) => a.pattern),
    };
    toast(`已重置 ${user.username} 的口令`);
    paintCreatedCredentialBanner();
  } catch (err) {
    toast("重置口令失败: " + explain(err));
  }
}

async function handleDeleteUser(user) {
  const ok = await askConfirm(
    `确定彻底删除账号 ${user.username} 及其个人阅读状态与邮箱授权吗？底层邮件原文仍保留在归档库中。`,
    { okText: "确认删除" },
  );
  if (!ok) return;
  try {
    await request(`/v1/users/${encodeURIComponent(user.id)}`, {
      method: "DELETE",
    });
    state.selectedUserId = "";
    toast(`账号 ${user.username} 已删除`);
    await loadUsersPage();
  } catch (err) {
    toast("删除失败: " + explain(err));
  }
}

export async function refreshAuditLogs() {
  if (state.sessionRole !== "admin") return;
  try {
    const res = await request("/v1/audit?limit=60");
    state.auditItems = Array.isArray(res.items) ? res.items : [];
    renderAuditTable(state.auditItems);
  } catch (err) {
    toast("刷新审计记录失败: " + explain(err));
  }
}

export function renderAuditTable(items) {
  const tbody = document.querySelector("#audit-tbody");
  if (!tbody) return;
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
