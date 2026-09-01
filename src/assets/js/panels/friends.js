/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { database, popup } from '../utils.js';
const { ipcRenderer } = require('electron');
const { AZauth } = require('minecraft-java-core');

// ===== TRADUCTION DES ÉMOTICÔNES TEXTE (:p, :), <3, etc.) =====
// Appliquée à l'ENVOI du message, pas en live pendant la frappe — un
// remplacement en direct serait pénible (ex: écrire "je programme :p")
// puisqu'il faudrait deviner quand l'utilisateur a fini de taper le
// symbole plutôt que de le laisser continuer sa phrase. Les motifs sont
// entourés de lookaheads/lookbehinds sur les espaces (pas de \b classique,
// qui ne fonctionne pas bien avec des caractères de ponctuation) pour
// éviter de matcher à l'intérieur d'un mot/URL.
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

function translateEmoticons(text) {
    let result = text;
    for (const [pattern, replacement] of EMOTICON_MAP) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

// Sélecteur d'émojis organisé en catégories (façon Discord/Slack), avec
// onglets pour naviguer entre elles — plus large couverture que l'ancienne
// liste plate unique. Pas de lib externe : tout est embarqué ici en dur,
// rien à charger depuis Internet.
const EMOJI_CATEGORIES = {
    'Smileys': [
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
    'Gestes': [
        '👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌',
        '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉',
        '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊', '🤛',
        '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '💅', '🤳',
        '💪', '🦾', '🦵', '🦿', '🦶', '👂', '🦻', '👃', '🧠', '👀',
        '👁️', '👅', '👄',
    ],
    'Coeurs': [
        '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
        '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟',
        '♥️', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💣', '💬',
        '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤',
    ],
    'Animaux': [
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
    'Nourriture': [
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
    'Activités': [
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
    'Objets': [
        '⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💽', '💾', '💿',
        '📀', '📷', '📸', '📹', '🎥', '📞', '☎️', '📟', '📠', '📺',
        '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛',
        '⏳', '📡', '🔋', '🪫', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯',
        '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎',
        '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚',
        '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓',
        '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🗿', '🪧',
    ],
    'Symboles': [
        '✨', '🔥', '⭐', '🌟', '💫', '⚡', '☀️', '🌤️', '⛅', '🌦️',
        '🌧️', '⛈️', '🌩️', '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️',
        '🌈', '☂️', '☔', '⚠️', '🚫', '❌', '⭕', '✅', '☑️', '✔️',
        '❓', '❔', '❗', '❕', '‼️', '⁉️', '🔞', '📵', '🚭', '♻️',
        '💲', '💱', '™️', '©️', '®️', '🆗', '🆕', '🆒', '🆓', '🆙',
    ],
};

// N'est PLUS un "panel" plein écran (donc plus lié au système
// changePanel()/createPanels()) : c'est un petit flyout autonome, construit
// directement en JS et ajouté à document.body, qui s'ouvre/se ferme par-
// dessus l'écran actuel — comme Epic Games / Discord — sans jamais faire
// quitter le panel où on se trouve (home, settings...).
class Friends {
    async init(config) {
        this.config = config;
        this.db = new database();
        this.apiBase = typeof config.online === 'string' ? `${config.online}/api/friends` : null;

        // Map id -> état de fenêtre de chat, remplace l'ancien système à
        // une seule fenêtre unique. Voir buildChatWindowFor/openChat plus
        // bas pour le détail.
        this.chatWindows = new Map();

        // BUG CORRIGÉ (pas de notif si chat ouvert + launcher dans le
        // tray) : le sondage d'une conversation ouverte marque les
        // messages comme lus côté serveur, donc le compteur "non lus"
        // n'augmente jamais pour cette conversation — la notif basée sur
        // ce compteur (loadUnreadCounts) ne se déclenche donc jamais pour
        // une conversation déjà ouverte, MÊME si le launcher est caché
        // dans le tray et que l'utilisateur ne peut pas la voir. Suivi de
        // la visibilité réelle de la fenêtre (signal envoyé par
        // mainWindow.js sur ses événements natifs show/hide/minimize/
        // restore) pour détecter ce cas précis directement dans
        // loadChatMessages() plutôt que de dépendre du compteur.
        this.isWindowVisible = true;
        ipcRenderer.on('window-visibility-changed', (_, visible) => {
            this.isWindowVisible = visible;
        });

        this.buildFlyout();
        this.wireOpenClose();
        this.wireSearch();
        this.wireAddFriend();

        await this.reloadAll();

        // Indépendant de l'ouverture du flyout : tourne tant que le
        // launcher est ouvert, quel que soit le panel affiché.
        this.startHeartbeat();

        // Pareil pour les compteurs de messages non lus (badges sur les
        // boutons 💬), toutes les 30s.
        this.loadUnreadCounts();
        setInterval(() => this.loadUnreadCounts(), 30000);

        // Recadre TOUTES les fenêtres de chat ouvertes si la fenêtre du
        // launcher change de taille — chacune recalculée individuellement
        // via layoutChatWindows() (voir plus bas), pas juste une seule.
        window.addEventListener('resize', () => {
            this.layoutChatWindows();
        });

        // BUG CORRIGÉ : le token AZauth (access_token) n'était rafraîchi
        // QU'AU DÉMARRAGE du launcher (voir launcher.js -> refreshAccount(),
        // appelé une seule fois par startLauncher()). Si le launcher reste
        // ouvert longtemps (cas normal ici, puisque le chat/la liste
        // d'amis tournent en tâche de fond), le token finissait par expirer
        // EN COURS DE SESSION, sans jamais être renouvelé — d'où "Token
        // invalide ou expiré" et les listes qui arrêtent de charger après
        // un moment. On revérifie donc le token toutes les 5 minutes,
        // pendant toute la durée de vie du launcher, pas juste au boot.
        this.refreshAccountToken();
        setInterval(() => this.refreshAccountToken(), 20 * 60 * 1000);
    }

    async refreshAccountToken() {
        try {
            const configClient = await this.db.readData('configClient');
            if (!configClient?.account_selected) {
                console.log('[Amis][Token] Pas de compte sélectionné, rafraîchissement ignoré.');
                return;
            }

            const account = await this.db.readData('accounts', configClient.account_selected);

            console.log(`[Amis][Token] Vérification — meta.type = ${account?.meta?.type} | config.online = ${this.config.online}`);

            if (!account || account.meta?.type !== 'AZauth' || typeof this.config.online !== 'string') {
                console.log('[Amis][Token] Conditions non remplies, rafraîchissement ignoré (voir meta.type/config.online ci-dessus).');
                return;
            }

            console.log(`[Amis][Token] Ancien access_token (10 premiers car.) : ${account.access_token?.slice(0, 10)}`);

            const refreshed = await new AZauth(this.config.online).verify(account);

            if (refreshed.error) {
                console.warn(`[Amis][Token] Rafraîchissement AZauth échoué. Message : ${refreshed.message} | Objet complet : ${JSON.stringify(refreshed)}`);
                return;
            }

            console.log(`[Amis][Token] Nouveau access_token (10 premiers car.) : ${refreshed.access_token?.slice(0, 10)}`);
            console.log('[Amis][Token] Rafraîchissement réussi, sauvegarde en base...');

            refreshed.ID = account.ID;
            await this.db.updateData('accounts', refreshed, account.ID);

            console.log('[Amis][Token] Sauvegarde terminée.');
        } catch (err) {
            console.error(`[Amis][Token] Exception pendant le rafraîchissement périodique : ${err?.message || err}`);
        }
    }

    buildFlyout() {
        const flyout = document.createElement('div');
        flyout.className = 'friends-flyout';
        flyout.innerHTML = `
            <div class="friends-flyout-header">
                <div class="friends-flyout-title">Amis</div>
                <div class="friends-flyout-close">&#10005;</div>
            </div>

            <div class="friends-add-box">
                <input type="text" class="friends-add-input" placeholder="Ajouter un ami par pseudo...">
                <button class="friends-add-btn">Ajouter</button>
            </div>

            <div class="friends-search-box">
                <input type="text" class="friends-search-input" placeholder="Rechercher dans les amis...">
            </div>

            <div class="friends-flyout-body content-scroll">
                <div class="friends-section" data-section="online">
                    <div class="friends-section-header">
                        <span class="friends-section-label">En ligne</span>
                        <span class="friends-section-count">0</span>
                        <span class="friends-section-chevron">▾</span>
                    </div>
                    <div class="friends-section-list friends-online-list"></div>
                </div>

                <div class="friends-section" data-section="offline">
                    <div class="friends-section-header">
                        <span class="friends-section-label">Hors ligne</span>
                        <span class="friends-section-count">0</span>
                        <span class="friends-section-chevron">▾</span>
                    </div>
                    <div class="friends-section-list friends-offline-list"></div>
                </div>

                <div class="friends-section" data-section="requests">
                    <div class="friends-section-header">
                        <span class="friends-section-label">Demandes reçues</span>
                        <span class="friends-section-count">0</span>
                        <span class="friends-section-chevron">▾</span>
                    </div>
                    <div class="friends-section-list friends-requests-list"></div>
                </div>

                <div class="friends-section" data-section="sent">
                    <div class="friends-section-header">
                        <span class="friends-section-label">Envoyées</span>
                        <span class="friends-section-count">0</span>
                        <span class="friends-section-chevron">▾</span>
                    </div>
                    <div class="friends-section-list friends-sent-list"></div>
                </div>
            </div>
        `;

        document.body.appendChild(flyout);
        this.flyout = flyout;

        flyout.querySelectorAll('.friends-section-header').forEach(header => {
            header.addEventListener('click', () => {
                header.closest('.friends-section').classList.toggle('collapsed');
            });
        });
    }

    wireOpenClose() {
        this.frameBtn = document.querySelector('.friends-frame-btn');

        if (this.frameBtn) {
            this.frameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFlyout();
            });
        }

        this.flyout.querySelector('.friends-flyout-close').addEventListener('click', () => this.closeFlyout());

        // Ferme au clic n'importe où ailleurs (Epic/Discord-like), sauf
        // dans le flyout lui-même ou sur le bouton qui l'ouvre.
        document.addEventListener('click', (e) => {
            if (!this.flyout.classList.contains('open')) return;
            if (this.flyout.contains(e.target)) return;
            if (this.frameBtn?.contains(e.target)) return;
            this.closeFlyout();
        });
    }

    toggleFlyout() {
        if (this.flyout.classList.contains('open')) this.closeFlyout();
        else this.openFlyout();
    }

    openFlyout() {
        this.flyout.classList.add('open');
        this.reloadAll();
    }

    closeFlyout() {
        this.flyout.classList.remove('open');
    }

    wireSearch() {
        const input = this.flyout.querySelector('.friends-search-input');
        input.addEventListener('input', () => {
            const query = input.value.trim().toLowerCase();
            this.flyout.querySelectorAll('.friends-online-list .friends-item, .friends-offline-list .friends-item').forEach(item => {
                const name = item.dataset.username?.toLowerCase() || '';
                item.style.display = name.includes(query) ? 'flex' : 'none';
            });
        });
    }

    async reloadAll() {
        await this.loadFriends();
        await this.loadRequests();
        await this.loadSentRequests();
    }

    async getAccount() {
        let configClient = await this.db.readData('configClient');
        if (!configClient?.account_selected) return null;
        return await this.db.readData('accounts', configClient.account_selected);
    }

    async apiFetch(path, options = {}, isRetry = false) {
        if (!this.apiBase) return null;

        // Backoff simple : après un 429, on suspend tout nouvel appel
        // pendant 15s plutôt que d'insister immédiatement au prochain
        // cycle de poll — évite d'aggraver un rate limit déjà déclenché.
        if (this.rateLimitedUntil && Date.now() < this.rateLimitedUntil) {
            return null;
        }

        const account = await this.getAccount();
        if (!account?.access_token) {
            console.warn(`[Amis][API] ${path} - aucun access_token disponible pour le compte sélectionné.`);
            return null;
        }

        try {
            const res = await fetch(`${this.apiBase}${path}`, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${account.access_token}`,
                    ...(options.headers || {})
                }
            });
            const data = await res.json().catch(() => null);

            if (res.status === 429) {
                this.rateLimitedUntil = Date.now() + 15000;
                console.warn(`[Amis][API] ${path} - 429 reçu, pause de 15s avant les prochains appels.`);
            } else if (res.status === 401 && !isRetry) {
                // BUG CORRIGÉ : le rafraîchissement périodique du token
                // (toutes les 20min) peut se terminer PILE pendant qu'une
                // requête est déjà partie avec l'ancien token — cette
                // requête-là reçoit un 401 isolé, même si le token est en
                // réalité déjà valide en base à ce moment précis. Plutôt que
                // d'attendre le prochain cycle de poll, on relit le compte
                // fraîchement et on retente UNE fois immédiatement, avant
                // d'abandonner pour de bon.
                console.warn(`[Amis][API] ${path} - 401 reçu, nouvelle tentative avec le token actuellement en base... (ancien token utilisé : ${account.access_token.slice(0, 10)})`);
                return await this.apiFetch(path, options, true);
            } else if (!res.ok) {
                console.warn(`[Amis][API] ${path} - HTTP ${res.status} - token utilisé (10 premiers car.) : ${account.access_token.slice(0, 10)} - réponse : ${JSON.stringify(data)}`);
            }

            return { ok: res.ok, status: res.status, data };
        } catch (err) {
            console.error(`[Amis][API] ${path} - erreur réseau : ${err?.message || err}`);
            return null;
        }
    }

    startHeartbeat() {
        const send = () => this.apiFetch('/heartbeat', { method: 'POST' });
        send();
        setInterval(send, 60000);
    }

    wireAddFriend() {
        const input = this.flyout.querySelector('.friends-add-input');
        const btn = this.flyout.querySelector('.friends-add-btn');

        const send = async () => {
            const username = input.value.trim();
            if (!username) return;

            const result = await this.apiFetch('/request', {
                method: 'POST',
                body: JSON.stringify({ username })
            });

            if (!result) {
                new popup().openPopup({ title: 'Erreur', content: 'Impossible de contacter le serveur.', color: 'red', options: true });
                return;
            }

            if (!result.ok) {
                new popup().openPopup({ title: 'Erreur', content: result.data?.message || 'Une erreur est survenue.', color: 'red', options: true });
                return;
            }

            input.value = '';
            await this.loadSentRequests();
        };

        btn.addEventListener('click', send);
        // stopPropagation() : login.js a un listener global sur tout le
        // document qui clique le bouton de connexion AZauth à CHAQUE
        // Entrée pressée, peu importe le panel actif. Sans ça, envoyer un
        // message ou une demande d'ami déclenchait aussi (en fond) le
        // formulaire de login invisible, avec son erreur "Veuillez remplir
        // tous les champs".
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); send(); } });
    }

    setSectionCount(section, count) {
        const sectionEl = this.flyout.querySelector(`.friends-section[data-section="${section}"]`);
        if (!sectionEl) return;

        sectionEl.querySelector('.friends-section-count').textContent = count;

        // "En ligne"/"Hors ligne" restent toujours visibles (même à 0, pour
        // dire clairement "personne en ligne"). "Demandes"/"Envoyées" ne
        // s'affichent que s'il y a quelque chose, pour ne pas encombrer le
        // flyout à vide.
        const alwaysVisible = section === 'online' || section === 'offline';
        sectionEl.style.display = (count > 0 || alwaysVisible) ? '' : 'none';
    }

    friendItemHtml(friend) {
        return `
            <div class="friends-item" data-username="${friend.username}">
                <span class="friends-online-dot ${friend.online ? 'online' : ''}"></span>
                <div class="friends-item-clickable" data-id="${friend.id}" data-username="${friend.username}">
                    <img class="friends-avatar" src="${friend.avatar}" alt="${friend.username}" onerror="this.src='https://mc-heads.net/avatar/MHF_Steve/64'">
                    <span class="friends-username">${friend.username}</span>
                </div>
                <span class="friends-chat-btn" data-id="${friend.id}" data-username="${friend.username}" data-avatar="${friend.avatar}" title="Message">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4l4 4 4-4h4c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                </span>
                <span class="friends-remove-btn" data-id="${friend.id}">Retirer</span>
            </div>
        `;
    }

    // ===== CHAT (fenêtre façon Messenger) =====
    // ===== MULTI-FENÊTRES DE CHAT =====
    // Remplace l'ancien système à une seule fenêtre unique (this.chatWindow,
    // this.chatFriendId, this.chatPollInterval) par une Map id -> état,
    // permettant plusieurs conversations ouvertes simultanément. Chaque
    // entrée garde son propre élément DOM, son propre intervalle de
    // sondage, sa propre position et son propre état minimisé/agrandi.
    // this.chatWindows initialisée dans init().

    buildChatWindowFor(id, username, avatar) {
        const chat = document.createElement('div');
        chat.className = 'friends-chat-window';
        chat.dataset.friendId = id;
        chat.innerHTML = `
            <div class="friends-chat-header">
                <img class="friends-chat-avatar" src="${avatar || `https://mc-heads.net/avatar/${encodeURIComponent(username)}/32`}" alt="">
                <span class="friends-chat-username">${this.escapeHtml(username)}</span>
                <span class="friends-chat-minimize" title="Réduire">&#8211;</span>
                <span class="friends-chat-expand" title="Agrandir">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 4h6V2H2v8h2V4zm16 0v6h2V2h-8v2h6zM4 20v-6H2v8h8v-2H4zm16-6v6h-6v2h8v-8h-2z"/></svg>
                </span>
                <span class="friends-chat-close">&#10005;</span>
            </div>
            <div class="friends-chat-messages content-scroll"></div>
            <div class="friends-chat-typing" style="display:none;">
                écrit
                <span class="friends-chat-typing-dots"><span></span><span></span><span></span></span>
            </div>
            <div class="friends-chat-emoji-panel">
                <div class="friends-chat-emoji-grid content-scroll"></div>
            </div>
            <div class="friends-chat-input-box">
                <button type="button" class="friends-chat-emoji-btn" title="Émojis">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8">
                        <circle cx="12" cy="12" r="9"/>
                        <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/>
                        <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/>
                        <path d="M8 14c1 1.5 2.5 2.3 4 2.3s3-0.8 4-2.3" stroke-linecap="round"/>
                    </svg>
                </button>
                <input type="text" class="friends-chat-input" placeholder="Écrire un message...">
                <button class="friends-chat-send">Envoyer</button>
            </div>
        `;
        document.body.appendChild(chat);

        chat.style.width = '300px';
        chat.style.height = '400px';
        chat.classList.add('open');

        chat.querySelector('.friends-chat-close').addEventListener('click', () => this.closeChat(id));

        chat.querySelector('.friends-chat-minimize').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMinimizeChat(id);
        });

        chat.querySelector('.friends-chat-expand').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleChatExpand(id);
        });

        // Cliquer sur l'en-tête d'une fenêtre minimisée la restaure (comme
        // cliquer sur un onglet réduit) — sauf si on vient de cliquer sur
        // un des boutons (gérés séparément juste au-dessus).
        chat.querySelector('.friends-chat-header').addEventListener('click', (e) => {
            if (e.target.closest('.friends-chat-close, .friends-chat-expand, .friends-chat-minimize')) return;
            const state = this.chatWindows.get(id);
            if (state?.minimized) this.toggleMinimizeChat(id);
        });

        const input = chat.querySelector('.friends-chat-input');
        const send = () => this.sendChatMessage(id);
        chat.querySelector('.friends-chat-send').addEventListener('click', send);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); send(); } });

        // Signal "j'écris" envoyé au plus une fois toutes les 2s (throttle
        // manuel via un timestamp), PAS à chaque frappe — évite de spammer
        // le serveur pendant une saisie rapide. Timestamp stocké par
        // conversation (sur l'état), pas globalement, pour que taper dans
        // une fenêtre n'affecte pas le throttle d'une autre.
        input.addEventListener('input', () => {
            const state = this.chatWindows.get(id);
            if (!state) return;
            const now = Date.now();
            if (state.lastTypingPingAt && now - state.lastTypingPingAt < 2000) return;
            state.lastTypingPingAt = now;
            this.apiFetch(`/messages/${id}/typing`, { method: 'POST' });
        });

        // ===== SÉLECTEUR D'ÉMOJIS (défilement continu, catégories en
        // simples séparateurs de titre plutôt que des onglets à cliquer) =====
        const emojiBtn = chat.querySelector('.friends-chat-emoji-btn');
        const emojiPanel = chat.querySelector('.friends-chat-emoji-panel');
        const emojiGrid = chat.querySelector('.friends-chat-emoji-grid');

        emojiGrid.innerHTML = Object.entries(EMOJI_CATEGORIES)
            .map(([name, emojis]) => `
                <div class="friends-chat-emoji-section-title">${name}</div>
                ${emojis.map(e => `<span class="friends-chat-emoji-item">${e}</span>`).join('')}
            `)
            .join('');

        emojiBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            emojiPanel.classList.toggle('open');
        });

        emojiGrid.addEventListener('click', (e) => {
            const item = e.target.closest('.friends-chat-emoji-item');
            if (!item) return;
            this.insertAtCursor(input, item.textContent);
            // Reste ouvert exprès (pas de emojiPanel.classList.remove('open')
            // ici) pour permettre d'enchaîner plusieurs émojis d'affilée
            // sans avoir à rouvrir le menu à chaque fois.
        });

        // Ferme le panneau au clic ailleurs dans la fenêtre (pas en dehors,
        // pour rester simple — suffisant en pratique).
        chat.addEventListener('click', (e) => {
            if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) {
                emojiPanel.classList.remove('open');
            }
        });
        // ===== FIN SÉLECTEUR D'ÉMOJIS =====

        this.wireChatDrag(chat, id);

        return chat;
    }

    // Insère du texte à la position actuelle du curseur dans un champ
    // (plutôt qu'à la fin), pour un clic sur un émoji au milieu d'une
    // phrase déjà tapée.
    insertAtCursor(input, text) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        const newPos = start + text.length;
        input.setSelectionRange(newPos, newPos);
        input.focus();
    }

    // Empile les fenêtres ouvertes de droite à gauche, chacune selon sa
    // largeur actuelle (réduite en mode minimisé) — façon Messenger/Discord.
    // Une fenêtre déplacée manuellement (userMoved) garde sa position
    // propre et n'est plus incluse dans le calcul d'empilement automatique,
    // mais continue d'être repositionnée correctement au redimensionnement
    // de la fenêtre du launcher (via applyChatPositionFor).
    layoutChatWindows() {
        const GAP = 10;
        const MARGIN = 12;
        let cumulativeRight = MARGIN;

        for (const [id, state] of this.chatWindows) {
            const width = state.minimized ? 200 : (state.expanded ? 460 : 300);
            // BUG CORRIGÉ : sans ce calcul explicite, applyChatPositionFor()
            // retombait sur el.offsetWidth/offsetHeight — qui, juste après
            // avoir retiré/ajouté la classe .minimized, reflète encore
            // l'ANCIENNE taille (la transition CSS n'a pas encore eu le
            // temps de progresser au moment de la lecture synchrone). La
            // fenêtre restaurée se positionnait donc avec les mauvaises
            // dimensions, retombant à un endroit différent de sa place
            // d'origine dans l'empilement.
            const height = state.minimized ? 44 : (state.expanded ? 600 : 400);

            if (!state.userMoved) {
                state.offsetRight = cumulativeRight;
                state.offsetBottom = 12;
                cumulativeRight += width + GAP;
            }

            this.applyChatPositionFor(id, width, height);
        }
    }

    applyChatPositionFor(id, width, height) {
        const state = this.chatWindows.get(id);
        if (!state) return;
        const el = state.el;

        width = width || (state.minimized ? 200 : el.offsetWidth);
        height = height || (state.minimized ? 44 : el.offsetHeight);

        let left = window.innerWidth - state.offsetRight - width;
        let top = window.innerHeight - state.offsetBottom - height;

        left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
        top = Math.max(8, Math.min(top, window.innerHeight - height - 8));

        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    // Déplacement de la fenêtre en glissant l'en-tête, comme n'importe
    // quelle fenêtre d'app de bureau. Les clics sur les boutons de l'en-tête
    // sont exclus pour ne pas déclencher un drag parasite. Met à jour
    // l'état PROPRE à cette conversation (pas un offset global partagé),
    // et marque la fenêtre comme déplacée manuellement (userMoved) pour
    // qu'elle sorte de l'empilement automatique.
    wireChatDrag(chat, id) {
        const header = chat.querySelector('.friends-chat-header');
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

            const newLeft = startLeft + (e.clientX - startX);
            const newTop = startTop + (e.clientY - startY);

            const clampedLeft = Math.max(-chat.offsetWidth + 80, Math.min(newLeft, window.innerWidth - 80));
            const clampedTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));

            chat.style.left = `${clampedLeft}px`;
            chat.style.top = `${clampedTop}px`;

            const state = this.chatWindows.get(id);
            if (state) {
                state.offsetRight = window.innerWidth - clampedLeft - chat.offsetWidth;
                state.offsetBottom = window.innerHeight - clampedTop - chat.offsetHeight;
                state.userMoved = true;
            }
        });

        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                document.body.style.userSelect = '';
            }
        });
    }

    // Bouton "agrandir" en un clic : bascule entre taille normale et une
    // taille agrandie fixe, avec transition CSS fluide, PROPRE à chaque
    // conversation (une fenêtre peut être agrandie pendant qu'une autre
    // reste en taille normale).
    toggleChatExpand(id) {
        const state = this.chatWindows.get(id);
        if (!state) return;

        state.expanded = !state.expanded;

        const btn = state.el.querySelector('.friends-chat-expand');
        btn.classList.toggle('active', state.expanded);
        btn.title = state.expanded ? 'Réduire' : 'Agrandir';

        const targetWidth = state.expanded ? 460 : 300;
        const targetHeight = state.expanded ? 600 : 400;

        state.el.style.width = `${targetWidth}px`;
        state.el.style.height = `${targetHeight}px`;

        this.layoutChatWindows();
    }

    // Réduit une conversation à une petite barre d'en-tête (comme minimiser
    // une fenêtre Windows), SANS la fermer : le sondage continue de tourner
    // en tâche de fond (les messages/notifs continuent d'arriver), il n'y a
    // juste plus la liste de messages ni le champ de saisie affichés.
    toggleMinimizeChat(id) {
        const state = this.chatWindows.get(id);
        if (!state) return;

        state.minimized = !state.minimized;
        state.el.classList.toggle('minimized', state.minimized);

        const btn = state.el.querySelector('.friends-chat-minimize');
        if (btn) btn.title = state.minimized ? 'Restaurer' : 'Réduire';

        this.layoutChatWindows();
    }

    // Ouvre une conversation. Si elle est déjà ouverte, la restaure si
    // minimisée (ne recrée jamais une fenêtre en double pour le même ami).
    openChat(id, username, avatar) {
        let state = this.chatWindows.get(id);

        if (state) {
            if (state.minimized) this.toggleMinimizeChat(id);
            return;
        }

        const el = this.buildChatWindowFor(id, username, avatar);

        state = {
            el,
            pollInterval: null,
            minimized: false,
            expanded: false,
            userMoved: false,
            offsetRight: 12,
            offsetBottom: 12,
            username,
            avatar,
            lastTypingPingAt: null,
            // Volontairement absent (undefined) au départ : sert de
            // marqueur "premier chargement" dans loadChatMessages(), pour
            // ne jamais notifier rétroactivement l'historique déjà là.
            lastNotifiedMessageId: undefined
        };
        this.chatWindows.set(id, state);

        el.querySelector('.friends-chat-messages').innerHTML = '<div class="friends-empty">Chargement...</div>';

        this.layoutChatWindows();
        this.loadChatMessages(id);

        // Polling toutes les 6s tant que la fenêtre est ouverte (pas de
        // WebSocket configuré côté serveur), PROPRE à cette conversation —
        // fermer/rouvrir une autre conversation n'affecte pas celle-ci.
        state.pollInterval = setInterval(() => this.loadChatMessages(id), 6000);
    }

    // Ferme réellement une conversation (contrairement à minimiser) :
    // arrête son sondage et retire son état, puis réorganise les fenêtres
    // restantes pour combler l'espace laissé.
    closeChat(id) {
        const state = this.chatWindows.get(id);
        if (!state) return;

        clearInterval(state.pollInterval);
        state.el.remove();
        this.chatWindows.delete(id);

        this.layoutChatWindows();
    }

    async loadChatMessages(id) {
        const state = this.chatWindows.get(id);
        if (!state) return;

        const result = await this.apiFetch(`/messages/${id}`, { method: 'GET' });
        const listEl = state.el.querySelector('.friends-chat-messages');
        const typingEl = state.el.querySelector('.friends-chat-typing');
        if (!listEl) return;

        // La réponse a changé de forme : avant un simple tableau, maintenant
        // { messages: [...], typing: bool } — le statut d'écriture est
        // greffé sur ce même appel déjà fait toutes les 6s, pas de requête
        // en plus pour ça.
        if (!result || !result.ok || !result.data || !Array.isArray(result.data.messages)) {
            listEl.innerHTML = '<div class="friends-empty">Impossible de charger la conversation.</div>';
            if (typingEl) typingEl.style.display = 'none';
            return;
        }

        const { messages, typing } = result.data;
        const wasAtBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 10;

        // ===== NOTIFICATION POUR CONVERSATION OUVERTE MAIS FENÊTRE CACHÉE =====
        // Détecté directement à partir des messages reçus (pas du compteur
        // "non lus", qui reste bloqué à 0 pour une conversation ouverte
        // puisque ce même sondage marque tout comme lu côté serveur).
        // state.lastNotifiedMessageId vaut `undefined` uniquement au tout
        // premier chargement de cette conversation : on ne notifie jamais
        // rétroactivement pour l'historique déjà présent, seulement pour
        // ce qui arrive APRÈS ce point.
        if (state.lastNotifiedMessageId === undefined) {
            state.lastNotifiedMessageId = messages.length ? messages[messages.length - 1].id : null;
        } else if (!this.isWindowVisible && messages.length) {
            const newFromFriend = messages.filter(m =>
                !m.mine && (state.lastNotifiedMessageId === null || m.id > state.lastNotifiedMessageId)
            );
            if (newFromFriend.length) {
                const last = newFromFriend[newFromFriend.length - 1];
                await this.notifyIfEnabled('friend_message_notifications', {
                    title: `Message de ${state.username}`,
                    body: last.content.length > 80 ? `${last.content.slice(0, 80)}…` : last.content
                });
            }
        }

        if (messages.length) {
            const newestId = messages[messages.length - 1].id;
            if (state.lastNotifiedMessageId === null || newestId > state.lastNotifiedMessageId) {
                state.lastNotifiedMessageId = newestId;
            }
        }
        // ===== FIN NOTIFICATION CONVERSATION OUVERTE + FENÊTRE CACHÉE =====

        // Statut affiché UNIQUEMENT sur le tout dernier message de la
        // conversation (si c'est bien un message envoyé par moi) — un seul
        // indicateur, pas de double logique "dernier lu / dernier envoyé"
        // qui prêtait à confusion. Pastille + texte ensemble, sous la bulle.
        let lastMineIndex = -1;
        messages.forEach((m, i) => { if (m.mine) lastMineIndex = i; });

        listEl.innerHTML = messages.length
            ? messages.map((m, i) => {
                const bubble = `<div class="friends-chat-bubble ${m.mine ? 'mine' : 'theirs'}">${this.escapeHtml(m.content)}</div>`;

                const isLastMine = m.mine && i === lastMineIndex;
                const status = isLastMine
                    ? `<div class="friends-chat-status">${m.read ? 'Vu' : 'Envoyé'}<span class="friends-chat-status-dot ${m.read ? 'read' : 'sent'}"></span></div>`
                    : '';

                return bubble + status;
            }).join('')
            : '<div class="friends-empty">Aucun message pour l\'instant, dis bonjour !</div>';

        if (typingEl) typingEl.style.display = typing ? 'flex' : 'none';

        if (wasAtBottom) listEl.scrollTop = listEl.scrollHeight;
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    async sendChatMessage(id) {
        const state = this.chatWindows.get(id);
        if (!state) return;

        const input = state.el.querySelector('.friends-chat-input');
        let content = input.value.trim();
        if (!content) return;

        // Traduction des émoticônes texte (:p, :), <3...) en vrais émojis,
        // appliquée juste avant l'envoi (voir EMOTICON_MAP en haut du fichier).
        content = translateEmoticons(content);

        input.value = '';

        // Le panneau émoji reste ouvert pendant la sélection (voir plus
        // haut), mais se referme ici une fois le message effectivement
        // envoyé — cohérent, plutôt que de le fermer à chaque émoji cliqué.
        state.el.querySelector('.friends-chat-emoji-panel')?.classList.remove('open');

        const result = await this.apiFetch(`/messages/${id}`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });

        if (!result?.ok) {
            new popup().openPopup({ title: 'Erreur', content: result?.data?.message || 'Message non envoyé.', color: 'red', options: true });
            return;
        }

        await this.loadChatMessages(id);
    }

    async loadUnreadCounts() {
        const result = await this.apiFetch('/messages/unread', { method: 'GET' });
        if (!result || !result.ok || !Array.isArray(result.data)) return;

        const counts = {};
        let total = 0;
        result.data.forEach(row => { counts[row.sender_id] = row.count; total += row.count; });

        // Notifie seulement si le compteur d'UN ami précis a AUGMENTÉ depuis
        // le dernier passage — pas juste "s'il y en a" (sinon ça re-notifie
        // en boucle tant qu'un message reste non lu).
        if (!this.knownUnreadCounts) this.knownUnreadCounts = {};

        const hasPreviousData = Object.keys(this.knownUnreadCounts).length > 0 || this.hasLoadedUnreadOnce;
        this.hasLoadedUnreadOnce = true;

        if (hasPreviousData) {
            for (const row of result.data) {
                const previous = this.knownUnreadCounts[row.sender_id] || 0;
                if (row.count > previous) {
                    await this.notifyIfEnabled('friend_message_notifications', {
                        title: 'Nouveau message',
                        body: `${row.sender_username || 'Un ami'} t'a envoyé un message.`
                    });
                }
            }
        }

        this.knownUnreadCounts = counts;
        this.totalUnreadCount = total;
        this.updateNotifBadge();

        this.flyout.querySelectorAll('.friends-chat-btn').forEach(btn => {
            const count = counts[btn.dataset.id] || 0;
            let badge = btn.querySelector('.friends-chat-unread');

            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'friends-chat-unread';
                    btn.appendChild(badge);
                }
                badge.textContent = count > 9 ? '9+' : count;
            } else if (badge) {
                badge.remove();
            }
        });
    }

    // Badge rouge cumulé (demandes reçues + messages non lus) collé sur
    // l'icône Amis de la barre de fenêtre.
    updateNotifBadge() {
        const badge = document.querySelector('.friends-notif-badge');
        if (!badge) return;

        const total = (this.pendingRequestsCount || 0) + (this.totalUnreadCount || 0);

        if (total > 0) {
            badge.textContent = total > 99 ? '99+' : total;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }

    // Lit la préférence de notification depuis configClient, activée par
    // défaut si jamais configurée (contrairement aux rapports de crash qui
    // sont opt-in — ici c'est juste une préférence d'affichage locale, pas
    // un partage de données, donc activé par défaut est cohérent).
    async isNotificationEnabled(settingKey) {
        const configClient = await this.db.readData('configClient');
        const value = configClient?.launcher_config?.[settingKey] ?? true;
        return value;
    }

    // Envoie une notification système seulement si la préférence
    // correspondante (settingKey) est activée — évite de répéter
    // isNotificationEnabled + ipcRenderer.send à chaque appel.
    async notifyIfEnabled(settingKey, { title, body }) {
        const enabled = await this.isNotificationEnabled(settingKey);
        if (enabled) {
            ipcRenderer.send('game-notification', { title, body });
        }
    }
    // ===== FIN CHAT =====
    buildProfileModal() {
        const modal = document.createElement('div');
        modal.className = 'friends-profile-modal';
        modal.innerHTML = `
            <div class="friends-profile-backdrop"></div>
            <div class="friends-profile-card">
                <div class="friends-profile-close">&#10005;</div>
                <img class="friends-profile-render" src="" alt="">
                <div class="friends-profile-username"></div>
                <div class="friends-profile-info">
                    <div class="friends-profile-info-item">
                        <span>📅</span>
                        <span class="friends-profile-date">...</span>
                    </div>
                    <div class="friends-profile-info-item">
                        <span>#</span>
                        <span class="friends-profile-uuid">...</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.friends-profile-close').addEventListener('click', () => modal.classList.remove('open'));
        modal.querySelector('.friends-profile-backdrop').addEventListener('click', () => modal.classList.remove('open'));

        const img = modal.querySelector('.friends-profile-render');
        img.addEventListener('error', () => this.handleProfileRenderError(img));

        this.profileModal = modal;
    }

    // Chaîne de secours, du meilleur rendu au plus basique. Loggée à
    // chaque étape pour diagnostiquer facilement quelle source a échoué
    // (regarde la console DevTools si l'image ne s'affiche toujours pas).
    handleProfileRenderError(img) {
        const stage = (img.dataset.stage ? parseInt(img.dataset.stage, 10) : 0) + 1;
        img.dataset.stage = stage;

        console.warn(`[Amis] Rendu de skin étape ${stage} échoué pour "${img.alt}", src tentée :`, img.src);

        if (stage === 1) {
            // Repli sur le skin Steve par défaut (pseudo introuvable côté
            // mc-heads, compte très récent pas encore indexé, etc.).
            img.src = 'https://mc-heads.net/body/MHF_Steve/300';
        } else {
            console.error(`[Amis] Aucun rendu de skin disponible pour "${img.alt}".`);
        }
    }

    async openProfile(id, username) {
        if (!this.profileModal) this.buildProfileModal();

        const img = this.profileModal.querySelector('.friends-profile-render');
        img.dataset.stage = '0';
        img.alt = username;
        img.src = `https://mc-heads.net/body/${encodeURIComponent(username)}/300`;

        this.profileModal.querySelector('.friends-profile-username').textContent = username;
        this.profileModal.querySelector('.friends-profile-date').textContent = 'Chargement...';
        this.profileModal.querySelector('.friends-profile-uuid').textContent = 'Chargement...';
        this.profileModal.classList.add('open');

        const result = await this.apiFetch(`/profile/${id}`, { method: 'GET' });

        if (!result || !result.ok || !result.data) {
            this.profileModal.querySelector('.friends-profile-date').textContent = 'Indisponible';
            this.profileModal.querySelector('.friends-profile-uuid').textContent = 'Indisponible';
            return;
        }

        this.profileModal.querySelector('.friends-profile-date').textContent = this.formatFrenchDate(result.data.created_at);
        this.profileModal.querySelector('.friends-profile-uuid').textContent = result.data.uuid || 'Inconnue';
    }

    formatFrenchDate(isoString) {
        if (!isoString) return 'Inconnue';
        const date = new Date(isoString);
        const datePart = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
        const timePart = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        return `${datePart} à ${timePart}`;
    }
    // ===== FIN PROFIL D'UN AMI =====

    async loadFriends() {
        const onlineList = this.flyout.querySelector('.friends-online-list');
        const offlineList = this.flyout.querySelector('.friends-offline-list');
        if (!onlineList || !offlineList) return;

        const result = await this.apiFetch('', { method: 'GET' });

        if (!result || !result.ok || !Array.isArray(result.data)) {
            onlineList.innerHTML = '<div class="friends-empty">Impossible de charger la liste d\'amis.</div>';
            offlineList.innerHTML = '';
            this.setSectionCount('online', 0);
            this.setSectionCount('offline', 0);
            this.updateFrameBadge(0, 0);
            return;
        }

        const online = result.data.filter(f => f.online);
        const offline = result.data.filter(f => !f.online);

        // Détecte les amis JAMAIS vus auparavant dans la liste — ça arrive
        // uniquement quand quelqu'un vient d'accepter ta demande (impossible
        // de devenir ami autrement). On notifie "X a accepté ta demande",
        // avec le même garde-fou que pour les demandes/messages : pas de
        // notif au tout premier chargement (sinon ça notifierait pour
        // TOUS tes amis existants au démarrage du launcher).
        if (!this.knownFriendIds) this.knownFriendIds = new Set();
        const newFriends = result.data.filter(f => !this.knownFriendIds.has(f.id));

        if (newFriends.length && this.knownFriendIds.size > 0) {
            for (const f of newFriends) {
                await this.notifyIfEnabled('friend_request_notifications', {
                    title: 'Demande d\'ami acceptée',
                    body: `${f.username} a accepté ta demande, vous êtes maintenant amis !`
                });
            }
        }

        result.data.forEach(f => this.knownFriendIds.add(f.id));

        this.setSectionCount('online', online.length);
        this.setSectionCount('offline', offline.length);
        this.updateFrameBadge(online.length, result.data.length);

        onlineList.innerHTML = online.length
            ? online.map(f => this.friendItemHtml(f)).join('')
            : '<div class="friends-empty">Personne en ligne.</div>';

        offlineList.innerHTML = offline.length
            ? offline.map(f => this.friendItemHtml(f)).join('')
            : '<div class="friends-empty">Aucun ami hors ligne.</div>';

        this.flyout.querySelectorAll('.friends-remove-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const result = await this.apiFetch(`/${id}`, { method: 'DELETE' });
                if (result?.ok) await this.loadFriends();
            });
        });

        this.flyout.querySelectorAll('.friends-item-clickable').forEach(el => {
            el.addEventListener('click', () => this.openProfile(el.dataset.id, el.dataset.username));
        });

        this.flyout.querySelectorAll('.friends-chat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openChat(btn.dataset.id, btn.dataset.username, btn.dataset.avatar);
            });
        });

        this.loadUnreadCounts();
    }

    updateFrameBadge(online, total) {
        const badge = document.querySelector('.friends-online-badge');
        if (!badge) return;
        if (total === 0) {
            badge.style.display = 'none';
            return;
        }
        badge.textContent = `${online}/${total}`;
        badge.style.display = 'inline-flex';
    }

    async loadRequests() {
        const listEl = this.flyout.querySelector('.friends-requests-list');
        if (!listEl) return;

        const result = await this.apiFetch('/requests', { method: 'GET' });

        if (!result || !result.ok || !Array.isArray(result.data)) {
            listEl.innerHTML = '<div class="friends-empty">Impossible de charger les demandes.</div>';
            this.setSectionCount('requests', 0);
            this.pendingRequestsCount = 0;
            this.updateNotifBadge();
            return;
        }

        // Notifie uniquement les demandes JAMAIS vues auparavant (pas à
        // chaque rafraîchissement, sinon ça notifierait en boucle pour la
        // même demande tant qu'elle reste en attente).
        if (!this.knownRequestIds) this.knownRequestIds = new Set();
        const newRequests = result.data.filter(r => !this.knownRequestIds.has(r.id));

        if (newRequests.length && this.knownRequestIds.size > 0) {
            for (const r of newRequests) {
                await this.notifyIfEnabled('friend_request_notifications', {
                    title: 'Nouvelle demande d\'ami',
                    body: `${r.sender_username} veut t'ajouter en ami.`
                });
            }
        }

        result.data.forEach(r => this.knownRequestIds.add(r.id));

        this.pendingRequestsCount = result.data.length;
        this.updateNotifBadge();
        this.setSectionCount('requests', result.data.length);

        if (!result.data.length) {
            listEl.innerHTML = '';
            return;
        }

        listEl.innerHTML = result.data.map(req => `
            <div class="friends-item">
                <img class="friends-avatar" src="${req.sender_avatar}" alt="${req.sender_username}" onerror="this.src='https://mc-heads.net/avatar/MHF_Steve/64'">
                <span class="friends-username">${req.sender_username}</span>
                <span class="friends-accept-btn" data-id="${req.id}">Accepter</span>
                <span class="friends-decline-btn" data-id="${req.id}">Refuser</span>
            </div>
        `).join('');

        listEl.querySelectorAll('.friends-accept-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const result = await this.apiFetch(`/accept/${id}`, { method: 'POST' });
                if (result?.ok) await this.reloadAll();
            });
        });

        listEl.querySelectorAll('.friends-decline-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const result = await this.apiFetch(`/decline/${id}`, { method: 'POST' });
                if (result?.ok) await this.loadRequests();
            });
        });
    }

    async loadSentRequests() {
        const listEl = this.flyout.querySelector('.friends-sent-list');
        if (!listEl) return;

        const result = await this.apiFetch('/requests/sent', { method: 'GET' });

        if (!result || !result.ok || !Array.isArray(result.data)) {
            listEl.innerHTML = '<div class="friends-empty">Impossible de charger les demandes envoyées.</div>';
            this.setSectionCount('sent', 0);
            return;
        }

        this.setSectionCount('sent', result.data.length);

        if (!result.data.length) {
            listEl.innerHTML = '';
            return;
        }

        listEl.innerHTML = result.data.map(req => `
            <div class="friends-item">
                <img class="friends-avatar" src="${req.receiver_avatar}" alt="${req.receiver_username}" onerror="this.src='https://mc-heads.net/avatar/MHF_Steve/64'">
                <span class="friends-username">${req.receiver_username}</span>
                <span class="friends-status-pending">En attente</span>
                <span class="friends-decline-btn" data-id="${req.id}">Annuler</span>
            </div>
        `).join('');

        listEl.querySelectorAll('.friends-decline-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const result = await this.apiFetch(`/decline/${id}`, { method: 'POST' });
                if (result?.ok) await this.loadSentRequests();
            });
        });
    }
}

export default Friends;