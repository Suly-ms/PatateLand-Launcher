// Menu de l'icône (zone de notification), comme l'ancien launcher
// (trayMenu.html) : les actions passent par Rust (src/tray.rs).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const toggle = document.getElementById('toggle-play');
const list = document.getElementById('instances-list');

/// La fenêtre prend la hauteur exacte du menu (« Quitter » jamais coupé).
function fit() {
    // Après la transition du sous-menu (0,18 s), pour mesurer la taille finale.
    requestAnimationFrame(() => invoke('tray_resize', { height: document.querySelector('.tray-menu').getBoundingClientRect().height }));
}

function render(view) {
    document.body.classList.toggle('light', view.light);
    document.body.classList.toggle('dark', !view.light);
    if (!view.instances.length) {
        const empty = document.createElement('div');
        empty.className = 'tray-empty';
        empty.textContent = 'Aucune instance';
        list.replaceChildren(empty);
    } else {
        list.replaceChildren(
            ...view.instances.map((instance) => {
                const item = document.createElement('div');
                item.className = 'tray-submenu-item';
                item.textContent = instance.name;
                if (instance.running) {
                    const badge = document.createElement('span');
                    badge.className = 'tray-running-badge';
                    badge.textContent = 'En cours';
                    item.append(' ', badge);
                }
                item.addEventListener('click', () => invoke('tray_action', { action: `play:${instance.name}` }));
                return item;
            }),
        );
    }
}

async function refresh() {
    // À chaque ouverture, le menu repart replié (comme l'ancien).
    toggle.classList.remove('expanded');
    list.classList.remove('open');
    try {
        render(await invoke('tray_state'));
    } catch {
        // Liste vide : le menu reste utilisable.
    }
    fit();
}

document.querySelectorAll('[data-action]').forEach((item) =>
    item.addEventListener('click', () => invoke('tray_action', { action: item.dataset.action })),
);
toggle.addEventListener('click', () => {
    toggle.classList.toggle('expanded');
    list.classList.toggle('open');
    setTimeout(fit, 190);
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') invoke('tray_hide');
});
document.addEventListener('contextmenu', (event) => event.preventDefault());

listen('tray-refresh', refresh);
refresh();
