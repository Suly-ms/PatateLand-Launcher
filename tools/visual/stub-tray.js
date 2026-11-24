// Données d'exemple pour afficher le menu de l'icône dans Chrome (sans Rust).
(() => {
    const light = location.search.includes('light');
    window.__TAURI__ = {
        core: {
            invoke: async (cmd, args) => {
                if (cmd === 'tray_state') return { light, instances: [{ name: 'Opti', running: true }, { name: 'Extra', running: false }, { name: 'Event', running: false }] };
                if (cmd === 'tray_resize') window.__trayHeight = args.height;
                return null;
            },
        },
        event: { listen: async () => () => {} },
    };
})();
