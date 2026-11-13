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
let redrawMenu;

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
    redrawMenu = undefined;
    widget.querySelector('[data-quick-menu]').hidden = true;
    widget.querySelector('[data-ball]').setAttribute('aria-expanded', 'false');
}

function createSwitch(label, checked, onChange) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wb-quick-switch';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', label);
    button.innerHTML = '<span class="wb-quick-switch-track" aria-hidden="true"><span class="wb-quick-switch-thumb"></span><span class="wb-quick-switch-state"></span></span>';
    const state = button.querySelector('.wb-quick-switch-state');
    const paint = () => {
        button.setAttribute('aria-checked', String(checked));
        state.textContent = checked ? '开' : '关';
    };
    paint();
    button.onclick = () => {
        if (onChange(!checked) === false) return;
        checked = !checked;
        paint();
    };
    return button;
}

function createBookFilters(onChange) {
    const element = document.createElement('div');
    element.className = 'wb-quick-filters';
    element.innerHTML = `
        <select aria-label="按标签筛选"></select>
        <button type="button" aria-pressed="false">显示主书</button>`;
    const [select, primaryButton] = element.children;
    let tag = '';
    let showPrimary = false;
    let books = [];

    select.onchange = () => {
        tag = select.value;
        onChange();
    };
    primaryButton.onclick = () => {
        showPrimary = !showPrimary;
        primaryButton.setAttribute('aria-pressed', String(showPrimary));
        onChange();
    };

    return {
        element,
        reset() {
            tag = select.value = '';
            showPrimary = false;
            primaryButton.setAttribute('aria-pressed', 'false');
        },
        update(names, bindings, currentPrimary) {
            const metadata = API.getMetadata();
            books = names.map(name => ({
                name,
                tags: Array.isArray(metadata[name]?.tags) ? metadata[name].tags.filter(value => typeof value === 'string' && value) : [],
                primary: name === currentPrimary || Boolean(bindings[name]?.primary?.length),
            }));
            const tags = [...new Set(books.flatMap(book => book.tags))].sort((a, b) => a.localeCompare(b));
            if (!tags.includes(tag)) tag = '';
            select.replaceChildren(new Option('全部标签', ''), ...tags.map(value => new Option(value, value)));
            select.value = tag;
            select.hidden = !tags.length;
            primaryButton.hidden = !books.some(book => book.primary);
            element.hidden = select.hidden && primaryButton.hidden;
        },
        visibleNames() {
            return books.filter(book => (showPrimary || !book.primary) && (!tag || book.tags.includes(tag)))
                .map(book => book.name);
        },
    };
}

async function renderMenu(filters) {
    const menu = widget.querySelector('[data-quick-menu]');
    if (menu.hidden) return;
    const revision = ++menuRevision;
    const { chatId } = getContext();
    const pinned = settings().pins;
    const [bound, available, bindings, character] = await Promise.all([
        getBoundWorldbooks(), API.getAllBookNames(), pinned.length ? API.getAllBoundBookNames() : {}, API.getCharBindings(),
    ]);
    const context = getContext();
    if (revision !== menuRevision || chatId !== context.chatId) return;
    const pins = pinned.filter(name => available.includes(name));
    const effective = new Set(effectiveWorldbookNames(bound, context.chatMetadata, available));
    filters.update(pins, bindings, character.primary);
    const list = menu.querySelector('[data-quick-list]');
    redrawMenu = () => renderBookRows(list, filters.visibleNames(), pins.length, effective, bound, chatId);
    redrawMenu();
}

function renderBookRows(list, names, pinCount, effective, bound, chatId) {
    list.replaceChildren();
    if (!names.length) {
        list.textContent = pinCount ? '没有符合筛选条件的快捷世界书' : '在设置中添加常用世界书';
        return;
    }
    for (const name of names) {
        const row = document.createElement('div');
        row.className = 'wb-quick-row';
        const title = document.createElement('span');
        title.className = 'wb-quick-name';
        title.textContent = name;
        const toggle = createSwitch(name, effective.has(name), enabled => {
            try {
                writeBookControl(getContext(), chatId, name, { enabled: bound.includes(name) === enabled ? undefined : enabled });
            } catch (error) {
                toastr.error(error.message, '世界书');
                return false;
            }
            if (enabled) effective.add(name);
            else effective.delete(name);
            synchronize().catch(error => toastr.error(error.message, '世界书正则'));
        });
        const snapshots = document.createElement('button');
        snapshots.type = 'button';
        snapshots.className = 'wb-quick-icon';
        snapshots.setAttribute('aria-label', `${name}的条目快照`);
        snapshots.title = '条目快照';
        snapshots.innerHTML = '<i class="fa-solid fa-layer-group" aria-hidden="true"></i>';
        snapshots.onclick = () => {
            closeMenu();
            openWorldbookSnapshots(name).catch(error => toastr.error(error.message, '条目快照'));
        };
        row.append(title, toggle, snapshots);
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
                <button type="button" class="wb-quick-icon" data-settings aria-label="悬浮球设置" title="悬浮球设置"><i class="fa-solid fa-gear" aria-hidden="true"></i></button>
            </div>
            <div class="wb-quick-list" data-quick-list></div>
        </div>
        <button type="button" class="wb-quick-ball" data-ball aria-label="世界书悬浮球" aria-controls="wb-quick-menu" aria-expanded="false">
            <i class="fa-solid fa-book-open" data-ball-default aria-hidden="true"></i>
            <img alt="" draggable="false" data-ball-image hidden>
        </button>`;
    const ball = widget.querySelector('[data-ball]');
    const menu = widget.querySelector('[data-quick-menu]');
    const filters = createBookFilters(() => redrawMenu?.());
    menu.querySelector('[data-quick-list]').before(filters.element);
    const refreshMenu = () => renderMenu(filters).catch(error => {
        if (!menu.hidden && !redrawMenu) menu.querySelector('[data-quick-list]').textContent = '无法读取快捷世界书';
        toastr.error(error.message, '世界书');
    });
    ball.onclick = () => {
        if (!menu.hidden) return closeMenu();
        filters.reset();
        filters.element.hidden = true;
        menu.querySelector('[data-quick-list]').textContent = '正在读取…';
        menu.hidden = false;
        ball.setAttribute('aria-expanded', 'true');
        refreshMenu();
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
    if (event_types.WORLDINFO_SETTINGS_UPDATED) eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, refreshMenu);
    refreshAppearance();
    const revision = imageRevision;
    imageTransaction('readonly', store => store.get('ball')).then(next => {
        if (next?.blob && revision === imageRevision) setImage(next);
    }).catch(error => console.warn('[世界书管理器] 无法读取悬浮球图片', error));
}

export async function openWorldbookQuickSettings() {
    if (document.querySelector('.wb-quick-settings[open]')) return;
    const [names, bindings, character] = await Promise.all([
        API.getAllBookNames(), API.getAllBoundBookNames(), API.getCharBindings(),
    ]);
    if (document.querySelector('.wb-quick-settings[open]')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'wbr-dialog wbr-picker wb-feature-dialog wb-quick-settings';
    dialog.setAttribute('aria-labelledby', 'wb-quick-settings-title');
    dialog.innerHTML = `
        <div class="wbr-toolbar">
            <strong id="wb-quick-settings-title">悬浮球设置</strong>
            <button type="button" class="menu_button" data-close>完成</button>
        </div>
        <div class="wb-feature-line" data-visible>显示悬浮球</div>
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
    visible.append(createSwitch('显示悬浮球', current.visible, value => updateSettings({ visible: value })));
    size.value = String(current.size);
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
    const filters = createBookFilters(renderPins);
    filters.update(sorted, bindings, character.primary);
    pins.before(filters.element);
    function renderPins() {
        const term = search.value.trim().toLocaleLowerCase();
        const pinned = new Set(settings().pins);
        pins.replaceChildren();
        for (const name of filters.visibleNames()) {
            if (term && !name.toLocaleLowerCase().includes(term)) continue;
            const row = document.createElement('div');
            row.className = 'wbr-check wb-feature-row';
            const toggle = createSwitch(name, pinned.has(name), enabled => {
                const next = new Set(settings().pins);
                if (enabled) next.add(name);
                else next.delete(name);
                updateSettings({ pins: [...next] });
            });
            const title = document.createElement('span');
            title.className = 'wb-quick-name';
            title.textContent = name;
            row.append(title, toggle);
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
