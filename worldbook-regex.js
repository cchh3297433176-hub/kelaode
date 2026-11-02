import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, updateMessageBlock } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getRegexScripts } from '../../regex/engine.js';
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
    // Keep original rows in place so native sortable indexes are not changed.
    const saved = document.getElementById('saved_regex_scripts');
    if (saved) for (const row of saved.children) {
        if (row.id?.startsWith('kelaode-wbr:')) row.classList.add('wbr-managed-row');
    }
    let panel = document.getElementById('wbr-native-panel');
    const signature = JSON.stringify([extension_settings[ENABLED_KEY] !== false, [...groups]]);
    if (panel && signature === nativeSignature) return;
    nativeSignature = signature;
    if (!panel) {
        panel = element('details', undefined, 'wbr-native');
        panel.id = 'wbr-native-panel';
        container.append(panel);
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
function mutateBook(name, update) {
    const work = writes.catch(() => {}).then(async () => {
        const book = await getContext().loadWorldInfo(name);
        if (!book) throw new Error('世界书不存在');
        const updated = writeBundle(book, update(readBundle(book)));
        await getContext().saveWorldInfo(name, updated, true);
        await synchronize();
    });
    writes = work;
    return work;
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

async function copyExisting(name) {
    const modal = dialog('复制已有正则');
    const scripts = getRegexScripts().filter(script => !isManaged(script));
    const selected = [];
    for (const script of scripts) {
        const label = element('label', undefined, 'wbr-check');
        const input = element('input'); input.type = 'checkbox';
        selected.push([script, input]); label.append(input, document.createTextNode(script.scriptName)); modal.append(label);
    }
    if (!scripts.length) modal.append(element('p', '没有可复制的正则'));
    modal.append(button('复制到世界书', async () => {
        const chosen = selected.filter(([, input]) => input.checked).map(([script]) => normalizeRegex({ ...script, id: createRegexId() }));
        if (!chosen.length) return;
        await mutateBook(name, rules => [...rules, ...chosen]); modal.close();
    }));
    return new Promise(resolve => modal.addEventListener('close', resolve, { once: true }));
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
    const toolbar = element('div', undefined, 'wbr-toolbar');
    const list = element('div');
    async function refresh() {
        if (!modal.isConnected) return;
        const book = await getContext().loadWorldInfo(name);
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
        button('复制已有', async () => { await copyExisting(name); await refresh(); }));
    modal.append(toolbar, file, list); await refresh();
}

export async function initWorldbookRegex() {
    if (initialized) return;
    initialized = true;
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
