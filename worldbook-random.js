import { updateBook } from './worldbook-regex.js';

export const diceIcon = `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="17" height="17">
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

function groupNames(entry) {
    return typeof entry.group === 'string' ? entry.group.split(/,\s*/).filter(Boolean) : [];
}

function hasTriggerRestrictions(entry) {
    return entry.groupOverride || entry.delayUntilRecursion || Number(entry.sticky) > 0
        || Number(entry.cooldown) > 0 || Number(entry.delay) > 0 || entry.triggers?.length
        || entry.characterFilter?.names?.length || entry.characterFilter?.tags?.length
        || (entry.useProbability && entry.probability !== 100)
        || /^@@/m.test(String(entry.content ?? ''));
}

function groupsIn(entries) {
    const groups = new Map();
    for (const entry of entries) {
        for (const name of groupNames(entry)) {
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(entry);
        }
    }
    return groups;
}

function entryWeight(entry) {
    return entry.groupWeight ?? 100;
}

function isSimpleGroup(members) {
    return members.every(entry => entry.constant && groupNames(entry).length === 1
        && !hasTriggerRestrictions(entry) && Number.isFinite(entryWeight(entry)) && entryWeight(entry) > 0
        && (entry.useGroupScoring === false || (!entry.key?.length && !entry.keysecondary?.length)));
}

function makeGroupName(bookName) {
    const id = crypto.getRandomValues(new Uint32Array(2));
    const suffix = Array.from(id, value => value.toString(16).padStart(8, '0')).join('');
    return `${bookName.replace(/,/g, '，').trim().slice(0, 48)}-${suffix}`;
}

export function applyRandomGroup(book, group, selected, previousMembers) {
    const entries = Object.values(book.entries ?? {});
    const members = groupsIn(entries).get(group) ?? [];
    const memberIds = new Set(members.map(entry => entry.uid));
    if (memberIds.size !== previousMembers.size || [...memberIds].some(uid => !previousMembers.has(uid))
        || !isSimpleGroup(members)) {
        throw new Error('包含组已变化，请重新打开随机组');
    }
    const byId = new Map(entries.map(entry => [entry.uid, entry]));
    for (const uid of selected) {
        const entry = byId.get(uid);
        if (!entry || (!memberIds.has(uid) && (groupNames(entry).length || hasTriggerRestrictions(entry)))) {
            throw new Error('候选条目已变化，请重新打开随机组');
        }
    }
    if (!previousMembers.size && selected.size < 2) throw new Error('请至少选择两条候选');
    return {
        ...book,
        entries: Object.fromEntries(Object.entries(book.entries ?? {}).map(([key, entry]) => {
            if (memberIds.has(entry.uid)) {
                return [key, selected.has(entry.uid) ? entry : { ...entry, group: '', disable: true }];
            }
            if (!selected.has(entry.uid)) return [key, entry];
            return [key, {
                ...entry, constant: true, vectorized: false, group,
                groupOverride: false, groupWeight: 100, useGroupScoring: false,
            }];
        })),
    };
}

function entryTitle(entry) {
    return entry.comment || `条目 #${entry.uid}`;
}

export function openRandomGroups(bookName, entries, bindSearch, onSaved) {
    const groups = groupsIn(entries);
    const dialog = document.createElement('dialog');
    dialog.className = 'wbr-dialog wbr-picker wb-random-dialog';
    dialog.setAttribute('aria-labelledby', 'wb-random-title');
    dialog.innerHTML = `
        <div class="wbr-toolbar">
            <strong id="wb-random-title">${diceIcon} 随机组</strong>
            <button type="button" class="menu_button" data-close>关闭</button>
        </div>
        <select data-groups aria-label="包含组"><option value="">新建随机组</option></select>
        <input type="search" data-search placeholder="搜索条目" aria-label="搜索条目">
        <div class="wbr-picker-list wb-random-list" data-list></div>
        <footer class="wb-random-footer">
            <p data-status aria-live="polite"></p>
            <div class="wbr-picker-footer">
                <button type="button" class="menu_button" data-draw>试抽</button>
                <button type="button" class="menu_button wb-random-confirm" data-save>创建随机组</button>
            </div>
        </footer>`;
    const find = selector => dialog.querySelector(`[data-${selector}]`);
    const select = find('groups');
    const search = find('search');
    const list = find('list');
    const status = find('status');
    const draw = find('draw');
    const save = find('save');
    const close = find('close');
    let initial = new Set();
    let selected = new Set();
    let saving = false;

    for (const [name, members] of groups) {
        const option = new Option(`${name} · ${members.length} 条`, name);
        option.disabled = !isSimpleGroup(members);
        if (option.disabled) option.textContent += '（有高级触发设置）';
        select.add(option);
    }

    const candidates = () => entries.filter(entry => selected.has(entry.uid) && !entry.disable);
    const weight = entry => initial.has(entry.uid) ? entryWeight(entry) : 100;
    function updateStatus(result = '') {
        const enabled = candidates();
        const removed = [...initial].filter(uid => !selected.has(uid)).length;
        const changed = removed > 0 || selected.size !== initial.size;
        const pieces = [`已选 ${selected.size} 条`, enabled.length ? `${enabled.length} 条参与，每轮抽 1 条` : '暂无参与条目'];
        if (enabled.length > 1 && new Set(enabled.map(weight)).size === 1) pieces.push('等概率');
        if (selected.size > initial.size - removed) pieces.push('新成员将设为蓝灯');
        if (removed) pieces.push(`移出并停用 ${removed} 条`);
        if (result) pieces.push(result);
        status.textContent = pieces.join(' · ');
        draw.disabled = saving || !enabled.length;
        save.disabled = saving || !changed || (!select.value && selected.size < 2);
        save.textContent = select.value ? '保存随机组' : '创建随机组';
    }

    function renderList(query = '') {
        const term = query.trim().toLowerCase();
        list.replaceChildren();
        for (const entry of entries) {
            const title = entryTitle(entry);
            if (!title.toLowerCase().includes(term)) continue;
            const membership = groupNames(entry);
            const note = !initial.has(entry.uid) && (membership.length ? `已在 ${membership.join('、')}`
                : hasTriggerRestrictions(entry) ? '有高级触发设置' : '');
            const label = document.createElement('label');
            label.className = 'wbr-check wb-random-row';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = selected.has(entry.uid);
            input.disabled = Boolean(note);
            input.onchange = () => {
                if (input.checked) selected.add(entry.uid);
                else selected.delete(entry.uid);
                updateStatus();
            };
            const text = document.createElement('span');
            text.textContent = title;
            const detail = note || (entry.disable ? '已停用' : '');
            if (detail) {
                const caption = document.createElement('small');
                caption.textContent = detail;
                text.append(caption);
            }
            label.append(input, text);
            list.append(label);
        }
        if (!list.children.length) list.textContent = '没有匹配的条目';
    }

    select.onchange = () => {
        initial = new Set((groups.get(select.value) ?? []).map(entry => entry.uid));
        selected = new Set(initial);
        renderList(search.value);
        updateStatus();
    };
    bindSearch(search, query => renderList(query));
    draw.onclick = () => {
        const enabled = candidates();
        let roll = Math.random() * enabled.reduce((sum, entry) => sum + weight(entry), 0);
        const winner = enabled.find(entry => (roll -= weight(entry)) <= 0) ?? enabled.at(-1);
        if (winner) updateStatus(`试抽到「${entryTitle(winner)}」`);
    };
    save.onclick = async () => {
        if (save.disabled) return;
        saving = true;
        close.disabled = select.disabled = search.disabled = list.inert = true;
        updateStatus();
        try {
            const group = select.value || makeGroupName(bookName);
            await updateBook(bookName, book => applyRandomGroup(book, group, selected, initial));
        } catch (error) {
            saving = false;
            close.disabled = select.disabled = search.disabled = list.inert = false;
            updateStatus(error.message);
            return;
        }
        dialog.close();
        onSaved();
    };
    close.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    renderList();
    updateStatus();
    document.body.append(dialog);
    dialog.showModal();
}
