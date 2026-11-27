// Données d'exemple pour afficher l'installateur dans Chrome (sans Rust) :
// cas le plus chargé, avec l'ancien launcher détecté.
(() => {
    window.__TAURI__ = {
        core: {
            invoke: async (cmd) => {
                if (cmd === 'info') {
                    return {
                        version: '2.0.1', complete: true, download_mb: 14, disk_mb: 26.3,
                        dir: 'C:\\Users\\joueur\\AppData\\Local\\PatateLand', update: true, previous_version: '2.0.0',
                        desktop: true, start_menu: true, autostart: false, lite: false,
                        old_launcher: null, auto: true,
                    };
                }
                return null;
            },
        },
        event: { listen: async () => () => {} },
    };
})();
