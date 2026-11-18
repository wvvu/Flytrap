// 多用户账号、邮箱规则分配、成员专属配额概览与安全审计面板。
import { ALLOCATION_KIND_LABELS, AUDIT_ACTION_LABELS, ROLE_LABELS } from "./constants.js";
import { state } from "./state.js";
import { request } from "./net.js";
import { askConfirm, copyText, explain, toast } from "./ui.js";
import { formatFullTime, formatShortTime, generateStrongPassword } from "./util.js";

export async function loadUsersSection() {
  if (!state.session.isAdmin) return;
  try {
    const res = await request("/v1/users");
    state.ownerAccount = res.owner || null;
    state.usersList = Array.isArray(res.items) ? res.items : [];
    renderUsersOverview();
    populateAllocationDomainHints();
    renderUsersCards();
  } catch (err) {
    toast("读取账号列表失败: " + explain(err));
  }
}

export function renderUsersOverview() {
  const host = document.querySelector("#users-kpi-strip");
  if (!host) return;
  host.replaceChildren();
  const totalUsers = state.usersList.length + 1;
  const activeMembers = state.usersList.filter((u) => !u.disabled && u.role === "member").length;
  const disabledCount = state.usersList.filter((u) => u.disabled).length;
  const totalRules = state.usersList.reduce((sum, u) => sum + (Array.isArray(u.allocations) ? u.allocations.length : 0), 0);

  host.append(
    kpiCell("全部账号", String(totalUsers), "含环境变量根管理员"),
    kpiCell("启用中成员", String(activeMembers), disabledCount > 0 ? `已停用 ${disabledCount} 个` : "全部处于正常状态"),
    kpiCell("邮箱分配规则", String(totalRules), "支持精确 +tag / 前缀 / 整域"),
  );

  const roleSelect = document.querySelector("#new-user-role");
  if (roleSelect) {
    for (const opt of roleSelect.options) {
      if (opt.value === "admin") {
        opt.disabled = !state.session.isOwner;
        opt.textContent = state.session.isOwner ? "协同管理员（全局权限）" : "协同管理员（仅根管理员可授）";
      }
    }
    if (!state.session.isOwner && roleSelect.value === "admin") {
      roleSelect.value = "member";
    }
  }
}

function kpiCell(label, value, sub) {
  const box = document.createElement("div");
  box.className = "kpi-card";
  const num = document.createElement("div");
  num.className = "kpi-num";
  num.textContent = value;
  const title = document.createElement("div");
  title.className = "kpi-label";
  title.textContent = label;
  const hint = document.createElement("div");
  hint.className = "kpi-hint";
  hint.textContent = sub;
  box.append(num, title, hint);
  return box;
}

export function populateAllocationDomainHints() {
  const datalist = document.querySelector("#alloc-domains-datalist");
  if (!datalist) return;
  datalist.replaceChildren();
  for (const dom of state.settingsDomains) {
    const opt = document.createElement("option");
    opt.value = dom;
    datalist.append(opt);
  }
  const createAllocInput = document.querySelector("#new-user-alloc");
  if (createAllocInput && state.settingsDomains[0] && !createAllocInput.placeholder.includes("@")) {
    createAllocInput.placeholder = `例如 alice@${state.settingsDomains[0]}，多个用逗号分隔`;
  }
}

export function fillRandomUserPassword() {
  const input = document.querySelector("#new-user-password");
  if (!input) return;
  input.type = "text";
  input.value = generateStrongPassword(16);
  input.focus();
  input.select();
}

export async function submitCreateUser() {
  const usernameInput = document.querySelector("#new-user-username");
  const displayInput = document.querySelector("#new-user-display");
  const passwordInput = document.querySelector("#new-user-password");
  const roleSelect = document.querySelector("#new-user-role");
  const limitInput = document.querySelector("#new-user-limit");
  const allocInput = document.querySelector("#new-user-alloc");
  const notesInput = document.querySelector("#new-user-notes");
  const submitBtn = document.querySelector("#btn-create-user");

  const username = usernameInput ? usernameInput.value.trim().toLowerCase() : "";
  const displayName = displayInput ? displayInput.value.trim() : "";
  const password = passwordInput ? passwordInput.value : "";
  const role = roleSelect ? roleSelect.value : "member";
  const limitRaw = limitInput ? limitInput.value.trim() : "50";
  const dailySendLimit = limitRaw === "" ? 50 : Number(limitRaw);
  const notes = notesInput ? notesInput.value.trim() : "";
  const rawAllocs = allocInput ? allocInput.value.trim() : "";

  if (!username) {
    toast("请填写登录名");
    usernameInput?.focus();
    return;
  }
  if (password.length < 8) {
    toast("初始密码至少 8 位");
    passwordInput?.focus();
    return;
  }
  if (!Number.isInteger(dailySendLimit) || dailySendLimit < 0 || dailySendLimit > 10000) {
    toast("24 小时发信配额需在 0 到 10000 之间");
    limitInput?.focus();
    return;
  }

  const allocations = rawAllocs
    ? rawAllocs
        .split(/[,;\uff0c\uff1b\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pattern) => ({ pattern, canSend: true }))
    : [];

  if (submitBtn) submitBtn.disabled = true;
  try {
    const res = await request("/v1/users", {
      method: "POST",
      body: {
        username,
        displayName: displayName || null,
        password,
        role,
        dailySendLimit,
        notes: notes || null,
        allocations,
      },
    });
    const created = res.user;
    const credSummary = [
      `登录地址: ${window.location.origin}`,
      `账号: ${created.username}`,
      `初始密码: ${password}`,
      created.allocations?.length
        ? `专属邮箱: ${created.allocations.map((a) => a.pattern).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (usernameInput) usernameInput.value = "";
    if (displayInput) displayInput.value = "";
    if (passwordInput) passwordInput.value = "";
    if (allocInput) allocInput.value = "";
    if (notesInput) notesInput.value = "";

    await copyText(credSummary, "账号已创建，登录凭据已复制到剪贴板");
    await loadUsersSection();
  } catch (err) {
    toast("创建账号失败: " + explain(err));
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

export function renderUsersCards() {
  const host = document.querySelector("#users-cards-list");
  if (!host) return;
  host.replaceChildren();
  const needle = state.usersQuery.trim().toLowerCase();

  if (state.ownerAccount && (!needle || state.ownerAccount.username.toLowerCase().includes(needle) || "owner".includes(needle))) {
    host.append(createOwnerCard(state.ownerAccount));
  }

  const filtered = state.usersList.filter((u) => {
    if (!needle) return true;
    const allocStr = (u.allocations || []).map((a) => a.pattern).join(" ");
    const hay = [u.username, u.displayName, u.role, u.notes, allocStr].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  });

  if (filtered.length === 0 && state.usersList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "user-empty-hint";
    empty.textContent = "当前仅有环境变量根管理员。可在上方为信任的伙伴开立独立成员账号并分配专属邮箱。";
    host.append(empty);
    return;
  }

  for (const user of filtered) {
    host.append(createUserCard(user));
  }
}

function createOwnerCard(owner) {
  const card = document.createElement("div");
  card.className = "user-card user-card-owner";

  const head = document.createElement("div");
  head.className = "user-card-head";

  const idGroup = document.createElement("div");
  idGroup.className = "user-id-group";
  const avatar = document.createElement("span");
  avatar.className = "user-avatar owner";
  avatar.textContent = (owner.username[0] || "R").toUpperCase();

  const meta = document.createElement("div");
  const titleLine = document.createElement("div");
  titleLine.className = "user-title-line";
  const strong = document.createElement("strong");
  strong.textContent = owner.username;
  const roleChip = document.createElement("span");
  roleChip.className = "role-badge role-owner";
  roleChip.textContent = ROLE_LABELS.owner;
  titleLine.append(strong, roleChip);

  const sub = document.createElement("p");
  sub.className = "muted user-subline";
  sub.textContent = owner.passwordSet
    ? "最高权限账号 · 已在面板自定义密码 · 拥有全部域名与系统控制权"
    : "最高权限账号 · 当前使用环境变量初始口令 · 拥有全部域名与系统控制权";
  meta.append(titleLine, sub);
  idGroup.append(avatar, meta);
  head.append(idGroup);
  card.append(head);
  return card;
}

function createUserCard(user) {
  const canManage = state.session.isOwner || user.role !== "admin" || user.id === state.session.userId;
  const card = document.createElement("div");
  card.className = "user-card" + (user.disabled ? " is-disabled" : "");

  const head = document.createElement("div");
  head.className = "user-card-head";

  const idGroup = document.createElement("div");
  idGroup.className = "user-id-group";
  const avatar = document.createElement("span");
  avatar.className = "user-avatar " + (user.role === "admin" ? "admin" : "member");
  avatar.textContent = ((user.displayName || user.username)[0] || "U").toUpperCase();

  const meta = document.createElement("div");
  const titleLine = document.createElement("div");
  titleLine.className = "user-title-line";
  const strong = document.createElement("strong");
  strong.textContent = user.displayName ? `${user.displayName} (${user.username})` : user.username;

  const roleChip = document.createElement("span");
  roleChip.className = "role-badge role-" + user.role;
  roleChip.textContent = ROLE_LABELS[user.role] || user.role;

  const statusChip = document.createElement("span");
  statusChip.className = "status-dot-badge " + (user.disabled ? "off" : "on");
  statusChip.textContent = user.disabled ? "已停用" : "正常";

  titleLine.append(strong, roleChip, statusChip);

  const sub = document.createElement("p");
  sub.className = "muted user-subline";
  const quotaText =
    user.role === "admin"
      ? `24h 已发 ${user.sentLast24h || 0} 封（管理员不限收信域）`
      : user.dailySendLimit === 0
        ? "禁止外发邮件"
        : `24h 发信 ${user.sentLast24h || 0} / ${user.dailySendLimit} 封`;
  const lastSeen = user.lastLoginAt ? `最近登录 ${formatShortTime(user.lastLoginAt)}` : "尚未登录";
  const notesPart = user.notes ? ` · 备注: ${user.notes}` : "";
  sub.textContent = `${quotaText} · ${lastSeen}${notesPart}`;

  meta.append(titleLine, sub);
  idGroup.append(avatar, meta);

  const actions = document.createElement("div");
  actions.className = "user-card-actions";

  if (canManage) {
    const editBtn = actionBtn("编辑资料", () => {
      editDrawer.hidden = !editDrawer.hidden;
      pwdDrawer.hidden = true;
    });
    const pwdBtn = actionBtn("重置密码", () => {
      pwdDrawer.hidden = !pwdDrawer.hidden;
      editDrawer.hidden = true;
    });
    actions.append(editBtn, pwdBtn);

    if (user.id !== state.session.userId) {
      const kickBtn = actionBtn("踢出会话", () => void handleRevokeSessions(user));
      const toggleBtn = actionBtn(user.disabled ? "恢复启用" : "停用", () => void handleToggleUser(user));
      const delBtn = actionBtn("删除", () => void handleDeleteUser(user), true);
      actions.append(kickBtn, toggleBtn, delBtn);
    }
  }

  head.append(idGroup, actions);
  card.append(head);

  // 编辑资料抽屉
  const editDrawer = buildEditUserDrawer(user);
  editDrawer.hidden = true;

  // 重置密码抽屉
  const pwdDrawer = buildResetUserPasswordDrawer(user);
  pwdDrawer.hidden = true;

  card.append(editDrawer, pwdDrawer);

  // 邮箱分配区（针对 member 账号尤为核心；admin 本身具备全局视野也可备注）
  if (user.role === "member") {
    card.append(buildUserAllocationsBox(user, canManage));
  } else {
    const adminHint = document.createElement("p");
    adminHint.className = "user-alloc-admin-note";
    adminHint.textContent = "协同管理员默认可查看全部收信域名下的邮件并管理普通成员。";
    card.append(adminHint);
  }

  return card;
}

function buildUserAllocationsBox(user, canManage) {
  const wrap = document.createElement("div");
  wrap.className = "user-alloc-box";

  const titleRow = document.createElement("div");
  titleRow.className = "user-alloc-head";
  const label = document.createElement("span");
  label.className = "user-alloc-title";
  label.textContent = `已分配邮箱规则 (${(user.allocations || []).length})`;
  titleRow.append(label);
  wrap.append(titleRow);

  const chips = document.createElement("div");
  chips.className = "alloc-chip-list";
  const allocs = Array.isArray(user.allocations) ? user.allocations : [];
  if (allocs.length === 0) {
    const none = document.createElement("span");
    none.className = "text-dim";
    none.textContent = "尚未分配邮箱（该成员当前看不到任何邮件，也无法发信）";
    chips.append(none);
  } else {
    for (const alloc of allocs) {
      const chip = document.createElement("div");
      chip.className = "alloc-chip";
      const pat = document.createElement("code");
      pat.className = "alloc-pattern";
      pat.textContent = alloc.pattern;

      const kindTag = document.createElement("span");
      kindTag.className = "alloc-meta";
      const sendFlag = alloc.canSend ? "收发" : "仅收";
      kindTag.textContent = `${ALLOCATION_KIND_LABELS[alloc.kind] || alloc.kind} · ${sendFlag}`;

      chip.append(pat, kindTag);
      if (canManage) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "alloc-remove";
        rm.title = "移除此分配规则";
        rm.textContent = "×";
        rm.addEventListener("click", () => void handleRemoveAllocation(user, alloc));
        chip.append(rm);
      }
      chips.append(chip);
    }
  }
  wrap.append(chips);

  if (canManage) {
    const addForm = document.createElement("form");
    addForm.className = "alloc-add-row";

    const kindSelect = document.createElement("select");
    kindSelect.className = "alloc-kind-select";
    for (const [val, txt] of [
      ["exact", "精确邮箱 (+tag)"],
      ["prefix", "前缀通配 (prefix*)"],
      ["domain", "整域接管 (*@domain)"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = txt;
      kindSelect.append(opt);
    }

    const localInput = document.createElement("input");
    localInput.placeholder = "邮箱前缀，如 alice";
    localInput.maxLength = 64;
    localInput.autocomplete = "off";

    const atSign = document.createElement("span");
    atSign.className = "alloc-at";
    atSign.textContent = "@";

    const domainInput = document.createElement("input");
    domainInput.setAttribute("list", "alloc-domains-datalist");
    domainInput.placeholder = state.settingsDomains[0] || "example.com";
    domainInput.value = state.settingsDomains[0] || "";
    domainInput.maxLength = 253;
    domainInput.autocomplete = "off";

    kindSelect.addEventListener("change", () => {
      if (kindSelect.value === "domain") {
        localInput.value = "*";
        localInput.disabled = true;
      } else {
        if (localInput.value === "*") localInput.value = "";
        localInput.disabled = false;
        localInput.placeholder = kindSelect.value === "prefix" ? "前缀，如 team-" : "邮箱前缀，如 alice";
      }
    });

    const canSendWrap = document.createElement("label");
    canSendWrap.className = "chk alloc-send-chk";
    const canSendBox = document.createElement("input");
    canSendBox.type = "checkbox";
    canSendBox.checked = true;
    const canSendTxt = document.createElement("span");
    canSendTxt.textContent = "允许发信";
    canSendWrap.append(canSendBox, canSendTxt);

    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.className = "btn-fit ghost";
    addBtn.textContent = "添加分配";

    addForm.append(kindSelect, localInput, atSign, domainInput, canSendWrap, addBtn);
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const kind = kindSelect.value;
      const domain = domainInput.value.trim().toLowerCase();
      const local = kind === "domain" ? "*" : localInput.value.trim().toLowerCase().replace(/\*$/, "");
      if (!domain || (kind !== "domain" && !local)) {
        toast("请完整填写邮箱前缀与域名");
        return;
      }
      addBtn.disabled = true;
      try {
        await request(`/v1/users/${encodeURIComponent(user.id)}/mailboxes`, {
          method: "POST",
          body: {
            kind,
            localpart: local,
            domain,
            canSend: canSendBox.checked,
          },
        });
        toast("邮箱分配已生效");
        await loadUsersSection();
      } catch (err) {
        toast("添加分配失败: " + explain(err));
      } finally {
        addBtn.disabled = false;
      }
    });

    wrap.append(addForm);
  }

  return wrap;
}

function buildEditUserDrawer(user) {
  const box = document.createElement("form");
  box.className = "user-drawer";

  const grid = document.createElement("div");
  grid.className = "user-drawer-grid";

  const displayInput = document.createElement("input");
  displayInput.value = user.displayName || "";
  displayInput.maxLength = 40;
  displayInput.placeholder = "显示名称（可空）";

  const limitInput = document.createElement("input");
  limitInput.value = String(user.dailySendLimit ?? 50);
  limitInput.inputMode = "numeric";
  limitInput.placeholder = "24h 发信上限";

  const notesInput = document.createElement("input");
  notesInput.value = user.notes || "";
  notesInput.maxLength = 300;
  notesInput.placeholder = "管理员备注（仅后台可见）";

  grid.append(
    labeledField("显示名称", displayInput),
    labeledField("24h 发信配额", limitInput),
    labeledField("备注说明", notesInput),
  );

  let roleSelect = null;
  if (state.session.isOwner && user.id !== state.session.userId) {
    roleSelect = document.createElement("select");
    const optMember = document.createElement("option");
    optMember.value = "member";
    optMember.textContent = "成员（按规则隔离）";
    const optAdmin = document.createElement("option");
    optAdmin.value = "admin";
    optAdmin.textContent = "协同管理员（全局权限）";
    roleSelect.append(optMember, optAdmin);
    roleSelect.value = user.role;
    grid.append(labeledField("账号角色", roleSelect));
  }

  const actions = document.createElement("div");
  actions.className = "inline-row";
  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn-fit";
  saveBtn.textContent = "保存变更";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn-fit ghost";
  cancelBtn.textContent = "收起";
  cancelBtn.addEventListener("click", () => {
    box.hidden = true;
  });
  actions.append(saveBtn, cancelBtn);

  box.append(grid, actions);
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const limit = Number(limitInput.value.trim());
    if (!Number.isInteger(limit) || limit < 0 || limit > 10000) {
      toast("配额需为 0 到 10000 的整数");
      return;
    }
    saveBtn.disabled = true;
    try {
      const payload = {
        displayName: displayInput.value.trim() || null,
        dailySendLimit: limit,
        notes: notesInput.value.trim() || null,
      };
      if (roleSelect) payload.role = roleSelect.value;
      await request(`/v1/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        body: payload,
      });
      toast("账号信息已更新");
      await loadUsersSection();
    } catch (err) {
      toast("更新失败: " + explain(err));
    } finally {
      saveBtn.disabled = false;
    }
  });
  return box;
}

function buildResetUserPasswordDrawer(user) {
  const box = document.createElement("form");
  box.className = "user-drawer";
  const row = document.createElement("div");
  row.className = "inline-row";

  const pwdInput = document.createElement("input");
  pwdInput.type = "text";
  pwdInput.placeholder = "输入至少 8 位新密码";
  pwdInput.maxLength = 200;
  pwdInput.value = generateStrongPassword(16);

  const genBtn = document.createElement("button");
  genBtn.type = "button";
  genBtn.className = "btn-fit ghost";
  genBtn.textContent = "换一组随机码";
  genBtn.addEventListener("click", () => {
    pwdInput.value = generateStrongPassword(16);
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn-fit";
  saveBtn.textContent = "重置并复制";

  row.append(pwdInput, genBtn, saveBtn);
  box.append(row);

  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const next = pwdInput.value;
    if (next.length < 8) {
      toast("密码至少 8 位");
      return;
    }
    saveBtn.disabled = true;
    try {
      await request(`/v1/users/${encodeURIComponent(user.id)}/password`, {
        method: "PUT",
        body: { next },
      });
      await copyText(`账号: ${user.username}\n新密码: ${next}`, "密码已重置并复制到剪贴板");
      box.hidden = true;
    } catch (err) {
      toast("重置密码失败: " + explain(err));
    } finally {
      saveBtn.disabled = false;
    }
  });
  return box;
}

function labeledField(labelText, control) {
  const wrap = document.createElement("label");
  wrap.className = "drawer-field";
  const span = document.createElement("span");
  span.className = "drawer-label";
  span.textContent = labelText;
  wrap.append(span, control);
  return wrap;
}

function actionBtn(text, onClick, danger = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = danger ? "btn-sm btn-quiet-danger" : "btn-sm";
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

async function handleToggleUser(user) {
  const nextDisabled = !user.disabled;
  if (nextDisabled && !(await askConfirm(`停用账号 ${user.username}？停用后其在线会话立即下线，邮件仍正常保留。`))) {
    return;
  }
  try {
    await request(`/v1/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: { disabled: nextDisabled },
    });
    toast(nextDisabled ? "账号已停用" : "账号已恢复启用");
    await loadUsersSection();
  } catch (err) {
    toast("变更状态失败: " + explain(err));
  }
}

async function handleRevokeSessions(user) {
  try {
    const res = await request(`/v1/users/${encodeURIComponent(user.id)}/sessions/revoke`, {
      method: "POST",
      body: {},
    });
    toast(`已清理 ${res.count || 0} 个活跃会话`);
  } catch (err) {
    toast("踢出会话失败: " + explain(err));
  }
}

async function handleDeleteUser(user) {
  if (!(await askConfirm(`确定删除账号 ${user.username}？其账号配置与个人状态将被移除，底层历史邮件原文不受影响。`))) {
    return;
  }
  try {
    await request(`/v1/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    toast("账号已删除");
    await loadUsersSection();
  } catch (err) {
    toast("删除账号失败: " + explain(err));
  }
}

async function handleRemoveAllocation(user, alloc) {
  if (!(await askConfirm(`从 ${user.username} 移除邮箱规则 ${alloc.pattern}？`))) return;
  try {
    await request(`/v1/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(alloc.id)}`, {
      method: "DELETE",
    });
    toast("已移除邮箱规则");
    await loadUsersSection();
  } catch (err) {
    toast("移除失败: " + explain(err));
  }
}

/** 为普通成员渲染其名下已分配的专属邮箱与每日发信额度概览。 */
export function renderMemberSelfMailboxes() {
  const host = document.querySelector("#member-allocations-host");
  const quotaEl = document.querySelector("#member-quota-line");
  if (!host) return;
  host.replaceChildren();
  const s = state.session;
  if (quotaEl) {
    if (s.dailySendLimit <= 0) {
      quotaEl.textContent = "发信权限：当前账号仅用于收信阅览，未开启外发权限。";
    } else {
      quotaEl.textContent = `24 小时发信额度：已使用 ${s.sentLast24h || 0} / ${s.dailySendLimit} 封`;
    }
  }
  const allocs = Array.isArray(s.allocations) ? s.allocations : [];
  if (allocs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "管理员尚未为此账号分配邮箱规则。";
    host.append(empty);
    return;
  }
  for (const alloc of allocs) {
    const row = document.createElement("div");
    row.className = "member-alloc-card";
    const pat = document.createElement("code");
    pat.className = "alloc-pattern";
    pat.textContent = alloc.pattern;

    const desc = document.createElement("span");
    desc.className = "muted";
    if (alloc.kind === "exact") {
      desc.textContent = `精确邮箱（自动接收 ${alloc.localpart}+任意标签@${alloc.domain}）· ${alloc.canSend ? "可收发" : "仅收信"}`;
    } else if (alloc.kind === "prefix") {
      desc.textContent = `前缀通配（接收一切以 ${alloc.localpart} 开头的地址）· ${alloc.canSend ? "可收发" : "仅收信"}`;
    } else {
      desc.textContent = `整域接管（接收 ${alloc.domain} 下全部地址）· ${alloc.canSend ? "可收发" : "仅收信"}`;
    }

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-sm";
    copyBtn.textContent = "复制";
    const copyVal = alloc.kind === "exact" ? alloc.pattern : `${alloc.localpart === "*" ? "hello" : alloc.localpart}@${alloc.domain}`;
    copyBtn.addEventListener("click", () => void copyText(copyVal));

    row.append(pat, desc, copyBtn);
    host.append(row);
  }
}

export async function loadAuditView() {
  if (!state.session.isAdmin) return;
  const tbody = document.querySelector("#audit-tbody");
  if (!tbody) return;
  try {
    const res = await request("/v1/audit?limit=60");
    state.auditItems = Array.isArray(res.items) ? res.items : [];
    tbody.replaceChildren();
    if (state.auditItems.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "muted";
      td.textContent = "暂无审计记录";
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const item of state.auditItems) {
      const tr = document.createElement("tr");
      const tdTime = document.createElement("td");
      tdTime.className = "mono-cell";
      tdTime.textContent = formatFullTime(item.at);

      const tdActor = document.createElement("td");
      tdActor.textContent = item.actor || "—";

      const tdAction = document.createElement("td");
      tdAction.textContent = AUDIT_ACTION_LABELS[item.action] || item.action;

      const tdTarget = document.createElement("td");
      tdTarget.className = "mono-cell";
      const parts = [];
      if (item.target) parts.push(String(item.target));
      if (item.detail) parts.push(typeof item.detail === "string" ? item.detail : JSON.stringify(item.detail));
      tdTarget.textContent = parts.join(" · ") || "—";

      tr.append(tdTime, tdActor, tdAction, tdTarget);
      tbody.append(tr);
    }
  } catch {
    // 审计日志读取失败时静默保持原样。
  }
}
