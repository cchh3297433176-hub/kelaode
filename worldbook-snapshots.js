import { getContext } from '../../../extensions.js';
import { applyEntryGroup, captureSnapshotState, getBookControl, readSnapshots, snapshotEntryDisabled, storeSnapshot, writeBookControl } from './worldbook-chat.js';
import { updateBook } from './worldbook-regex.js';

export async function openWorldbookSnapshots(bookName) {
    if (document.querySelector('.wb-snapshot-dialog[open]')) return;
    const context = getContext();
    const chatId = context.chatId;
    let book = await context.loadWorldInfo(bookName);
    if (!book) throw new Error('世界书不存在');
    if (getContext().chatId !== chatId) throw new Error('聊天已切换，请重新打开');
    if (document.querySelector('.wb-snapshot-dialog[open]')) return;

    const dialog = document.createElement('dialog');
    dialog.className = 'wbr-dialog wbr-picker wb-feature-dialog wb-snapshot-dialog';
    dialog.setAttribute('aria-labelledby', 'wb-snapshot-title');
    dialog.innerHTML = `
        <div class="wbr-toolbar">
            <div><strong id="wb-snapshot-title">条目快照</strong><small data-book></small></div>
            <button type="button" class="menu_button" data-close>关闭</button>
        </div>
        <div class="wb-snapshot-picks" role="group" aria-label="条目快照" data-snapshots></div>
        <label class="wbr-check"><input type="checkbox" data-group> 存为条目分组</label>
        <input type="search" data-search placeholder="搜索条目" aria-label="搜索条目">
        <div class="wbr-picker-list wb-feature-list" data-entries></div>
        <p class="wb-feature-status" data-status aria-live="polite"></p>
        <div class="wb-snapshot-controls">
            <input type="text" data-name maxlength="60" placeholder="快照名称" aria-label="快照名称">
            <button type="button" class="menu_button" data-save>存为快照</button>
        </div>`;
    const find = key => dialog.querySelector(`[data-${key}]`);
    const picker = find('snapshots');
    const search = find('search');
    const entryList = find('entries');
    const status = find('status');
    const save = find('save');
    const close = find('close');
    const nameInput = find('name');
    const draft = new Map();
    const groupMode = find('group');
    const members = new Set();
    let busy = false;
    let selectedId = '';

    find('book').textContent = bookName;
    function getAppliedId() {
        return getBookControl(getContext().chatMetadata, bookName).snapshot ?? '';
    }
    function resetDraft(snapshot) {
        draft.clear();
        members.clear();
        const { groupStates } = getBookControl(getContext().chatMetadata, bookName);
        for (const entry of Object.values(book.entries ?? {})) {
            draft.set(entry.uid, captureSnapshotState(entry, snapshotEntryDisabled(snapshot, entry, groupStates)));
        }
    }
    function renderPicker() {
        picker.replaceChildren();
        for (const snapshot of [null, ...readSnapshots(book)]) {
            const id = snapshot?.id ?? '';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu_button';
            button.dataset.snapshotId = id;
            button.textContent = snapshot?.kind === 'group' ? snapshot.name + ' · 分组' : snapshot?.name ?? '原书条目设置';
            button.setAttribute('aria-pressed', String(id === selectedId));
            button.onclick = () => {
                if (busy) return;
                try {
                    if (snapshot?.kind === 'group') {
                        applyEntryGroup(getContext(), chatId, bookName, book, snapshot);
                    } else {
                        if (chatId) writeBookControl(getContext(), chatId, bookName, { snapshot: id || undefined, groupStates: undefined });
                        selectedId = id;
                    }
                    for (const option of picker.children) option.setAttribute('aria-pressed', String(option.dataset.snapshotId === selectedId));
                    resetDraft(readSnapshots(book).find(item => item.id === selectedId));
                    renderEntries();
                    renderStatus();
                    if (snapshot?.kind === 'group') status.textContent = '已应用分组「' + snapshot.name + '」到当前聊天';
                } catch (error) {
                    status.textContent = error.message;
                }
            };
            picker.append(button);
        }
    }
    function renderEntries() {
        const term = search.value.trim().toLocaleLowerCase();
        entryList.replaceChildren();
        for (const entry of Object.values(book.entries ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
            const title = entry.comment || `条目 #${entry.uid}`;
            if (term && !title.toLocaleLowerCase().includes(term)) continue;
            const row = document.createElement('div');
            row.className = 'wbr-check wb-feature-row wb-snapshot-entry';
            const toggle = document.createElement('label');
            toggle.className = 'wbr-check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !draft.get(entry.uid)?.disabled;
            input.onchange = () => {
                draft.set(entry.uid, captureSnapshotState(entry, !input.checked));
                status.textContent = '已调整草稿';
            };
            toggle.append(input, document.createTextNode(title));
            row.append(toggle);
            if (groupMode.checked) {
                const include = document.createElement('label');
                include.className = 'wbr-check';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = members.has(entry.uid);
                checkbox.setAttribute('aria-label', '将「' + title + '」加入分组');
                checkbox.onchange = () => checkbox.checked ? members.add(entry.uid) : members.delete(entry.uid);
                include.append(checkbox, document.createTextNode('纳入'));
                row.append(include);
            }
            entryList.append(row);
        }
        if (!entryList.childElementCount) entryList.textContent = '没有匹配的条目';
    }
    function renderStatus() {
        const current = readSnapshots(book).find(snapshot => snapshot.id === getAppliedId());
        const hasGroup = Object.keys(getBookControl(getContext().chatMetadata, bookName).groupStates ?? {}).length;
        status.textContent = hasGroup ? '当前聊天 · 已应用条目分组' : !chatId ? '打开聊天后可应用快照' : current ? `当前聊天 · ${current.name}` : '当前聊天 · 原书条目设置';
    }

    search.oninput = () => renderEntries();
    groupMode.onchange = () => {
        save.textContent = groupMode.checked ? '存为分组' : '存为快照';
        nameInput.placeholder = groupMode.checked ? '分组名称' : '快照名称';
        nameInput.setAttribute('aria-label', nameInput.placeholder);
        renderEntries();
    };
    save.onclick = async () => {
        if (busy) return;
        const name = nameInput.value.trim();
        if (!name) {
            status.textContent = '请输入' + (groupMode.checked ? '分组' : '快照') + '名称';
            nameInput.focus();
            return;
        }
        const selection = groupMode.checked ? new Set(members) : undefined;
        busy = true;
        save.disabled = close.disabled = groupMode.disabled = search.disabled = nameInput.disabled = picker.inert = entryList.inert = true;
        try {
            const states = new Map(draft);
            await updateBook(bookName, current => {
                book = storeSnapshot(current, name, states, selection);
                return book;
            });
            renderPicker();
            if (!selection) resetDraft(readSnapshots(book).find(snapshot => snapshot.name === name));
            renderEntries();
            nameInput.value = '';
            status.textContent = `已保存「${name}」`;
        } catch (error) {
            status.textContent = error.message;
        } finally {
            busy = false;
            save.disabled = close.disabled = groupMode.disabled = search.disabled = nameInput.disabled = picker.inert = entryList.inert = false;
        }
    };
    nameInput.onkeydown = event => {
        if (event.key === 'Enter' && !event.isComposing && !busy) save.click();
    };
    close.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    const applied = readSnapshots(book).find(snapshot => snapshot.id === getAppliedId());
    selectedId = applied?.id ?? '';
    renderPicker();
    resetDraft(applied);
    renderEntries();
    renderStatus();
    document.body.append(dialog);
    dialog.showModal();
}
