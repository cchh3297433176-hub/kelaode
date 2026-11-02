// Portable data only. This module has no dependency on the Tavern UI.
export const BUNDLE_KEY = 'kelaode_worldbook_regex';
export const OWNER_KEY = 'kelaodeWorldbookRegex';
export const ID_PREFIX = 'kelaode-wbr:';

export function createRegexId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    // getRandomValues also works on HTTP Tavern installations.
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeRegex(input, makeId = createRegexId) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('正则必须是对象');
    const findRegex = input.findRegex ?? input.find_regex;
    if (typeof findRegex !== 'string' || !findRegex.trim()) throw new Error('缺少查找表达式');
    // Match Tavern's /pattern/flags and bare-pattern formats.
    const literal = findRegex.match(/^\/(.*)\/([a-z]*)$/s);
    new RegExp(literal ? literal[1] : findRegex, literal ? literal[2] : '');
    const source = input.source;
    const destination = input.destination;
    const placement = input.placement ?? (source ? [source.user_input && 1, source.ai_output && 2,
        source.slash_command && 3, source.world_info && 5, source.reasoning && 6].filter(Boolean) : [2]);
    if (!Array.isArray(placement) || !placement.every(n => [1, 2, 3, 5, 6].includes(n))) throw new Error('正则作用位置无效');
    const result = {
        ...structuredClone(input),
        id: typeof input.id === 'string' && input.id && !input.id.startsWith(ID_PREFIX) ? input.id : makeId(),
        scriptName: String(input.scriptName ?? input.script_name ?? '未命名正则'),
        findRegex,
        replaceString: String(input.replaceString ?? input.replace_string ?? ''),
        trimStrings: Array.isArray(input.trimStrings ?? input.trim_strings) ? (input.trimStrings ?? input.trim_strings).map(String) : [],
        placement,
        disabled: !!(input.disabled ?? (input.enabled === false)),
        markdownOnly: input.markdownOnly ?? (destination ? !!destination.display : true),
        promptOnly: input.promptOnly ?? (destination ? !!destination.prompt : false),
        runOnEdit: input.runOnEdit ?? input.run_on_edit ?? true,
        substituteRegex: input.substituteRegex ?? 0,
        minDepth: input.minDepth ?? input.min_depth ?? null,
        maxDepth: input.maxDepth ?? input.max_depth ?? null,
    };
    if (![0, 1, 2].includes(result.substituteRegex)) throw new Error('宏替换模式无效');
    for (const key of ['minDepth', 'maxDepth']) {
        if (result[key] !== null && (!Number.isInteger(result[key]) || result[key] < -1)) throw new Error('深度必须是整数或 null');
    }
    delete result[OWNER_KEY];
    delete result.scope;
    return result;
}

export function parseRegexImport(value) {
    const list = Array.isArray(value) ? value : value?.regexes ?? value?.regex_scripts ?? [value];
    if (!Array.isArray(list)) throw new Error('未找到正则列表');
    return list.map(item => normalizeRegex(item));
}

export function readBundle(book) {
    const bundle = book?.extensions?.[BUNDLE_KEY];
    if (!bundle) return [];
    if (bundle.version !== 1 || !Array.isArray(bundle.regexes)) throw new Error('不支持的世界书正则数据版本');
    const scripts = bundle.regexes.map(item => normalizeRegex(item));
    if (new Set(scripts.map(item => item.id)).size !== scripts.length) throw new Error('世界书内存在重复正则 ID');
    return scripts;
}

export function writeBundle(book, regexes) {
    const copy = structuredClone(book);
    copy.extensions = { ...copy.extensions, [BUNDLE_KEY]: { version: 1, regexes: regexes.map(item => normalizeRegex(item)) } };
    return copy;
}

export function isManaged(script) {
    return typeof script?.id === 'string' && script.id.startsWith(ID_PREFIX);
}

export function runtimeCopies(bookName, scripts) {
    return scripts.map((script, index) => ({ ...structuredClone(script),
        id: `${ID_PREFIX}${encodeURIComponent(bookName)}:${encodeURIComponent(script.id)}:${index}`,
        [OWNER_KEY]: { book: bookName, sourceId: script.id },
    }));
}

export function replaceManaged(existing, copies) {
    return [...existing.filter(script => !isManaged(script)), ...copies];
}

export function importWorldbook(value) {
    if (!value || typeof value !== 'object') throw new Error('无效的世界书文件');
    const data = Array.isArray(value) ? { entries: value } : structuredClone(value);
    if (!data.entries || typeof data.entries !== 'object') throw new Error('世界书缺少 entries');
    const entries = {};
    Object.entries(data.entries).forEach(([key, entry]) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('无效的世界书条目');
        const uid = entry.uid ?? Number(key);
        if (!Number.isInteger(uid) || uid < 0 || Object.hasOwn(entries, uid)) throw new Error('世界书条目 UID 无效或重复');
        entries[uid] = { ...entry, uid };
    });
    data.entries = entries;
    readBundle(data); // Validate before replacing an existing book.
    return data;
}
