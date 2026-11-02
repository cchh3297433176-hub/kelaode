import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Production scripts are browser ES modules; load without changing the repo's packaging.
const coreSource = await readFile(new URL('../worldbook-regex-core.js', import.meta.url), 'utf8');
const core = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);
const rule = (extra = {}) => core.normalizeRegex({ id: 'r1', scriptName: '状态栏', findRegex: '/<status>([\\s\\S]*?)<\/status>/g', replaceString: '<div>$1</div>', ...extra });

test('worldbook JSON round trip retains regex options and unrelated extensions', () => {
    const original = { entries: { 0: { uid: 0, content: '世界观' } }, extensions: { other: { value: 7 } }, custom: 'preserve' };
    const regex = rule({ placement: [1, 2, 5], promptOnly: true, minDepth: 2, maxDepth: 5, trimStrings: ['abc'], runOnEdit: false, substituteRegex: 2 });
    const stored = core.writeBundle(original, [regex]);
    const imported = core.importWorldbook(JSON.parse(JSON.stringify(stored)));
    assert.deepEqual(core.readBundle(imported), [regex]);
    assert.deepEqual(imported.extensions.other, { value: 7 });
    assert.equal(imported.custom, 'preserve');
    assert.equal(original.extensions[core.BUNDLE_KEY], undefined);
});

test('native and helper imports preserve enabled state, placement and destinations', () => {
    const [native] = core.parseRegexImport({ regexes: [rule({ disabled: true, markdownOnly: false, placement: [3, 6] })] });
    assert.equal(native.disabled, true);
    assert.deepEqual(native.placement, [3, 6]);
    const [helper] = core.parseRegexImport({ script_name: 'helper', find_regex: '/foo/g', replace_string: '$1', enabled: false,
        source: { ai_output: true, world_info: true }, destination: { display: false, prompt: true }, min_depth: 3 });
    assert.equal(helper.disabled, true);
    assert.equal(helper.markdownOnly, false);
    assert.equal(helper.promptOnly, true);
    assert.equal(helper.minDepth, 3);
    assert.deepEqual(helper.placement, [2, 5]);
});

test('runtime reconciliation removes only owned copies, preserves ordinary ids and order', () => {
    const ordinary = { id: 'ordinary', scriptName: '用户正则' };
    const old = core.runtimeCopies('旧世界', [rule()]);
    const fresh = core.runtimeCopies('新世界', [rule(), rule({ id: 'r2', disabled: true })]);
    const replaced = core.replaceManaged([ordinary, ...old], fresh);
    assert.equal(replaced[0], ordinary);
    assert.equal(replaced.length, 3);
    assert.equal(replaced[1][core.OWNER_KEY].book, '新世界');
    assert.equal(replaced[2].disabled, true);
    assert.equal(new Set(replaced.map(x => x.id)).size, 3);
    assert.deepEqual(core.replaceManaged(replaced, []), [ordinary]);
});

test('invalid files fail before overwrite, old entry-only books remain compatible', () => {
    assert.throws(() => core.normalizeRegex({ findRegex: '/[/g' }));
    assert.throws(() => core.importWorldbook({ entries: {}, extensions: { [core.BUNDLE_KEY]: { version: 99, regexes: [] } } }));
    assert.throws(() => core.importWorldbook([{ uid: 0 }, { uid: 0 }]));
    assert.deepEqual(core.importWorldbook([{ uid: 0, content: 'a' }]), { entries: { 0: { uid: 0, content: 'a' } } });
    assert.deepEqual(core.readBundle({ entries: {} }), []);
});

async function runtime() {
    const state = { globals: ['A'], character: { primary: 'A', additional: ['A'] }, chat: 'A', books: {
        A: core.writeBundle({ entries: {} }, [rule()]), B: core.writeBundle({ entries: {} }, [rule({ id: 'r2' })]),
    }, settings: { regex: [{ id: 'user', scriptName: 'untouched' }, ...core.runtimeCopies('stale', [rule()])] }, persona: {}, waits: {} };
    const context = vm.createContext({ console, structuredClone, crypto, setTimeout, clearTimeout, queueMicrotask,
        document: { getElementById: () => null, querySelectorAll: () => [] }, toastr: { error() {} } });
    const coreModule = new vm.SourceTextModule(coreSource, { context });
    const ctx = { loadWorldInfo: async name => { if (state.waits[name]) await state.waits[name]; return state.books[name]; } };
    const bindings = {
        '../../../extensions.js': { getContext: () => ctx, extension_settings: state.settings },
        '../../../../script.js': { eventSource: { on() {} }, event_types: {}, updateMessageBlock() {} },
        '../../../power-user.js': { power_user: state.persona },
        '../../regex/engine.js': { getRegexScripts: () => state.settings.regex },
        './api.js': { API: { getGlobalBindings: async () => state.globals, getCharBindings: async () => state.character, getChatBinding: async () => state.chat } },
        './state.js': { STATE: {} },
    };
    const modules = new Map();
    for (const [name, exports] of Object.entries(bindings)) modules.set(name, new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context }));
    const module = new vm.SourceTextModule(await readFile(new URL('../worldbook-regex.js', import.meta.url), 'utf8'), { context });
    await module.link(specifier => specifier === './worldbook-regex-core.js' ? coreModule : modules.get(specifier));
    await module.evaluate();
    return { state, sync: module.namespace.synchronize };
}

test('multiple binding sources load a book once; character/chat switches clear stale copies', async () => {
    const { state, sync } = await runtime();
    await sync();
    assert.equal(state.settings.regex.length, 2);
    assert.equal(state.settings.regex[1][core.OWNER_KEY].book, 'A');
    state.globals = []; state.character = { primary: null, additional: [] }; state.chat = 'B';
    await sync();
    assert.equal(state.settings.regex.length, 2);
    assert.equal(state.settings.regex[1][core.OWNER_KEY].book, 'B');
    state.chat = null; await sync();
    assert.equal(state.settings.regex.length, 1);
    assert.equal(state.settings.regex[0].id, 'user');
});

test('late reads from previous chat never overwrite the new chat, concurrent user edits survive', async () => {
    const { state, sync } = await runtime();
    let release;
    state.waits.A = new Promise(resolve => { release = resolve; });
    const oldSync = sync();
    await new Promise(resolve => setImmediate(resolve));
    state.globals = ['B']; state.character = { primary: null, additional: [] }; state.chat = null;
    await sync();
    state.settings.regex.push({ id: 'added-during-sync' });
    release(); await oldSync;
    assert.equal(state.settings.regex.find(core.isManaged)[core.OWNER_KEY].book, 'B');
    assert.ok(state.settings.regex.some(x => x.id === 'added-during-sync'));
});

test('failed book load removes old runtime copies without deleting ordinary rules', async () => {
    const { state, sync } = await runtime();
    await sync(); state.globals = ['missing'];
    await assert.rejects(sync(), /无法读取/);
    assert.equal(state.settings.regex.length, 1);
    assert.equal(state.settings.regex[0].id, 'user');
});

test('persona book participates in reconciliation', async () => {
    const { state, sync } = await runtime();
    state.persona.persona_description_lorebook = 'B'; await sync();
    assert.equal(state.settings.regex.filter(core.isManaged).length, 2);
});

test('pausing linkage clears runtime copies while preserving portable originals', async () => {
    const { state, sync } = await runtime();
    await sync();
    state.settings.kelaode_worldbook_regex_enabled = false;
    await sync();
    assert.equal(state.settings.regex.length, 1);
    assert.equal(core.readBundle(state.books.A).length, 1);
    state.settings.kelaode_worldbook_regex_enabled = true;
    await sync();
    assert.equal(state.settings.regex.length, 2);
});
