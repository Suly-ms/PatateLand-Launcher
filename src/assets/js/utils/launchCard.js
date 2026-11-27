/**
 * Écran de lancement : quatre étapes (Préparation, Vérification,
 * Téléchargement, Lancement) avec leur barre, le pourcentage de l'étape en
 * cours et ce que fait le launcher. Repris du nouveau launcher Rust
 * (rust-launcher/crates/pl-app/ui/js/app.js).
 *
 * Plusieurs instances peuvent être lancées en même temps : la carte suit le
 * dernier lancement, les événements des lancements précédents sont ignorés.
 */

const STEPS = { PREPARE: 0, VERIFY: 1, DOWNLOAD: 2, LAUNCH: 3 };

// Ligne écrite par Minecraft quand le menu principal est chargé
// (même repère que le moteur Rust, pl-engine/src/game.rs).
const MENU_REACHED = 'Sound engine started';

const mb = (b) => (b / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const n = (v) => v.toLocaleString('fr-FR');

class LaunchCard {
    constructor() {
        this.current = null;
        this.hideTimer = null;
    }

    el(id) {
        return document.getElementById(id);
    }

    render(run) {
        document.querySelectorAll('#launch-card .launch-step').forEach((el, i) => {
            const done = i < run.step || run.pct[i] >= 100;
            const active = i === run.step && !done;
            el.classList.toggle('done', done);
            el.classList.toggle('active', active);
            el.querySelector('b').textContent = active && run.pct[i] > 0 ? `${Math.floor(run.pct[i])}%` : '';
            el.querySelector('.launch-step-bar span').style.width = `${done ? 100 : run.pct[i]}%`;
        });
    }

    /** Démarre l'affichage pour un nouveau lancement et renvoie son suivi. */
    start(instanceName) {
        const card = this.el('launch-card');
        if (!card) return new LaunchRun(this, instanceName, true);
        clearTimeout(this.hideTimer);
        const run = new LaunchRun(this, instanceName);
        this.current = run;
        this.el('launch-icon').className = 'launch-spinner';
        this.el('launch-icon').textContent = '';
        card.classList.remove('hidden');
        run.set(STEPS.PREPARE, 5, `Préparation de ${instanceName}…`);
        return run;
    }

    hide() {
        clearTimeout(this.hideTimer);
        this.el('launch-card')?.classList.add('hidden');
    }
}

class LaunchRun {
    constructor(card, instanceName, detached = false) {
        this.card = card;
        this.instanceName = instanceName;
        this.detached = detached;
        this.step = STEPS.PREPARE;
        this.pct = [0, 0, 0, 0];
        this.finished = false;
    }

    get active() {
        return !this.detached && !this.finished && this.card.current === this;
    }

    set(step, pct, message, detail = '') {
        if (!this.active) return;
        if (step !== null) this.step = step;
        if (pct !== null) this.pct[this.step] = Math.max(0, Math.min(100, pct));
        if (message) this.card.el('launch-message').textContent = message;
        this.card.el('launch-detail').textContent = detail;
        this.card.render(this);
    }

    /**
     * minecraft-java-core vérifie les fichiers du jeu sans émettre
     * d'événement : l'étape est affichée dès que le lancement démarre.
     */
    verifying() {
        if (this.step >= STEPS.VERIFY) return;
        this.pct[STEPS.PREPARE] = 100;
        this.set(STEPS.VERIFY, 0, 'Vérification des fichiers…');
    }

    /** Événement « check » de minecraft-java-core (bibliothèques du loader). */
    check(done, total) {
        if (this.step >= STEPS.DOWNLOAD || !(total > 0)) return;
        this.set(STEPS.VERIFY, (done / total) * 100, 'Vérification des fichiers…', `${n(done)} / ${n(total)} fichiers`);
    }

    /** Événement « progress » (octets téléchargés), « speed » en octets/s. */
    download(done, total, speed = 0) {
        if (this.step >= STEPS.LAUNCH || !(total > 0)) return;
        this.pct[STEPS.VERIFY] = 100;
        const rate = speed > 0 ? ` · ${mb(speed)} Mo/s` : '';
        this.set(STEPS.DOWNLOAD, (done / total) * 100, 'Téléchargement des fichiers…', `${mb(done)} / ${mb(total)} Mo${rate}`);
    }

    /** Extraction / installation du loader (Forge, NeoForge…). */
    install(label) {
        if (this.step >= STEPS.LAUNCH) return;
        this.set(null, null, label);
    }

    /** Premières lignes du jeu, puis menu principal atteint. */
    gameOutput(line) {
        if (!this.active) return;
        if (this.step < STEPS.LAUNCH) {
            this.pct = [100, 100, 100, 0];
            this.set(STEPS.LAUNCH, 50, 'Démarrage de Minecraft…');
        }
        if (typeof line === 'string' && line.includes(MENU_REACHED)) {
            this.set(STEPS.LAUNCH, 100, 'Bon jeu !');
            this.end('ok', 'Bon jeu !');
        }
    }

    /** État final de la carte : succès (vert) ou erreur (rouge). */
    end(kind, message) {
        if (!this.active) return;
        this.finished = true;
        const icon = this.card.el('launch-icon');
        icon.className = kind === 'ok' ? 'launch-icon ok' : 'launch-icon error';
        icon.textContent = kind === 'ok' ? '✓' : '✕';
        this.card.el('launch-message').textContent = message;
        this.card.el('launch-detail').textContent = '';
        clearTimeout(this.card.hideTimer);
        this.card.hideTimer = setTimeout(() => this.card.hide(), kind === 'ok' ? 2500 : 5000);
    }

    /** Jeu fermé avant le menu principal sans erreur : on retire la carte. */
    close() {
        if (!this.active) return;
        this.finished = true;
        this.card.hide();
    }
}

const launchCard = new LaunchCard();

export { launchCard, STEPS };
