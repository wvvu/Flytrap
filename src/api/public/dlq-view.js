// 处理失败（DLQ）：失败任务列表、详情、重试 / 忽略 / 全部重试。
import { STEP_NAMES, STEP_ORDER } from "./constants.js";
import { state } from "./state.js";
import { badgeDlq, dlqEmptyEl, dlqNoticeEl, failureDetailEl, listEl, retryAllBtn } from "./dom.js";
import { request } from "./net.js";
import { askConfirm, copyText, explain, setMobilePane, toast } from "./ui.js";
import { formatFrom, formatFullTime, formatRecipients, formatShortTime } from "./util.js";
import { switchNav } from "./nav.js";
import { selectMail } from "./mail-view.js";

export async function loadDlqJobs(scope = state.currentDlqScope) {
  state.currentDlqScope = scope || "open";
  listEl.replaceChildren();
  if (dlqNoticeEl) dlqNoticeEl.textContent = "正在读取";
  try {
    const [res, summary] = await Promise.all([request(jobsUrl(state.currentDlqScope)), request("/v1/jobs/summary")]);
    state.currentJobs = Array.isArray(res.items) ? res.items : [];
    paintDlqCounts(summary);
    renderFailureGroups(state.currentJobs);
  } catch (err) {
    if (dlqNoticeEl) dlqNoticeEl.textContent = explain(err);
  }
}

export function jobsUrl(scope) {
  if (scope === "stopped") return "/v1/jobs?scope=stopped";
  if (scope === "dismissed") return "/v1/jobs?status=dismissed";
  if (scope === "retrying") return "/v1/jobs?scope=retrying";
  return "/v1/jobs?scope=open";
}

export function paintDlqCounts(summary) {
  state.failureCounts = {
    open: summary.open || 0,
    dead: summary.dead || 0,
    failed: summary.failed || 0,
    retrying: summary.retrying || 0,
    dismissed: summary.dismissed || 0,
    running: summary.running || 0,
  };
  const stopped = state.failureCounts.dead + state.failureCounts.failed;
  setPillLabel("open", "要处理", state.failureCounts.open);
  setPillLabel("stopped", "已放弃", stopped);
  setPillLabel("retrying", "还会再试", state.failureCounts.retrying);
  setPillLabel("dismissed", "已放过", state.failureCounts.dismissed);
  const summaryEl = document.querySelector("#dlq-summary");
  if (summaryEl) {
    const waiting = state.failureCounts.retrying ? `还有 ${state.failureCounts.retrying} 步会自己再试。` : "";
    summaryEl.textContent = stopped
      ? `停住 ${stopped} 步。再试会重新排队，放过则先不动这步。${waiting}`
      : `没有停住的步骤。${waiting}`;
  }
  if (retryAllBtn) retryAllBtn.disabled = stopped === 0;
}

export function setPillLabel(status, label, count) {
  const button = document.querySelector(`#dlq-pills button[data-dlq-status="${status}"]`);
  if (!button) return;
  const active = button.classList.contains("active");
  button.textContent = count > 0 ? `${label} ${count}` : label;
  if (active) button.classList.add("active");
}

export function renderFailureGroups(jobs) {
  listEl.replaceChildren();
  const needle = state.dlqQuery;
  const groups = new Map();
  for (const job of jobs) {
    if (needle && !jobMatches(job, needle)) continue;
    const key = job.messageId || job.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  if (dlqNoticeEl) {
    if (jobs.length === 0) dlqNoticeEl.textContent = emptyDlqCopy(state.currentDlqScope);
    else if (groups.size === 0) dlqNoticeEl.textContent = "没有符合搜索的记录";
    else dlqNoticeEl.textContent = "";
  }
  let matched = null;
  for (const [key, group] of groups) {
    group.sort((a, b) => stepRank(a.type) - stepRank(b.type));
    if (key === state.selectedFailureKey) matched = group;
    listEl.append(createFailureListItem(key, group));
  }
  if (matched) renderFailureDetail(matched);
  else if (groups.size > 0 && window.matchMedia("(min-width: 901px)").matches) {
    const first = groups.entries().next().value;
    if (first) selectFailure(first[0], first[1], { keepListOnNarrow: true });
  } else {
    clearFailureDetail();
  }
}

export function createFailureListItem(key, jobs) {
  const first = jobs[0] || {};
  const card = document.createElement("button");
  card.type = "button";
  card.className = "mail-item";
  card.dataset.failureKey = key;
  if (key === state.selectedFailureKey) card.classList.add("selected");
  const line1 = document.createElement("div");
  line1.className = "item-line1";
  const subject = document.createElement("span");
  subject.className = "item-from";
  subject.textContent = first.messageSubject || "（无主题）";
  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(first.updatedAt);
  line1.append(subject, time);
  const who = document.createElement("p");
  who.className = "item-subject";
  const from = first.messageFrom ? formatFrom(first.messageFrom) : "";
  who.textContent = from || first.messageTo || "地址尚未解析";
  const steps = document.createElement("p");
  steps.className = "item-snippet";
  steps.textContent = jobs.map((job) => STEP_NAMES[job.type] || job.type).join(" · ");
  card.append(line1, who, steps);
  card.addEventListener("click", () => selectFailure(key, jobs));
  return card;
}

export function selectFailure(key, jobs, options = {}) {
  state.selectedFailureKey = key;
  markFailureSelection();
  renderFailureDetail(jobs);
  if (!options.keepListOnNarrow) setMobilePane("detail");
}

export function markFailureSelection() {
  for (const card of listEl.querySelectorAll(".mail-item")) {
    card.classList.toggle("selected", card.dataset.failureKey === state.selectedFailureKey);
  }
}

export function clearFailureDetail() {
  state.selectedFailureKey = "";
  if (failureDetailEl) {
    failureDetailEl.replaceChildren();
    failureDetailEl.hidden = true;
  }
  if (dlqEmptyEl) dlqEmptyEl.hidden = false;
}

export function renderFailureDetail(jobs) {
  if (!failureDetailEl) return;
  failureDetailEl.replaceChildren(createFailureLetter(jobs));
  failureDetailEl.hidden = false;
  if (dlqEmptyEl) dlqEmptyEl.hidden = true;
  markFailureSelection();
}

export function jobMatches(job, needle) {
  const haystack = [job.messageSubject, job.messageFrom, job.messageTo, job.lastError, STEP_NAMES[job.type] || job.type]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function emptyDlqCopy(scope) {
  if (scope === "stopped") return "没有已经放弃的步骤";
  if (scope === "retrying") return "没有还在等的步骤";
  if (scope === "dismissed") return "没有放过的步骤";
  return "没有要处理的任务";
}

export function stepRank(type) {
  const index = STEP_ORDER.indexOf(type);
  return index === -1 ? STEP_ORDER.length : index;
}

export function createFailureLetter(jobs) {
  const first = jobs[0] || {};
  const article = document.createElement("article");
  article.className = "letter";

  const head = document.createElement("div");
  head.className = "letter-head";
  const subjectText = first.messageSubject || "（无主题）";
  if (first.messageId) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "letter-open";
    open.textContent = subjectText;
    open.title = "打开邮件";
    open.addEventListener("click", () => void openFailedMail(first.messageId));
    head.append(open);
  } else {
    const subject = document.createElement("p");
    subject.className = "letter-subject";
    subject.textContent = subjectText;
    head.append(subject);
  }
  const stopped = jobs.filter((job) => job.status === "dead" || job.status === "failed");
  if (stopped.length > 1 && first.messageId) {
    const retryLetter = document.createElement("button");
    retryLetter.type = "button";
    retryLetter.className = "btn-fit";
    retryLetter.textContent = "整封重试";
    retryLetter.addEventListener("click", () => void retryMessage(first.messageId));
    head.append(retryLetter);
  }

  const who = document.createElement("p");
  who.className = "muted";
  const from = first.messageFrom ? formatFrom(first.messageFrom) : "";
  const to = first.messageTo ? formatRecipients(first.messageTo) : "";
  who.textContent = from || to ? [from || "发件人尚未解析", to].filter(Boolean).join(" → ") : "地址尚未解析";

  article.append(head, who);
  for (const job of jobs) article.append(createFailureStep(job));
  return article;
}

export function createFailureStep(job) {
  const row = document.createElement("div");
  row.className = "step-row";

  const copy = document.createElement("div");
  copy.className = "step-copy";
  const name = document.createElement("strong");
  name.textContent = STEP_NAMES[job.type] || job.type;
  const error = document.createElement("p");
  error.className = "step-error";
  error.textContent = job.lastError || "没有错误说明";
  const state = document.createElement("p");
  state.className = "muted";
  state.textContent = stepState(job);
  copy.append(name, error, state);

  const actions = document.createElement("div");
  actions.className = "step-actions";
  const stopped = job.status === "dead" || job.status === "failed";
  if (stopped) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-fit";
    retry.textContent = "再试一次";
    retry.addEventListener("click", () => void retrySingleJob(job.id));
    actions.append(retry);
  }
  if (stopped) {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn-fit ghost";
    dismiss.textContent = "放过";
    dismiss.addEventListener("click", () => void dismissJob(job.id));
    actions.append(dismiss);
  }
  if (job.lastError) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-fit ghost";
    copyBtn.textContent = "复制错误";
    copyBtn.addEventListener("click", () => void copyText(job.lastError));
    actions.append(copyBtn);
  }

  row.append(copy, actions);
  return row;
}

export function stepState(job) {
  const when = job.updatedAt ? ` · ${formatFullTime(job.updatedAt)}` : "";
  if (job.status === "dismissed") return `已放过 · 试了 ${job.attempts}/${job.maxAttempts} 次${when}`;
  if (job.status === "dead" || job.status === "failed") {
    return `已放弃 · 试了 ${job.attempts}/${job.maxAttempts} 次${when}`;
  }
  if (job.status === "running") return "正在跑";
  if (job.status === "queued" && job.runAfter) {
    return `还会再试 · 下次 ${formatFullTime(job.runAfter)}`;
  }
  return "还会再试";
}

export async function openFailedMail(id) {
  await switchNav("inbox");
  await selectMail(id);
}

export async function retrySingleJob(id) {
  try {
    await request("/v1/jobs/" + encodeURIComponent(id) + "/retry", { method: "POST", body: {} });
    toast("已重新排队");
    await loadDlqJobs(state.currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("任务重试失败: " + explain(err));
  }
}

export async function dismissJob(id) {
  if (!(await askConfirm("此步骤不再自动执行。邮件仍保留，之后可以重试。"))) return;
  try {
    await request("/v1/jobs/" + encodeURIComponent(id) + "/dismiss", { method: "POST", body: {} });
    toast("已放过");
    await loadDlqJobs(state.currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("操作失败: " + explain(err));
  }
}

export async function retryMessage(messageId) {
  try {
    const res = await request("/v1/jobs/retry-message", { method: "POST", body: { messageId } });
    toast(`已重新排队 ${res.count || 0} 步`);
    await loadDlqJobs(state.currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("重试失败: " + explain(err));
  }
}

export async function retryAllDead() {
  if (!(await askConfirm("重新执行全部已停止的任务？已放过的任务保持不变。"))) return;
  try {
    const res = await request("/v1/jobs/retry-all", { method: "POST", body: {} });
    toast(`已重新排队 ${res.count || 0} 个`);
    await loadDlqJobs(state.currentDlqScope);
    void updateDlqBadge();
  } catch (err) {
    toast("批量重试失败: " + explain(err));
  }
}

export async function updateDlqBadge() {
  try {
    const res = await request("/v1/jobs/summary");
    const count = (res.dead || 0) + (res.failed || 0);
    if (count > 0) {
      badgeDlq.hidden = false;
      badgeDlq.textContent = String(count);
    } else {
      badgeDlq.hidden = true;
    }
    if (state.currentView === "dlq") paintDlqCounts(res);
  } catch {
    // ignore
  }
}
