import {LFO_FREQUENCIES, VIBRATO_PRESETS} from './src/common.js';
import GenesisSound from './src/genesis.js';
import YM2612 from './src/ym2612.js';
import {logToLinear, linearToLog} from './src/opn2.js';

let context, channels;

function initialize() {
	if (context !== undefined) {
		return;
	}
	context = new AudioContext({sampleRate: 96000});
	window.audioContext = context;
	const soundSystem = new GenesisSound(context);
	window.soundSystem = soundSystem;
	window.synth = soundSystem.fm;
	channels = synth.channels;
	window.chan = synth.getChannel(1);
	window.psg = soundSystem.psg;
	window.ym2612 = new YM2612(soundSystem.fm);

	soundSystem.start(context.currentTime + 0.01);
	synth.setChannelGain(6);
}

document.body.addEventListener('keydown', function (event) {
	initialize();
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.activeElement.type === 'number') {
		return;
	}
	channels[0].keyOn(context, context.currentTime + 0.1);
});

document.body.addEventListener('keyup', function (event) {
	initialize();
	channels[0].keyOff(context.currentTime + 0.1);
});

let filterFrequency, filterQ;

document.getElementById('filter-enable').addEventListener('input', function (event) {
	initialize();
	if (this.checked) {
		soundSystem.setFilterCutoff(filterFrequency);
		soundSystem.setFilterResonance(filterQ);
	} else {
		filterFrequency = soundSystem.getFilterCutoff();
		soundSystem.setFilterCutoff(21050);
		filterQ = soundSystem.getFilterResonance();
		soundSystem.setFilterResonance(0);
	}
});

document.getElementById('filter-cutoff-slider').addEventListener('input', function (event) {
	initialize();
	filterFrequency = parseInt(this.value);
	const box = document.getElementById('filter-cutoff');
	box.value = filterFrequency;
	soundSystem.setFilterCutoff(filterFrequency);
});

document.getElementById('filter-cutoff').addEventListener('input', function (event) {
	initialize();
	const value = parseFloat(this.value);
	if (value >= 0) {
		document.getElementById('filter-cutoff-slider').value = value;
		soundSystem.setFilterCutoff(value);
		filterFrequency = value;
	}
});

document.getElementById('filter-q-slider').addEventListener('input', function (event) {
	initialize();
	filterQ = parseFloat(this.value);
	const box = document.getElementById('filter-q');
	box.value = filterQ;
	soundSystem.setFilterResonance(filterQ);
});

document.getElementById('filter-q').addEventListener('input', function (event) {
	initialize();
	const value = parseFloat(this.value);
	if (value >= -770.63678 && value <= 770.63678) {
		document.getElementById('filter-q-slider').value = value;
		soundSystem.setFilterResonance(value);
		filterQ = value;
	}
});

function updateAlgorithmDetails() {
	for (let i = 1; i <= 3; i ++) {
		for (let j = i + 1; j <= 4; j++) {
			const depth = channels[0].getModulationDepth(i, j);
			const box = document.getElementById('modulation-' + i + '-' + j);
			box.value = depth * 100;
		}
	}
	for (let i = 1; i <= 4; i++) {
		const outputLevel = channels[0].getOperator(i).getVolume();
		const box = document.getElementById('output-level-' + i);
		box.value = Math.round(linearToLog(outputLevel) * 200) / 2;
	}
}

function algorithmRadio(event) {
	initialize();
	for (let i = 1; i <=4; i++) {
		const checkbox = document.getElementById('op' + i + '-enabled');
		if (!checkbox.checked) {
			checkbox.click();
		}
	}
	const algorithmNumber = parseInt(this.id.slice(-1));
	channels.map(c => c.useAlgorithm(algorithmNumber));
	setTimeout(updateAlgorithmDetails, 20);
}

for (let i = 0; i <= 7; i++) {
	document.getElementById('algorithm-' + i).addEventListener('click', algorithmRadio);
}

function modulationDepth(event) {
	const value = parseFloat(this.value) / 100;
	if (Number.isFinite(value)) {
		const id = this.id;
		const from = parseInt(id.slice(-3));
		const to = parseInt(id.slice(-1));
		channels.map(c => c.setModulationDepth(from, to, value));
	}
}

for (let i = 1; i <= 3; i++) {
	for (let j = i + 1; j <= 4; j++) {
		document.getElementById('modulation-' + i + '-' + j).addEventListener('input', modulationDepth);
	}
}

function outputLevel() {
	const value = parseFloat(this.value);
	if (Number.isFinite(value)) {
		const opNum = parseInt(this.id.slice(-1));
		const volume = logToLinear(value / 100);
		channels.map(c => c.getOperator(opNum).setVolume(volume));
	}
}

for (let i = 1; i <= 4; i++) {
	document.getElementById('output-level-' + i).addEventListener('input', outputLevel);
}

document.getElementById('lfo-frequency-slider').addEventListener('input', function (event) {
	initialize();
	const value = parseFloat(this.value);
	const fast = document.getElementById('fast-lfo').checked;
	const free = document.getElementById('lfo-frequency-free').checked;
	let frequency;
	if (free) {
		frequency = value;
	} else {
		frequency = value === 0 ? 0 : LFO_FREQUENCIES[value - 1] * synth.lfoRateMultiplier;
	}
	synth.setLFOFrequency(frequency);
	document.getElementById('lfo-frequency').value = Math.round(frequency * 100) / 100;
});

function configureLFOFreqSlider(fast, free) {
	const slider = document.getElementById('lfo-frequency-slider');
	if (fast) {
		// Enable faster rates
		if (free) {
			slider.min = Math.ceil(LFO_FREQUENCIES[5] * synth.lfoRateMultiplier * 10) / 10;
			slider.max = Math.ceil(LFO_FREQUENCIES[7] * synth.lfoRateMultiplier * 10) / 10;
			slider.step = 0.1;
		} else {
			slider.min = 6;
			slider.max = 8;
			slider.step = 1;
		}
	} else {
		// Slower rates
		if (free) {
			slider.min = 0;
			slider.max = Math.ceil(LFO_FREQUENCIES[5] * synth.lfoRateMultiplier * 10) / 10;
			slider.step = 0.01;
		} else {
			slider.min = 0;
			slider.max = 6;
			slider.step = 1;
		}
	}
}

document.getElementById('lfo-frequency').addEventListener('input', function (event) {
	const value = parseFloat(this.value);
	if (value >= 0) {
		const fastCheckbox = document.getElementById('fast-lfo');
		const fastThreshold = Math.ceil(LFO_FREQUENCIES[5] * synth.lfoRateMultiplier * 10) / 10;
		if (fastCheckbox.checked && value < fastThreshold) {
			fastCheckbox.checked = false;
			configureLFOFreqSlider(false, true);
		} else if (!fastCheckbox.checked && value > fastThreshold) {
			fastCheckbox.checked = true;
			configureLFOFreqSlider(true, true);
		}
		document.getElementById('lfo-frequency-slider').value = value;
		synth.setLFOFrequency(value);
	}
});

document.getElementById('fast-lfo').addEventListener('input', function (event) {
	initialize();
	const slider = document.getElementById('lfo-frequency-slider');
	const box = document.getElementById('lfo-frequency');
	const fast = this.checked;
	const free = document.getElementById('lfo-frequency-free').checked;
	configureLFOFreqSlider(fast, free);
	if (fast) {
		slider.value = slider.min;
	} else {
		slider.value = slider.max;
	}
	const frequency = free ? parseFloat(slider.value) : LFO_FREQUENCIES[5] * synth.lfoRateMultiplier;
	box.value = Math.round(frequency * 100) / 100;
	synth.setLFOFrequency(frequency);
});

document.getElementById('lfo-frequency-free').addEventListener('input', function (event) {
	initialize();
	const slider = document.getElementById('lfo-frequency-slider');
	const box = document.getElementById('lfo-frequency');
	const value = synth.getLFOFrequency();
	const fast = document.getElementById('fast-lfo').checked;
	const free = this.checked;
	box.disabled = !free;
	configureLFOFreqSlider(fast, free);
	if (free) {
		slider.value = value;
	} else {
		let delta = value;
		let presetNum = 8;
		for (let i = 7; i >= 0; i--) {
			const presetValue = LFO_FREQUENCIES[i] * synth.lfoRateMultiplier;
			const thisDelta = Math.abs(value - presetValue);
			if (thisDelta < delta) {
				delta = thisDelta;
				presetNum = i;
			}
			if (presetValue <= value) {
				break;
			}
		}
		slider.value = presetNum === 8 ? 0 : presetNum + 1;
		box.value = Math.round(LFO_FREQUENCIES[presetNum] * synth.lfoRateMultiplier * 100) / 100;
		synth.useLFOPreset(presetNum);
	}
});

document.getElementById('lfo-delay-slider').addEventListener('input', function (event) {
	initialize();
	const value = parseFloat(this.value);
	document.getElementById('lfo-delay').value = value;
	channels.map(c => c.setLFOAttack(value));
});

document.getElementById('lfo-delay').addEventListener('input', function (event) {
	initialize();
	const value = parseFloat(this.value);
	if (value >= 0) {
		document.getElementById('lfo-delay-slider').value = value;
		channels.map(c => c.setLFOAttack(value));
	}
});

function vibratoPresetToCents(x) {
	if (x === 0) {
		return 0;
	} else if (x <= 3) {
		return 3.3 * x + 0.1;
	} else if (x < 5) {
		return 10 * 2 ** ((x - 3) / 2);
	} else {
		return 10 * 2 ** (x - 4);
	}
}

function centsToVibratoPreset(cents) {
	cents = Math.abs(cents);
	if (cents <= 0.1) {
		return 0;
	} else if (cents <= 10) {
		return (cents - 0.1) / 3.3;
	} else if (cents < 20) {
		return Math.log2(cents / 10) * 2 + 3;
	} else {
		return Math.log2(cents / 10) + 4;
	}
}

document.getElementById('vibrato-slider').addEventListener('input', function (event) {
	initialize();
	const value = parseFloat(this.value);
	const free = document.getElementById('vibrato-free').checked;
	const box = document.getElementById('vibrato');
	let cents;
	if (free) {
		const sign = channels[0].getVibratoDepth() < 0 ? -1 : 1;
		cents = sign * vibratoPresetToCents(value);
	} else {
		cents = VIBRATO_PRESETS[value];
	}
	box.value = Math.round(cents * 10) / 10;
	channels.map(c => c.setVibratoDepth(cents));
});

document.getElementById('vibrato-free').addEventListener('input', function (event) {
	initialize();
	const slider = document.getElementById('vibrato-slider');
	const box = document.getElementById('vibrato');
	const free = this.checked;
	box.disabled = !free;
	if (free) {
		slider.step = 0.02;
	} else {
		let cents = Math.abs(channels[0].getVibratoDepth());
		let presetNum = centsToVibratoPreset(cents);
		const lowerPresetNum = Math.trunc(presetNum);
		const upperPresetNum = Math.ceil(presetNum);
		const lowerCents = VIBRATO_PRESETS[lowerPresetNum];
		const upperCents = VIBRATO_PRESETS[upperPresetNum];
		const lowerDelta = cents - lowerCents;
		const upperDelta = upperCents - cents;
		if (upperDelta <= lowerDelta) {
			presetNum = upperPresetNum;
			cents = upperCents;
		} else {
			presetNum = lowerPresetNum;
			cents = lowerCents;
		}
		slider.step = 1;
		slider.value = presetNum;
		box.value = cents;
		channels.map(c => c.setVibratoDepth(cents));
	}
});

document.getElementById('vibrato').addEventListener('input', function (event) {
	const cents = parseFloat(this.value);
	if (!Number.isFinite(cents)) {
		return;
	}
	document.getElementById('vibrato-slider').value = centsToVibratoPreset(cents);
	channels.map(c => c.setVibratoDepth(cents));
});

function getOperator(element) {
	while (element !== null) {
		if ('operator' in element.dataset) {
			return parseInt(element.dataset.operator);
		}
		element = element.parentElement;
	}
}

function frequencyMultipleSlider(event) {
	initialize();
	let value = parseFloat(this.value);
	if (value === 0) {
		value = 0.5;
	}
	const opNum = getOperator(this);
	document.getElementById('op' + opNum + '-freq-unfixed').checked = true;
	document.getElementById('op' + opNum + '-multiple').value = value;
	channels.map(c => {
		c.fixFrequency(opNum, false);
		c.setFrequencyMultiple(opNum, value, 0)
	});
}

function frequencyMultiple(event) {
	const opNum = getOperator(this);
	const valueStr = this.value;
	let numerator = parseFloat(valueStr);
	if (!(numerator >= 0)) {
		return;
	}
	let denominator = 1;
	const slashIndex = valueStr.indexOf('/');
	if (slashIndex !== -1) {
		denominator = parseInt(valueStr.slice(slashIndex + 1));
		if (!(denominator > 0)) {
			return;
		}
	}
	const value = numerator / denominator;
	document.getElementById('op' + opNum + '-multiple-slider').value = value;
	channels.map(c => c.setFrequencyMultiple(opNum, value, 0));
}

function frequencyFreeMultiple(event) {
	initialize();
	const opNum = getOperator(this);
	const slider = document.getElementById('op' + opNum + '-multiple-slider');
	const box = document.getElementById('op' + opNum + '-multiple');
	let value = channels[0].getFrequencyMultiple(opNum);
	box.disabled = !this.checked;
	if (this.checked) {
		slider.step = 0.01;
		if (value < 1) {
			slider.value = value; // 0..1 on the slider represent those exact values.
		}
		return;
	}
	slider.step = 1;
	if (value < 0.75) {
		value = 0.5;
	} else if (value > 15) {
		value = 15;
	} else {
		value = Math.round(value);
	}
	slider.value = value === 0.5 ? 0 : value;	// 0 on the slider represents 0.5.
	box.value = value;
	channels.map(c => c.setFrequencyMultiple(opNum, value, 0));
}

function frequency(event) {
	initialize();
	const opNum = getOperator(this);
	document.getElementById('op' + opNum + '-freq-fixed').checked = true;
	const block = parseInt(document.getElementById('op' + opNum + '-block').value);
	let freqNum = parseInt(document.getElementById('op' + opNum + '-freq-num').value);
	if (!(freqNum >= 0 && freqNum <= 2047)) {
		freqNum = channels[0].getOperator(opNum).getFrequencyNumber();
	}
	channels.map(c => {
		c.fixFrequency(opNum, true);
		c.setOperatorFrequency(opNum, block, freqNum);
	});
}

function rateScaleSlider(event) {
	initialize();
	const opNum = getOperator(this);
	const value = parseFloat(this.value);
	document.getElementById('op' + opNum + '-rate-scale').value = value;
	channels.map(c => c.getOperator(opNum).setRateScaling(value));
}

function rateScale(event) {
	const opNum = getOperator(this);
	const value = parseFloat(this.value);
	if (Number.isFinite(value)) {
		document.getElementById('op' + opNum + '-rate-scale-slider').value = value;
		channels.map(c => c.getOperator(opNum).setRateScaling(value));
	}
}

function rateScaleFree(event) {
	initialize();
	const opNum = getOperator(this);
	const slider = document.getElementById('op' + opNum + '-rate-scale-slider');
	const box = document.getElementById('op' + opNum + '-rate-scale');
	const free = this.checked;
	box.disabled = !free;
	if (free) {
		slider.step = 0.05;
	} else {
		let scaling = Math.round(channels[0].getOperator(opNum).getRateScaling());
		if (scaling > 3) {
			scaling = 3;
		} else if (scaling < 0) {
			scaling = 0;
		}
		slider.step = 1;
		slider.value = scaling;
		box.value = scaling;
		channels.map(c => c.getOperator(opNum).setRateScaling(scaling));
	}
}

let domParser = new DOMParser();

function createOperatorPage(n) {
	const li = document.createElement('LI');
	li.className = 'nav-item operator-' + n;
	const anchor = document.createElement('A');
	anchor.innerHTML = 'Operator ' + n;
	anchor.className = 'nav-link';
	const id = 'operator-' + n + '-tab';
	anchor.id = id;
	anchor.dataset.toggle = 'tab';
	anchor.href = '#operator-' + n;
	li.appendChild(anchor);
	document.getElementById('instrument-tablist').appendChild(li);

	let html = document.getElementById('operator-template').innerHTML;
	html = html.replace(/\$/g, n);
	const doc = domParser.parseFromString(html, 'text/html');
	const opStr = 'op' + n;
	doc.getElementById(opStr + '-multiple-slider').addEventListener('input', frequencyMultipleSlider);
	doc.getElementById(opStr + '-multiple').addEventListener('input', frequencyMultiple);
	doc.getElementById(opStr + '-multiple-free').addEventListener('input', frequencyFreeMultiple);
	doc.getElementById(opStr + '-block').addEventListener('input', frequency);
	doc.getElementById(opStr + '-freq-num').addEventListener('input', frequency);
	doc.getElementById(opStr + '-rate-scale-slider').addEventListener('input', rateScaleSlider);
	doc.getElementById(opStr + '-rate-scale').addEventListener('input', rateScale);
	doc.getElementById(opStr + '-rate-scale-free').addEventListener('input', rateScaleFree);
	document.getElementById('instrument-tabs').append(doc.body.children[0]);
}

createOperatorPage(1);
createOperatorPage(2);
createOperatorPage(3);
createOperatorPage(4);
domParser = undefined;

function enableOperator(event) {
	const opNum = parseInt(this.id[2]);
	for (let i = opNum + 1; i <= 4; i++) {
		document.getElementById('modulation-' + opNum + '-' + i).value = 0;
	}
	for (let elem of document.getElementsByClassName('operator-' + opNum)) {
		elem.hidden = false;
	}
	const volumeBox = document.getElementById('output-level-' + opNum);
	const volume = logToLinear(parseFloat(volumeBox.value) / 100) || 1;
	channels.map(c => c.enableOperator(opNum, volume));
	setTimeout(updateAlgorithmDetails, 20);
}

function disableOperator(event) {
	initialize();
	const opNum = parseInt(this.id[2]);
	channels.map(c => c.disableOperator(opNum));
	for (let elem of document.getElementsByClassName('operator-' + opNum)) {
		elem.hidden = true;
	}
}

for (let i = 1; i <=4; i++) {
	document.getElementById('op' + i + '-enabled').addEventListener('input', enableOperator);
	document.getElementById('op' + i + '-disabled').addEventListener('input', disableOperator);
}
