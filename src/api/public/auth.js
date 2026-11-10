// 登录 / 登出 / 找回密码。
import { state } from "./state.js";
import { appEl, btnResetResend, loginEl, loginError, resetCodeStep, resetDigits, resetError, resetModal, resetPasswordStep } from "./dom.js";
import { request } from "./net.js";
import { explain, toast } from "./ui.js";
import { revealApp } from "./nav.js";

export async function signIn() {
  loginError.textContent = "";
  const btn = document.querySelector("#btn-login");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "请稍候";
  }
  try {
    await request("/v1/login", {
      method: "POST",
      body: {
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value,
      },
    });
    document.querySelector("#password").value = "";
    state.csrfToken = null;
    await revealApp();
  } catch (err) {
    loginError.textContent = explain(err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "继续";
    }
  }
}

export async function signOut() {
  try {
    await request("/v1/logout", { method: "POST", body: {} });
  } catch {
    // Session destroyed
  }
  state.csrfToken = null;
  showLogin();
}

export function showLogin() {
  document.title = "登录";
  state.holdBoot = false;
  if (appEl) appEl.classList.remove("is-booting");
  loginEl.hidden = false;
  loginEl.style.display = "flex";
  appEl.hidden = true;
  appEl.style.display = "none";
  closeReset(false);
  const username = document.querySelector("#username");
  if (username instanceof HTMLInputElement) username.focus();
}

export function bindResetDigits() {
  resetDigits.forEach((input, index) => {
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "");
      if (digits.length > 1) {
        fillResetDigits(digits);
        return;
      }
      input.value = digits;
      if (digits && resetDigits[index + 1]) resetDigits[index + 1].focus();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && resetDigits[index - 1]) resetDigits[index - 1].focus();
    });
    input.addEventListener("paste", (event) => {
      const text = (event.clipboardData && event.clipboardData.getData("text") || "").replace(/\D/g, "");
      if (!text) return;
      event.preventDefault();
      fillResetDigits(text);
    });
  });
}

export function fillResetDigits(digits) {
  for (let i = 0; i < resetDigits.length; i += 1) resetDigits[i].value = digits[i] || "";
  const focusAt = Math.min(Math.max(digits.length, 1), resetDigits.length) - 1;
  resetDigits[focusAt].focus();
}

export function resetCodeValue() {
  return resetDigits.map((input) => input.value).join("");
}

export function clearResetDigits() {
  for (const input of resetDigits) input.value = "";
}

export async function startReset() {
  loginError.textContent = "";
  const username = document.querySelector("#username");
  const email = username ? username.value.trim() : "";
  if (!email) {
    loginError.textContent = "先填写邮箱";
    if (username) username.focus();
    return;
  }
  state.resetEmail = email;
  openResetModal();
  await sendResetCode();
}

export function openResetModal() {
  showResetCode();
  clearResetDigits();
  const next = document.querySelector("#reset-next");
  const again = document.querySelector("#reset-again");
  if (next) next.value = "";
  if (again) again.value = "";
  if (resetError) resetError.textContent = "";
  if (resetModal) resetModal.hidden = false;
  if (resetDigits[0]) resetDigits[0].focus();
}

export async function sendResetCode() {
  if (resetError) resetError.textContent = "";
  try {
    await request("/v1/password/forgot", { method: "POST", body: { email: state.resetEmail } });
    showResetCode();
    startResetCountdown(60);
  } catch (err) {
    if (resetError) resetError.textContent = explain(err);
  }
}

export function showResetCode() {
  if (resetCodeStep) resetCodeStep.hidden = false;
  if (resetPasswordStep) resetPasswordStep.hidden = true;
}

export function showResetPassword() {
  if (resetError) resetError.textContent = "";
  if (!/^\d{6}$/.test(resetCodeValue())) {
    if (resetError) resetError.textContent = "请输入验证码";
    return;
  }
  if (resetCodeStep) resetCodeStep.hidden = true;
  if (resetPasswordStep) resetPasswordStep.hidden = false;
  document.querySelector("#reset-next")?.focus();
}

export async function finishReset() {
  const nextInput = document.querySelector("#reset-next");
  const againInput = document.querySelector("#reset-again");
  const next = nextInput ? nextInput.value : "";
  const again = againInput ? againInput.value : "";
  if (resetError) resetError.textContent = "";
  if (next.length < 8) {
    if (resetError) resetError.textContent = "新密码至少 8 位";
    return;
  }
  if (next !== again) {
    if (resetError) resetError.textContent = "两次输入不一致";
    return;
  }
  const btn = document.querySelector("#btn-reset-save");
  if (btn) btn.disabled = true;
  try {
    await request("/v1/password/reset", {
      method: "POST",
      body: { email: state.resetEmail, code: resetCodeValue(), next },
    });
    closeReset(false);
    const password = document.querySelector("#password");
    if (password) password.value = "";
    loginError.textContent = "密码已更新，请登录";
  } catch (err) {
    if (err && err.status === 401) {
      showResetCode();
      clearResetDigits();
      if (resetError) resetError.textContent = "验证码不正确";
      if (resetDigits[0]) resetDigits[0].focus();
    } else if (err && err.status === 400) {
      if (resetError) resetError.textContent = "新密码至少 8 位";
    } else if (resetError) {
      resetError.textContent = explain(err);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function closeReset(focusEmail) {
  window.clearInterval(state.resetTimer);
  state.resetTimer = 0;
  state.resetLeft = 0;
  if (resetModal) resetModal.hidden = true;
  showResetCode();
  paintResend();
  if (focusEmail) document.querySelector("#username")?.focus();
}

export function startResetCountdown(seconds) {
  state.resetLeft = seconds;
  paintResend();
  window.clearInterval(state.resetTimer);
  state.resetTimer = window.setInterval(() => {
    state.resetLeft -= 1;
    if (state.resetLeft <= 0) {
      window.clearInterval(state.resetTimer);
      state.resetTimer = 0;
      state.resetLeft = 0;
    }
    paintResend();
  }, 1000);
}

export function paintResend() {
  if (!btnResetResend) return;
  if (state.resetLeft > 0) {
    btnResetResend.disabled = true;
    btnResetResend.textContent = "重新发送验证码 (" + state.resetLeft + "s)";
  } else {
    btnResetResend.disabled = false;
    btnResetResend.textContent = "重新发送验证码";
  }
}

export async function savePassword() {
  const current = document.querySelector("#password-current");
  const next = document.querySelector("#password-next");
  const currentValue = current ? current.value : "";
  const nextValue = next ? next.value : "";
  if (nextValue.length < 8) {
    toast("新密码至少 8 位");
    return;
  }
  try {
    await request("/v1/settings/password", { method: "PUT", body: { current: currentValue, next: nextValue } });
    if (current) current.value = "";
    if (next) next.value = "";
    toast("密码已更新");
  } catch {
    toast("密码未更新");
  }
}

bindResetDigits();
