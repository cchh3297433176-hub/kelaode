const CHAT_KEY = 'kelaode_worldbook_controls';
const SNAPSHOT_KEY = 'kelaode_worldbook_snapshots';

function chatControls(metadata) {
    const controls = metadata?.[CHAT_KEY];
    return Array.isArray(controls) ? controls.filter(control => typeof control?.name === 'string') : [];
}

export function getBookControl(metadata, name) {
    return chatControls(metadata).find(control => control.name === name) ?? {};
}

export function effectiveWorldbookNames(bound, metadata, available) {
    const names = new Set(bound);
    for (const { name, enabled } of chatControls(metadata)) {
        if (enabled === false) names.delete(name);
        if (enabled === true && available?.includes(name)) names.add(name);
    }
    return [...names];
}

export function writeBookControl(context, chatId, name, patch) {
    if (!chatId || context.chatId !== chatId || !context.chatMetadata) {
        throw new Error('聊天已切换，请重新打开');
    }
    const metadata = context.chatMetadata;
    const current = getBookControl(metadata, name);
    const control = { ...current, ...patch, name };
    const remaining = chatControls(metadata).filter(item => item.name !== name);
    if (typeof control.enabled === 'boolean' || control.snapshot) remaining.push(control);
    if (remaining.length) metadata[CHAT_KEY] = remaining;
    else delete metadata[CHAT_KEY];
    context.saveMetadataDebounced();
}

export function readSnapshots(book) {
    const snapshots = book?.extensions?.[SNAPSHOT_KEY];
    if (!Array.isArray(snapshots)) return [];
    return snapshots.filter(snapshot => typeof snapshot?.name === 'string'
        && typeof snapshot.id === 'string' && snapshot.states && typeof snapshot.states === 'object');
}

function entryFingerprint(entry) {
    // An entry UID can be reused after a deletion. Match its title/keys as well.
    const identity = JSON.stringify([
        entry.comment ?? '', entry.key ?? [], entry.keysecondary ?? [], entry.comment ? '' : entry.content ?? '',
    ]);
    let hash = 2166136261;
    for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
    return hash >>> 0;
}

export function snapshotEntryDisabled(snapshot, entry) {
    const state = Object.hasOwn(snapshot?.states ?? {}, entry.uid) ? snapshot.states[entry.uid] : null;
    return state?.fingerprint === entryFingerprint(entry) && typeof state.disabled === 'boolean'
        ? state.disabled
        : Boolean(entry.disable);
}

export function storeSnapshot(book, name, states) {
    const existing = readSnapshots(book);
    if (existing.some(snapshot => snapshot.name === name)) throw new Error('已有同名快照，请换个名字');
    const id = Array.from(crypto.getRandomValues(new Uint32Array(2))).join('-');
    const entries = Object.values(book.entries ?? {});
    const saved = {
        id,
        name,
        states: Object.fromEntries(entries.map(entry => {
            const draft = states.get(entry.uid);
            const fingerprint = entryFingerprint(entry);
            return [entry.uid, { fingerprint, disabled: draft?.fingerprint === fingerprint ? draft.disabled : Boolean(entry.disable) }];
        })),
    };
    return { ...book, extensions: { ...book.extensions, [SNAPSHOT_KEY]: [...existing, saved] } };
}

export function captureSnapshotState(entry, disabled) {
    return { fingerprint: entryFingerprint(entry), disabled };
}
