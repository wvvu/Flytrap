// 全局命令速达面板 (Ctrl/Cmd + K) 与键盘快捷键速查表 (?)。
import { state } from "./state.js";
import { paletteInput, paletteList, paletteModal, shortcutsModal } from "./dom.js";
import { handleMarkAllRead, reloadMessages, reloadTrash } from "./mail-view.js";
import { openComposer } from "./send-view.js";
import { setPromoMode, switchNav, toggleTheme } from "./shell.js";
import { showCreateUserPanel } from "./users-view.js";

export function buildPaletteCommands() {
  const isAdmin = state.sessionRole === "admin";
  const cmds = [
    {
      id: "nav-inbox",
      title: "前往收件箱",
      hint: "正常与待分拣来信",
      kbd: "G I",
      run: () => switchNav("inbox"),
    },
    {
      id: "nav-promo",
      title: "只看推广邮件",
      hint: "营销通讯与产品通知",
      kbd: "",
      run: async () => {
        await switchNav("inbox");
        setPromoMode(true);
      },
    },
    {
      id: "nav-starred",
      title: "前往星标邮件",
      hint: "重要标记汇总",
      kbd: "",
      run: () => switchNav("starred"),
    },
    {
      id: "compose",
      title: "撰写新邮件",
      hint: "打开发信编辑器",
      kbd: "C",
      run: async () => {
        await switchNav("send");
        openComposer();
      },
    },
    {
      id: "nav-spam",
      title: "前往已拦截列表",
      hint: "垃圾、钓鱼与可疑邮件",
      kbd: "",
      run: () => switchNav("spam"),
    },
    {
      id: "nav-trash",
      title: "前往垃圾桶",
      hint: "已归档移除邮件",
      kbd: "",
      run: () => switchNav("trash"),
    },
    {
      id: "mark-all-read",
      title: "将收件箱全部标为已读",
      hint: "清空未读红点",
      kbd: "",
      run: () => handleMarkAllRead("inbox"),
    },
    {
      id: "refresh",
      title: "刷新当前列表",
      hint: "同步最新邮件状态",
      kbd: "R",
      run: () => (state.currentView === "trash" ? reloadTrash() : reloadMessages()),
    },
    {
      id: "theme",
      title: "切换深色 / 浅色外观主题",
      hint: "即时切换画布配色",
      kbd: "",
      run: () => toggleTheme(),
    },
  ];

  if (isAdmin) {
    cmds.push(
      {
        id: "users",
        title: "成员与邮箱分配管理",
        hint: "管理独立账号、授权邮箱与配额",
        kbd: "",
        run: () => switchNav("users"),
      },
      {
        id: "new-user",
        title: "新建独立成员账号",
        hint: "开通专属收发工作台",
        kbd: "",
        run: async () => {
          state.creatingUser = true;
          await switchNav("users");
          showCreateUserPanel();
        },
      },
      {
        id: "dlq",
        title: "查看处理失败队列",
        hint: "重试或忽略停滞任务",
        kbd: "",
        run: () => switchNav("dlq"),
      },
      {
        id: "settings-ai",
        title: "设置 · 模型池与分拣提示词",
        hint: "管理 API Key 与在线测通",
        kbd: "",
        run: () => {
          state.currentSettingsSection = "classify";
          return switchNav("settings");
        },
      },
      {
        id: "settings-domains",
        title: "设置 · 收信域名与 DKIM 签名",
        hint: "管理域名与 DNS 记录",
        kbd: "",
        run: () => {
          state.currentSettingsSection = "domains";
          return switchNav("settings");
        },
      },
    );
  } else {
    cmds.push({
      id: "my-mailboxes",
      title: "查看已分配专属邮箱与配额",
      hint: "查看收发地址规则与设置称呼",
      kbd: "",
      run: () => {
        state.currentSettingsSection = "my-mailboxes";
        return switchNav("settings");
      },
    });
  }

  cmds.push({
    id: "shortcuts",
    title: "查看键盘快捷键列表",
    hint: "全键盘高效操作指南",
    kbd: "?",
    run: () => openShortcutsModal(),
  });

  return cmds;
}

export function openPalette() {
  if (!paletteModal || !paletteInput) return;
  state.paletteOpen = true;
  state.paletteIndex = 0;
  paletteModal.hidden = false;
  paletteInput.value = "";
  renderPaletteItems("");
  paletteInput.focus();
}

export function closePalette() {
  state.paletteOpen = false;
  if (paletteModal) paletteModal.hidden = true;
}

export function renderPaletteItems(query) {
  if (!paletteList) return;
  const needle = String(query || "").trim().toLowerCase();
  const all = buildPaletteCommands();
  state.paletteFiltered = all.filter((cmd) => {
    if (!needle) return true;
    return `${cmd.title} ${cmd.hint}`.toLowerCase().includes(needle);
  });
  if (state.paletteIndex >= state.paletteFiltered.length) {
    state.paletteIndex = 0;
  }
  paletteList.replaceChildren();
  if (state.paletteFiltered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = "未找到匹配指令";
    paletteList.append(empty);
    return;
  }
  state.paletteFiltered.forEach((cmd, idx) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "palette-item" + (idx === state.paletteIndex ? " active" : "");
    const left = document.createElement("div");
    left.className = "palette-item-left";
    const t = document.createElement("span");
    t.className = "palette-item-title";
    t.textContent = cmd.title;
    const h = document.createElement("span");
    h.className = "palette-item-hint";
    h.textContent = cmd.hint;
    left.append(t, h);
    item.append(left);
    if (cmd.kbd) {
      const k = document.createElement("kbd");
      k.className = "kbd-hint";
      k.textContent = cmd.kbd;
      item.append(k);
    }
    item.addEventListener("mouseenter", () => {
      state.paletteIndex = idx;
      highlightPaletteRow();
    });
    item.addEventListener("click", () => {
      closePalette();
      void cmd.run();
    });
    paletteList.append(item);
  });
}

function highlightPaletteRow() {
  if (!paletteList) return;
  const rows = paletteList.querySelectorAll(".palette-item");
  rows.forEach((row, idx) => {
    row.classList.toggle("active", idx === state.paletteIndex);
  });
}

export function handlePaletteKeydown(event) {
  if (!state.paletteOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
    return;
  }
  const len = state.paletteFiltered.length;
  if (len === 0) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.paletteIndex = (state.paletteIndex + 1) % len;
    highlightPaletteRow();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.paletteIndex = (state.paletteIndex - 1 + len) % len;
    highlightPaletteRow();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const chosen = state.paletteFiltered[state.paletteIndex];
    closePalette();
    if (chosen) void chosen.run();
  }
}

export function openShortcutsModal() {
  if (shortcutsModal) shortcutsModal.hidden = false;
}

export function closeShortcutsModal() {
  if (shortcutsModal) shortcutsModal.hidden = true;
}
