import { updateBook } from './worldbook-regex.js';
import { effectiveWorldbookNames, getBookControl, readSnapshots, snapshotEntryDisabled } from './worldbook-chat.js';

const COUNTS_KEY = 'kelaode_worldbook_draw_counts';

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

function drawCount(book, group) {
    const counts = book?.extensions?.[COUNTS_KEY];
    const value = counts && Object.hasOwn(counts, group) ? counts[group] : 1;
    return Number.isSafeInteger(value) && value > 1 ? value : 1;
}

function drawWeighted(entries, count, weight = entryWeight, random = Math.random) {
    const pool = entries.map(entry => ({ entry, weight: weight(entry) }));
    const drawn = [];
    while (pool.length && drawn.length < count) {
        let roll = random() * pool.reduce((sum, item) => sum + item.weight, 0);
        const index = pool.findIndex(item => (roll -= item.weight) < 0);
        drawn.push(pool.splice(index < 0 ? pool.length - 1 : index, 1)[0].entry);
    }
    return drawn;
}

// SillyTavern 1.18 passes request-local entries before it scans for activations.
export async function applyWorldbookRuntime(lore, context, available, random = Math.random) {
    const buckets = [lore.globalLore, lore.characterLore, lore.chatLore, lore.personaLore].filter(Array.isArray);
    const bound = new Set(buckets.flatMap(bucket => bucket.map(entry => entry.world)));
    const metadata = context.chatMetadata;
    const effective = new Set(effectiveWorldbookNames(bound, metadata, available));
    const toLoad = new Set([...effective].filter(name => {
        const control = getBookControl(metadata, name);
        return !bound.has(name) || control.snapshot || Object.keys(control.groupStates ?? {}).length;
    }));
    for (const bucket of buckets) {
        for (const entry of bucket) if (entry.group && effective.has(entry.world)) toLoad.add(entry.world);
    }
    if (!toLoad.size && effective.size === bound.size) return;
    const books = new Map(await Promise.all([...toLoad].map(async name => {
        try {
            return [name, await context.loadWorldInfo(name)];
        } catch (error) {
            console.warn('[世界书管理器] 无法读取世界书', name, error);
            return [name, null];
        }
    })));

    const prepared = buckets.map(bucket => bucket.filter(entry => effective.has(entry.world)));
    const chatEntries = prepared[buckets.indexOf(lore.chatLore)];
    for (const [name, book] of books) {
        if (!book || bound.has(name) || !chatEntries) continue;
        for (const entry of Object.values(book.entries ?? {})) chatEntries.push({ ...entry, world: name });
    }

    const byBook = new Map();
    const snapshots = new Map();
    for (const [name, book] of books) {
        const { snapshot, groupStates } = getBookControl(metadata, name);
        if (snapshot || groupStates) {
            snapshots.set(name, {
                snapshot: readSnapshots(book).find(item => item.id === snapshot),
                groupStates,
            });
        }
    }
    for (const bucket of prepared) {
        for (let i = 0; i < bucket.length; i++) {
            const entry = bucket[i];
            const controls = snapshots.get(entry.world);
            if (controls) {
                const disable = snapshotEntryDisabled(controls.snapshot, entry, controls.groupStates);
                if (disable !== Boolean(entry.disable)) bucket[i] = { ...entry, disable };
            }
            if (!entry.group) continue;
            if (!byBook.has(entry.world)) byBook.set(entry.world, []);
            byBook.get(entry.world).push(bucket[i]);
        }
    }

    const decisions = new Map();
    for (const [name, entries] of byBook) {
        for (const [group, members] of groupsIn(entries)) {
            const count = drawCount(books.get(name), group);
            if (count === 1 || !isSimpleGroup(members)) continue;
            const candidates = members.filter(entry => !entry.disable);
            const winners = new Set(drawWeighted(candidates, count, entryWeight, random));
            for (const entry of candidates) decisions.set(entry, winners.has(entry));
        }
    }

    for (const [index, bucket] of buckets.entries()) {
        bucket.length = 0;
        for (const entry of prepared[index]) {
            if (decisions.get(entry) === false) continue;
            bucket.push(decisions.has(entry) ? { ...entry, group: '' } : entry);
        }
    }
}

function makeGroupName(bookName) {
    const id = crypto.getRandomValues(new Uint32Array(2));
    const suffix = Array.from(id, value => value.toString(16).padStart(8, '0')).join('');
    return `${bookName.replace(/,/g, '，').trim().slice(0, 48)}-${suffix}`;
}

export function applyRandomGroup(book, group, selected, previousMembers, count = 1, previousCount = 1) {
    const entries = Object.values(book.entries ?? {});
    const members = groupsIn(entries).get(group) ?? [];
    const memberIds = new Set(members.map(entry => entry.uid));
    if (memberIds.size !== previousMembers.size || [...memberIds].some(uid => !previousMembers.has(uid))
        || !isSimpleGroup(members) || drawCount(book, group) !== previousCount) {
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
    if (!Number.isSafeInteger(count) || count < 1 || count > Math.max(1, selected.size)) {
        throw new Error('抽取条数不能超过组内条目数');
    }
    const extensions = { ...book.extensions };
    const counts = { ...extensions[COUNTS_KEY] };
    if (count > 1) counts[group] = count;
    else delete counts[group];
    if (Object.keys(counts).length) extensions[COUNTS_KEY] = counts;
    else delete extensions[COUNTS_KEY];
    return {
        ...book,
        ...(book.extensions || count > 1 ? { extensions } : {}),
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

export function openRandomGroups(bookName, book, bindSearch, onSaved) {
    const entries = Object.values(book.entries ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
        <div class="wb-random-count">
            <label for="wb-random-draw-count">每轮抽取</label>
            <button type="button" class="menu_button" data-minus aria-label="少抽一条">−</button>
            <input type="number" id="wb-random-draw-count" data-count min="1" max="1" value="1" inputmode="numeric">
            <button type="button" class="menu_button" data-plus aria-label="多抽一条">+</button>
        </div>
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
    const countInput = find('count');
    const minus = find('minus');
    const plus = find('plus');
    let initial = new Set();
    let selected = new Set();
    let initialCount = 1;
    let saving = false;

    for (const [name, members] of groups) {
        const option = new Option(`${name} · ${members.length} 条`, name);
        option.disabled = !isSimpleGroup(members);
        if (option.disabled) option.textContent += '（有高级触发设置）';
        select.add(option);
    }

    const candidates = () => entries.filter(entry => selected.has(entry.uid) && !entry.disable);
    const weight = entry => initial.has(entry.uid) ? entryWeight(entry) : 100;
    const maxCount = () => Math.max(1, selected.size);
    const requestedCount = () => countInput.valueAsNumber;
    function updateStatus(result = '') {
        const enabled = candidates();
        const removed = [...initial].filter(uid => !selected.has(uid)).length;
        const count = requestedCount();
        const valid = Number.isSafeInteger(count) && count >= 1 && count <= maxCount();
        const changed = removed > 0 || selected.size !== initial.size || count !== initialCount;
        const pieces = [`已选 ${selected.size} 条`];
        if (!valid) pieces.push(`抽取条数可设为 1–${maxCount()}`);
        else if (enabled.length) pieces.push(`${enabled.length} 条参与，每轮抽 ${Math.min(count, enabled.length)} 条`);
        else pieces.push('暂无参与条目');
        if (enabled.length > 1 && new Set(enabled.map(weight)).size === 1) pieces.push('等概率');
        if (selected.size > initial.size - removed) pieces.push('新成员将设为蓝灯');
        if (removed) pieces.push(`移出并停用 ${removed} 条`);
        if (result) pieces.push(result);
        status.textContent = pieces.join(' · ');
        countInput.max = String(maxCount());
        countInput.disabled = saving;
        minus.disabled = saving || count <= 1;
        plus.disabled = saving || count >= maxCount();
        draw.disabled = saving || !valid || !enabled.length;
        save.disabled = saving || !valid || !changed || (!select.value && selected.size < 2);
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
                if (requestedCount() > maxCount()) countInput.value = String(maxCount());
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
        initialCount = drawCount(book, select.value);
        countInput.value = String(Math.min(initialCount, maxCount()));
        renderList(search.value);
        updateStatus();
    };
    bindSearch(search, query => renderList(query));
    countInput.oninput = () => updateStatus();
    function stepCount(step) {
        const count = requestedCount() || 1;
        countInput.value = String(Math.min(maxCount(), Math.max(1, count + step)));
        updateStatus();
    }
    minus.onclick = () => stepCount(-1);
    plus.onclick = () => stepCount(1);
    draw.onclick = () => {
        const winners = drawWeighted(candidates(), requestedCount(), weight);
        if (winners.length) updateStatus(`试抽到 ${winners.map(entry => `「${entryTitle(entry)}」`).join('、')}`);
    };
    save.onclick = async () => {
        if (save.disabled) return;
        saving = true;
        close.disabled = select.disabled = search.disabled = list.inert = true;
        updateStatus();
        try {
            const group = select.value || makeGroupName(bookName);
            await updateBook(bookName, book => applyRandomGroup(book, group, selected, initial, requestedCount(), initialCount));
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
