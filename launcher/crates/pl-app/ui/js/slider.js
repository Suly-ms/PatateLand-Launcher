// Curseur de RAM à deux poignées, repris de l'ancien launcher
// (src/assets/js/utils/slider.js, Luuxis License v1.0) avec trois ajouts :
// l'élément est passé directement, `refresh()` replace les poignées, et
// l'événement `release` signale la fin du glissement (pour n'enregistrer
// qu'une fois).

export default class Slider {
    constructor(element, minValue, maxValue) {
        this.slider = element;
        this.touchLeft = element.querySelector('.slider-touch-left');
        this.touchRight = element.querySelector('.slider-touch-right');
        this.lineSpan = element.querySelector('.slider-line span');
        this.func = {};
        this.isDragging = false;
        this.currentHandle = null;
        this.readBounds();
        this.minValue = minValue || this.min;
        this.maxValue = maxValue || this.max;
        this.init();
    }

    readBounds() {
        this.min = parseFloat(this.slider.getAttribute('min'));
        this.max = parseFloat(this.slider.getAttribute('max'));
        this.step = parseFloat(this.slider.getAttribute('step')) || 0.5;
    }

    init() {
        this.touchLeft.addEventListener('mousedown', (e) => this.startDrag(e, 'left'));
        this.touchRight.addEventListener('mousedown', (e) => this.startDrag(e, 'right'));
        document.addEventListener('mousemove', (e) => this.onDrag(e));
        document.addEventListener('mouseup', () => this.stopDrag());
        this.updatePositions();
    }

    startDrag(event, handle) {
        event.preventDefault();
        this.isDragging = true;
        this.currentHandle = handle;
        (handle === 'left' ? this.touchLeft : this.touchRight).classList.add('dragging');
    }

    onDrag(event) {
        if (!this.isDragging || !this.currentHandle) return;
        event.preventDefault();
        const rect = this.slider.getBoundingClientRect();
        const relativeX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        let value = this.min + relativeX * (this.max - this.min);
        if (this.step > 0) value = Math.round(value / this.step) * this.step;

        if (this.currentHandle === 'left') {
            this.minValue = Math.max(this.min, Math.min(value, this.maxValue - this.step));
        } else {
            this.maxValue = Math.min(this.max, Math.max(value, this.minValue + this.step));
        }
        this.updatePositions();
        this.emit('change', this.minValue, this.maxValue);
    }

    stopDrag() {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.touchLeft.classList.remove('dragging');
        this.touchRight.classList.remove('dragging');
        this.currentHandle = null;
        this.emit('release', this.minValue, this.maxValue);
    }

    /// Replace les poignées (valeurs enregistrées ou bornes modifiées).
    refresh(minValue, maxValue) {
        if (this.isDragging) return;
        this.readBounds();
        this.minValue = Math.max(this.min, Math.min(minValue, this.max - this.step));
        this.maxValue = Math.min(this.max, Math.max(maxValue, this.minValue + this.step));
        this.updatePositions();
    }

    updatePositions() {
        const sliderWidth = this.slider.offsetWidth;
        const handleWidth = this.touchLeft.offsetWidth;
        // Onglet caché : placé à la prochaine ouverture de l'onglet JEU.
        if (sliderWidth === 0 || handleWidth === 0) {
            this.updateLabels();
            return;
        }
        const span = this.max - this.min || 1;
        const leftPos = ((this.minValue - this.min) / span) * (sliderWidth - handleWidth);
        const rightPos = ((this.maxValue - this.min) / span) * (sliderWidth - handleWidth);
        this.touchLeft.style.setProperty('left', `${leftPos}px`, 'important');
        this.touchRight.style.setProperty('left', `${rightPos}px`, 'important');
        const barStart = leftPos + handleWidth / 2;
        const barEnd = rightPos + handleWidth / 2;
        this.lineSpan.style.marginLeft = `${barStart}px`;
        this.lineSpan.style.width = `${barEnd - barStart}px`;
        this.updateLabels();
    }

    updateLabels() {
        this.touchLeft.querySelector('span')?.setAttribute('value', `${this.minValue.toFixed(1)} Go`);
        this.touchRight.querySelector('span')?.setAttribute('value', `${this.maxValue.toFixed(1)} Go`);
    }

    on(name, func) {
        this.func[name] = func;
    }

    emit(name, ...args) {
        this.func[name]?.(...args);
    }
}
