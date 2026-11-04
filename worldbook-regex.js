import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, updateMessageBlock } from '../../../../script.js';
import { worldInfoCache } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { SCRIPT_TYPES, getScriptsByType, saveScriptsByType, getCurrentPresetAPI, getCurrentPresetName } from '../../regex/engine.js';
import { API } from './api.js';
import { STATE } from './state.js';
import { readBundle, writeBundle, normalizeRegex, parseRegexImport, isManaged, runtimeCopies, replaceManaged, createRegexId } from './worldbook-regex-core.js';

let revision = 0;
let timer;
const ENABLED_KEY = 'kelaode_worldbook_regex_enabled';
let initialized = false;
let groups = new Map();
let observer;
let renderPending = false;
let nativeSignature = '';
let appliedSignature = '';
let chatNeedsRender = true;
const expandedBooks = new Set();

function report(error) {
    console.error('[世界书正则]', error);
    toastr.error(error.message, '世界书正则');
}

async function activeBooks() {
    const [global, character, chat] = await Promise.all([API.getGlobalBindings(), API.getCharBindings(), API.getChatBinding()]);
    return [...new Set([...global, character.primary, ...character.additional, chat, power_user.persona_description_lorebook].filter(Boolean))];
}

function clearCopies() {
    extension_settings.regex = replaceManaged(extension_settings.regex || [], []);
    groups = new Map();
    queuePanel();
}

export async function synchronize() {
    const token = ++revision;
    // Clear synchronously: a slow previous-chat read must never leak into a new chat.
    clearCopies();
    const names = extension_settings[ENABLED_KEY] === false ? [] : await activeBooks();
    const next = new Map();
    const copies = [];
    for (const name of names) {
        const book = await getContext().loadWorldInfo(name);
        if (!book) throw new Error(`无法读取世界书「${name}」`);
        const scripts = readBundle(book);
        if (scripts.length) {
            next.set(name, scripts);
            copies.push(...runtimeCopies(name, scripts));
        }
    }
    if (token !== revision) return;
    // Preserve edits by other plugins that occurred while the books were loading.
    extension_settings.regex = replaceManaged(extension_settings.regex || [], copies);
    groups = next;
    queuePanel();
    const signature = JSON.stringify(copies);
    if (chatNeedsRender || signature !== appliedSignature) {
        chatNeedsRender = false;
        appliedSignature = signature;
        const chat = getContext().chat || [];
        // Reformat visible messages without reloading the chat or changing saved text.
        for (const row of document.querySelectorAll('#chat .mes[mesid]')) {
            const index = Number(row.getAttribute('mesid'));
            if (chat[index] && !row.querySelector('.edit_textarea')) updateMessageBlock(index, chat[index]);
        }
    }
}

export function requestRegexSync() {
    ++revision;
    clearCopies();
    clearTimeout(timer);
    timer = setTimeout(() => synchronize().catch(report), 60);
}

function element(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
}
function button(text, action) {
    const node = element('button', text, 'menu_button');
    node.type = 'button';
    node.onclick = () => Promise.resolve().then(action).catch(report);
    return node;
}

function queuePanel() {
    if (renderPending) return;
    renderPending = true;
    queueMicrotask(() => { renderPending = false; renderNativePanel(); });
}

function renderNativePanel() {
    const container = document.getElementById('regex_container');
    if (!container) return;
    const drawer = container.querySelector('.regex_settings > .inline-drawer > .inline-drawer-content')
        || document.getElementById('saved_regex_scripts')?.closest('.inline-drawer-content');
    if (!drawer) return;
    // Keep original rows in place so native sortable indexes are not changed.
    const saved = document.getElementById('saved_regex_scripts');
    if (saved) for (const row of saved.children) {
        if (row.id?.startsWith('kelaode-wbr:')) row.classList.add('wbr-managed-row');
    }
    let panel = document.getElementById('wbr-native-panel');
    const signature = JSON.stringify([extension_settings[ENABLED_KEY] !== false, [...groups]]);
    if (panel && panel.parentElement !== drawer) drawer.append(panel);
    if (panel && signature === nativeSignature) return;
    nativeSignature = signature;
    if (!panel) {
        panel = element('details', undefined, 'wbr-native');
        panel.id = 'wbr-native-panel';
        drawer.append(panel);
    }
    panel.replaceChildren(element('summary', '世界书正则'));
    const enabledLabel = element('label', undefined, 'wbr-check');
    const enabled = element('input');
    enabled.type = 'checkbox'; enabled.checked = extension_settings[ENABLED_KEY] !== false;
    enabled.onchange = async () => {
        enabled.disabled = true;
        extension_settings[ENABLED_KEY] = enabled.checked;
        try { await synchronize(); getContext().saveSettingsDebounced(); }
        catch (error) { report(error); }
        finally { enabled.disabled = false; }
    };
    enabledLabel.append(enabled, document.createTextNode('启用联动'));
    panel.append(enabledLabel);
    if (!groups.size) panel.append(element('div', '当前没有启用的配套正则', 'wbr-empty'));
    for (const [name, scripts] of groups) {
        const group = element('details', undefined, 'wbr-book-group');
        group.open = expandedBooks.has(name);
        group.ontoggle = () => { if (group.isConnected) { if (group.open) expandedBooks.add(name); else expandedBooks.delete(name); } };
        const summary = element('summary', `${name} · ${scripts.length}`);
        group.append(summary);
        for (const script of scripts) {
            const row = element('div', undefined, 'wbr-rule');
            const label = element('label');
            const toggle = element('input');
            toggle.type = 'checkbox';
            toggle.checked = !script.disabled;
            toggle.onchange = async () => {
                toggle.disabled = true;
                try {
                    await mutateBook(name, rules => rules.map(rule => rule.id === script.id ? { ...rule, disabled: !toggle.checked } : rule));
                } catch (error) { toggle.checked = !toggle.checked; report(error); }
                finally { toggle.disabled = false; }
            };
            label.append(toggle, document.createTextNode(script.scriptName));
            row.append(label, button('编辑', () => openManager(name, script.id)));
            group.append(row);
        }
        panel.append(group);
    }
}

// Serialize writes to avoid one checkbox/edit replacing another in flight.
let writes = Promise.resolve();
function queueWrite(operation) {
    const work = writes.catch(() => {}).then(operation);
    writes = work;
    return work;
}

export async function saveBookChecked(name, data) {
    const response = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ name, data }),
    });
    if (!response.ok) throw new Error(`保存世界书失败（HTTP ${response.status}）`);
    worldInfoCache.set(name, data);
    try {
        await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
    } catch (error) {
        console.warn('[世界书正则] 已保存，更新通知失败', error);
    }
}

export function updateBook(name, update) {
    return queueWrite(async () => {
        const book = await getContext().loadWorldInfo(name);
        if (!book) throw new Error('世界书不存在');
        await saveBookChecked(name, update(book));
        await synchronize().catch(report);
    });
}

function mutateBook(name, update) {
    return updateBook(name, book => writeBundle(book, update(readBundle(book))));
}

function dialog(title) {
    const node = element('dialog', undefined, 'wbr-dialog');
    const header = element('div', undefined, 'wbr-toolbar');
    header.append(element('strong', title), button('关闭', () => node.close()));
    node.append(header);
    document.body.append(node);
    node.addEventListener('close', () => node.remove(), { once: true });
    node.showModal();
    return node;
}

async function editRule(name, original) {
    const rule = original || normalizeRegex({ scriptName: '新建正则', findRegex: '/待匹配内容/g', placement: [2], markdownOnly: true });
    const modal = dialog(rule.scriptName);
    const form = element('form', undefined, 'wbr-form');
    const fields = {};
    for (const [key, label, multiline] of [['scriptName', '名称'], ['findRegex', '查找表达式'], ['replaceString', '替换内容', true]]) {
        const wrap = element('label', label);
        const input = element(multiline ? 'textarea' : 'input');
        input.value = rule[key];
        if (multiline) input.rows = 7;
        input.required = key !== 'replaceString';
        fields[key] = input;
        wrap.append(input);
        form.append(wrap);
    }
    const locations = element('fieldset');
    locations.append(element('legend', '作用位置'));
    const placement = [];
    for (const [value, title] of [[1, '用户输入'], [2, 'AI 输出'], [3, '快捷命令'], [5, '世界书'], [6, '推理']]) {
        const label = element('label', undefined, 'wbr-check');
        const input = element('input'); input.type = 'checkbox'; input.checked = rule.placement.includes(value);
        placement.push([value, input]); label.append(input, document.createTextNode(title)); locations.append(label);
    }
    form.append(locations);
    for (const [key, label] of [['markdownOnly', '显示时处理'], ['promptOnly', '发送时处理'], ['runOnEdit', '编辑后运行'], ['disabled', '停用']]) {
        const wrap = element('label', undefined, 'wbr-check');
        const input = element('input'); input.type = 'checkbox'; input.checked = !!rule[key]; fields[key] = input;
        wrap.append(input, document.createTextNode(label)); form.append(wrap);
    }
    const advanced = element('details'); advanced.append(element('summary', '高级设置'));
    const json = element('textarea'); json.rows = 7;
    json.value = JSON.stringify({ trimStrings: rule.trimStrings, substituteRegex: rule.substituteRegex, minDepth: rule.minDepth, maxDepth: rule.maxDepth }, null, 2);
    json.setAttribute('aria-label', '高级正则设置 JSON'); advanced.append(json); form.append(advanced);
    const save = element('button', '保存', 'menu_button'); save.type = 'submit'; form.append(save);
    form.onsubmit = async event => {
        event.preventDefault(); save.disabled = true;
        try {
            const extra = JSON.parse(json.value);
            const updated = normalizeRegex({ ...rule, trimStrings: extra.trimStrings, substituteRegex: extra.substituteRegex,
                minDepth: extra.minDepth, maxDepth: extra.maxDepth,
                ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.value])),
                placement: placement.filter(([, input]) => input.checked).map(([value]) => value) });
            await mutateBook(name, rules => original ? rules.map(item => item.id === rule.id ? updated : item) : [...rules, updated]);
            modal.close();
        } catch (error) { report(error); }
        finally { save.disabled = false; }
    };
    modal.append(form);
    return new Promise(resolve => modal.addEventListener('close', resolve, { once: true }));
}

function picker(title) {
    const modal = dialog(title);
    modal.classList.add('wbr-picker');
    return modal;
}

function pickerFooter(action) {
    const footer = element('div', undefined, 'wbr-picker-footer');
    footer.append(action);
    return footer;
}

function sourceKey(type) {
    if (type === SCRIPT_TYPES.PRESET) return JSON.stringify([getCurrentPresetAPI(), getCurrentPresetName()]);
    if (type === SCRIPT_TYPES.SCOPED) {
        const { characters, characterId } = getContext();
        return characters?.[characterId]?.avatar;
    }
    return type;
}

async function moveExisting(name) {
    const modal = picker('移动已有正则');
    const list = element('div', undefined, 'wbr-picker-list');
    const groups = [];
    for (const [title, type] of [['全局', SCRIPT_TYPES.GLOBAL], ['预设', SCRIPT_TYPES.PRESET], ['角色卡', SCRIPT_TYPES.SCOPED]]) {
        const details = element('details');
        const scripts = getScriptsByType(type, { allowedOnly: false }).filter(rule => !isManaged(rule));
        details.open = type === SCRIPT_TYPES.GLOBAL;
        details.append(element('summary', `${title}（${scripts.length}）`));
        const items = scripts.map(rule => {
            const label = element('label', undefined, 'wbr-check');
            const input = element('input');
            input.type = 'checkbox';
            label.append(input, document.createTextNode(rule.scriptName));
            details.append(label);
            return { input, id: rule.id, snapshot: JSON.stringify(rule) };
        });
        groups.push({ type, key: sourceKey(type), items });
        list.append(details);
    }

    const close = modal.querySelector('.wbr-toolbar button');
    const hasSelection = () => groups.some(group => group.items.some(({ input }) => input.checked));
    const move = button('移到世界书', async () => {
        move.disabled = close.disabled = list.inert = true;
        try {
            await queueWrite(async () => {
                let book = await getContext().loadWorldInfo(name);
                if (!book) throw new Error('世界书不存在');
                for (const { type, key, items } of groups) {
                    const chosen = items.filter(({ input }) => input.checked);
                    if (!chosen.length) continue;
                    const ids = new Set(chosen.map(({ id }) => id));
                    const getSource = () => {
                        const current = getScriptsByType(type, { allowedOnly: false });
                        if (sourceKey(type) !== key || chosen.some(({ id, snapshot }) => {
                            const matches = current.filter(rule => rule.id === id);
                            return matches.length !== 1 || JSON.stringify(matches[0]) !== snapshot;
                        })) throw new Error('原位置的正则已变化，请重新打开弹窗');
                        return current;
                    };
                    getSource();
                    const added = chosen.map(({ snapshot }) => normalizeRegex({ ...JSON.parse(snapshot), id: createRegexId() }));
                    const updated = writeBundle(book, [...readBundle(book), ...added]);
                    await saveBookChecked(name, updated);
                    try {
                        const remaining = getSource().filter(rule => !ids.has(rule.id) && !isManaged(rule));
                        await saveScriptsByType(remaining, type);
                    } catch (error) {
                        await saveBookChecked(name, book);
                        throw error;
                    }
                    book = updated;
                    for (const { input } of chosen) {
                        input.checked = false;
                        input.disabled = true;
                    }
                }
            });
            modal.close();
        } finally {
            close.disabled = list.inert = false;
            move.disabled = !hasSelection();
            requestRegexSync();
        }
    });
    move.disabled = true;
    list.onchange = () => { move.disabled = !hasSelection(); };
    modal.addEventListener('cancel', event => { if (list.inert) event.preventDefault(); });
    modal.append(list, pickerFooter(move));
    return new Promise(resolve => modal.addEventListener('close', resolve, { once: true }));
}

export function pickUpdateBook(names, metadata, onSelect) {
    const modal = picker('更新已有世界书');
    const search = element('input');
    search.type = 'search';
    search.placeholder = '搜索书名或标签';
    search.setAttribute('aria-label', search.placeholder);
    const list = element('div', undefined, 'wbr-picker-list');
    let selected;
    const choose = button('选择新版文件', () => { modal.close(); onSelect(selected); });
    function render() {
        const query = search.value.trim().toLowerCase();
        selected = undefined;
        choose.disabled = true;
        list.replaceChildren();
        for (const name of names) {
            const tags = metadata[name]?.tags || [];
            if (![name, ...tags].some(value => String(value).toLowerCase().includes(query))) continue;
            const label = element('label', undefined, 'wbr-check');
            const input = element('input');
            input.type = 'radio';
            input.name = 'wbr-update-book';
            input.onchange = () => { selected = name; choose.disabled = false; };
            label.append(input, document.createTextNode([name, ...tags].join(' · ')));
            list.append(label);
        }
        if (!list.children.length) list.append(element('p', '没有匹配的世界书'));
    }
    search.oninput = render;
    render();
    modal.append(search, list, pickerFooter(choose));
}

export function confirmBookUpdate(name, filename, hasRegex) {
    const modal = dialog('更新世界书');
    modal.append(element('p', `用「${filename}」替换「${name}」的条目？`));
    const input = element('input');
    input.type = 'checkbox';
    if (hasRegex) {
        const label = element('label', undefined, 'wbr-check');
        label.append(input, document.createTextNode('同时替换绑定正则'));
        modal.append(label);
    }
    modal.append(pickerFooter(button('确认更新', () => modal.close('update'))));
    return new Promise(resolve => modal.addEventListener('close', () => resolve({
        confirmed: modal.returnValue === 'update',
        updateRegex: input.checked,
    }), { once: true }));
}

export async function openManager(name = STATE.currentBookName, ruleId) {
    if (!name) return toastr.warning('请先选择一本世界书');
    if (ruleId) {
        const book = await getContext().loadWorldInfo(name);
        const rule = readBundle(book).find(item => item.id === ruleId);
        if (rule) await editRule(name, rule);
        return;
    }
    const modal = dialog(`${name} · 配套正则`);
    await mountRegexManager(modal, name, true);
}

const mountedEditors = new WeakMap();
export async function mountRegexManager(host, name, keepHeader = false) {
    const token = Symbol(name);
    mountedEditors.set(host, token);
    if (!keepHeader) host.replaceChildren();
    if (!name) { host.append(element('p', '请先选择一本世界书')); return; }
    const toolbar = element('div', undefined, 'wbr-toolbar');
    const list = element('div');
    async function refresh() {
        if (!host.isConnected || mountedEditors.get(host) !== token) return;
        const book = await getContext().loadWorldInfo(name);
        if (!host.isConnected || mountedEditors.get(host) !== token) return;
        if (!book) throw new Error('世界书不存在');
        const rules = readBundle(book);
        list.replaceChildren();
        if (!rules.length) list.append(element('p', '暂无配套正则'));
        rules.forEach((rule, index) => {
            const row = element('div', undefined, 'wbr-rule');
            const label = element('label');
            const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = !rule.disabled;
            toggle.onchange = () => mutateBook(name, items => items.map(item => item.id === rule.id ? { ...item, disabled: !toggle.checked } : item)).then(refresh).catch(error => { toggle.checked = !toggle.checked; report(error); });
            label.append(toggle, document.createTextNode(rule.scriptName));
            row.append(label,
                button('编辑', async () => { await editRule(name, rule); await refresh(); }),
                button('↑', async () => { await mutateBook(name, items => { if (index > 0) [items[index - 1], items[index]] = [items[index], items[index - 1]]; return items; }); await refresh(); }),
                button('移除', async () => { if (!confirm(`移除配套正则「${rule.scriptName}」？`)) return; await mutateBook(name, items => items.filter(item => item.id !== rule.id)); await refresh(); }));
            list.append(row);
        });
    }
    const file = element('input'); file.type = 'file'; file.accept = '.json'; file.multiple = true; file.hidden = true;
    file.onchange = async () => {
        try {
            const rules = [];
            for (const input of file.files) rules.push(...parseRegexImport(JSON.parse(await input.text())).map(rule => ({ ...rule, id: createRegexId() })));
            await mutateBook(name, items => [...items, ...rules]); await refresh();
        } catch (error) { report(error); }
        finally { file.value = ''; }
    };
    toolbar.append(button('新建', async () => { await editRule(name); await refresh(); }), button('导入', () => file.click()),
        button('移动已有', async () => { await moveExisting(name); await refresh(); }));
    host.append(toolbar, file, list); await refresh();
}

export async function listBindingTargets() {
    const [all, global, character] = await Promise.all([API.getAllBookNames(), API.getGlobalBindings(), API.getCharBindings()]);
    return { all, global, primary: character.primary };
}

export async function bindGeneratedRegexes(name, inputs) {
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('没有可绑定的正则');
    if (!(await API.getAllBookNames()).includes(name)) throw new Error('目标世界书已删除，请重新选择');
    const copies = inputs.map(item => normalizeRegex({ ...item, id: createRegexId() }));
    await mutateBook(name, rules => [...rules, ...copies]);
    return { book: name, count: copies.length };
}

export async function initWorldbookRegex() {
    if (initialized) return;
    initialized = true;
    window.KelaodeWorldbookRegex = Object.freeze({ version: 1, listTargets: listBindingTargets, bind: bindGeneratedRegexes });
    // Saved runtime copies are never treated as source data.
    clearCopies();
    const names = ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_EDITED', 'WORLDINFO_SETTINGS_UPDATED',
        'WORLDINFO_UPDATED', 'SETTINGS_UPDATED', 'PRESET_CHANGED', 'PERSONA_CHANGED'];
    for (const name of names) if (event_types[name]) eventSource.on(event_types[name], () => {
        if (name === 'CHAT_CHANGED') chatNeedsRender = true;
        requestRegexSync();
    });
    if (event_types.GENERATION_AFTER_COMMANDS) eventSource.on(event_types.GENERATION_AFTER_COMMANDS, synchronize);
    observer = new MutationObserver(queuePanel);
    observer.observe(document.body, { childList: true, subtree: true });
    await synchronize();
}
