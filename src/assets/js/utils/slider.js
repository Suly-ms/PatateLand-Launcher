/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

'use strict';

export default class Slider {
    constructor(id, minValue, maxValue) {
        this.slider = document.querySelector(id);
        
        if (!this.slider) {
            console.error(`Slider not found: ${id}`);
            return;
        }
        
        this.touchLeft = this.slider.querySelector('.slider-touch-left');
        this.touchRight = this.slider.querySelector('.slider-touch-right');
        this.lineSpan = this.slider.querySelector('.slider-line span');

        if (!this.touchLeft || !this.touchRight || !this.lineSpan) {
            console.error('Slider elements not found');
            return;
        }

        this.min = parseFloat(this.slider.getAttribute('min'));
        this.max = parseFloat(this.slider.getAttribute('max'));
        this.step = parseFloat(this.slider.getAttribute('step')) || 0.5;

        this.minValue = minValue || this.min;
        this.maxValue = maxValue || this.max;

        this.isDragging = false;
        this.currentHandle = null;


        // Initialiser immédiatement
        this.init();
    }

    init() {
        // S'assurer que le slider a des dimensions
        if (this.slider.offsetWidth === 0) {
            setTimeout(() => this.init(), 50);
            return;
        }


        // Positionner IMMÉDIATEMENT
        this.updatePositions();

        // Événements
        this.touchLeft.addEventListener('mousedown', (e) => this.startDrag(e, 'left'));
        this.touchLeft.addEventListener('touchstart', (e) => this.startDrag(e, 'left'), { passive: false });
        this.touchRight.addEventListener('mousedown', (e) => this.startDrag(e, 'right'));
        this.touchRight.addEventListener('touchstart', (e) => this.startDrag(e, 'right'), { passive: false });

        document.addEventListener('mousemove', (e) => this.onDrag(e));
        document.addEventListener('touchmove', (e) => this.onDrag(e), { passive: false });
        document.addEventListener('mouseup', () => this.stopDrag());
        document.addEventListener('touchend', () => this.stopDrag());
    }

    startDrag(event, handle) {
        event.preventDefault();
        this.isDragging = true;
        this.currentHandle = handle;
        
        
        if (handle === 'left') {
            this.touchLeft.classList.add('dragging');
        } else {
            this.touchRight.classList.add('dragging');
        }
    }

    onDrag(event) {
        if (!this.isDragging || !this.currentHandle) return;
        
        event.preventDefault();

        // Récupérer la position X de l'événement
        const clientX = event.type.includes('touch') ? event.touches[0].clientX : event.clientX;
        
        // Récupérer les dimensions du slider
        const sliderRect = this.slider.getBoundingClientRect();
        const sliderWidth = sliderRect.width;
        
        // Calculer la position relative dans le slider (0 à 1)
        let relativeX = (clientX - sliderRect.left) / sliderWidth;
        
        // Contraindre entre 0 et 1
        relativeX = Math.max(0, Math.min(1, relativeX));
        
        // Calculer la valeur correspondante
        let value = this.min + (relativeX * (this.max - this.min));
        
        // Arrondir selon le step
        if (this.step > 0) {
            value = Math.round(value / this.step) * this.step;
        }

        // Mettre à jour la valeur appropriée
        if (this.currentHandle === 'left') {
            // Le curseur gauche ne peut pas dépasser le curseur droit
            if (value >= this.maxValue - this.step) {
                value = this.maxValue - this.step;
            }
            this.minValue = value;
        } else {
            // Le curseur droit ne peut pas descendre en dessous du curseur gauche
            if (value <= this.minValue + this.step) {
                value = this.minValue + this.step;
            }
            this.maxValue = value;
        }

        // Mettre à jour l'affichage
        this.updatePositions();
        
        // Émettre l'événement de changement
        this.emit('change', this.minValue, this.maxValue);
    }

    stopDrag() {
        if (!this.isDragging) return;
        
        
        this.isDragging = false;
        this.touchLeft.classList.remove('dragging');
        this.touchRight.classList.remove('dragging');
        this.currentHandle = null;
    }

    updatePositions() {
        const sliderWidth = this.slider.offsetWidth;
        const handleWidth = this.touchLeft.offsetWidth;

        if (sliderWidth === 0 || handleWidth === 0) {
            console.warn('Invalid dimensions, skipping update');
            return;
        }


        // Calculer les positions en pourcentage
        const leftPercent = ((this.minValue - this.min) / (this.max - this.min));
        const rightPercent = ((this.maxValue - this.min) / (this.max - this.min));

        // Positionner les curseurs
        const leftPos = leftPercent * (sliderWidth - handleWidth);
        const rightPos = rightPercent * (sliderWidth - handleWidth);


        // Appliquer avec !important
        this.touchLeft.style.setProperty('left', leftPos + 'px', 'important');
        this.touchRight.style.setProperty('left', rightPos + 'px', 'important');


        // Mettre à jour la barre colorée
        const barStart = leftPos + (handleWidth / 2);
        const barEnd = rightPos + (handleWidth / 2);
        
        this.lineSpan.style.marginLeft = barStart + 'px';
        this.lineSpan.style.width = (barEnd - barStart) + 'px';

        // Mettre à jour les labels
        this.updateLabels();
    }

    updateLabels() {
        const minSpan = this.touchLeft.querySelector('span');
        const maxSpan = this.touchRight.querySelector('span');
        
        if (minSpan) minSpan.setAttribute('value', `${this.minValue.toFixed(1)} Go`);
        if (maxSpan) maxSpan.setAttribute('value', `${this.maxValue.toFixed(1)} Go`);
    }

    setMinValue(value) {
        this.minValue = Math.max(this.min, Math.min(value, this.maxValue - this.step));
        this.updatePositions();
    }

    setMaxValue(value) {
        this.maxValue = Math.min(this.max, Math.max(value, this.minValue + this.step));
        this.updatePositions();
    }

    reset() {
        this.minValue = this.min;
        this.maxValue = this.max;
        this.updatePositions();
    }

    // Système d'événements
    func = {};

    on(name, func) {
        this.func[name] = func;
    }

    emit(name, ...args) {
        if (this.func[name]) {
            this.func[name](...args);
        }
    }
}