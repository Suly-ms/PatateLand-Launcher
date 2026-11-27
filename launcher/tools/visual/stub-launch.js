// Remplace les commandes Rust (Tauri) par des données d'exemple, pour
// afficher l'interface du nouveau launcher dans Chrome sans le launcher.
(() => {
    const settings = {
        theme: 'dark', lite_mode: false, memory: null, width: 1280, height: 720, fullscreen: false,
        show_console: false, java_path: null, download_concurrency: 5, close_behavior: 'close-launcher',
        auto_launch: false, start_minimized: false, send_crash_reports: false,
        notify_friend_requests: true, notify_friend_messages: true, selected_instance: 'Opti',
        review_dismissed_accounts: [],
    };
    const accounts = { accounts: [{ id: 'a1', name: 'Kales', kind: 'AZauth', status: 'valid', detail: null, head: 'img/icon.png' }], selected: 'a1' };
    window.__STUB_LOG__ = [];
    const handlers = {
        bootstrap: () => ({
            version: '0.1.0', remote_ok: false, remote_error: 'hors ligne', cached_at: null, maintenance: null,
            auth_mode: 'azauth', auth_site: 'https://patateland.wstr.fr', instances: [{name:'Opti',description:'',allowed:true,installed:true,address:null},{name:'Extra',description:'',allowed:true,installed:true,address:null},{name:'Secret',description:'',allowed:false,installed:false,address:null},{name:'Event',description:'',allowed:true,installed:true,address:null}], selected_instance: 'Opti',
            accounts: accounts.accounts, selected_account: 'a1', settings,
            system: { ram_gb: 16, recommended: { min_gb: 2, max_gb: 6 }, max_allowed_gb: 12, low_ram: false, free_gb: 7.4 },
            running: [], autoplay: false,
        }),
        refresh_accounts: () => accounts,
        instances: () => [{name:'Opti',description:'',allowed:true,installed:true,address:null},{name:'Extra',description:'',allowed:true,installed:true,address:null},{name:'Secret',description:'',allowed:false,installed:false,address:null},{name:'Event',description:'',allowed:true,installed:true,address:null}],
        news: () => { throw 'hors ligne'; },
        server_status: () => null,
        take_last_exit: () => null,
        auto_launch_enabled: () => false,
        update_settings: ({ patch }) => Object.assign(settings, patch),
        packs_list: () => [],
        storage_overview: () => ({ overview: { logs: 1e6, accounts: 1e4, shared: 3e8, runtime: 2e8, instances: 9e8, other: 1e5 }, total: 1.4e9, quarantine: [] }),
        friends: () => null,
    };
    window.__emit = (n, payload) => ((window.__L || {})[n] || []).forEach((f) => f({ payload }));
    window.__TAURI__ = {
        core: {
            invoke: async (cmd, args) => {
                window.__STUB_LOG__.push(cmd);
                if (!(cmd in handlers)) return null;
                return handlers[cmd](args ?? {});
            },
        },
        event: { listen: async (name, f) => { (window.__L ||= {})[name] = [...(window.__L[name] || []), f]; return () => {}; } },
    };
})();
