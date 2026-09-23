import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
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

const currentWindow = getCurrentWindow();

let settings = null;
let settingsOpen = false;
let messageTimer = null;

const normalizeUrl = (raw) => {
  const value = raw.trim();

  if (!value) {
    throw new Error('网址不能为空');
  }

  const candidate = /^https?:\/\//i.test(value)
    ? value
    : `https://${value}`;

  const parsed = new URL(candidate);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 HTTP/HTTPS 网站');
  }

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

  await invoke('set_toolbar_height', {
    height: open ? 310 : 56,
  });

  if (open) {
    await refreshAutostart();
    shortcutInput.focus();
  }
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
      ${
        site.builtin
          ? ''
          : '<button class="tiny-danger" data-id="' +
            escapeAttr(site.id) +
            '">删除</button>'
      }
    `;

    row
      .querySelector('.tiny-danger')
      ?.addEventListener('click', async () => {
        try {
          settings = await invoke('remove_site', {
            id: site.id,
          });

          renderSites();
          showMessage('已删除');
        } catch (error) {
          showMessage(String(error), true);
        }
      });

    siteList.appendChild(row);
  }
};

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );

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

  pinButton.title = settings.pinned
    ? '取消置顶'
    : '置顶';

  pinButton.setAttribute(
    'aria-label',
    settings.pinned
      ? '取消置顶'
      : '置顶',
  );
};

const load = async () => {
  settings = await invoke('get_settings');

  renderSites();
  applyPinnedUi();

  shortcutInput.value = settings.shortcut;
  shortcutInput.readOnly = true;

  await refreshAutostart();
};

const modifierOnlyKeys = new Set([
  'Control',
  'Alt',
  'Shift',
  'Meta',
]);

const keyNames = new Map([
  [' ', 'Space'],
  ['Escape', 'Escape'],
  ['Enter', 'Enter'],
  ['Tab', 'Tab'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Insert', 'Insert'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['ArrowUp', 'ArrowUp'],
  ['ArrowDown', 'ArrowDown'],
  ['ArrowLeft', 'ArrowLeft'],
  ['ArrowRight', 'ArrowRight'],
  ['PrintScreen', 'PrintScreen'],
]);

const formatShortcutFromEvent = (event) => {
  if (modifierOnlyKeys.has(event.key)) {
    return null;
  }

  const modifiers = [];

  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  if (modifiers.length === 0) {
    return null;
  }

  let key = keyNames.get(event.key);

  if (!key) {
    if (/^F\d{1,2}$/i.test(event.key)) {
      key = event.key.toUpperCase();
    } else if (event.key.length === 1) {
      key = event.key.toUpperCase();
    } else {
      key = event.key;
    }
  }

  return [...modifiers, key].join('+');
};

const saveShortcutFromKeyEvent = async (event) => {
  if (!settingsOpen || event.repeat) {
    return;
  }

  const shortcut = formatShortcutFromEvent(event);

  // 只有按到完整组合键时才截断输入。
  if (!shortcut) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  try {
    settings = await invoke('set_shortcut', {
      shortcut,
    });

    shortcutInput.value = settings.shortcut;
    showMessage(`快捷键已设置为 ${settings.shortcut}`);
  } catch (error) {
    shortcutInput.value = settings.shortcut;
    showMessage(String(error), true);
  }
};

shortcutInput.addEventListener('keydown', saveShortcutFromKeyEvent);

siteSelect.addEventListener('change', async () => {
  try {
    settings = await invoke('select_site', {
      id: siteSelect.value,
    });

    renderSites();
  } catch (error) {
    showMessage(String(error), true);
  }
});

pinButton.addEventListener('click', async () => {
  settings.pinned = !settings.pinned;

  try {
    settings = await invoke('set_pinned', {
      pinned: settings.pinned,
    });

    applyPinnedUi();
  } catch (error) {
    settings.pinned = !settings.pinned;
    applyPinnedUi();
    showMessage(String(error), true);
  }
});

settingsButton.addEventListener('click', async () => {
  await setSettingsPanel(!settingsOpen);
});

hideButton.addEventListener('click', async () => {
  try {
    await invoke('hide_window');
  } catch (error) {
    showMessage(String(error), true);
  }
});

addSiteButton.addEventListener('click', async () => {
  try {
    const name = newSiteName.value.trim();
    const url = normalizeUrl(newSiteUrl.value);

    if (!name) {
      throw new Error('请填写网站名称');
    }

    settings = await invoke('add_site', {
      name,
      url,
    });

    newSiteName.value = '';
    newSiteUrl.value = '';

    renderSites();
    showMessage('网站已添加并切换');
  } catch (error) {
    showMessage(String(error), true);
  }
});

autostartToggle.addEventListener('change', async () => {
  const value = autostartToggle.checked;

  try {
    if (value) {
      await enable();
    } else {
      await disable();
    }

    settings = await invoke('set_autostart', {
      enabled: value,
    });

    showMessage(
      value
        ? '已启用开机启动'
        : '已关闭开机启动',
    );
  } catch (error) {
    autostartToggle.checked = !value;
    showMessage(String(error), true);
  }
});

window.addEventListener('keydown', async (event) => {
  if (event.repeat) return;

  if (
    event.key.toLowerCase() !== 'f' ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) {
    return;
  }

  const target = event.target;
  const tag = target?.tagName;

  if (
    settingsOpen ||
    target?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)
  ) {
    return;
  }

  event.preventDefault();

  try {
    await invoke('toggle_fullscreen_command');
  } catch (error) {
    console.error(error);
  }
});

const createResizeHandle = (className, direction) => {
  const element = document.createElement('div');

  element.className = `resize-edge ${className}`;
  element.setAttribute('aria-hidden', 'true');

  element.addEventListener('mousedown', async (event) => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      await currentWindow.startResizeDragging(direction);
    } catch (error) {
      console.error(error);
    }
  });

  document.body.appendChild(element);
};

createResizeHandle('resize-top', 'North');
createResizeHandle('resize-top-left', 'NorthWest');
createResizeHandle('resize-top-right', 'NorthEast');

await load();
