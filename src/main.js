import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { listen } from '@tauri-apps/api/event';

const $ = (id) => document.getElementById(id);

const siteSelect = $('siteSelect');
const pinButton = $('pinButton');
const settingsButton = $('settingsButton');
const minimizeButton = $('minimizeButton');
const closeButton = $('closeButton');
const dragZone = $('dragZone');
const downloadToast = $('downloadToast');
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
let shortcutRecording = false;

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
  shortcutRecording = false;
  settingsPanel.classList.toggle('open', open);
  settingsPanel.setAttribute('aria-hidden', String(!open));
  shortcutInput.classList.remove('recording');

  await invoke('set_settings_mode', { open });

  if (open) {
    await refreshAutostart();
  }
};

const getFaviconCandidates = (site) => {
  try {
    const url = new URL(site.url);
    const domain = url.hostname;

    return [
      `${url.origin}/favicon.ico`,
      `${url.origin}/favicon.svg`,
      `${url.origin}/favicon.png`,
      `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(site.url)}`,
      `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    ];
  } catch {
    return [];
  }
};

const firstLetter = (site) => {
  const name = site.name?.trim() || 'AI';
  return name.slice(0, 1).toUpperCase();
};

const loadFavicon = (site, image, fallback) => {
  const candidates = getFaviconCandidates(site);
  let index = 0;

  const showFallback = () => {
    image.hidden = true;
    fallback.hidden = false;
    fallback.textContent = firstLetter(site);
  };

  const tryNext = () => {
    if (index >= candidates.length) {
      showFallback();
      return;
    }

    image.onload = () => {
      image.hidden = false;
      fallback.hidden = true;
    };

    image.onerror = () => {
      index += 1;
      tryNext();
    };

    image.src = candidates[index++];
  };

  image.hidden = true;
  fallback.hidden = false;
  fallback.textContent = firstLetter(site);
  tryNext();
};

const setFavicon = (site) => {
  loadFavicon(
    site,
    $('siteIcon'),
    $('siteIconFallback'),
  );
};

const createSiteIcon = (site) => {
  const wrap = document.createElement('div');
  wrap.className = 'site-row-icon-wrap';

  const image = document.createElement('img');
  image.className = 'site-row-icon';
  image.alt = '';
  image.draggable = false;
  image.hidden = true;

  const fallback = document.createElement('span');
  fallback.className = 'site-row-icon-fallback';
  fallback.textContent = firstLetter(site);

  wrap.append(image, fallback);
  loadFavicon(site, image, fallback);

  return wrap;
};

const renderSites = () => {
  siteSelect.innerHTML = '';

  for (const site of settings.sites) {
    const option = document.createElement('option');
    option.value = site.id;
    option.textContent = site.name;
    siteSelect.appendChild(option);
  }

  siteSelect.value = settings.selected_site_id;

  const current =
    settings.sites.find((site) => site.id === settings.selected_site_id) ||
    settings.sites[0];

  if (current) {
    setFavicon(current);
  }

  siteList.innerHTML = '';

  for (const site of settings.sites) {
    const row = document.createElement('div');
    row.className = 'site-row';

    const identity = document.createElement('div');
    identity.className = 'site-row-identity';
    identity.appendChild(createSiteIcon(site));

    const text = document.createElement('div');
    text.className = 'site-row-text';

    const name = document.createElement('div');
    name.className = 'site-name';
    name.textContent = site.name;

    const url = document.createElement('div');
    url.className = 'site-url';
    url.textContent = site.url;

    text.append(name, url);
    identity.appendChild(text);

    const remove = document.createElement('button');
    remove.className = 'tiny-danger';
    remove.type = 'button';
    remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      if (settings.sites.length <= 1) {
        showMessage('至少保留一个 AI 网站', true);
        return;
      }

      try {
        settings = await invoke('remove_site', {
          id: site.id,
        });

        renderSites();
        showMessage(`已删除 ${site.name}`);
      } catch (error) {
        showMessage(String(error), true);
      }
    });

    row.append(identity, remove);
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

const startShortcutRecording = () => {
  shortcutRecording = true;
  shortcutInput.classList.add('recording');
  shortcutInput.value = '请按快捷键…';
  shortcutInput.focus();
};

shortcutInput.addEventListener('click', startShortcutRecording);
shortcutInput.addEventListener('focus', () => {
  if (!shortcutRecording) {
    startShortcutRecording();
  }
});

window.addEventListener('keydown', async (event) => {
  if (!settingsOpen || !shortcutRecording || event.repeat) {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();

    shortcutRecording = false;
    shortcutInput.classList.remove('recording');
    shortcutInput.value = settings.shortcut;
    return;
  }

  const shortcut = formatShortcutFromEvent(event);

  if (!shortcut) {
    event.preventDefault();
    event.stopPropagation();
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
  } finally {
    shortcutRecording = false;
    shortcutInput.classList.remove('recording');
    shortcutInput.blur();
  }
}, true);

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

minimizeButton.addEventListener('click', async () => {
  try {
    await invoke('minimize_window');
  } catch (error) {
    showMessage(String(error), true);
  }
});

closeButton.addEventListener('click', async () => {
  try {
    await invoke('hide_window');
  } catch (error) {
    showMessage(String(error), true);
  }
});

dragZone.addEventListener('mousedown', async (event) => {
  if (event.button !== 0) return;

  event.preventDefault();
  try {
    await currentWindow.startDragging();
  } catch (error) {
    console.error(error);
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

let toastTimer = null;
const showDownloadToast = (text, isError = false) => {
  downloadToast.textContent = text;
  downloadToast.classList.toggle('error', isError);
  downloadToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    downloadToast.classList.remove('show');
  }, 2200);
};

await listen('download-started', (event) => {
  showDownloadToast(`正在下载：${event.payload.name}`);
});

await listen('download-finished', (event) => {
  const message = event.payload.success
    ? `下载完成：${event.payload.name}`
    : `下载失败：${event.payload.name}`;
  showDownloadToast(message, !event.payload.success);
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
