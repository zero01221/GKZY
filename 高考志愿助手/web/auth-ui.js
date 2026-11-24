/* 登录态 UI + 本地收藏一次性迁移（仅个人本地使用场景） */
'use strict';

const AUTH = { authenticated: false, user: null };
let modalEl = null;
let migrating = false;

/** 合并键与服务端 store.mjs 保持一致：schoolId|extra（或 major）。 */
function mergeKeyOf(item) {
  return `${item?.schoolId ?? ''}|${String(item?.extra || item?.major || '').trim()}`;
}

function notify(msg, ms) {
  if (typeof toast === 'function') toast(msg, ms);
}

async function getJson(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', ...(options || {}) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function injectTopbar() {
  const slot = document.getElementById('auth-slot');
  if (!slot) return;
  if (AUTH.authenticated) {
    slot.innerHTML = '<span class="auth-user">👤 admin</span><span class="auth-sep">|</span>'
      + '<button class="auth-btn" id="auth-logout" type="button">退出</button>';
    slot.querySelector('#auth-logout')?.addEventListener('click', doLogout);
  } else {
    slot.innerHTML = '<button class="auth-btn" id="auth-login" type="button">登录</button>';
    slot.querySelector('#auth-login')?.addEventListener('click', promptLogin);
  }
}

function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement('div');
  modalEl.className = 'auth-mask';
  modalEl.innerHTML = `
    <div class="auth-dialog" role="dialog" aria-modal="true" aria-label="登录">
      <h2>登录</h2>
      <p>登录后可查看填报历史、草稿箱与数据管理；收藏会自动同步到本机服务端。</p>
      <form id="auth-form">
        <label>账号 <input id="auth-user" type="text" autocomplete="username" value="" required></label>
        <label>密码 <input id="auth-pass" type="password" autocomplete="current-password" required></label>
        <div class="auth-error" id="auth-error"></div>
        <div class="auth-actions">
          <button class="btn" id="auth-cancel" type="button">取消</button>
          <button class="btn primary" type="submit">登录</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modalEl);
  modalEl.querySelector('#auth-cancel')?.addEventListener('click', closeModal);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
  modalEl.querySelector('#auth-form')?.addEventListener('submit', doLogin);
  return modalEl;
}

function closeModal() {
  if (modalEl) modalEl.style.display = 'none';
}

/** 弹出登录框。 */
function promptLogin() {
  const el = ensureModal();
  el.style.display = '';
  const err = el.querySelector('#auth-error');
  if (err) err.textContent = '';
  el.querySelector('#auth-pass')?.focus();
}

async function doLogin(e) {
  e.preventDefault();
  const el = ensureModal();
  const user = el.querySelector('#auth-user').value.trim();
  const pass = el.querySelector('#auth-pass').value;
  const err = el.querySelector('#auth-error');
  const submit = el.querySelector('button[type="submit"]');
  err.textContent = '';
  submit.disabled = true;
  try {
    const { status, data } = await getJson('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (!data.ok) {
      err.textContent = status === 401 ? '账号或密码错误' : (data.message || '登录失败');
      return;
    }
    AUTH.authenticated = true;
    AUTH.user = data.user || 'admin';
    injectTopbar();
    window.dispatchEvent(new CustomEvent('auth-changed', { detail: { authenticated: true } }));
    closeModal();
    notify('登录成功');
    await migrateWishlist();
    notify('登录成功，收藏已同步');
  } catch (error) {
    err.textContent = '登录失败：' + error.message;
  } finally {
    submit.disabled = false;
  }
}

async function doLogout() {
  try {
    await getJson('/api/logout', { method: 'POST' });
  } catch { /* 本地服务短暂不可用时仍清理前端状态 */ }
  AUTH.authenticated = false;
  AUTH.user = null;
  injectTopbar();
  window.dispatchEvent(new CustomEvent('auth-changed', { detail: { authenticated: false } }));
  notify('已退出登录');
}

/**
 * 一次性把 localStorage 的旧收藏合并到服务端：
 * 服务端优先，仅上传缺失项；成功后写 gk_wishlist_migrated 时间戳，失败不写。
 */
async function migrateWishlist() {
  if (migrating || !AUTH.authenticated) return;
  if (localStorage.getItem('gk_wishlist_migrated')) return;
  migrating = true;
  try {
    const listRes = await getJson('/api/wishlist');
    if (!listRes.data.ok) return;
    const serverKeys = new Set((listRes.data.items || []).map((x) => x.mergeKey || mergeKeyOf(x)));
    let localItems = [];
    try { localItems = JSON.parse(localStorage.getItem('gk_wishlist') || '[]'); } catch { localItems = []; }
    if (!Array.isArray(localItems)) localItems = [];
    const missing = localItems.filter((x) => x && !serverKeys.has(mergeKeyOf(x)));
    if (!missing.length) {
      localStorage.setItem('gk_wishlist_migrated', new Date().toISOString());
      return;
    }
    const result = await getJson('/api/wishlist/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: missing }),
    });
    if (result.data.ok) {
      localStorage.setItem('gk_wishlist_migrated', new Date().toISOString());
    }
  } catch (error) {
    console.error('收藏迁移失败：', error.message);
  } finally {
    migrating = false;
  }
}

/** 页面初始化：注入顶栏 DOM，探测已有会话，必要时补触发迁移。 */
async function init() {
  injectTopbar();
  try {
    const { data } = await getJson('/api/session');
    if (data.ok && data.authenticated) {
      AUTH.authenticated = true;
      AUTH.user = data.user || 'admin';
      injectTopbar();
      await migrateWishlist();
      window.dispatchEvent(new CustomEvent('auth-changed', { detail: { authenticated: true } }));
    }
  } catch { /* 服务不可达时保持未登录态 */ }
}

function isAuthenticated() {
  return AUTH.authenticated;
}

window.AuthUI = { init, isAuthenticated, promptLogin, migrateWishlist };
