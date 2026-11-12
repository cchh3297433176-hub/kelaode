import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worldbook-ball.js', import.meta.url), 'utf8');

async function setup(stored = null) {
    let resize;
    let writes = 0;
    const context = vm.createContext({
        localStorage: {
            getItem: () => stored,
            setItem: (_key, value) => { stored = value; writes++; },
        },
        ResizeObserver: class {
            constructor(callback) { resize = callback; }
            observe() {}
        },
    });
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => {});
    await module.evaluate();
    const events = new Map();
    const widget = { style: {} };
    const menu = { style: {} };
    const shell = { clientWidth: 360, clientHeight: 640 };
    const composer = { offsetHeight: 64 };
    let closed = 0;
    const ball = {
        offsetWidth: 52,
        classList: new Set(),
        setPointerCapture() {},
        addEventListener: (type, listener) => events.set(type, listener),
    };
    ball.classList.remove = ball.classList.delete.bind(ball.classList);
    const refresh = module.namespace.mountWorldbookBall({ widget, ball, menu, shell, composer, closeMenu: () => { closed++; } });
    function pointer(type, clientX, clientY, pointerId = 1) {
        events.get(type)({ isPrimary: pointerId === 1, button: 0, pointerId, clientX, clientY });
    }
    function click(detail, pointerType) {
        let stopped = false;
        events.get('click')({ detail, pointerType, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
        return stopped;
    }
    return { widget, menu, shell, composer, ball, pointer, click, refresh, resize: () => resize(),
        stats: () => ({ closed, writes, position: stored && JSON.parse(stored) }) };
}

test('a tap or small finger movement remains a click', async () => {
    const ball = await setup();
    assert.equal(ball.widget.style.left, '296px');
    assert.equal(ball.widget.style.top, '516px');
    assert.equal(ball.menu.style.bottom, '61px');
    ball.pointer('pointerdown', 320, 540);
    ball.pointer('pointermove', 323, 541);
    ball.pointer('pointerup', 323, 541);
    assert.equal(ball.click(1, 'touch'), false);
    assert.deepEqual(ball.stats(), { closed: 0, writes: 0, position: null });
});

test('dragging clamps the ball, flips the menu, suppresses the pointer click and restores the position on reload', async () => {
    const ball = await setup();
    ball.pointer('pointerdown', 320, 540);
    ball.pointer('pointermove', 0, 0);
    assert.equal(ball.widget.style.left, '12px');
    assert.equal(ball.widget.style.top, '8px');
    assert.equal(ball.menu.style.left, '-4px');
    assert.equal(ball.menu.style.top, '61px');
    assert.equal(ball.stats().writes, 0);
    ball.pointer('pointerup', 0, 0);
    assert.equal(ball.click(0, 'touch'), true);
    assert.equal(ball.click(0, ''), false);
    assert.deepEqual(ball.stats(), { closed: 1, writes: 1, position: { x: 0, y: 0 } });
    const reloaded = await setup(JSON.stringify(ball.stats().position));
    assert.equal(reloaded.widget.style.left, '12px');
    assert.equal(reloaded.widget.style.top, '8px');
});

test('cancelled drags restore the saved position, and a larger composer keeps the ball above the input', async () => {
    const ball = await setup();
    ball.pointer('pointerdown', 320, 540);
    ball.pointer('pointermove', 150, 200);
    ball.pointer('pointercancel', 150, 200);
    assert.equal(ball.widget.style.top, '516px');
    assert.equal(ball.stats().writes, 0);
    ball.shell.clientWidth = 320;
    ball.composer.offsetHeight = 100;
    ball.ball.offsetWidth = 80;
    ball.resize();
    assert.equal(ball.widget.style.left, '228px');
    assert.equal(ball.widget.style.top, '452px');
    assert.equal(ball.menu.style.width, '288px');
});
