import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const context = vm.createContext({ crypto, console });
const moduleSource = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const chatModule = new vm.SourceTextModule(await moduleSource('worldbook-chat.js'), { context });
const randomModule = new vm.SourceTextModule(await moduleSource('worldbook-random.js'), { context });
const regexModule = new vm.SyntheticModule(['updateBook'], function () {
    this.setExport('updateBook', () => {});
}, { context });
await randomModule.link(specifier => specifier === './worldbook-chat.js' ? chatModule : regexModule);
await randomModule.evaluate();
const { applyRandomGroup, applyWorldbookRuntime, commitWorldbookDraws } = randomModule.namespace;
const { applyEntryGroup, captureSnapshotState, getBookControl, readSnapshots, snapshotEntryDisabled, storeSnapshot, writeBookControl } = chatModule.namespace;

function createBook(count = 5) {
    return {
        extensions: { unrelated: true },
        entries: Object.fromEntries(Array.from({ length: count }, (_, uid) => [uid, {
            uid, comment: `候选 ${uid}`, content: `条目内容 ${uid}`, key: [], constant: true,
            disable: false, group: 'outfits', groupWeight: 100,
        }])),
    };
}

function setDrawCount(book, count, previous = 1) {
    const members = new Set(Object.values(book.entries).map(entry => entry.uid));
    return applyRandomGroup(book, 'outfits', members, members, count, previous);
}

function loreFor(name, book) {
    return {
        globalLore: Object.values(book.entries).map(entry => ({ ...entry, world: name })),
        characterLore: [], chatLore: [], personaLore: [],
    };
}

test('old inclusion groups and groups reset to one retain their native selection', async () => {
    const oldBook = createBook();
    const resetBook = setDrawCount(setDrawCount(oldBook, 2), 1, 2);
    for (const book of [oldBook, resetBook]) {
        const lore = loreFor('A', book);
        await applyWorldbookRuntime(lore, { loadWorldInfo: async () => book }, ['A']);
        assert.equal(lore.globalLore.length, 5);
        assert.ok(lore.globalLore.every(entry => entry.group === 'outfits'));
        assert.equal(book.extensions.unrelated, true);
    }
});

test('the live filter samples without replacement by weight and leaves the original book intact', async () => {
    const book = setDrawCount(createBook(), 2);
    book.entries[4].groupWeight = 400;
    const lore = loreFor('A', book);
    const rolls = [0.75, 0];
    await applyWorldbookRuntime(lore, { loadWorldInfo: async () => book }, ['A'], () => rolls.shift());
    assert.deepEqual(lore.globalLore.map(entry => entry.uid), [0, 4]);
    assert.ok(lore.globalLore.every(entry => entry.group === ''));
    assert.ok(Object.values(book.entries).every(entry => entry.group === 'outfits'));
    assert.equal(Object.values(book.entries).length, 5);
});

test('rotation uses the last candidate before refilling, and records only activated entries', async () => {
    let book = createBook();
    const members = new Set([0, 1, 2, 3, 4]);
    book = applyRandomGroup(book, 'outfits', members, members, 2, 1, { label: '日常', rotation: true }, { label: '', rotation: false });
    let saves = 0;
    const chat = { chatId: 'one', chatMetadata: {}, saveMetadataDebounced() { saves++; }, loadWorldInfo: async () => book };
    const scan = async (context = chat, rolls = []) => {
        const lore = loreFor('A', book);
        await applyWorldbookRuntime(lore, context, ['A'], () => rolls.shift() ?? 0);
        return structuredClone(lore.globalLore);
    };
    const ids = entries => entries.map(entry => entry.uid);
    const first = await scan();
    assert.deepEqual(ids(first), [0, 1]);
    assert.deepEqual(ids(await scan()), [0, 1]);
    assert.equal(saves, 0);
    commitWorldbookDraws(first, chat);
    commitWorldbookDraws(first, chat);
    assert.equal(saves, 1);
    const second = await scan();
    assert.deepEqual(ids(second), [2, 3]);
    commitWorldbookDraws(second, chat);
    const boundary = await scan(chat, [0, 0.3]);
    assert.deepEqual(ids(boundary), [1, 4]);
    commitWorldbookDraws(boundary.filter(entry => entry.uid === 1), chat);
    assert.deepEqual(ids(await scan(chat, [0, 0.3])), [1, 4], 'an over-budget last entry is still due');
    commitWorldbookDraws(await scan(chat, [0, 0.3]), chat);
    assert.deepEqual(ids(await scan()), [0, 2], 'the refill was carried into the new cycle');
    const otherChat = { ...chat, chatId: 'two', chatMetadata: {} };
    commitWorldbookDraws(boundary, otherChat);
    assert.deepEqual(ids(await scan(otherChat)), [0, 1]);
    assert.deepEqual(ids(await scan()), [0, 2]);
});

test('a single scan draws one entry from each group and advances each group separately', async () => {
    let book = createBook(4);
    book.entries[2].group = book.entries[3].group = 'bonus';
    for (const [group, ids] of [['outfits', [0, 1]], ['bonus', [2, 3]]]) {
        const members = new Set(ids);
        book = applyRandomGroup(book, group, members, members, 1, 1, { label: group, rotation: true }, { label: '', rotation: false });
    }
    const chat = { chatId: 'one', chatMetadata: {}, saveMetadataDebounced() {}, loadWorldInfo: async () => book };
    const lore = loreFor('A', book);
    await applyWorldbookRuntime(lore, chat, ['A'], () => 0);
    assert.deepEqual(lore.globalLore.map(entry => entry.uid), [0, 2]);
    commitWorldbookDraws(structuredClone(lore.globalLore.slice(0, 1)), chat);
    const next = loreFor('A', book);
    await applyWorldbookRuntime(next, chat, ['A'], () => 0);
    assert.deepEqual(next.globalLore.map(entry => entry.uid), [1, 2]);
});

test('snapshot disable switches apply before a draw and changed entry identities use original settings', async () => {
    let book = setDrawCount(createBook(), 3);
    const states = new Map(Object.values(book.entries).map(entry => [entry.uid, captureSnapshotState(entry, entry.uid >= 2)]));
    book = storeSnapshot(book, '日常', states);
    const [snapshot] = readSnapshots(book);
    const chat = { chatId: 'one', chatMetadata: {}, saveMetadataDebounced() {}, loadWorldInfo: async () => book };
    writeBookControl(chat, 'one', 'A', { snapshot: snapshot.id });
    const lore = loreFor('A', book);
    await applyWorldbookRuntime(lore, chat, ['A'], () => 0);
    assert.deepEqual(lore.globalLore.filter(entry => !entry.disable).map(entry => entry.uid), [0, 1]);
    assert.equal(book.entries[2].disable, false);
    assert.equal(snapshotEntryDisabled(snapshot, { ...book.entries[2], comment: '替换后的条目' }), false);
    assert.equal(snapshotEntryDisabled(snapshot, book.entries[2]), true);
});

test('whole-book overrides suppress all bound sources and load extras once into the current chat', async () => {
    const book = createBook(2);
    const lore = loreFor('A', book);
    lore.personaLore = lore.globalLore.map(entry => ({ ...entry }));
    const loads = [];
    const chat = { chatId: 'one', chatMetadata: {}, saveMetadataDebounced() {}, loadWorldInfo: async name => {
        loads.push(name);
        return book;
    } };
    writeBookControl(chat, 'one', 'A', { enabled: false });
    writeBookControl(chat, 'one', 'B', { enabled: true });
    writeBookControl(chat, 'one', 'deleted', { enabled: true });
    await applyWorldbookRuntime(lore, chat, ['A', 'B']);
    assert.deepEqual(lore.globalLore, []);
    assert.deepEqual(lore.personaLore, []);
    assert.deepEqual(loads, ['B']);
    assert.deepEqual(lore.chatLore.map(entry => entry.world), ['B', 'B']);
    assert.throws(() => writeBookControl(chat, 'other', 'A', { enabled: true }), /聊天已切换/);
    writeBookControl(chat, 'one', 'A', { enabled: undefined });
    assert.equal(getBookControl(chat.chatMetadata, 'A').enabled, undefined);
    assert.equal(getBookControl({}, 'B').enabled, undefined);
});

test('advanced or concurrently edited groups keep native behavior and reject stale saves', async () => {
    const book = setDrawCount(createBook(), 2);
    book.entries[4].cooldown = 2;
    const lore = loreFor('A', book);
    await applyWorldbookRuntime(lore, { loadWorldInfo: async () => book }, ['A']);
    assert.equal(lore.globalLore.length, 5);
    assert.ok(lore.globalLore.every(entry => entry.group === 'outfits'));
    assert.throws(() => setDrawCount(setDrawCount(createBook(), 2), 3, 1), /包含组已变化/);
});

test('partial groups compose in the current chat without replacing unrelated switches', async () => {
    let book = createBook(4);
    const states = disabled => new Map(Object.values(book.entries).map(entry => [
        entry.uid, captureSnapshotState(entry, disabled.includes(entry.uid)),
    ]));
    book = storeSnapshot(book, '基础', states([3]));
    book = storeSnapshot(book, '末日', states([0, 1]), new Set([0, 1]));
    book = storeSnapshot(book, '星际', states([2]), new Set([1, 2]));
    const [base, first, second] = readSnapshots(book);
    const chat = { chatId: 'one', chatMetadata: {}, saveMetadataDebounced() {}, loadWorldInfo: async () => book };
    assert.deepEqual(Object.keys(first.states), ['0', '1']);
    writeBookControl(chat, 'one', 'A', { snapshot: base.id });
    applyEntryGroup(chat, 'one', 'A', book, first);
    applyEntryGroup(chat, 'one', 'A', book, second);
    const lore = loreFor('A', book);
    await applyWorldbookRuntime(lore, chat, ['A']);
    assert.deepEqual(lore.globalLore.map(entry => entry.disable), [true, false, true, true]);
    assert.ok(Object.values(book.entries).every(entry => !entry.disable));
    writeBookControl(chat, 'one', 'A', { snapshot: undefined, groupStates: undefined });
    assert.equal(Object.keys(getBookControl(chat.chatMetadata, 'A')).length, 0);
    assert.throws(() => storeSnapshot(book, '空组', states([]), new Set()), /请选择/);
});
