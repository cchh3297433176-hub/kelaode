import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { API } from './api.js';
import { effectiveWorldbookNames, writeBookControl } from './worldbook-chat.js';
import { getBoundWorldbooks, synchronize } from './worldbook-regex.js';
import { openWorldbookSnapshots } from './worldbook-snapshots.js';
import { mountWorldbookBall } from './worldbook-ball.js';

const SETTINGS_KEY = 'kelaode_worldbook_quick';
const IMAGE_STORE = 'images';
let widget;
let refreshBallPosition;
let asset;
let imageUrl;
let imageRevision = 0;
let menuRevision = 0;

function settings() {
    const saved = extension_settings[SETTINGS_KEY];
    return {
        visible: saved?.visible !== false,
        size: Number.isFinite(saved?.size) ? Math.min(80, Math.max(44, saved.size)) : 52,
        pins: Array.isArray(saved?.pins) ? [...new Set(saved.pins.filter(name => typeof name === 'string'))] : [],
    };
}

function updateSettings(patch) {
    extension_settings[SETTINGS_KEY] = { ...settings(), ...patch };
    getContext().saveSettingsDebounced();
    refreshAppearance();
}

export function worldbookQuickSummary() {
    const { visible, size } = settings();
    return visible ? `开启 · ${size} px` : '关闭';
}

async function imageTransaction(mode, operation) {
    const database = await new Promise((resolve, reject) => {
        const open = indexedDB.open('kelaode-worldbook-quick', 1);
        open.onupgradeneeded = () => open.result.createObjectStore(IMAGE_STORE);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(IMAGE_STORE, mode);
            const request = operation(transaction.objectStore(IMAGE_STORE));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error);
        });
    } finally {
        database.close();
    }
}

function setImage(next) {
    const previous = imageUrl;
    asset = next;
    imageUrl = asset?.blob ? URL.createObjectURL(asset.blob) : undefined;
    refreshAppearance();
    if (previous) URL.revokeObjectURL(previous);
}

function refreshAppearance() {
    const { visible, size } = settings();
    if (widget) {
        widget.hidden = !visible || !getContext().chatId;
        if (widget.hidden) closeMenu();
        widget.style.setProperty('--wb-quick-size', `${size}px`);
        refreshBallPosition?.();
    }
    const summary = document.getElementById('wb-quick-settings-state');
    if (summary) summary.textContent = worldbookQuickSummary();
    const dialog = document.querySelector('.wb-quick-settings[open]');
    if (dialog) {
        dialog.style.setProperty('--wb-quick-size', `${size}px`);
        dialog.querySelector('[data-size-value]').textContent = `${size} px`;
        dialog.querySelector('[data-image-name]').textContent = asset?.name || 'PNG、GIF、JPG、WebP 等';
        dialog.querySelector('[data-reset-image]').hidden = !asset;
    }
    for (const surface of [widget, dialog]) {
        if (!surface) continue;
        const image = surface.querySelector('[data-ball-image]');
        image.hidden = !imageUrl;
        if (imageUrl && image.getAttribute('src') !== imageUrl) image.src = imageUrl;
        if (!imageUrl) image.removeAttribute('src');
        surface.querySelector('[data-ball-default]').hidden = Boolean(imageUrl);
    }
}

function closeMenu() {
    if (!widget) return;
    menuRevision++;
    widget.querySelector('[data-quick-menu]').hidden = true;
    widget.querySelector('[data-ball]').setAttribute('aria-expanded', 'false');
}

async function renderMenu() {
    const menu = widget.querySelector('[data-quick-menu]');
    if (menu.hidden) return;
    const revision = ++menuRevision;
    const context = getContext();
    const [bound, available] = await Promise.all([getBoundWorldbooks(), API.getAllBookNames()]);
    if (revision !== menuRevision || context.chatId !== getContext().chatId) return;
    const pins = settings().pins.filter(name => available.includes(name));
    const effective = new Set(effectiveWorldbookNames(bound, context.chatMetadata, available));
    const list = menu.querySelector('[data-quick-list]');
    list.replaceChildren();
    if (!pins.length) {
        list.textContent = '在设置中添加常用世界书';
        return;
    }
    for (const name of pins) {
        const row = document.createElement('div');
        row.className = 'wb-quick-row';
        const label = document.createElement('label');
        const title = document.createElement('span');
        title.textContent = name;
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'wb-feature-switch';
        toggle.setAttribute('role', 'switch');
        toggle.checked = effective.has(name);
        toggle.onchange = async () => {
            const enabled = toggle.checked;
            try {
                writeBookControl(getContext(), context.chatId, name, { enabled: bound.includes(name) === enabled ? undefined : enabled });
            } catch (error) {
                toggle.checked = !enabled;
                toastr.error(error.message, '世界书');
                return;
            }
            await synchronize().catch(error => toastr.error(error.message, '世界书正则'));
        };
        label.append(title, toggle);
        const snapshots = document.createElement('button');
        snapshots.type = 'button';
        snapshots.className = 'menu_button wb-quick-icon';
        snapshots.setAttribute('aria-label', `${name}的条目快照`);
        snapshots.title = '条目快照';
        snapshots.innerHTML = '<i class="fa-solid fa-layer-group" aria-hidden="true"></i>';
        snapshots.onclick = () => {
            closeMenu();
            openWorldbookSnapshots(name).catch(error => toastr.error(error.message, '条目快照'));
        };
        row.append(label, snapshots);
        list.append(row);
    }
}

export function initWorldbookQuick() {
    const shell = document.getElementById('sheld');
    const composer = document.getElementById('form_sheld');
    if (widget || !shell || !composer) return;
    widget = document.createElement('div');
    widget.className = 'wb-quick-widget';
    widget.innerHTML = `
        <div id="wb-quick-menu" class="wb-quick-popover" data-quick-menu hidden>
            <div class="wb-quick-head">
                <div><strong>世界书</strong><small>仅当前聊天</small></div>
                <button type="button" class="menu_button wb-quick-icon" data-settings aria-label="悬浮球设置" title="悬浮球设置"><i class="fa-solid fa-gear" aria-hidden="true"></i></button>
            </div>
            <div class="wb-quick-list" data-quick-list></div>
        </div>
        <button type="button" class="wb-quick-ball" data-ball aria-label="世界书悬浮球" aria-controls="wb-quick-menu" aria-expanded="false">
            <i class="fa-solid fa-book-open" data-ball-default aria-hidden="true"></i>
            <img alt="" draggable="false" data-ball-image hidden>
        </button>`;
    const ball = widget.querySelector('[data-ball]');
    const menu = widget.querySelector('[data-quick-menu]');
    ball.onclick = () => {
        if (!menu.hidden) return closeMenu();
        menu.hidden = false;
        ball.setAttribute('aria-expanded', 'true');
        renderMenu().catch(error => toastr.error(error.message, '世界书'));
    };
    widget.querySelector('[data-settings]').onclick = () => {
        closeMenu();
        openWorldbookQuickSettings().catch(error => toastr.error(error.message, '悬浮球设置'));
    };
    shell.append(widget);
    refreshBallPosition = mountWorldbookBall({ widget, ball, menu, shell, composer, closeMenu });
    document.addEventListener('pointerdown', event => { if (!widget.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) {
            closeMenu();
            ball.focus();
        }
    });
    for (const name of ['CHAT_CHANGED', 'CHARACTER_SELECTED']) {
        if (event_types[name]) eventSource.on(event_types[name], () => { closeMenu(); refreshAppearance(); });
    }
    if (event_types.WORLDINFO_SETTINGS_UPDATED) eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => {
        renderMenu().catch(error => toastr.error(error.message, '世界书'));
    });
    refreshAppearance();
    const revision = imageRevision;
    imageTransaction('readonly', store => store.get('ball')).then(next => {
        if (next?.blob && revision === imageRevision) setImage(next);
    }).catch(error => console.warn('[世界书管理器] 无法读取悬浮球图片', error));
}

export async function openWorldbookQuickSettings() {
    if (document.querySelector('.wb-quick-settings[open]')) return;
    const names = await API.getAllBookNames();
    if (document.querySelector('.wb-quick-settings[open]')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'wbr-dialog wbr-picker wb-feature-dialog wb-quick-settings';
    dialog.setAttribute('aria-labelledby', 'wb-quick-settings-title');
    dialog.innerHTML = `
        <div class="wbr-toolbar">
            <strong id="wb-quick-settings-title">悬浮球设置</strong>
            <button type="button" class="menu_button" data-close>完成</button>
        </div>
        <label class="wb-feature-line">显示悬浮球<input type="checkbox" class="wb-feature-switch" role="switch" data-visible></label>
        <div class="wb-quick-image">
            <span class="wb-quick-ball" aria-hidden="true"><i class="fa-solid fa-book-open" data-ball-default></i><img alt="" data-ball-image hidden></span>
            <div>
                <button type="button" class="menu_button" data-choose>导入图片</button>
                <small data-image-name></small>
                <button type="button" class="menu_button" data-reset-image hidden>恢复默认图标</button>
            </div>
            <input type="file" accept="image/*,.apng,.avif,.ico" data-file hidden>
        </div>
        <p class="wb-feature-status" data-image-error role="alert" hidden></p>
        <label class="wb-feature-line" for="wb-quick-size">悬浮球大小<output data-size-value for="wb-quick-size"></output></label>
        <input type="range" id="wb-quick-size" min="44" max="80" step="2" data-size>
        <strong>快捷世界书</strong>
        <input type="search" data-search aria-label="搜索世界书" placeholder="搜索世界书">
        <div class="wbr-picker-list wb-feature-list" data-pins></div>`;
    const find = key => dialog.querySelector(`[data-${key}]`);
    const visible = find('visible');
    const size = find('size');
    const file = find('file');
    const choose = find('choose');
    const reset = find('reset-image');
    const error = find('image-error');
    const close = find('close');
    const search = find('search');
    const pins = find('pins');
    let busy = false;
    const current = settings();
    visible.checked = current.visible;
    size.value = String(current.size);
    visible.onchange = () => updateSettings({ visible: visible.checked });
    size.oninput = () => updateSettings({ size: size.valueAsNumber });
    choose.onclick = () => file.click();
    async function changeImage(next) {
        if (busy) return;
        busy = choose.disabled = reset.disabled = close.disabled = true;
        error.hidden = true;
        try {
            if (next) {
                const previewUrl = URL.createObjectURL(next.blob);
                try {
                    const preview = new Image();
                    preview.src = previewUrl;
                    await preview.decode();
                } catch {
                    throw new Error('浏览器无法读取这张图片，可试试 PNG 或 GIF');
                } finally {
                    URL.revokeObjectURL(previewUrl);
                }
            }
            await imageTransaction('readwrite', store => next ? store.put(next, 'ball') : store.delete('ball'));
            imageRevision++;
            setImage(next);
        } catch (failure) {
            error.textContent = failure.message || '无法保存图片';
            error.hidden = false;
        } finally {
            busy = choose.disabled = reset.disabled = close.disabled = false;
        }
    }
    file.onchange = () => {
        const image = file.files[0];
        if (image) void changeImage({ blob: image, name: image.name });
        file.value = '';
    };
    reset.onclick = () => void changeImage(undefined);
    const sorted = [...names].sort((left, right) => Number(current.pins.includes(right)) - Number(current.pins.includes(left)));
    function renderPins() {
        const term = search.value.trim().toLocaleLowerCase();
        const pinned = new Set(settings().pins);
        pins.replaceChildren();
        for (const name of sorted) {
            if (term && !name.toLocaleLowerCase().includes(term)) continue;
            const row = document.createElement('label');
            row.className = 'wbr-check wb-feature-row';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = pinned.has(name);
            input.onchange = () => {
                const next = new Set(settings().pins);
                if (input.checked) next.add(name);
                else next.delete(name);
                updateSettings({ pins: [...next] });
            };
            row.append(input, document.createTextNode(name));
            pins.append(row);
        }
        if (!pins.childElementCount) pins.textContent = '没有匹配的世界书';
    }
    search.oninput = renderPins;
    close.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    renderPins();
    document.body.append(dialog);
    dialog.showModal();
    refreshAppearance();
}
