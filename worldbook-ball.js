const POSITION_KEY = 'kelaode_worldbook_ball_position';
const DRAG_THRESHOLD = 6;
const MENU_GAP = 9;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function readPosition() {
    try {
        const point = JSON.parse(localStorage.getItem(POSITION_KEY));
        if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
            return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
        }
    } catch {
        // Storage can be unavailable in a private or embedded browser.
    }
    return { x: 1, y: 1 };
}

export function mountWorldbookBall({ widget, ball, menu, shell, composer, closeMenu }) {
    let saved = readPosition();
    let bounds;
    let drag;
    let suppressPointerClick = false;

    function paint() {
        if (!bounds) return;
        const { width, height, size, insetX, insetY, travelX, travelY } = bounds;
        const position = drag?.position ?? saved;
        const x = insetX + position.x * travelX;
        const y = insetY + position.y * travelY;
        widget.style.left = `${x}px`;
        widget.style.top = `${y}px`;

        const menuInset = Math.min(8, width / 4);
        const menuWidth = Math.min(288, width - 2 * menuInset);
        const menuX = clamp(x + size - menuWidth, menuInset, width - menuWidth - menuInset);
        const above = Math.max(0, y - MENU_GAP - insetY);
        const below = Math.max(0, height - y - size - MENU_GAP - insetY);
        const openAbove = above >= below;
        menu.style.width = `${menuWidth}px`;
        menu.style.left = `${menuX - x}px`;
        menu.style.top = openAbove ? 'auto' : `${size + MENU_GAP}px`;
        menu.style.bottom = openAbove ? `${size + MENU_GAP}px` : 'auto';
        menu.style.maxHeight = `${Math.min(380, openAbove ? above : below)}px`;
    }

    function refresh() {
        const width = shell.clientWidth;
        const height = shell.clientHeight - composer.offsetHeight;
        const size = ball.offsetWidth;
        if (!width || height <= 0 || !size) {
            bounds = undefined;
            return;
        }
        const insetX = Math.min(12, Math.max(0, (width - size) / 2));
        const insetY = Math.min(8, Math.max(0, (height - size) / 2));
        bounds = {
            width, height, size, insetX, insetY,
            travelX: Math.max(0, width - size - 2 * insetX),
            travelY: Math.max(0, height - size - 2 * insetY),
        };
        paint();
    }

    ball.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || drag) return;
        suppressPointerClick = false;
        refresh();
        if (!bounds) return;
        ball.setPointerCapture(event.pointerId);
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, position: saved };
    });

    ball.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId || !bounds) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!suppressPointerClick) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            suppressPointerClick = true;
            ball.classList.add('is-dragging');
            closeMenu();
        }
        const { travelX, travelY } = bounds;
        drag.position = {
            x: travelX ? clamp(saved.x + dx / travelX, 0, 1) : saved.x,
            y: travelY ? clamp(saved.y + dy / travelY, 0, 1) : saved.y,
        };
        paint();
    });

    function finish(event, persist) {
        if (drag?.id !== event.pointerId) return;
        if (persist && suppressPointerClick) {
            saved = drag.position;
            try {
                localStorage.setItem(POSITION_KEY, JSON.stringify(saved));
            } catch {
                // Keep the current position for the rest of this page session.
            }
        }
        drag = undefined;
        ball.classList.remove('is-dragging');
        paint();
    }

    ball.addEventListener('pointerup', event => finish(event, true));
    ball.addEventListener('pointercancel', event => finish(event, false));
    ball.addEventListener('lostpointercapture', event => finish(event, false));
    ball.addEventListener('click', event => {
        if (suppressPointerClick && (event.detail || event.pointerType)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            suppressPointerClick = false;
        }
    }, { capture: true });

    const observer = new ResizeObserver(refresh);
    observer.observe(shell);
    observer.observe(composer);
    refresh();
    return refresh;
}
