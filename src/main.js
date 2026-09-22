import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

const $ = (id) => document.getElementById(id);
const siteSelect = $('siteSelect');
const pinButton = $('pinButton');
const settingsButton = $('settingsButton');
const hideButton = $('hideButton');
const settingsPanel = $('settingsPanel');
const siteList = $('siteList');
const shortcutInput = $('shortcutInput');
const autostartToggle = $('autostartToggle');
const newSiteName = $('newSiteName');
const newSiteUrl = $('newSiteUrl');
const addSiteButton = $('addSiteButton');
const settingsMessage = $('settingsMessage');

let settings = null;
let shortcutRegistered = null;
let settingsOpen = false;
let messageTimer = null;

const normalizeUrl = (raw) => {
  const value = raw.trim();
  if (!value) throw new Error('网址不能为空');
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 HTTP/HTTPS 网站');
  return parsed.toString();
};

const showMessage = (text, isError = false) => {
  settingsMessage.textContent = text;
  settingsMessage.className = `settings-message ${isError ? 'error' : ''}`;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    settingsMessage.textContent = '';
    settingsMessage.className = 'settings-message';
  }, 2600);
};

const setSettingsPanel = async (open) => {
  settingsOpen = open;
  settingsPanel.classList.toggle('open', open);
  settingsPanel.setAttribute('aria-hidden', String(!open));
  await invoke('set_toolbar_height', { height: open ? 310 : 46 });
  if (open) await refreshAutostart();
};

const renderSites = () => {
  siteSelect.innerHTML = '';
  for (const site of settings.sites) {
    const option = document.createElement('option');
    option.value = site.id;
    option.textContent = site.name;
    option.selected = site.id === settings.selected_site_id;
    siteSelect.appendChild(option);
  }

  siteList.innerHTML = '';
  for (const site of settings.sites) {
    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `
      <div class="site-row-text">
        <div class="site-name">${escapeHtml(site.name)}</div>
        <div class="site-url">${escapeHtml(site.url)}</div>
      </div>
      ${site.builtin ? '' : '<button class="tiny-danger" data-id="' + escapeAttr(site.id) + '">删除</button>'}
    `;
    row.querySelector('.tiny-danger')?.addEventListener('click', async () => {
      try {
        settings = await invoke('remove_site', { id: site.id });
        renderSites();
        showMessage('已删除');
      } catch (error) {
        showMessage(String(error), true);
      }
    });
    siteList.appendChild(row);
  }
};

const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeAttr = escapeHtml;

const refreshAutostart = async () => {
  try {
    autostartToggle.checked = await isEnabled();
  } catch {
    autostartToggle.checked = Boolean(settings.autostart);
  }
};

const applyPinnedUi = () => {
  pinButton.classList.toggle('active', Boolean(settings.pinned));
  pinButton.title = settings.pinned ? '取消置顶' : '置顶';
  pinButton.setAttribute('aria-label', settings.pinned ? '取消置顶' : '置顶');
};

const load = async () => {
  settings = await invoke('get_settings');
  renderSites();
  applyPinnedUi();
  shortcutInput.value = settings.shortcut;
  await refreshAutostart();
  await registerShortcut(settings.shortcut);
};

const registerShortcut = async (shortcut) => {
  const value = shortcut.trim();
  if (!value) throw new Error('快捷键不能为空');
  if (shortcutRegistered === value) return;

  const old = shortcutRegistered;
  try {
    if (old) await unregister(old);
    await register(value, async (event) => {
      if (event.state === 'Pressed') await invoke('toggle_visibility');
    });
    shortcutRegistered = value;
    await invoke('set_shortcut', { shortcut: value });
  } catch (error) {
    if (old) {
      try {
        await register(old, async (event) => {
          if (event.state === 'Pressed') await invoke('toggle_visibility');
        });
        shortcutRegistered = old;
      } catch {}
    }
    throw error;
  }
};

siteSelect.addEventListener('change', async () => {
  try {
    settings = await invoke('select_site', { id: siteSelect.value });
    renderSites();
  } catch (error) {
    showMessage(String(error), true);
  }
});

pinButton.addEventListener('click', async () => {
  settings.pinned = !settings.pinned;
  try {
    settings = await invoke('set_pinned', { pinned: settings.pinned });
    applyPinnedUi();
  } catch (error) {
    settings.pinned = !settings.pinned;
    applyPinnedUi();
    showMessage(String(error), true);
  }
});

settingsButton.addEventListener('click', () => setSettingsPanel(!settingsOpen));
hideButton.addEventListener('click', () => invoke('hide_window'));

addSiteButton.addEventListener('click', async () => {
  try {
    const name = newSiteName.value.trim();
    const url = normalizeUrl(newSiteUrl.value);
    if (!name) throw new Error('请填写网站名称');
    settings = await invoke('add_site', { name, url });
    newSiteName.value = '';
    newSiteUrl.value = '';
    renderSites();
    showMessage('网站已添加并切换');
  } catch (error) {
    showMessage(String(error), true);
  }
});

let shortcutSaveTimer;
shortcutInput.addEventListener('change', async () => {
  clearTimeout(shortcutSaveTimer);
  shortcutSaveTimer = setTimeout(async () => {
    try {
      await registerShortcut(shortcutInput.value);
      settings.shortcut = shortcutInput.value.trim();
      showMessage('快捷键已更新');
    } catch (error) {
      shortcutInput.value = settings.shortcut;
      showMessage(String(error), true);
    }
  }, 50);
});

autostartToggle.addEventListener('change', async () => {
  const value = autostartToggle.checked;
  try {
    if (value) await enable();
    else await disable();
    settings = await invoke('set_autostart', { enabled: value });
    showMessage(value ? '已启用开机启动' : '已关闭开机启动');
  } catch (error) {
    autostartToggle.checked = !value;
    showMessage(String(error), true);
  }
});

window.addEventListener('keydown', async (event) => {
  if (event.repeat) return;
  if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.altKey || event.metaKey) return;
  const target = event.target;
  const tag = target?.tagName;
  if (settingsOpen || target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  event.preventDefault();
  await invoke('toggle_fullscreen');
});

await load();
