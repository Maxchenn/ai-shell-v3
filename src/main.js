import './style.css';

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
  register,
  unregister,
} from '@tauri-apps/plugin-global-shortcut';

import {
  enable,
  disable,
  isEnabled,
} from '@tauri-apps/plugin-autostart';


const $ = (id) => document.getElementById(id);

const isSettingsPage =
  new URLSearchParams(window.location.search).get('view') === 'settings';


let settings = null;
let shortcutRegistered = null;
let messageTimer = null;


/* =========================
   通用工具
   ========================= */

const escapeHtml = (value) =>
  String(value).replace(
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


const getFaviconCandidates = (site) => {
  try {
    const url = new URL(site.url);
    const origin = url.origin;

    return [
      `${origin}/favicon.ico`,
      `${origin}/favicon.svg`,
      `${origin}/favicon.png`,
    ];
  } catch {
    return [];
  }
};


const setFavicon = (img, fallback, site) => {
  const candidates = getFaviconCandidates(site);

  let index = 0;

  img.hidden = false;
  fallback.hidden = true;

  const fallbackToText = () => {
    img.hidden = true;
    fallback.hidden = false;

    const name = site.name?.trim() || 'AI';

    fallback.textContent =
      name.length > 1
        ? name.slice(0, 1).toUpperCase()
        : name;
  };

  const tryNext = () => {
    if (index >= candidates.length) {
      fallbackToText();
      return;
    }

    const next = candidates[index++];

    img.onload = () => {
      img.hidden = false;
      fallback.hidden = true;
    };

    img.onerror = () => {
      tryNext();
    };

    img.src = next;
  };

  tryNext();
};


const showMessage = (element, text, isError = false) => {
  element.textContent = text;
  element.className =
    `settings-message${isError ? ' error' : ''}`;

  clearTimeout(messageTimer);

  messageTimer = setTimeout(() => {
    element.textContent = '';
    element.className = 'settings-message';
  }, 2600);
};


const formatShortcut = (shortcut) => {
  if (!shortcut) {
    return '未设置';
  }

  return shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' + ');
};


const buildShortcutFromEvent = (event) => {
  const modifierOnly = [
    'Control',
    'Alt',
    'Shift',
    'Meta',
  ];

  if (modifierOnly.includes(event.key)) {
    return null;
  }

  const parts = [];

  if (event.ctrlKey) {
    parts.push('Ctrl');
  }

  if (event.altKey) {
    parts.push('Alt');
  }

  if (event.shiftKey) {
    parts.push('Shift');
  }

  if (event.metaKey) {
    parts.push('Super');
  }

  const keyMap = {
    ' ': 'Space',
    Escape: 'Escape',
    Tab: 'Tab',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };

  let key = keyMap[event.key];

  if (!key) {
    if (/^F\d{1,2}$/.test(event.key)) {
      key = event.key;
    } else if (event.key.length === 1) {
      key = event.key.toUpperCase();
    } else {
      key = event.key;
    }
  }

  parts.push(key);

  return parts.join('+');
};


const registerGlobalShortcut = async (shortcut) => {
  const value = shortcut.trim();

  if (!value) {
    throw new Error('快捷键不能为空');
  }

  const old = shortcutRegistered;

  if (old === value) {
    return;
  }

  try {
    if (old) {
      await unregister(old);
    }

    await register(value, async (event) => {
      if (event.state === 'Pressed') {
        await invoke('toggle_visibility');
      }
    });

    shortcutRegistered = value;

    await invoke('set_shortcut', {
      shortcut: value,
    });
  } catch (error) {
    if (old) {
      try {
        await register(old, async (event) => {
          if (event.state === 'Pressed') {
            await invoke('toggle_visibility');
          }
        });

        shortcutRegistered = old;
      } catch {}
    }

    throw error;
  }
};


/* =========================
   主窗口
   ========================= */

const initMain = async () => {
  const siteSelect = $('siteSelect');
  const siteIcon = $('siteIcon');
  const siteIconFallback = $('siteIconFallback');

  const pinButton = $('pinButton');
  const settingsButton = $('settingsButton');
  const minimizeButton = $('minimizeButton');
  const closeButton = $('closeButton');

  settings = await invoke('get_settings');

  const renderSites = () => {
    siteSelect.innerHTML = '';

    for (const site of settings.sites) {
      const option = document.createElement('option');

      option.value = site.id;
      option.textContent = site.name;

      if (site.id === settings.selected_site_id) {
        option.selected = true;
      }

      siteSelect.appendChild(option);
    }

    const current =
      settings.sites.find(
        (site) => site.id === settings.selected_site_id,
      ) || settings.sites[0];

    if (current) {
      setFavicon(
        siteIcon,
        siteIconFallback,
        current,
      );
    }
  };


  const applyPinnedUi = () => {
    const pinned = Boolean(settings.pinned);

    pinButton.classList.toggle(
      'active',
      pinned,
    );

    pinButton.title = pinned
      ? '取消置顶'
      : '置顶';

    pinButton.setAttribute(
      'aria-label',
      pinned
        ? '取消置顶'
        : '置顶',
    );
  };


  siteSelect.addEventListener(
    'change',
    async () => {
      try {
        settings = await invoke(
          'select_site',
          {
            id: siteSelect.value,
          },
        );

        renderSites();
      } catch (error) {
        console.error(error);
      }
    },
  );


  pinButton.addEventListener(
    'click',
    async () => {
      try {
        settings = await invoke(
          'set_pinned',
          {
            pinned: !settings.pinned,
          },
        );

        applyPinnedUi();
      } catch (error) {
        console.error(error);
      }
    },
  );


  settingsButton.addEventListener(
    'click',
    async () => {
      try {
        await invoke('open_settings_window');
      } catch (error) {
        console.error(error);
      }
    },
  );


  minimizeButton.addEventListener(
    'click',
    async () => {
      try {
        await invoke('minimize_window');
      } catch (error) {
        console.error(error);
      }
    },
  );


  closeButton.addEventListener(
    'click',
    async () => {
      try {
        await invoke('hide_window');
      } catch (error) {
        console.error(error);
      }
    },
  );


  window.addEventListener(
    'keydown',
    async (event) => {
      if (event.repeat) {
        return;
      }

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
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)
      ) {
        return;
      }

      event.preventDefault();

      try {
        await invoke(
          'toggle_fullscreen_command',
        );
      } catch (error) {
        console.error(error);
      }
    },
  );


  shortcutRegistered = null;

  try {
    await registerGlobalShortcut(
      settings.shortcut,
    );
  } catch (error) {
    console.error(
      '无法注册快捷键:',
      error,
    );
  }

  renderSites();
  applyPinnedUi();
};


/* =========================
   设置窗口
   ========================= */

const initSettings = async () => {
  const settingsView = $('settingsView');
  const mainView = $('mainView');

  mainView.classList.add('hidden');
  settingsView.classList.remove('hidden');

  const siteList = $('siteSettingsList');
  const newSiteName = $('newSiteName');
  const newSiteUrl = $('newSiteUrl');
  const addSiteButton = $('addSiteButton');

  const shortcutRecorder =
    $('shortcutRecorder');

  const autostartToggle =
    $('autostartToggle');

  const closeButton =
    $('settingsCloseButton');

  const settingsMessage =
    $('settingsMessage');

  const currentWindow =
    getCurrentWindow();

  settings =
    await invoke('get_settings');


  const renderSiteCards = () => {
    siteList.innerHTML = '';

    for (const site of settings.sites) {
      const card =
        document.createElement('article');

      card.className = 'site-card';

      const header =
        document.createElement('div');

      header.className =
        'site-card-header';

      const title =
        document.createElement('div');

      title.className =
        'site-card-title';

      const icon =
        document.createElement('div');

      icon.className =
        'site-card-icon';

      const img =
        document.createElement('img');

      const fallback =
        document.createElement('span');

      setFavicon(
        img,
        fallback,
        site,
      );

      icon.appendChild(img);
      icon.appendChild(fallback);

      const titleText =
        document.createElement('div');

      titleText.className =
        'site-card-name';

      titleText.textContent =
        site.name;

      if (site.builtin) {
        const badge =
          document.createElement('span');

        badge.className =
          'site-badge';

        badge.textContent =
          '内置';

        titleText.appendChild(badge);
      }

      title.appendChild(icon);
      title.appendChild(titleText);

      header.appendChild(title);


      const fieldGrid =
        document.createElement('div');

      fieldGrid.className =
        'field-grid';


      const nameField =
        document.createElement('label');

      nameField.className =
        'field';

      const nameLabel =
        document.createElement('span');

      nameLabel.textContent =
        '名称';

      const nameInput =
        document.createElement('input');

      nameInput.type = 'text';
      nameInput.maxLength = 40;
      nameInput.value = site.name;

      nameField.appendChild(nameLabel);
      nameField.appendChild(nameInput);


      const urlField =
        document.createElement('label');

      urlField.className =
        'field';

      const urlLabel =
        document.createElement('span');

      urlLabel.textContent =
        '网址';

      const urlInput =
        document.createElement('input');

      urlInput.type = 'text';
      urlInput.value = site.url;

      urlField.appendChild(urlLabel);
      urlField.appendChild(urlInput);

      fieldGrid.appendChild(nameField);
      fieldGrid.appendChild(urlField);


      const actions =
        document.createElement('div');

      actions.className =
        'site-card-actions';


      const useButton =
        document.createElement('button');

      useButton.type = 'button';
      useButton.className =
        'secondary-button';

      useButton.textContent =
        site.id === settings.selected_site_id
          ? '正在使用'
          : '使用';


      const saveButton =
        document.createElement('button');

      saveButton.type = 'button';
      saveButton.className =
        'primary-button';

      saveButton.textContent =
        '保存';


      actions.appendChild(useButton);
      actions.appendChild(saveButton);


      if (!site.builtin) {
        const deleteButton =
          document.createElement('button');

        deleteButton.type = 'button';
        deleteButton.className =
          'danger-button';

        deleteButton.textContent =
          '删除';

        actions.appendChild(
          deleteButton,
        );


        deleteButton.addEventListener(
          'click',
          async () => {
            if (
              !window.confirm(
                `确定删除「${site.name}」吗？`,
              )
            ) {
              return;
            }

            try {
              settings =
                await invoke(
                  'remove_site',
                  {
                    id: site.id,
                  },
                );

              renderSiteCards();
              showMessage(
                settingsMessage,
                '已删除',
              );
            } catch (error) {
              showMessage(
                settingsMessage,
                String(error),
                true,
              );
            }
          },
        );
      }


      saveButton.addEventListener(
        'click',
        async () => {
          try {
            const name =
              nameInput.value.trim();

            const url =
              normalizeUrl(
                urlInput.value,
              );

            if (!name) {
              throw new Error(
                '名称不能为空',
              );
            }

            settings =
              await invoke(
                'update_site',
                {
                  id: site.id,
                  name,
                  url,
                },
              );

            renderSiteCards();

            showMessage(
              settingsMessage,
              '已保存',
            );
          } catch (error) {
            showMessage(
              settingsMessage,
              String(error),
              true,
            );
          }
        },
      );


      useButton.addEventListener(
        'click',
        async () => {
          try {
            settings =
              await invoke(
                'select_site',
                {
                  id: site.id,
                },
              );

            showMessage(
              settingsMessage,
              `已切换到 ${site.name}`,
            );

            setTimeout(
              () =>
                currentWindow.close(),
              180,
            );
          } catch (error) {
            showMessage(
              settingsMessage,
              String(error),
              true,
            );
          }
        },
      );


      card.appendChild(header);
      card.appendChild(fieldGrid);
      card.appendChild(actions);

      siteList.appendChild(card);
    }
  };


  addSiteButton.addEventListener(
    'click',
    async () => {
      try {
        const name =
          newSiteName.value.trim();

        const url =
          normalizeUrl(
            newSiteUrl.value,
          );

        if (!name) {
          throw new Error(
            '请填写网站名称',
          );
        }

        settings =
          await invoke(
            'add_site',
            {
              name,
              url,
            },
          );

        newSiteName.value = '';
        newSiteUrl.value = '';

        renderSiteCards();

        showMessage(
          settingsMessage,
          'AI 已添加',
        );
      } catch (error) {
        showMessage(
          settingsMessage,
          String(error),
          true,
        );
      }
    },
  );


  const refreshAutostart =
    async () => {
      try {
        autostartToggle.checked =
          await isEnabled();
      } catch {
        autostartToggle.checked =
          Boolean(settings.autostart);
      }
    };


  autostartToggle.addEventListener(
    'change',
    async () => {
      const enabled =
        autostartToggle.checked;

      try {
        if (enabled) {
          await enable();
        } else {
          await disable();
        }

        settings =
          await invoke(
            'set_autostart',
            {
              enabled,
            },
          );

        showMessage(
          settingsMessage,
          enabled
            ? '已启用开机启动'
            : '已关闭开机启动',
        );
      } catch (error) {
        autostartToggle.checked =
          !enabled;

        showMessage(
          settingsMessage,
          String(error),
          true,
        );
      }
    },
  );


  shortcutRegistered =
    settings.shortcut;

  shortcutRecorder.textContent =
    formatShortcut(
      settings.shortcut,
    );


  shortcutRecorder.addEventListener(
    'click',
    () => {
      shortcutRecorder.dataset.recording =
        'true';

      shortcutRecorder.textContent =
        '请按下快捷键…';

      shortcutRecorder.focus();
    },
  );


  shortcutRecorder.addEventListener(
    'keydown',
    async (event) => {
      event.preventDefault();

      if (event.key === 'Escape') {
        shortcutRecorder.dataset.recording =
          'false';

        shortcutRecorder.textContent =
          formatShortcut(
            settings.shortcut,
          );

        shortcutRecorder.blur();

        return;
      }

      const shortcut =
        buildShortcutFromEvent(
          event,
        );

      if (!shortcut) {
        return;
      }

      try {
        await registerGlobalShortcut(
          shortcut,
        );

        settings.shortcut =
          shortcut;

        shortcutRecorder.dataset.recording =
          'false';

        shortcutRecorder.textContent =
          formatShortcut(
            shortcut,
          );

        shortcutRecorder.blur();

        showMessage(
          settingsMessage,
          '快捷键已更新',
        );
      } catch (error) {
        shortcutRecorder.dataset.recording =
          'false';

        shortcutRecorder.textContent =
          formatShortcut(
            settings.shortcut,
          );

        shortcutRecorder.blur();

        showMessage(
          settingsMessage,
          String(error),
          true,
        );
      }
    },
  );


  closeButton.addEventListener(
    'click',
    () => currentWindow.close(),
  );


  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        currentWindow.close();
      }
    },
  );


  renderSiteCards();

  await refreshAutostart();
};


if (isSettingsPage) {
  await initSettings();
} else {
  await initMain();
}