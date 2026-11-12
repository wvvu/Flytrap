// 设置页：各分区渲染与即时保存，外加 DKIM 与日志。
import { LABELS, LABEL_NAMES, SETTING_SECTIONS } from "./constants.js";
import { state } from "./state.js";
import { appEl, detailVerdictSelect, filterSelect, listEl } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, copyText, explain, setMobilePane, setViewTitle, toast } from "./ui.js";
import { cssEscape, normalizeAddress } from "./util.js";

export async function loadSettingsPage() {
  try {
    const settings = await request("/v1/settings");
    applyAppearance(settings);
    state.settingsDomains = Array.isArray(settings.acceptDomains) ? settings.acceptDomains.slice() : [];
    renderNameEditors(settings);
    renderNotify(settings);
    renderDomains(settings.acceptDomains || []);
    const attempts = document.querySelector("#job-max-attempts");
    if (attempts) {
      attempts.value = String(settings.jobMaxAttempts ?? 5);
      state.attemptsBaseline = attempts.value;
      syncAttemptSave();
    }
    const aiLine = document.querySelector("#ai-status-line");
    if (aiLine) aiLine.textContent = describeAi(settings.ai);
    const channels = document.querySelector("#notify-channels");
    if (channels) channels.textContent = describeChannels(settings.channels);

    const promptsRes = await request("/v1/prompts");
    state.currentPromptId = promptsRes.defaultPromptId || "classify-v1";
    const detail = await request("/v1/prompts/" + encodeURIComponent(state.currentPromptId));
    const editor = document.querySelector("#prompt-editor");
    if (editor) {
      editor.value = detail.content || "";
      state.promptBaseline = editor.value;
      syncPromptSave();
    }
    await loadMailboxesView();
    await loadMachineLine();
    const enabled = document.querySelector("#ai-enabled");
    if (enabled) enabled.checked = settings.aiEnabled !== false;
    const thinking = document.querySelector("#ai-thinking");
    if (thinking) thinking.value = settings.aiThinking || "low";
    renderAiEditors(settings.aiPool || {});
    renderBlockList(settings.blockedSenders || []);
    await loadDkimSection();
  } catch (err) {
    toast(explain(err));
  }
}

export function renderSettingsNav() {
  if (state.currentView !== "settings") return;
  listEl.replaceChildren();
  for (const [id, label, hint] of SETTING_SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mail-item";
    button.dataset.section = id;
    if (id === state.currentSettingsSection) button.classList.add("selected");
    const title = document.createElement("span");
    title.className = "item-from";
    title.textContent = label;
    const sub = document.createElement("span");
    sub.className = "item-subject";
    sub.textContent = hint;
    button.append(title, sub);
    button.addEventListener("click", () => showSettingsSection(id));
    listEl.append(button);
  }
}

export function showSettingsSection(id, options = {}) {
  state.currentSettingsSection = id;
  for (const block of document.querySelectorAll("#view-settings .block")) {
    block.hidden = block.dataset.group !== id;
  }
  for (const button of listEl.querySelectorAll(".mail-item")) {
    button.classList.toggle("selected", button.dataset.section === id);
  }
  if (!options.keepListOnNarrow) setMobilePane("detail");
  if (id === "status") {
    void loadLogs();
    void loadMachineLine();
  }
  if (id === "domains") void loadDkimSection();
  if (id === "people") void loadMailboxesView();
}

export function describeAi(ai) {
  if (!ai || ai.classifier === "fake" || !ai.model) return "尚未配置模型。提示词会在模型可用后用于新邮件。";
  const keys = Number(ai.keyCount) === 1 ? "1 个密钥可用" : `${ai.keyCount || 0} 个密钥可用`;
  return `${ai.model} · ${keys}`;
}

export function describeChannels(channels) {
  const telegram = channels && channels.telegram ? "Telegram 已配置" : "Telegram 未配置";
  const webhook = channels && channels.webhook ? "Webhook 已配置" : "Webhook 未配置";
  return `${telegram} · ${webhook}`;
}

export function renderNotify(settings) {
  const host = document.querySelector("#notify-labels");
  if (!host) return;
  host.replaceChildren();
  const selected = new Set(settings.notifyLabels || []);
  for (const label of LABELS) {
    const wrap = document.createElement("label");
    wrap.className = "chk";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = label;
    input.checked = selected.has(label);
    input.addEventListener("change", syncNotifySave);
    const text = document.createElement("span");
    text.textContent = labelName(label);
    wrap.append(input, text);
    host.append(wrap);
  }
  const confidence = document.querySelector("#notify-confidence");
  if (confidence) confidence.value = String(settings.notifyMinConfidence ?? 0.6);
  state.notifyBaseline = notifySnapshot();
  syncNotifySave();
}

export function notifySnapshot() {
  const labels = [];
  document.querySelectorAll("#notify-labels input").forEach((input) => {
    if (input.checked) labels.push(input.value);
  });
  const confidence = document.querySelector("#notify-confidence");
  return JSON.stringify({ labels, confidence: confidence ? confidence.value.trim() : "" });
}

export function syncNotifySave() {
  const button = document.querySelector("#btn-save-notify");
  if (button) button.disabled = notifySnapshot() === state.notifyBaseline;
}

export function syncPromptSave() {
  const editor = document.querySelector("#prompt-editor");
  const button = document.querySelector("#btn-save-prompt");
  if (button) button.disabled = !editor || editor.value === state.promptBaseline;
}

export function syncAttemptSave() {
  const input = document.querySelector("#job-max-attempts");
  const button = document.querySelector("#btn-save-attempts");
  if (button) button.disabled = !input || input.value.trim() === state.attemptsBaseline;
}

export function renderDomains(domains) {
  state.settingsDomains = Array.isArray(domains) ? domains.slice() : [];
  renderDomainCards();
}

export async function saveNotifySettings() {
  const confidence = Number(document.querySelector("#notify-confidence")?.value);
  const labels = [];
  document.querySelectorAll("#notify-labels input").forEach((input) => {
    if (input.checked) labels.push(input.value);
  });
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    toast("置信度要在 0 到 1 之间");
    return;
  }
  try {
    await request("/v1/settings/notify", { method: "PUT", body: { labels, minConfidence: confidence } });
    state.notifyBaseline = notifySnapshot();
    syncNotifySave();
    toast("提醒已保存");
  } catch (err) {
    toast("保存提醒失败: " + explain(err));
  }
}

export function renderBlockList(addresses) {
  state.blockedSenders = Array.isArray(addresses) ? addresses.slice() : [];
  const host = document.querySelector("#block-list");
  const empty = document.querySelector("#block-empty");
  if (empty) empty.hidden = state.blockedSenders.length > 0;
  if (!host) return;
  host.replaceChildren();
  for (const address of state.blockedSenders) {
    const row = document.createElement("div");
    row.className = "domain-row";
    const input = document.createElement("input");
    input.value = address;
    input.readOnly = true;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-fit ghost";
    button.textContent = "移除";
    button.addEventListener("click", () => void removeBlocked(address));
    row.append(input, button);
    host.append(row);
  }
}

export async function addBlocked() {
  const input = document.querySelector("#block-add");
  const address = input ? input.value.trim() : "";
  if (!address) return;
  try {
    const res = await request("/v1/settings/blocklist", {
      method: "PUT",
      body: { addresses: state.blockedSenders.concat([address]) },
    });
    if (input) input.value = "";
    renderBlockList(res.blockedSenders || []);
    toast("已加入黑名单");
  } catch {
    toast("发件地址无效");
  }
}

export async function removeBlocked(address) {
  try {
    const res = await request("/v1/settings/blocklist", {
      method: "PUT",
      body: { addresses: state.blockedSenders.filter((item) => item !== address) },
    });
    renderBlockList(res.blockedSenders || []);
    toast("已移出黑名单");
  } catch (err) {
    toast("移出黑名单失败: " + explain(err));
  }
}

export async function addDomain() {
  const input = document.querySelector("#domain-add");
  const domain = input ? input.value.trim() : "";
  if (!domain) return;
  const ok = await addDomainName(domain);
  if (ok && input) input.value = "";
}

export async function addDomainName(domain) {
  try {
    const res = await request("/v1/settings/domains", {
      method: "PUT",
      body: { domains: state.settingsDomains.concat([domain]) },
    });
    renderDomains(res.acceptDomains || []);
    toast("域名已添加");
    return true;
  } catch (err) {
    toast("添加域名失败: " + explain(err));
    return false;
  }
}

export async function removeDomain(domain) {
  if (state.settingsDomains.length <= 1) {
    toast("至少保留一个域名");
    return;
  }
  if (!(await askConfirm(`停止接收 ${domain}？`))) return;
  try {
    const res = await request("/v1/settings/domains", {
      method: "PUT",
      body: { domains: state.settingsDomains.filter((item) => item !== domain) },
    });
    const hadShortName = Boolean((state.domainShortNames[domain] || "").trim());
    delete state.domainShortNames[domain];
    renderDomains(res.acceptDomains || []);
    if (hadShortName) enqueueNames("已移除 " + domain);
    else toast("已移除 " + domain);
  } catch (err) {
    toast("移除域名失败: " + explain(err));
  }
}

export async function saveAttemptSettings() {
  const raw = document.querySelector("#job-max-attempts")?.value.trim() || "";
  const maxAttempts = Number(raw);
  if (!/^\d+$/.test(raw) || maxAttempts < 1 || maxAttempts > 20) {
    toast("次数要是 1 到 20 的整数");
    return;
  }
  try {
    await request("/v1/settings/jobs", { method: "PUT", body: { maxAttempts } });
    state.attemptsBaseline = String(maxAttempts);
    syncAttemptSave();
    toast("之后的新任务会在达到该次数后停止");
  } catch (err) {
    toast("保存失败: " + explain(err));
  }
}

export async function loadMailboxesView() {
  try {
    const res = await request("/v1/mailbox-history");
    const items = res.items || [];
    const tbody = document.querySelector("#mailboxes-tbody");
    if (!tbody) return;
    tbody.replaceChildren();
    rememberMailboxes(items);
    for (const item of items) {
      const tr = document.createElement("tr");
      const tdAddr = document.createElement("td");
      tdAddr.textContent = `${item.localpart}@${item.domain}`;
      const tdName = document.createElement("td");
      tdName.textContent = item.displayName || "—";
      const tdNotes = document.createElement("td");
      tdNotes.textContent = item.notes || "无备注";
      const tdEdit = document.createElement("td");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn-fit ghost";
      edit.textContent = "改";
      edit.addEventListener("click", () => fillMailboxForm(item));
      tdEdit.append(edit);
      tr.append(tdAddr, tdName, tdNotes, tdEdit);
      tbody.append(tr);
    }
  } catch (err) {
    toast("地址列表读取失败: " + explain(err));
  }
}

export async function loadMachineLine() {
  try {
    const health = await request("/healthz");
    const stats = await request("/v1/stats");
    const line = document.querySelector("#machine-line");
    const dbText = health.db === "ok" ? "SQLite 正常" : "数据库异常";
    if (line) line.textContent = `在线 · ${dbText}`;
    renderOverview(stats);
    renderTrend(Array.isArray(stats.daily) ? stats.daily : []);
  } catch (err) {
    const line = document.querySelector("#machine-line");
    if (line) line.textContent = explain(err);
  }
}

export function renderOverview(stats) {
  const host = document.querySelector("#stat-cards");
  if (!host) return;
  host.replaceChildren();
  const today = stats && stats.today ? stats.today : {};
  const total = stats && stats.total ? stats.total : {};
  host.append(statCard("今天", String(countMapSum(today)), ""));
  host.append(statCard("累计", String(countMapSum(total)), ""));
  const keys = ["legit", "spam", "phish", "malware", "unsolicited-admin", "gray", "unlabeled"];
  for (const key of keys) {
    const n = Number(today[key]) || 0;
    if (n < 1) continue;
    const name = key === "unlabeled" ? "未分类" : labelName(key);
    const tone = key === "unlabeled" ? "" : key === "unsolicited-admin" ? "promo" : key;
    host.append(statCard(name, String(n), tone ? "stat-" + tone : ""));
  }
}

export function countMapSum(map) {
  return Object.values(map).reduce((acc, n) => acc + (typeof n === "number" ? n : 0), 0);
}

export function statCard(label, value, extra) {
  const card = document.createElement("div");
  card.className = extra ? "stat-card " + extra : "stat-card";
  const num = document.createElement("div");
  num.className = "stat-num";
  num.textContent = value;
  const desc = document.createElement("div");
  desc.className = "stat-desc";
  desc.textContent = label;
  card.append(num, desc);
  return card;
}

export function renderTrend(days) {
  const host = document.querySelector("#stat-trend");
  if (!host) return;
  host.replaceChildren();
  const max = Math.max(1, ...days.map((day) => day.total || 0));
  for (const day of days) {
    const col = document.createElement("div");
    col.className = "trend-col";
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    const total = day.total || 0;
    bar.style.height = Math.max(2, Math.round((total / max) * 100)) + "%";
    const labelNameOf = (key) => labelName(key);
    const parts = Object.entries(day.labels || {})
      .filter(([, n]) => n > 0)
      .map(([key, n]) => `${labelNameOf(key)} ${n}`);
    bar.title = `${day.day} 共 ${total} 封` + (parts.length ? " · " + parts.join("，") : "");
    const caption = document.createElement("span");
    caption.className = "trend-label";
    caption.textContent = String(day.day || "").slice(5);
    col.append(bar, caption);
    host.append(col);
  }
}

export async function saveCurrentPrompt() {
  const editor = document.querySelector("#prompt-editor");
  try {
    await request("/v1/prompts/" + encodeURIComponent(state.currentPromptId), {
      method: "PUT",
      body: { content: editor ? editor.value : "" },
    });
    state.promptBaseline = editor ? editor.value : "";
    syncPromptSave();
    toast("提示词已保存，之后的新邮件会使用这份");
  } catch (err) {
    toast("保存提示词失败: " + explain(err));
  }
}

export function fillMailboxForm(item) {
  const domain = document.querySelector("#mb-domain");
  const localpart = document.querySelector("#mb-localpart");
  const name = document.querySelector("#mb-name");
  const notes = document.querySelector("#mb-notes");
  if (domain) domain.value = item.domain || "";
  if (localpart) localpart.value = item.localpart || "";
  if (name) name.value = item.displayName || "";
  if (notes) notes.value = item.notes || "";
  domain?.focus();
}

export async function saveMailbox() {
  try {
    await request("/v1/mailbox-history", {
      method: "POST",
      body: {
        domain: document.querySelector("#mb-domain").value,
        localpart: document.querySelector("#mb-localpart").value,
        notes: document.querySelector("#mb-notes").value,
        displayName: document.querySelector("#mb-name")?.value || "",
      },
    });
    toast("地址已保存");
    const form = document.querySelector("#mailbox-form");
    if (form) form.reset();
    await loadMailboxesView();
  } catch (err) {
    toast("保存地址失败: " + explain(err));
  }
}

export async function loadAppearance() {
  try {
    const settings = await request("/v1/settings");
    applyAppearance(settings);
    const history = await request("/v1/mailbox-history");
    rememberMailboxes(history.items || []);
  } catch {
    // Built-in names still work if this read fails.
  }
}

export function applyAppearance(settings) {
  state.panelTitle = (settings && settings.panelTitle) || "邮箱";
  state.labelNames = { ...LABEL_NAMES, ...(settings && settings.labelNames ? settings.labelNames : {}) };
  state.domainNames = (settings && settings.domainNames) || {};
  state.senderMap = new Map(
    ((settings && settings.senderNames) || [])
      .filter((item) => item && item.address)
      .map((item) => [String(item.address).toLowerCase(), item.name]),
  );
  const mark = document.querySelector("#rail-mark");
  if (mark) mark.title = state.panelTitle;
  for (const select of [filterSelect, detailVerdictSelect]) {
    if (!select) continue;
    for (const option of select.options) {
      if (!option.value || !LABEL_NAMES[option.value]) continue;
      option.textContent = labelName(option.value);
    }
  }
  if (state.currentView && !appEl.hidden) setViewTitle(state.currentView);
}

export function rememberMailboxes(items) {
  state.mailboxNames = new Map();
  for (const item of items) {
    if (!item || !item.displayName) continue;
    state.mailboxNames.set(`${item.localpart}@${item.domain}`.toLowerCase(), item.displayName);
  }
}

export function labelName(id) {
  if (!id) return "未分类";
  return state.labelNames[id] || LABEL_NAMES[id] || id;
}

export function renderNameEditors(settings) {
  const title = document.querySelector("#panel-title");
  if (title) title.value = settings.panelTitle || "邮箱";
  const labels = document.querySelector("#label-names");
  if (labels) {
    labels.replaceChildren();
    for (const id of LABELS) {
      labels.append(nameRow(id, labelName(id), "label"));
    }
  }
  state.domainShortNames = { ...(settings.domainNames || {}) };
  state.savedSenders = Array.isArray(settings.senderNames)
    ? settings.senderNames.map((item) => ({ address: item.address, name: item.name }))
    : [];
  renderDomainCards();
  renderSenderRows(state.savedSenders);
  state.namesBaseline = JSON.stringify(collectNames());
  syncNamesSave();
}

export function refreshNotifyLabels() {
  const notifyHost = document.querySelector("#notify-labels");
  if (!notifyHost) return;
  notifyHost.querySelectorAll("label.chk").forEach((wrap) => {
    const input = wrap.querySelector("input");
    const text = wrap.querySelector("span");
    if (input && text) text.textContent = labelName(input.value);
  });
}

export function renderSenderRows(senders) {
  const host = document.querySelector("#sender-names");
  if (!host) return;
  host.replaceChildren();
  for (const item of senders) host.append(senderRow(item.address, item.name));
}

export function nameRow(key, value, kind) {
  const row = document.createElement("label");
  row.className = "name-row";
  const caption = document.createElement("span");
  caption.className = "name-key";
  caption.textContent = key;
  caption.title = key;
  const input = document.createElement("input");
  input.value = value || "";
  input.maxLength = kind === "label" ? 16 : 24;
  input.autocomplete = "off";
  input.dataset.nameKey = key;
  input.dataset.nameKind = kind;
  input.placeholder = kind === "label" ? LABEL_NAMES[key] || "" : "短名，可空";
  input.addEventListener("input", syncNamesSave);
  row.append(caption, input);
  return row;
}

export function senderRow(address, name) {
  const row = document.createElement("div");
  row.className = "name-row with-action";
  const addressInput = document.createElement("input");
  addressInput.value = address;
  addressInput.readOnly = true;
  addressInput.dataset.senderAddress = address;
  const nameInput = document.createElement("input");
  nameInput.value = name || "";
  nameInput.maxLength = 40;
  nameInput.dataset.senderName = "1";
  nameInput.placeholder = "名称";
  nameInput.dataset.savedName = name || "";
  nameInput.addEventListener("change", () => {
    if (!nameInput.value.trim()) {
      nameInput.value = nameInput.dataset.savedName || "";
      toast("请填写名称");
      return;
    }
    enqueueNames("发件人已保存");
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-fit ghost";
  remove.textContent = "移除";
  remove.addEventListener("click", () => {
    row.remove();
    enqueueNames("发件人已移除");
  });
  row.append(addressInput, nameInput, remove);
  return row;
}

export function addSenderRow() {
  const addressInput = document.querySelector("#sender-address");
  const nameInput = document.querySelector("#sender-name");
  const address = normalizeAddress(addressInput ? addressInput.value : "");
  const name = nameInput ? nameInput.value.trim() : "";
  if (!address) {
    toast("发件地址无效");
    return;
  }
  if (!name) {
    toast("请填写名称");
    return;
  }
  const existing = document.querySelector(`#sender-names input[data-sender-address="${cssEscape(address)}"]`);
  if (existing) {
    const row = existing.closest(".name-row");
    const field = row ? row.querySelector("input[data-sender-name]") : null;
    if (field) field.value = name;
  } else {
    document.querySelector("#sender-names")?.append(senderRow(address, name));
  }
  if (addressInput) addressInput.value = "";
  if (nameInput) nameInput.value = "";
  enqueueNames("发件人已保存");
}

export function collectNames(options = {}) {
  const labelNamesOut = {};
  document.querySelectorAll('#label-names input[data-name-kind="label"]').forEach((input) => {
    labelNamesOut[input.dataset.nameKey] = input.value.trim();
  });
  const typedTitle = document.querySelector("#panel-title")?.value.trim() || "";
  return {
    panelTitle: typedTitle || (options.fallbackTitle ? (state.panelTitle || "邮箱") : ""),
    labelNames: labelNamesOut,
    domainNames: collectDomainNames(),
    senderNames: collectSenderList(),
  };
}

export function collectSenderList() {
  const senderNames = [];
  document.querySelectorAll("#sender-names .name-row").forEach((row) => {
    const address = row.querySelector("input[data-sender-address]")?.value.trim() || "";
    const name = row.querySelector("input[data-sender-name]")?.value.trim() || "";
    if (address && name) senderNames.push({ address, name });
  });
  return senderNames;
}

export function collectDomainNames() {
  const domainNamesOut = {};
  const inputs = document.querySelectorAll('#domain-cards input[data-name-kind="domain"]');
  if (inputs.length === 0) return { ...state.domainShortNames };
  inputs.forEach((input) => {
    const value = input.value.trim();
    if (value) domainNamesOut[input.dataset.nameKey] = value;
  });
  return domainNamesOut;
}

export function enqueueNames(message) {
  state.namesJob = state.namesJob.then(() => commitNamesNow(message)).catch(() => {});
}

export async function commitNamesNow(message) {
  const backupSenders = state.savedSenders.map((item) => ({ address: item.address, name: item.name }));
  const backupShort = { ...state.domainShortNames };
  try {
    const saved = await request("/v1/settings/names", {
      method: "PUT",
      body: collectNames({ fallbackTitle: true }),
    });
    applyNamesSaved(saved);
    toast(message);
  } catch (err) {
    state.savedSenders = backupSenders;
    state.domainShortNames = backupShort;
    renderSenderRows(state.savedSenders);
    renderDomainCards({ discardPending: true });
    toast("保存失败: " + explain(err));
  }
}

export function applyNamesSaved(saved) {
  applyAppearance(saved);
  state.domainShortNames = { ...(saved.domainNames || {}) };
  state.savedSenders = Array.isArray(saved.senderNames)
    ? saved.senderNames.map((item) => ({ address: item.address, name: item.name }))
    : [];
  syncShortNameFields();
  if (JSON.stringify(collectSenderList()) !== JSON.stringify(state.savedSenders)) renderSenderRows(state.savedSenders);
  state.namesBaseline = JSON.stringify(collectNames());
  syncNamesSave();
  refreshNotifyLabels();
}

export function syncShortNameFields() {
  document.querySelectorAll('#domain-cards input[data-name-kind="domain"]').forEach((input) => {
    const saved = state.domainShortNames[input.dataset.nameKey] || "";
    input.dataset.savedValue = saved;
    if (document.activeElement !== input) input.value = saved;
  });
}

export function syncNamesSave() {
  const button = document.querySelector("#btn-save-names");
  if (!button) return;
  const draft = collectNames();
  button.disabled = !draft.panelTitle || JSON.stringify(draft) === state.namesBaseline;
}

export async function saveNameSettings() {
  if (!collectNames().panelTitle) {
    toast("面板名称不能为空");
    return;
  }
  state.namesJob = state.namesJob.then(async () => {
    if (!collectNames().panelTitle) {
      toast("面板名称不能为空");
      return;
    }
    try {
      const saved = await request("/v1/settings/names", { method: "PUT", body: collectNames() });
      applyNamesSaved(saved);
      renderNameEditors({
        panelTitle: saved.panelTitle,
        labelNames: saved.labelNames,
        domainNames: saved.domainNames,
        senderNames: saved.senderNames,
        acceptDomains: state.settingsDomains,
      });
      toast("名称已保存");
    } catch (err) {
      toast("保存名称失败: " + explain(err));
    }
  }).catch(() => {});
}

export function renderAiEditors(pool) {
  state.aiModels = Array.isArray(pool.models) ? pool.models.slice() : [];
  state.aiKeyRows = (Array.isArray(pool.keys) ? pool.keys : []).map((item) => ({
    id: item.id,
    tail: item.tail || "",
  }));
  paintAiEditors();
  rememberAiControls();
}

export function rememberAiControls() {
  const thinking = document.querySelector("#ai-thinking");
  if (thinking) thinking.dataset.prev = thinking.value;
}

export function captureAi() {
  const enabled = document.querySelector("#ai-enabled");
  const thinking = document.querySelector("#ai-thinking");
  return {
    models: state.aiModels.slice(),
    keys: state.aiKeyRows.map((row) => ({ id: row.id, tail: row.tail, secret: row.secret })),
    enabled: enabled ? enabled.checked : true,
    thinking: thinking ? thinking.value : "low",
  };
}

export function restoreAi(snapshot) {
  state.aiModels = snapshot.models.slice();
  state.aiKeyRows = snapshot.keys.map((row) => ({ id: row.id, tail: row.tail, secret: row.secret }));
  const enabled = document.querySelector("#ai-enabled");
  const thinking = document.querySelector("#ai-thinking");
  if (enabled) enabled.checked = snapshot.enabled;
  if (thinking) thinking.value = snapshot.thinking;
  paintAiEditors();
  rememberAiControls();
}

export function aiPayload() {
  const enabled = document.querySelector("#ai-enabled");
  const thinking = document.querySelector("#ai-thinking");
  return {
    models: state.aiModels.slice(),
    keys: state.aiKeyRows.map((row) => (row.secret ? { secret: row.secret } : { id: row.id })),
    enabled: enabled ? enabled.checked : true,
    thinking: thinking ? thinking.value : "low",
  };
}

export function enqueueAi(apply, message) {
  state.aiJob = state.aiJob.then(() => applyAndSaveAi(apply, message)).catch(() => {});
}

export function aiStateKey(snapshot) {
  return JSON.stringify({
    models: snapshot.models,
    keys: snapshot.keys.map((row) => ({ id: row.id || "", tail: row.tail || "", secret: row.secret || "" })),
    enabled: snapshot.enabled,
    thinking: snapshot.thinking,
  });
}

export async function applyAndSaveAi(apply, message) {
  const backup = captureAi();
  try {
    apply();
    if (aiStateKey(captureAi()) === aiStateKey(backup)) return;
    paintAiEditors();
    const saved = await request("/v1/settings/ai", { method: "PUT", body: aiPayload() });
    const enabled = document.querySelector("#ai-enabled");
    const thinking = document.querySelector("#ai-thinking");
    if (enabled) enabled.checked = saved.aiEnabled !== false;
    if (thinking && saved.aiThinking) thinking.value = saved.aiThinking;
    renderAiEditors(saved.aiPool || {});
    toast(message);
  } catch (err) {
    restoreAi(backup);
    toast("保存模型失败: " + explain(err));
    return;
  }
  try {
    const status = await request("/v1/ai/status");
    const aiLine = document.querySelector("#ai-status-line");
    const enabledNow = document.querySelector("#ai-enabled");
    if (aiLine) aiLine.textContent = enabledNow && !enabledNow.checked ? "分拣已关" : describeAi(status);
  } catch {
    // The pool is already stored. The status line refreshes the next time settings open.
  }
}

export function paintAiEditors() {
  const models = document.querySelector("#model-list");
  const keys = document.querySelector("#key-list");
  if (models) {
    models.replaceChildren();
    state.aiModels.forEach((model, index) => models.append(orderRow(model, index, state.aiModels.length, "model")));
  }
  if (keys) {
    keys.replaceChildren();
    if (state.aiKeyRows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "没有密钥。";
      keys.append(empty);
    }
    state.aiKeyRows.forEach((row, index) => keys.append(orderRow(maskKey(row.tail), index, state.aiKeyRows.length, "key")));
  }
}

export function maskKey(tail) {
  return tail ? `····${tail}` : "已保存";
}

export function orderRow(label, index, total, kind) {
  const row = document.createElement("div");
  row.className = "name-row order-row";
  const text = document.createElement("input");
  text.value = label;
  text.readOnly = true;
  const actions = document.createElement("div");
  actions.className = "step-actions";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "btn-fit ghost";
  up.textContent = "上移";
  up.disabled = index === 0;
  up.addEventListener("click", () => moveAiRow(kind, index, -1));
  const down = document.createElement("button");
  down.type = "button";
  down.className = "btn-fit ghost";
  down.textContent = "下移";
  down.disabled = index === total - 1;
  down.addEventListener("click", () => moveAiRow(kind, index, 1));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-fit ghost";
  remove.textContent = "移除";
  remove.addEventListener("click", () => removeAiRow(kind, index));
  actions.append(up, down, remove);
  row.append(text, actions);
  return row;
}

export function moveAiRow(kind, index, delta) {
  const list = kind === "model" ? state.aiModels : state.aiKeyRows;
  const next = index + delta;
  if (next < 0 || next >= list.length) return;
  enqueueAi(() => {
    const current = kind === "model" ? state.aiModels : state.aiKeyRows;
    if (index < 0 || next >= current.length) return;
    const [item] = current.splice(index, 1);
    current.splice(next, 0, item);
  }, "顺序已保存");
}

export function removeAiRow(kind, index) {
  const list = kind === "model" ? state.aiModels : state.aiKeyRows;
  if (index < 0 || index >= list.length) return;
  enqueueAi(() => {
    const current = kind === "model" ? state.aiModels : state.aiKeyRows;
    if (index < 0 || index >= current.length) return;
    current.splice(index, 1);
  }, kind === "model" ? "模型已移除" : "密钥已移除");
}

export function addModelRow() {
  const input = document.querySelector("#model-add");
  const model = input ? input.value.trim() : "";
  if (!model) {
    toast("请输入模型名称");
    return;
  }
  if (!/^[A-Za-z0-9._:@/-]{1,80}$/.test(model)) {
    toast("模型名称无效");
    return;
  }
  if (state.aiModels.includes(model)) {
    if (input) input.value = "";
    toast("这个模型已经在列表里");
    return;
  }
  if (input) input.value = "";
  enqueueAi(() => {
    if (!state.aiModels.includes(model)) state.aiModels.push(model);
  }, "模型已添加");
}

export function addKeyRow() {
  const input = document.querySelector("#key-add");
  const secret = input ? input.value.trim() : "";
  if (!secret) {
    toast("请输入密钥");
    return;
  }
  if (secret.length < 8 || secret.length > 512 || /\s/.test(secret)) {
    toast("密钥无效");
    return;
  }
  const tail = secret.length >= 12 ? secret.slice(-4) : "";
  if (input) input.value = "";
  enqueueAi(() => {
    state.aiKeyRows.push({ secret, tail });
  }, "密钥已添加");
}

export async function loadDkimSection() {
  try {
    const keys = await request("/v1/dkim");
    state.dkimKeys = Array.isArray(keys.items) ? keys.items : [];
    renderDkim(state.dkimKeys);
  } catch (err) {
    toast("读取发信设置失败: " + explain(err));
  }
}

export function renderDkim(keys) {
  if (Array.isArray(keys)) state.dkimKeys = keys;
  renderDomainCards();
}

export function renderDomainCards(options = {}) {
  const host = document.querySelector("#domain-cards");
  if (!host) return;
  const pending = new Map();
  if (!options.discardPending) {
    host.querySelectorAll('input[data-name-kind="domain"]').forEach((input) => {
      pending.set(input.dataset.nameKey, input.value);
    });
  }
  host.replaceChildren();
  const domains = new Set(state.settingsDomains);
  for (const key of state.dkimKeys) domains.add(key.domain);
  const ordered = [...domains].sort();
  if (ordered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "还没有域名。";
    host.append(empty);
    return;
  }
  for (const domain of ordered) {
    const typed = pending.has(domain) ? pending.get(domain) : (state.domainShortNames[domain] || "");
    const matches = state.dkimKeys.filter((key) => key.domain === domain);
    host.append(domainCard(domain, typed, matches));
  }
}

export function domainCard(domain, shortName, keys) {
  const card = document.createElement("div");
  card.className = "domain-card";
  const head = document.createElement("div");
  head.className = "domain-card-head";
  const title = document.createElement("strong");
  title.textContent = domain;
  head.append(title);
  const accepting = state.settingsDomains.includes(domain);
  if (accepting) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-fit ghost";
    remove.textContent = "停止收信";
    remove.addEventListener("click", () => void removeDomain(domain));
    head.append(remove);
  } else {
    const join = document.createElement("button");
    join.type = "button";
    join.className = "btn-fit ghost";
    join.textContent = "开始收信";
    join.addEventListener("click", () => void addDomainName(domain));
    head.append(join);
  }
  card.append(head);
  if (accepting) {
    const row = document.createElement("label");
    row.className = "name-row";
    const caption = document.createElement("span");
    caption.className = "name-key";
    caption.textContent = "短名";
    const input = document.createElement("input");
    input.value = shortName || "";
    input.maxLength = 24;
    input.autocomplete = "off";
    input.placeholder = "短名，可空";
    input.dataset.nameKey = domain;
    input.dataset.nameKind = "domain";
    input.dataset.savedValue = state.domainShortNames[domain] || "";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
    input.addEventListener("change", () => {
      if (input.value.trim() === (input.dataset.savedValue || "")) return;
      enqueueNames("短名已保存");
    });
    row.append(caption, input);
    card.append(row);
  }
  fillDkim(card, domain, keys);
  return card;
}

export function fillDkim(card, domain, keys) {
  if (keys.length === 0) {
    const missing = document.createElement("p");
    missing.className = "muted";
    missing.textContent = "还没有密钥。生成后把 TXT 加到 DNS。换密钥后要改同一条记录。";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-fit";
    button.textContent = "生成密钥";
    button.addEventListener("click", () => void generateDkim(domain));
    card.append(missing, button);
    return;
  }
  for (const key of keys) {
    const line = document.createElement("p");
    line.className = "muted";
    line.textContent = `主机记录: ${key.dnsName || key.selector} · ${dkimAlgLabel(key.algorithm)}`;
    const txt = document.createElement("div");
    txt.className = "dkim-txt";
    txt.textContent = key.txt;
    const actions = document.createElement("div");
    actions.className = "inline-row";
    actions.append(
      dkimButton("复制主机记录", () => void copyText(key.dnsName || key.selector)),
      dkimButton("复制 TXT", () => void copyText(key.txt)),
      dkimButton("重新生成", () => void generateDkim(domain, key.selector)),
      dkimButton("移除", () => void removeDkim(domain, key.selector)),
    );
    card.append(line, txt, actions);
  }
}

export function dkimButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-fit ghost";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

export function selectedDkimAlg() {
  const select = document.querySelector("#dkim-alg");
  return select && select.value === "ed25519" ? "ed25519" : "rsa";
}

export function dkimAlgLabel(alg) {
  return alg === "ed25519" ? "Ed25519" : "RSA 2048";
}

export async function generateDkim(domain, selector) {
  const name = (selector || "mail").trim().toLowerCase();
  const algorithm = selectedDkimAlg();
  const exists = state.dkimKeys.some((key) => key.domain === domain && key.selector === name);
  if (exists && !(await askConfirm("重新生成后，原来的 DNS 记录要换成新的。"))) return;
  try {
    const body = selector ? { domain, selector: name, algorithm } : { domain, algorithm };
    await request("/v1/dkim", { method: "POST", body });
    const extra = document.querySelector("#dkim-domain");
    if (extra && extra.value.trim().toLowerCase() === domain) extra.value = "";
    toast("密钥已生成");
    await loadDkimSection();
  } catch (err) {
    toast("生成密钥失败: " + explain(err));
  }
}

export async function removeDkim(domain, selector) {
  if (!(await askConfirm("移除这把密钥？之后发出的信不再签名。"))) return;
  try {
    await request("/v1/dkim/remove", { method: "POST", body: { domain, selector } });
    toast("密钥已移除");
    await loadDkimSection();
  } catch (err) {
    toast("移除密钥失败: " + explain(err));
  }
}

export async function loadLogs() {
  const view = document.querySelector("#log-view");
  if (!view) return;
  try {
    const res = await request("/v1/logs");
    const lines = Array.isArray(res.lines) ? res.lines : [];
    view.textContent = lines.length ? lines.join("\n") : "还没有记录";
  } catch (err) {
    view.textContent = explain(err);
  }
}
