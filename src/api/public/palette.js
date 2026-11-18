// 命令面板（Ctrl+K / Cmd+K）与键盘快捷键速查表（?）。
import { SHORTCUT_ITEMS } from "./constants.js";
import { state } from "./state.js";
import {
  paletteInput,
  paletteList,
  paletteModal,
  recipientFilterSelect,
  shortcutsGrid,
  shortcutsModal,
} from "./dom.js";
import {
  populateRecipientFilter,
  setMailScope,
  setPromoMode,
  switchNav,
  toggleTheme,
} from "./shell.js";
import { openComposer } from "./send-view.js";
import { handleMarkAllRead, reloadMessages } from "./mail-view.js";

function buildPaletteCommands() {
  const cmds = [
    {
      title: "撰写新邮件",
      sub: "快捷键 C",
      run: () => openComposer(),
    },
    {
      title: "前往收件箱",
      sub: "查看正常与未分类来信",
      run: () => void switchNav("inbox"),
    },
    {
      title: "前往星标邮件",
      sub: "重点与待办邮件",
      run: () => void switchNav("starred"),
    },
    {
      title: "只看推广邮件",
      sub: "订阅通讯与活动通知",
      run: async () => {
        if (state.currentView !== "inbox") await switchNav("inbox");
        setPromoMode(true);
      },
    },
    {
      title: "前往已拦截",
      sub: "垃圾、钓鱼与非正常来信",
      run: () => void switchNav("spam"),
    },
    {
      title: "前往已发信",
      sub: "出站队列与送达回执",
      run: () => void switchNav("send"),
    },
    {
      title: "前往垃圾桶",
      sub: "已删除邮件",
      run: () => void switchNav("trash"),
    },
    {
      title: "将当前收件箱全部标为已读",
      sub: "清零未读计数",
      run: () => void handleMarkAllRead("inbox"),
    },
    {
      title: "切换深色 / 浅色主题",
      sub: "即时切换界面配色",
      run: () => toggleTheme(),
    },
    {
      title: "打开设置",
      sub: "管理域名、分拣、签名与密码",
      run: () => void switchNav("settings"),
    },
    {
      title: "查看键盘快捷键",
      sub: "快捷键 ?",
      run: () => openShortcutsModal(),
    },
  ];

  if (state.role === "admin") {
    cmds.push(
      {
        title: "前往成员与邮箱管理",
        sub: "开通独立成员账号、分配邮箱或整域",
        run: () => void switchNav("users"),
      },
      {
        title: "前往处理失败队列",
        sub: "重试或放过停住的异步步骤",
        run: () => void switchNav("dlq"),
      },
      {
        title: state.mailScope === "all" ? "切换为个人收件视角" : "切换为全局总览视角",
        sub: "管理员收件范围切换",
        run: () => setMailScope(state.mailScope === "all" ? "mine" : "all"),
      },
    );
  }

  for (const mb of state.userMailboxes) {
    if (!mb || mb.localpart === "*") continue;
    const addr = `${mb.localpart}@${mb.domain}`.toLowerCase();
    cmds.push({
      title: `筛选收件地址：${addr}`,
      sub: mb.displayName || "按该地址过滤邮件流",
      run: async () => {
        state.recipientFilter = addr;
        populateRecipientFilter();
        if (recipientFilterSelect) recipientFilterSelect.value = addr;
        if (state.currentView !== "inbox") await switchNav("inbox");
        else await reloadMessages();
      },
    });
  }

  if (state.recipientFilter) {
    cmds.unshift({
      title: "清除收件地址筛选（恢复全部地址）",
      sub: `当前筛选：${state.recipientFilter}`,
      run: async () => {
        state.recipientFilter = "";
        if (recipientFilterSelect) recipientFilterSelect.value = "";
        await reloadMessages();
      },
    });
  }

  return cmds;
}

export function openPalette() {
  if (!paletteModal || !paletteInput) return;
  paletteModal.hidden = false;
  paletteInput.value = "";
  state.paletteIndex = 0;
  renderPaletteItems("");
  paletteInput.focus();
}

export function closePalette() {
  if (!paletteModal) return;
  paletteModal.hidden = true;
}

export function renderPaletteItems(query) {
  if (!paletteList) return;
  const needle = String(query || "").trim().toLowerCase();
  const all = buildPaletteCommands();
  state.paletteItems = needle
    ? all.filter((c) => `${c.title} ${c.sub}`.toLowerCase().includes(needle))
    : all;

  if (state.paletteIndex >= state.paletteItems.length) {
    state.paletteIndex = 0;
  }

  paletteList.replaceChildren();
  if (state.paletteItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "stream-notice";
    empty.textContent = "没有匹配的命令";
    paletteList.append(empty);
    return;
  }

  state.paletteItems.forEach((cmd, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item" + (idx === state.paletteIndex ? " active" : "");
    const title = document.createElement("span");
    title.textContent = cmd.title;
    const sub = document.createElement("span");
    sub.className = "palette-item-sub";
    sub.textContent = cmd.sub;
    btn.append(title, sub);
    btn.addEventListener("mouseenter", () => {
      state.paletteIndex = idx;
      highlightPaletteRow();
    });
    btn.addEventListener("click", () => {
      closePalette();
      cmd.run();
    });
    paletteList.append(btn);
  });
}

function highlightPaletteRow() {
  if (!paletteList) return;
  const rows = paletteList.querySelectorAll(".palette-item");
  rows.forEach((row, idx) => {
    const active = idx === state.paletteIndex;
    row.classList.toggle("active", active);
    if (active) row.scrollIntoView({ block: "nearest" });
  });
}

export function handlePaletteKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (state.paletteItems.length > 0) {
      state.paletteIndex = (state.paletteIndex + 1) % state.paletteItems.length;
      highlightPaletteRow();
    }
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (state.paletteItems.length > 0) {
      state.paletteIndex = (state.paletteIndex - 1 + state.paletteItems.length) % state.paletteItems.length;
      highlightPaletteRow();
    }
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const chosen = state.paletteItems[state.paletteIndex];
    if (chosen) {
      closePalette();
      chosen.run();
    }
  }
}

export function openShortcutsModal() {
  if (!shortcutsModal || !shortcutsGrid) return;
  shortcutsGrid.replaceChildren();
  for (const [keys, desc] of SHORTCUT_ITEMS) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const d = document.createElement("span");
    d.textContent = desc;
    const k = document.createElement("kbd");
    k.className = "kbd-hint";
    k.textContent = keys;
    row.append(d, k);
    shortcutsGrid.append(row);
  }
  shortcutsModal.hidden = false;
}

export function closeShortcutsModal() {
  if (!shortcutsModal) return;
  shortcutsModal.hidden = true;
}
