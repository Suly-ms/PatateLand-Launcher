/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)/
 */

'use strict';

export default class Slider {
    constructor(id, minValue, maxValue) {
        this.slider = document.querySelector(id);
        this.touchLeft = this.slider.querySelector('.slider-touch-left');
        this.touchRight = this.slider.querySelector('.slider-touch-right');
        this.lineSpan = this.slider.querySelector('.slider-line span');

        this.min = parseFloat(this.slider.getAttribute('min'));
        this.max = parseFloat(this.slider.getAttribute('max'));
        this.step = parseFloat(this.slider.getAttribute('step')) || 0.1;

        if (!minValue) minValue = this.min;
        if (!maxValue) maxValue = this.max;

        this.minValue = minValue;
        this.maxValue = maxValue;

        this.startX = 0;
        this.x = 0;
        this.selectedTouch = null;
        
        // On initialise visuellement les positions
        // Note: On attend un petit délai ou un premier clic pour recalculer si l'onglet est caché
        this.updateUIFromValues();

        // Events
        const startHandler = (elem, event) => this.onStart(elem, event);
        
        this.touchLeft.addEventListener('mousedown', (e) => startHandler(this.touchLeft, e));
        this.touchRight.addEventListener('mousedown', (e) => startHandler(this.touchRight, e));
        this.touchLeft.addEventListener('touchstart', (e) => startHandler(this.touchLeft, e));
        this.touchRight.addEventListener('touchstart', (e) => startHandler(this.touchRight, e));
    }

    // Met à jour les positions des curseurs en fonction des valeurs min/max
    updateUIFromValues() {
        // Recalcul des dimensions (important si l'onglet était caché)
        const rangeWidth = this.slider.offsetWidth - this.touchLeft.offsetWidth;
        if(rangeWidth <= 0) return; // Sécurité si caché

        const totalValue = this.max - this.min;
        
        // Ratio (0 à 1)
        const ratioMin = (this.minValue - this.min) / totalValue;
        const ratioMax = (this.maxValue - this.min) / totalValue;

        // Position en pixels
        const leftPos = Math.round(ratioMin * rangeWidth);
        const rightPos = Math.round(ratioMax * rangeWidth);

        this.touchLeft.style.left = leftPos + 'px';
        this.touchRight.style.left = rightPos + 'px';
        
        this.updateLine();
    }

    onStart(elem, event) {
        event.preventDefault();
        
        // CORRECTION MAJEURE : On recalcule les limites au début du mouvement
        // Cela règle le problème des sliders inversés ou bloqués si initialisés cachés
        this.maxX = this.slider.offsetWidth - this.touchLeft.offsetWidth;
        
        this.selectedTouch = elem;
        this.x = this.selectedTouch.offsetLeft;
        
        // Support Tactile et Souris
        const pageX = event.type.includes('touch') ? event.touches[0].pageX : event.pageX;
        this.startX = pageX - this.x;

        this.func1 = (e) => this.onMove(e);
        this.func2 = (e) => this.onStop(e);

        document.addEventListener('mousemove', this.func1);
        document.addEventListener('mouseup', this.func2);
        document.addEventListener('touchmove', this.func1);
        document.addEventListener('touchend', this.func2);
    }

    onMove(event) {
        const pageX = event.type.includes('touch') ? event.touches[0].pageX : event.pageX;
        this.x = pageX - this.startX;

        // Limites et Collisions
        if (this.selectedTouch === this.touchLeft) {
            // Ne pas dépasser à gauche (0)
            if (this.x < 0) this.x = 0;
            // Ne pas dépasser le curseur de droite (moins une marge de 20px)
            const limitRight = this.touchRight.offsetLeft - this.touchLeft.offsetWidth; 
            if (this.x > limitRight) this.x = limitRight;

            this.touchLeft.style.left = this.x + 'px';
            
        } else if (this.selectedTouch === this.touchRight) {
            // Ne pas dépasser le curseur de gauche
            const limitLeft = this.touchLeft.offsetLeft + this.touchLeft.offsetWidth;
            if (this.x < limitLeft) this.x = limitLeft;
            // Ne pas dépasser à droite (maxX)
            if (this.x > this.maxX) this.x = this.maxX;

            this.touchRight.style.left = this.x + 'px';
        }

        this.updateLine();
        this.calculateValue();
    }

    updateLine() {
        // La ligne bleue commence au milieu du curseur gauche et finit au milieu du droit
        // Pour faire simple : de leftEdgeGauche à leftEdgeDroit
        const left = this.touchLeft.offsetLeft;
        const right = this.touchRight.offsetLeft;
        
        this.lineSpan.style.marginLeft = left + 'px';
        this.lineSpan.style.width = (right - left) + 'px';
    }

    calculateValue() {
        const rangeWidth = this.slider.offsetWidth - this.touchLeft.offsetWidth;
        if (rangeWidth <= 0) return;

        // Calcul direct basé sur la position (plus fiable que la largeur de la ligne)
        const leftRatio = this.touchLeft.offsetLeft / rangeWidth;
        const rightRatio = this.touchRight.offsetLeft / rangeWidth;

        // Conversion en valeur
        let rawMin = leftRatio * (this.max - this.min) + this.min;
        let rawMax = rightRatio * (this.max - this.min) + this.min;

        // Arrondi au step près
        this.minValue = Math.round(rawMin / this.step) * this.step;
        this.maxValue = Math.round(rawMax / this.step) * this.step;
        
        // Petit nettoyage pour éviter les 3.000000004
        this.minValue = parseFloat(this.minValue.toFixed(1));
        this.maxValue = parseFloat(this.maxValue.toFixed(1));

        this.emit('change', this.minValue, this.maxValue);
    }

    onStop() {
        document.removeEventListener('mousemove', this.func1);
        document.removeEventListener('mouseup', this.func2);
        document.removeEventListener('touchmove', this.func1);
        document.removeEventListener('touchend', this.func2);
        this.selectedTouch = null;
    }

    func = [];
    on(name, func) {
        this.func[name] = func;
    }
    emit(name, ...args) {
        if (this.func[name]) this.func[name](...args);
    }
}