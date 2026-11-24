// Console de jeu dans Chrome : les événements sont déclenchés à la main
// (window.__emit) pour simuler une partie.
(() => {
    const listeners = {};
    window.__emit = (name, payload) => (listeners[name] || []).forEach((f) => f({ payload }));
    window.__TAURI__ = {
        core: { invoke: async (cmd) => (cmd === 'crash_report_read' ? '---- Minecraft Crash Report ----\n// Exemple de rapport\n\nDescription: Ticking entity\njava.lang.NullPointerException: test\n\tat net.minecraft.world.Level.tick(Level.java:42)' : null) },
        event: { listen: async (name, f) => { (listeners[name] ||= []).push(f); return () => {}; } },
        window: { getCurrentWindow: () => ({ minimize() {}, close() {} }) },
    };
})();
