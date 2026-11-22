// Système d'amis et chat : même interface et mêmes comportements que
// l'ancien launcher (src/assets/js/panels/friends.js).
//
// Différences voulues :
// - les appels au site passent par Rust (commande `friends`) : le jeton du
//   compte n'est jamais dans l'interface ;
// - pseudos, avatars et messages sont insérés comme du texte (jamais comme
//   du HTML) : un pseudo ou un message ne peut pas exécuter de code ;
// - présence, non-lus et notifications sont gérés par Rust (src/friends.rs),
//   y compris fenêtre fermée pendant une partie.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ===== TRADUCTION DES ÉMOTICÔNES TEXTE (:p, :), <3, etc.), à l'envoi =====
const EMOTICON_MAP = [
    [/(?<=^|\s):'\((?=$|\s)/g, '😢'],
    [/(?<=^|\s):-?\)(?=$|\s)/g, '🙂'],
    [/(?<=^|\s):-?\((?=$|\s)/g, '🙁'],
    [/(?<=^|\s):-?[pP](?=$|\s)/g, '😛'],
    [/(?<=^|\s):-?[dD](?=$|\s)/g, '😄'],
    [/(?<=^|\s);-?\)(?=$|\s)/g, '😉'],
    [/(?<=^|\s)<3(?=$|\s)/g, '❤️'],
    [/(?<=^|\s):-?[oO](?=$|\s)/g, '😮'],
    [/(?<=^|\s)[xX][dD](?=$|\s)/g, '😆'],
    [/(?<=^|\s):\|(?=$|\s)/g, '😐'],
];

export function translateEmoticons(text) {
    return EMOTICON_MAP.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

const EMOJI_CATEGORIES = {
    Smileys: [
        '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
        '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚',
        '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
        '🫢', '🫣', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶',
        '🫥', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤',
        '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴',
        '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤',
        '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '🥹', '😦',
        '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞',
        '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿',
        '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖',
    ],
    Gestes: [
        '👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌',
        '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉',
        '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊', '🤛',
        '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '💅', '🤳',
        '💪', '🦾', '🦵', '🦿', '🦶', '👂', '🦻', '👃', '🧠', '👀',
        '👁️', '👅', '👄',
    ],
    Coeurs: [
        '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
        '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟',
        '♥️', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💣', '💬',
        '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤',
    ],
    Animaux: [
        '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
        '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔',
        '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴',
        '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🐢', '🐍',
        '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠',
        '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍',
        '🦧', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🐃', '🐂',
        '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩',
        '🦮', '🐈', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️',
    ],
    Nourriture: [
        '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
        '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑',
        '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅',
        '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳',
        '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟',
        '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🍿',
        '🧂', '🥫', '🍱', '🍘', '🍙', '🍚', '🍛', '🍜', '🍝', '🍠',
        '🍢', '🍣', '🍤', '🍥', '🥮', '🍡', '🥟', '🥠', '🥡', '🦀',
        '🍦', '🍧', '🍨', '🍩', '🍪', '🎂', '🍰', '🧁', '🥧', '🍫',
        '🍬', '🍭', '🍮', '🍯', '🍼', '🥛', '☕', '🫖', '🍵', '🍶',
        '🍾', '🍷', '🍸', '🍹', '🍺', '🍻', '🥂', '🥃', '🥤', '🧋',
    ],
    Activités: [
        '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
        '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳',
        '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷',
        '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️',
        '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗',
        '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️',
        '🎮', '🕹️', '🎲', '♟️', '🧩', '🎯', '🎳', '🎰', '🧨', '🎆',
        '🎇', '🧧', '🎐', '🎏', '🎀', '🎁', '🎫', '🎟️', '⚔️', '🛡️',
        '🗡️', '🪓', '🔫',
    ],
    Objets: [
        '⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💽', '💾', '💿',
        '📀', '📷', '📸', '📹', '🎥', '📞', '☎️', '📟', '📠', '📺',
        '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛',
        '⏳', '📡', '🔋', '🪫', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯',
        '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎',
        '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚',
        '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓',
        '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🗿', '🪧',
    ],
    Symboles: [
        '✨', '🔥', '⭐', '🌟', '💫', '⚡', '☀️', '🌤️', '⛅', '🌦️',
        '🌧️', '⛈️', '🌩️', '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️',
        '🌈', '☂️', '☔', '⚠️', '🚫', '❌', '⭕', '✅', '☑️', '✔️',
        '❓', '❔', '❗', '❕', '‼️', '⁉️', '🔞', '📵', '🚭', '♻️',
        '💲', '💱', '™️', '©️', '®️', '🆗', '🆕', '🆒', '🆓', '🆙',
    ],
};

const STEVE_HEAD = 'https://mc-heads.net/avatar/MHF_Steve/64';
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- Petits outils DOM (texte uniquement) ----------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function svg(viewBox, size, paths, attrs = {}) {
    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('viewBox', viewBox);
    root.setAttribute('width', size);
    root.setAttribute('height', size);
    for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
    for (const p of paths) {
        const node = document.createElementNS(SVG_NS, p.tag ?? 'path');
        for (const [k, v] of Object.entries(p)) if (k !== 'tag') node.setAttribute(k, v);
        root.append(node);
    }
    return root;
}

const chatIcon = () => svg('0 0 24 24', 14, [{ d: 'M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4l4 4 4-4h4c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z' }], { fill: 'currentColor' });
const expandIcon = () => svg('0 0 24 24', 14, [{ d: 'M4 4h6V2H2v8h2V4zm16 0v6h2V2h-8v2h6zM4 20v-6H2v8h8v-2H4zm16-6v6h-6v2h8v-8h-2z' }], { fill: 'currentColor' });
const emojiIcon = () =>
    svg(
        '0 0 24 24',
        20,
        [
            { tag: 'circle', cx: 12, cy: 12, r: 9 },
            { tag: 'circle', cx: 9, cy: 10, r: 1, fill: 'currentColor', stroke: 'none' },
            { tag: 'circle', cx: 15, cy: 10, r: 1, fill: 'currentColor', stroke: 'none' },
            { d: 'M8 14c1 1.5 2.5 2.3 4 2.3s3-0.8 4-2.3', 'stroke-linecap': 'round' },
        ],
        { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 },
    );

/// Avatar envoyé par le site : seulement une image https, sinon Steve.
function avatarImg(className, url, alt) {
    const img = el('img', className);
    img.alt = alt ?? '';
    img.src = typeof url === 'string' && url.startsWith('https://') ? url : STEVE_HEAD;
    img.addEventListener('error', () => {
        if (img.src !== STEVE_HEAD) img.src = STEVE_HEAD;
    });
    return img;
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

// ---------- Module ----------

const f = {
    enabled: false,
    flyout: null,
    profileModal: null,
    chatWindows: new Map(),
    counts: { unread: {}, unreadTotal: 0, requests: 0 },
    dialog: null,
};

async function api(action) {
    try {
        return await invoke('friends', { action });
    } catch (error) {
        // Saisie refusée par Rust (pseudo vide, message trop long…).
        return { ok: false, status: 0, data: { message: String(error) } };
    }
}

function errorPopup(message) {
    f.dialog?.('Erreur', [message]);
}

// ---------- Flyout ----------

function section(key, label) {
    const box = el('div', 'friends-section');
    box.dataset.section = key;
    const header = el('div', 'friends-section-header');
    header.append(el('span', 'friends-section-label', label), el('span', 'friends-section-count', '0'), el('span', 'friends-section-chevron', '▾'));
    header.addEventListener('click', () => box.classList.toggle('collapsed'));
    const list = el('div', `friends-section-list friends-${key}-list`);
    box.append(header, list);
    return box;
}

function buildFlyout() {
    const flyout = el('div', 'friends-flyout');

    const header = el('div', 'friends-flyout-header');
    const close = el('div', 'friends-flyout-close', '✕');
    close.addEventListener('click', closeFlyout);
    header.append(el('div', 'friends-flyout-title', 'Amis'), close);

    const addBox = el('div', 'friends-add-box');
    const addInput = el('input', 'friends-add-input');
    addInput.type = 'text';
    addInput.placeholder = 'Ajouter un ami par pseudo...';
    addInput.maxLength = 32;
    const addBtn = el('button', 'friends-add-btn', 'Ajouter');
    const add = async () => {
        const username = addInput.value.trim();
        if (!username) return;
        const result = await api({ type: 'add', username });
        if (!result) return errorPopup('Impossible de contacter le serveur.');
        if (!result.ok) return errorPopup(str(result.data?.message) || 'Une erreur est survenue.');
        addInput.value = '';
        await loadSentRequests();
    };
    addBtn.addEventListener('click', add);
    addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.stopPropagation();
            add();
        }
    });
    addBox.append(addInput, addBtn);

    const searchBox = el('div', 'friends-search-box');
    const search = el('input', 'friends-search-input');
    search.type = 'text';
    search.placeholder = 'Rechercher dans les amis...';
    search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        flyout.querySelectorAll('.friends-online-list .friends-item, .friends-offline-list .friends-item').forEach((item) => {
            item.classList.toggle('hidden', !(item.dataset.username ?? '').toLowerCase().includes(query));
        });
    });
    searchBox.append(search);

    const body = el('div', 'friends-flyout-body content-scroll');
    body.append(section('online', 'En ligne'), section('offline', 'Hors ligne'), section('requests', 'Demandes reçues'), section('sent', 'Envoyées'));

    flyout.append(header, addBox, searchBox, body);
    document.body.append(flyout);
    f.flyout = flyout;

    // Fermeture au clic ailleurs (comme Epic / Discord).
    document.addEventListener('click', (e) => {
        if (!flyout.classList.contains('open')) return;
        if (flyout.contains(e.target) || document.getElementById('friends-btn').contains(e.target)) return;
        closeFlyout();
    });
}

function openFlyout() {
    f.flyout.classList.add('open');
    reloadAll();
}

function closeFlyout() {
    f.flyout?.classList.remove('open');
}

function setSectionCount(key, count) {
    const box = f.flyout.querySelector(`.friends-section[data-section="${key}"]`);
    box.querySelector('.friends-section-count').textContent = count;
    // « En ligne » / « Hors ligne » toujours visibles, le reste seulement s'il y a quelque chose.
    box.classList.toggle('hidden', count === 0 && key !== 'online' && key !== 'offline');
}

async function reloadAll() {
    await loadFriends();
    await loadRequests();
    await loadSentRequests();
}

function friendItem(friend) {
    const id = str(friend.id);
    const username = str(friend.username);
    const item = el('div', 'friends-item');
    item.dataset.username = username;
    item.append(el('span', `friends-online-dot${friend.online ? ' online' : ''}`));

    const clickable = el('div', 'friends-item-clickable');
    clickable.append(avatarImg('friends-avatar', friend.avatar, username), el('span', 'friends-username', username));
    clickable.addEventListener('click', () => openProfile(id, username));

    const chat = el('span', 'friends-chat-btn');
    chat.title = 'Message';
    chat.dataset.id = id;
    chat.append(chatIcon());
    chat.addEventListener('click', (e) => {
        e.stopPropagation();
        openChat(id, username, friend.avatar);
    });

    const remove = el('span', 'friends-remove-btn', 'Retirer');
    remove.addEventListener('click', async () => {
        const result = await api({ type: 'remove', id });
        if (result?.ok) await loadFriends();
    });

    item.append(clickable, chat, remove);
    return item;
}

async function loadFriends() {
    const online = f.flyout.querySelector('.friends-online-list');
    const offline = f.flyout.querySelector('.friends-offline-list');
    const result = await api({ type: 'list' });
    if (!result?.ok || !Array.isArray(result.data)) {
        online.replaceChildren(el('div', 'friends-empty', "Impossible de charger la liste d'amis."));
        offline.replaceChildren();
        setSectionCount('online', 0);
        setSectionCount('offline', 0);
        return;
    }
    const on = result.data.filter((x) => x.online);
    const off = result.data.filter((x) => !x.online);
    setSectionCount('online', on.length);
    setSectionCount('offline', off.length);
    updateFrameBadge(on.length, result.data.length);
    online.replaceChildren(...(on.length ? on.map(friendItem) : [el('div', 'friends-empty', 'Personne en ligne.')]));
    offline.replaceChildren(...(off.length ? off.map(friendItem) : [el('div', 'friends-empty', 'Aucun ami hors ligne.')]));
    paintUnread();
}

function requestItem(avatar, username, buttons) {
    const item = el('div', 'friends-item');
    item.append(avatarImg('friends-avatar', avatar, username), el('span', 'friends-username', username), ...buttons);
    return item;
}

function actionButton(className, label, run) {
    const button = el('span', className, label);
    button.addEventListener('click', run);
    return button;
}

async function loadRequests() {
    const list = f.flyout.querySelector('.friends-requests-list');
    const result = await api({ type: 'requests' });
    if (!result?.ok || !Array.isArray(result.data)) {
        list.replaceChildren(el('div', 'friends-empty', 'Impossible de charger les demandes.'));
        setSectionCount('requests', 0);
        return;
    }
    f.counts.requests = result.data.length;
    updateNotifBadge();
    setSectionCount('requests', result.data.length);
    list.replaceChildren(
        ...result.data.map((req) => {
            const id = str(req.id);
            return requestItem(req.sender_avatar, str(req.sender_username), [
                actionButton('friends-accept-btn', 'Accepter', async () => {
                    if ((await api({ type: 'accept', id }))?.ok) await reloadAll();
                }),
                actionButton('friends-decline-btn', 'Refuser', async () => {
                    if ((await api({ type: 'decline', id }))?.ok) await loadRequests();
                }),
            ]);
        }),
    );
}

async function loadSentRequests() {
    const list = f.flyout.querySelector('.friends-sent-list');
    const result = await api({ type: 'sent' });
    if (!result?.ok || !Array.isArray(result.data)) {
        list.replaceChildren(el('div', 'friends-empty', 'Impossible de charger les demandes envoyées.'));
        setSectionCount('sent', 0);
        return;
    }
    setSectionCount('sent', result.data.length);
    list.replaceChildren(
        ...result.data.map((req) => {
            const id = str(req.id);
            return requestItem(req.receiver_avatar, str(req.receiver_username), [
                el('span', 'friends-status-pending', 'En attente'),
                actionButton('friends-decline-btn', 'Annuler', async () => {
                    if ((await api({ type: 'decline', id }))?.ok) await loadSentRequests();
                }),
            ]);
        }),
    );
}

// ---------- Pastilles (barre de titre et boutons de chat) ----------

function updateFrameBadge(online, total) {
    const badge = document.getElementById('friends-online-badge');
    badge.classList.toggle('hidden', total === 0);
    badge.textContent = `${online}/${total}`;
}

/// Pastille rouge : demandes reçues + messages non lus.
function updateNotifBadge() {
    const badge = document.getElementById('friends-notif-badge');
    const total = f.counts.requests + f.counts.unreadTotal;
    badge.classList.toggle('hidden', total === 0);
    badge.textContent = total > 99 ? '99+' : String(total);
}

function paintUnread() {
    f.flyout?.querySelectorAll('.friends-chat-btn').forEach((btn) => {
        const count = f.counts.unread[btn.dataset.id] ?? 0;
        let badge = btn.querySelector('.friends-chat-unread');
        if (count > 0) {
            if (!badge) {
                badge = el('span', 'friends-chat-unread');
                btn.append(badge);
            }
            badge.textContent = count > 9 ? '9+' : String(count);
        } else {
            badge?.remove();
        }
    });
}

/// Envoyé par Rust toutes les 30 s (src/friends.rs).
function onBadges(b) {
    if (!f.enabled) return;
    if (!b.available) {
        document.getElementById('friends-online-badge').classList.add('hidden');
        document.getElementById('friends-notif-badge').classList.add('hidden');
        return;
    }
    f.counts.unread = b.unread ?? {};
    f.counts.unreadTotal = b.unread_total ?? 0;
    f.counts.requests = b.requests ?? 0;
    updateFrameBadge(b.online ?? 0, b.total ?? 0);
    updateNotifBadge();
    paintUnread();
}

// ---------- Fenêtres de chat (plusieurs à la fois, façon Messenger) ----------

function insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
}

function buildChatWindow(id, username, avatar) {
    const chat = el('div', 'friends-chat-window open');
    chat.dataset.friendId = id;

    const header = el('div', 'friends-chat-header');
    const minimize = el('span', 'friends-chat-minimize', '–');
    minimize.title = 'Réduire';
    const expand = el('span', 'friends-chat-expand');
    expand.title = 'Agrandir';
    expand.append(expandIcon());
    const close = el('span', 'friends-chat-close', '✕');
    header.append(
        avatarImg('friends-chat-avatar', avatar || `https://mc-heads.net/avatar/${encodeURIComponent(username)}/32`, ''),
        el('span', 'friends-chat-username', username),
        minimize,
        expand,
        close,
    );

    const messages = el('div', 'friends-chat-messages content-scroll');
    const typing = el('div', 'friends-chat-typing hidden', 'écrit ');
    const dots = el('span', 'friends-chat-typing-dots');
    dots.append(el('span'), el('span'), el('span'));
    typing.append(dots);

    const emojiPanel = el('div', 'friends-chat-emoji-panel');
    const emojiGrid = el('div', 'friends-chat-emoji-grid content-scroll');
    for (const [name, emojis] of Object.entries(EMOJI_CATEGORIES)) {
        emojiGrid.append(el('div', 'friends-chat-emoji-section-title', name), ...emojis.map((e) => el('span', 'friends-chat-emoji-item', e)));
    }
    emojiPanel.append(emojiGrid);

    const inputBox = el('div', 'friends-chat-input-box');
    const emojiBtn = el('button', 'friends-chat-emoji-btn');
    emojiBtn.type = 'button';
    emojiBtn.title = 'Émojis';
    emojiBtn.append(emojiIcon());
    const input = el('input', 'friends-chat-input');
    input.type = 'text';
    input.placeholder = 'Écrire un message...';
    input.maxLength = 2000;
    const send = el('button', 'friends-chat-send', 'Envoyer');
    inputBox.append(emojiBtn, input, send);

    chat.append(header, messages, typing, emojiPanel, inputBox);
    chat.style.width = '300px';
    chat.style.height = '400px';
    document.body.append(chat);

    close.addEventListener('click', () => closeChat(id));
    minimize.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMinimize(id);
    });
    expand.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExpand(id);
    });
    header.addEventListener('click', (e) => {
        if (e.target.closest('.friends-chat-close, .friends-chat-expand, .friends-chat-minimize')) return;
        if (f.chatWindows.get(id)?.minimized) toggleMinimize(id);
    });

    send.addEventListener('click', () => sendMessage(id));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.stopPropagation();
            sendMessage(id);
        }
    });
    // « En train d'écrire » : au plus une fois toutes les 2 s.
    input.addEventListener('input', () => {
        const state = f.chatWindows.get(id);
        if (!state) return;
        const now = Date.now();
        if (state.lastTypingPingAt && now - state.lastTypingPingAt < 2000) return;
        state.lastTypingPingAt = now;
        api({ type: 'typing', id });
    });

    emojiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        emojiPanel.classList.toggle('open');
    });
    emojiGrid.addEventListener('click', (e) => {
        const item = e.target.closest('.friends-chat-emoji-item');
        if (item) insertAtCursor(input, item.textContent);
    });
    chat.addEventListener('click', (e) => {
        if (!emojiPanel.contains(e.target) && !emojiBtn.contains(e.target)) emojiPanel.classList.remove('open');
    });

    wireDrag(chat, header, id);
    return chat;
}

/// Empile les fenêtres de droite à gauche ; une fenêtre déplacée à la main garde sa place.
function layoutChatWindows() {
    let right = 12;
    for (const [id, state] of f.chatWindows) {
        const width = state.minimized ? 200 : state.expanded ? 460 : 300;
        const height = state.minimized ? 44 : state.expanded ? 600 : 400;
        if (!state.userMoved) {
            state.offsetRight = right;
            state.offsetBottom = 12;
            right += width + 10;
        }
        placeChat(id, width, height);
    }
}

function placeChat(id, width, height) {
    const state = f.chatWindows.get(id);
    if (!state) return;
    let left = window.innerWidth - state.offsetRight - width;
    let top = window.innerHeight - state.offsetBottom - height;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    state.el.style.left = `${left}px`;
    state.el.style.top = `${top}px`;
}

function wireDrag(chat, header, id) {
    let dragging = false;
    let startX, startY, startLeft, startTop;
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.friends-chat-close, .friends-chat-expand, .friends-chat-minimize')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = chat.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const left = Math.max(-chat.offsetWidth + 80, Math.min(startLeft + (e.clientX - startX), window.innerWidth - 80));
        const top = Math.max(0, Math.min(startTop + (e.clientY - startY), window.innerHeight - 40));
        chat.style.left = `${left}px`;
        chat.style.top = `${top}px`;
        const state = f.chatWindows.get(id);
        if (state) {
            state.offsetRight = window.innerWidth - left - chat.offsetWidth;
            state.offsetBottom = window.innerHeight - top - chat.offsetHeight;
            state.userMoved = true;
        }
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
    });
}

function toggleExpand(id) {
    const state = f.chatWindows.get(id);
    if (!state) return;
    state.expanded = !state.expanded;
    const btn = state.el.querySelector('.friends-chat-expand');
    btn.classList.toggle('active', state.expanded);
    btn.title = state.expanded ? 'Réduire' : 'Agrandir';
    state.el.style.width = state.expanded ? '460px' : '300px';
    state.el.style.height = state.expanded ? '600px' : '400px';
    layoutChatWindows();
}

function toggleMinimize(id) {
    const state = f.chatWindows.get(id);
    if (!state) return;
    state.minimized = !state.minimized;
    state.el.classList.toggle('minimized', state.minimized);
    state.el.querySelector('.friends-chat-minimize').title = state.minimized ? 'Restaurer' : 'Réduire';
    layoutChatWindows();
}

function openChat(id, username, avatar) {
    const existing = f.chatWindows.get(id);
    if (existing) {
        if (existing.minimized) toggleMinimize(id);
        return;
    }
    const state = {
        el: buildChatWindow(id, username, avatar),
        poll: null,
        minimized: false,
        expanded: false,
        userMoved: false,
        offsetRight: 12,
        offsetBottom: 12,
        username,
        lastTypingPingAt: null,
        // undefined : premier chargement, jamais de notification pour l'historique.
        lastNotifiedId: undefined,
    };
    f.chatWindows.set(id, state);
    state.el.querySelector('.friends-chat-messages').replaceChildren(el('div', 'friends-empty', 'Chargement...'));
    layoutChatWindows();
    loadMessages(id);
    // Pas de WebSocket côté site : relecture toutes les 6 s, propre à chaque conversation.
    state.poll = setInterval(() => loadMessages(id), 6000);
}

function closeChat(id) {
    const state = f.chatWindows.get(id);
    if (!state) return;
    clearInterval(state.poll);
    state.el.remove();
    f.chatWindows.delete(id);
    layoutChatWindows();
}

function newer(a, b) {
    // Identifiants numériques du site, comparés comme nombres si possible.
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na > nb : String(a) > String(b);
}

async function loadMessages(id) {
    const state = f.chatWindows.get(id);
    if (!state) return;
    const result = await api({ type: 'messages', id });
    if (!f.chatWindows.has(id)) return;
    const list = state.el.querySelector('.friends-chat-messages');
    const typing = state.el.querySelector('.friends-chat-typing');
    if (!result?.ok || !Array.isArray(result.data?.messages)) {
        list.replaceChildren(el('div', 'friends-empty', 'Impossible de charger la conversation.'));
        typing.classList.add('hidden');
        return;
    }
    const { messages } = result.data;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 10;

    // Conversation ouverte mais fenêtre cachée : le site marque ces messages
    // lus, ils n'apparaissent donc pas dans les non-lus. Notification ici.
    const newest = messages.length ? messages[messages.length - 1].id : null;
    if (state.lastNotifiedId === undefined) {
        state.lastNotifiedId = newest;
    } else if (document.visibilityState !== 'visible' && messages.length) {
        const fresh = messages.filter((m) => !m.mine && (state.lastNotifiedId === null || newer(m.id, state.lastNotifiedId)));
        if (fresh.length) invoke('friends_notify', { from: state.username, message: str(fresh[fresh.length - 1].content) }).catch(() => {});
    }
    if (newest !== null && (state.lastNotifiedId === null || newer(newest, state.lastNotifiedId))) state.lastNotifiedId = newest;

    // Statut « Envoyé » / « Vu » sous le tout dernier message envoyé.
    let lastMine = -1;
    messages.forEach((m, i) => {
        if (m.mine) lastMine = i;
    });
    if (!messages.length) {
        list.replaceChildren(el('div', 'friends-empty', "Aucun message pour l'instant, dis bonjour !"));
    } else {
        const nodes = [];
        messages.forEach((m, i) => {
            nodes.push(el('div', `friends-chat-bubble ${m.mine ? 'mine' : 'theirs'}`, str(m.content)));
            if (m.mine && i === lastMine) {
                const status = el('div', 'friends-chat-status', m.read ? 'Vu' : 'Envoyé');
                status.append(el('span', `friends-chat-status-dot ${m.read ? 'read' : 'sent'}`));
                nodes.push(status);
            }
        });
        list.replaceChildren(...nodes);
    }
    typing.classList.toggle('hidden', !result.data.typing);
    if (atBottom) list.scrollTop = list.scrollHeight;
}

async function sendMessage(id) {
    const state = f.chatWindows.get(id);
    if (!state) return;
    const input = state.el.querySelector('.friends-chat-input');
    const content = translateEmoticons(input.value.trim());
    if (!content) return;
    input.value = '';
    state.el.querySelector('.friends-chat-emoji-panel').classList.remove('open');
    const result = await api({ type: 'send', id, content });
    if (!result?.ok) {
        errorPopup(str(result?.data?.message) || 'Message non envoyé.');
        return;
    }
    await loadMessages(id);
}

// ---------- Profil d'un ami ----------

function buildProfileModal() {
    const modal = el('div', 'friends-profile-modal');
    const backdrop = el('div', 'friends-profile-backdrop');
    const card = el('div', 'friends-profile-card');
    const close = el('div', 'friends-profile-close', '✕');
    const render = el('img', 'friends-profile-render');
    render.addEventListener('error', () => {
        // Repli sur Steve si le skin est introuvable.
        if (render.dataset.stage !== '1') {
            render.dataset.stage = '1';
            render.src = 'https://mc-heads.net/body/MHF_Steve/300';
        }
    });
    const info = el('div', 'friends-profile-info');
    const date = el('div', 'friends-profile-info-item');
    date.append(el('span', '', '📅'), el('span', 'friends-profile-date', '...'));
    const uuid = el('div', 'friends-profile-info-item');
    uuid.append(el('span', '', '#'), el('span', 'friends-profile-uuid', '...'));
    info.append(date, uuid);
    card.append(close, render, el('div', 'friends-profile-username'), info);
    modal.append(backdrop, card);
    document.body.append(modal);
    close.addEventListener('click', () => modal.classList.remove('open'));
    backdrop.addEventListener('click', () => modal.classList.remove('open'));
    f.profileModal = modal;
}

function frenchDate(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return 'Inconnue';
    const day = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${day} à ${time}`;
}

async function openProfile(id, username) {
    if (!f.profileModal) buildProfileModal();
    const modal = f.profileModal;
    const render = modal.querySelector('.friends-profile-render');
    render.dataset.stage = '0';
    render.alt = username;
    render.src = `https://mc-heads.net/body/${encodeURIComponent(username)}/300`;
    modal.querySelector('.friends-profile-username').textContent = username;
    modal.querySelector('.friends-profile-date').textContent = 'Chargement...';
    modal.querySelector('.friends-profile-uuid').textContent = 'Chargement...';
    modal.classList.add('open');
    const result = await api({ type: 'profile', id });
    const ok = result?.ok && result.data;
    modal.querySelector('.friends-profile-date').textContent = ok ? frenchDate(result.data.created_at) : 'Indisponible';
    modal.querySelector('.friends-profile-uuid').textContent = ok ? str(result.data.uuid) || 'Inconnue' : 'Indisponible';
}

// ---------- Entrée ----------

/// `dialog` : fenêtre d'erreur du launcher.
export function initFriends({ dialog }) {
    f.dialog = dialog;
    buildFlyout();
    document.getElementById('friends-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (f.flyout.classList.contains('open')) closeFlyout();
        else openFlyout();
    });
    window.addEventListener('resize', layoutChatWindows);
    listen('friends-badges', (e) => onBadges(e.payload));
}

/// Compte sélectionné : le bouton Amis n'existe que pour un compte du site.
export function setFriendsAccount(account) {
    const enabled = account?.kind === 'AZauth';
    const changed = f.enabled !== enabled || f.accountId !== account?.id;
    f.enabled = enabled;
    f.accountId = account?.id;
    document.getElementById('friends-frame').classList.toggle('hidden', !enabled);
    if (!changed) return;
    // Autre compte : on repart de zéro (conversations et pastilles).
    for (const id of [...f.chatWindows.keys()]) closeChat(id);
    closeFlyout();
    f.counts = { unread: {}, unreadTotal: 0, requests: 0 };
    document.getElementById('friends-online-badge').classList.add('hidden');
    document.getElementById('friends-notif-badge').classList.add('hidden');
    if (enabled) {
        // Pastilles dès l'ouverture, sans attendre la tâche de fond.
        reloadAll();
        api({ type: 'unread' }).then((r) => {
            if (!r?.ok || !Array.isArray(r.data)) return;
            const unread = {};
            for (const row of r.data) unread[str(row.sender_id)] = Number(row.count) || 0;
            f.counts.unread = unread;
            f.counts.unreadTotal = Object.values(unread).reduce((a, b) => a + b, 0);
            updateNotifBadge();
            paintUnread();
        });
    }
}
