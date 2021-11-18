import {
	decibelReductionToAmplitude, amplitudeToDecibels, CLOCK_RATE as OPN_CLOCK_RATE,
	LFO_FREQUENCIES, VIBRATO_PRESETS
} from './common.js';

const AMPLITUDES = new Array(16);
for (let i = 0; i < 15; i++) {
	AMPLITUDES[i] = decibelReductionToAmplitude(i * 2);
}
AMPLITUDES[15] = 0;

const CLOCK_RATE = {
	PAL: 	3546893,
	NTSC: 	3579545
}

const CLOCK_RATIO = OPN_CLOCK_RATE.NTSC / CLOCK_RATE.NTSC;

const AM_PRESETS = [0, 2, 6, 12];

let supportsCancelAndHold;

class PSGChannel {

	constructor(synth, context, lfo1, lfo2, output, reciprocalTable) {
		this.synth = synth;
		const saw = new OscillatorNode(context, {frequency: 0, type: 'sawtooth'});
		this.saw = saw;
		const frequency = new ConstantSourceNode(context, {offset: 0});
		this.frequencyNode = frequency;
		this.frequencyControl = frequency.offset;
		const fmMod = new GainNode(context);
		frequency.connect(fmMod);
		this.fmMod = fmMod.gain;
		const fmModGain = new GainNode(context, {gain: 0});
		fmModGain.connect(fmMod.gain);
		this.fmModAmp = fmModGain.gain;
		lfo1.connect(fmModGain);
		fmMod.connect(saw.frequency);

		const reciprocalInputScaler = new GainNode(context, {gain: 2 / synth.maxFrequency});
		fmMod.connect(reciprocalInputScaler);
		const reciprocal = new WaveShaperNode(context, {curve: reciprocalTable});
		reciprocalInputScaler.connect(reciprocal);
		const reciprocalShift = new ConstantSourceNode(context, {offset: -1});
		this.reciprocalShift = reciprocalShift;
		reciprocalShift.connect(reciprocal);
		this.reciprocal = reciprocal;
		const dutyCycle = new GainNode(context, {gain: 0.5});
		reciprocal.connect(dutyCycle);
		this.dutyCycle = dutyCycle.gain;
		const delay = new DelayNode(context, {delayTime: 0, maxDelayTime: 0.5});
		saw.connect(delay);
		dutyCycle.connect(delay.delayTime);
		const inverter = new GainNode(context, {gain: -1});
		delay.connect(inverter);
		this.wave = inverter.gain;
		const dcOffset = new ConstantSourceNode(context, {offset: 0});
		dcOffset.connect(inverter);
		this.dcOffset = dcOffset;
		const waveGain = new GainNode(context, {gain: 0});
		saw.connect(waveGain);
		inverter.connect(waveGain);
		this.waveAmp = waveGain.gain;

		const constant = new ConstantSourceNode(context, {offset: 0.5});
		this.constant = constant.offset;
		this.constantNode = constant;

		const pwm = new GainNode(context, {gain: 0});
		lfo2.connect(pwm);
		pwm.connect(dutyCycle.gain);
		const times2 = new GainNode(context, {gain: 2});
		pwm.connect(times2);
		times2.connect(dcOffset.offset);
		this.pwm = pwm.gain;

		const amMod = new GainNode(context);
		waveGain.connect(amMod);
		constant.connect(amMod);
		this.amMod = amMod.gain;
		const amModGain = new GainNode(context, {gain: 0});
		amModGain.connect(amMod.gain);
		this.amModAmp = amModGain.gain;
		lfo1.connect(amModGain);

		const envelopeGain = new GainNode(context, {gain: 0});
		amMod.connect(envelopeGain);
		envelopeGain.connect(output);
		this.envelopeGain = envelopeGain;

		this.frequency = 0;
		this.lastFreqChange = 0;
		this.keyCode = -Infinity;
	}

	start(time = 0) {
		this.saw.start(time);
		this.frequencyNode.start(time);
		this.reciprocalShift.start(time);
		this.dcOffset.start(time);
		this.constantNode.start(time);
	}

	stop(time = 0) {
		this.saw.stop(time);
		this.frequencyNode.stop(time);
		this.reciprocalShift.stop(time);
		this.dcOffset.stop(time);
		this.constantNode.stop(time);
		this.reciprocal.disconnect();
	}

	setFrequency(frequency, time = 0, method = 'setValueAtTime') {
		const limit = this.synth.frequencyLimit;
		if (frequency > limit) {
			this.frequencyControl[method](limit, time);
			this.waveAmp[method](0, time);
			this.constant[method](0.5, time);
		} else {
			this.frequencyControl[method](frequency, time);
			this.waveAmp[method](1, time);
			this.constant[method](0, time);
		}
		this.frequency = frequency;
		this.lastFreqChange = time;
		this.keyCode = this.synth.calcKeyCode(frequency);
	}

	getFrequency() {
		return this.frequency;
	}

	setFrequencyNumber(frequencyNumber, time = 0, method = 'setValueAtTime') {
		this.setFrequency(this.synth.frequencies[frequencyNumber], time, method);
	}

	getFrequencyNumber() {
		return Math.round(100000 * this.synth.clockRate / (this.frequency * 32)) / 100000;
	}

	setWave(value, time = 0, method = 'setValueAtTime') {
		this.wave[method](-value, time);
	}

	getWave() {
		return -this.wave.value;
	}

	setDutyCycle(value, time = 0, method = 'setValueAtTime') {
		this.dutyCycle[method](value, time);
		this.dcOffset.offset[method](2 * value - 1, time);
	}

	getDutyCycle() {
		return (this.dcOffset.offset.value + 1) / 2;
	}

	setPWMDepth(amount, time = 0, method = 'setValueAtTime') {
		this.pwm[method](amount, time);
	}

	getPWMDepth() {
		return this.pwm.value;
	}

	setAMDepth(decibels, time = 0, method = 'setValueAtTime') {
		const leftOver = decibelReductionToAmplitude(decibels);
		this.amModAmp[method](1 - leftOver, time);
		this.amMod[method](leftOver, time);
	}

	getAMDepth() {
		return amplitudeToDecibels(this.amModAmp.value);
	}

	useAMPreset(presetNum, time = 0) {
		this.setAMDepth(AM_PRESETS[presetNum], time);
	}

	getAMPreset() {
		return AM_PRESETS.indexOf(Math.round(this.getAMDepth()));
	}

	setVibratoDepth(cents, time = 0, method = 'setValueAtTime') {
		const depth = (2 ** (cents / 1200)) - 1;
		this.fmModAmp[method](-depth, time);
	}

	getVibratoDepth() {
		return -this.fmModAmp.value;
	}

	useVibratoPreset(presetNum, time = 0) {
		this.setVibratoDepth(VIBRATO_PRESETS[presetNum], time);
	}

	getVibratoPreset() {
		return VIBRATO_PRESETS.indexOf(this.getVibratoDepth());
	}

}

class PSG {

	constructor(context, output = context.destination, numWaveChannels = 3, clockRate = CLOCK_RATE.PAL) {
		this.clockRate = clockRate;
		const frequencies = new Array(1024);
		for (let i = 1; i < 1024; i++) {
			let frequency = clockRate / (i * 32);
			frequencies[i] = frequency;
		}
		frequencies[0] = frequencies[1];
		this.frequencies = frequencies;

		const frequencyLimit = context.sampleRate / 2;
		let maxFrequency;
		for (let i = 1; i < 1024; i++) {
			if (frequencies[i] <= frequencyLimit) {
				maxFrequency = frequencies[i];
				break;
			}
		}
		this.frequencyLimit = frequencyLimit;
		this.maxFrequency = maxFrequency;
		this.noteFrequencies = this.tunedMIDINotes(440);

		const opnClock = clockRate * CLOCK_RATIO;
		const opnFrequencyStep = opnClock / (144 * 2 ** 20);
		this.opnBaseNote = 256 * opnFrequencyStep;
		this.lfoRateMultiplier = opnClock / 8000000;

		const reciprocalTable = new Float32Array(maxFrequency + 1);
		reciprocalTable[0] = (2 - 2 ** -23) * 2 ** 127;
		for (let i = 1; i <= maxFrequency; i++) {
			reciprocalTable[i] = 1 / i;
		}

		const lfo1 = new OscillatorNode(context, {frequency: 0, type: 'triangle'});
		this.lfo1 = lfo1;
		supportsCancelAndHold = lfo1.frequency.cancelAndHoldAtTime !== undefined;
		const lfo2 = new OscillatorNode(context, {frequency: 0, type: 'triangle'});
		this.lfo2 = lfo2;

		const channelGain = new GainNode(context, {gain: 1 / numWaveChannels});
		channelGain.connect(context.destination);
		const channels = [];
		for (let i = 0; i < numWaveChannels; i++) {
			const channel = new PSGChannel(this, context, lfo1, lfo2, channelGain, reciprocalTable);
			channels[i] = channel;
		}
		this.channels = channels;

	}

	start(time) {
		this.lfo1.start(time);
		this.lfo2.start(time);
		for (let channel of this.channels) {
			channel.start(time);
		}
	}

	stop(time = 0) {
		this.lfo1.stop(time);
		this.lfo2.stop(time);
		for (let channel of this.channels) {
			channel.stop(time);
		}
	}

	setLFOFrequency(frequency, time = 0, method = 'setValueAtTime') {
		this.lfo1.frequency[method](frequency, time);
	}

	getLFOFrequency() {
		return this.lfo1.frequency.value;
	}

	useLFOPreset(n, time = 0) {
		this.setLFOFrequency(LFO_FREQUENCIES[n] * this.lfoRateMultiplier, time);
	}

	getLFOPreset() {
		let frequency = this.getLFOFrequency() / this.lfoRateMultiplier;
		frequency = Math.round(frequency * 100) / 100;
		return LFO_FREQUENCIES.indexOf(frequency);
	}

	setPWMFrequency(frequency, time = 0, method = 'setValueAtTime') {
		this.lfo2.frequency[method](frequency, time);
	}

	getPWMFrequency() {
		return this.lfo2.frequency.value;
	}

	tunedMIDINotes(a4Pitch) {
		const frequencyNums = new Array(128);
		let freqNum = 1;
		for (let i = 127; i >= 0; i--) {
			const frequency = a4Pitch * (2 ** ((i - 69) / 12));
			let upperFreqNum = freqNum;
			let upperFrequency;
			do {
				upperFreqNum++;
				upperFrequency = this.frequencies[upperFreqNum];
			} while (upperFrequency >= frequency && upperFreqNum < 1023);
			upperFreqNum--;
			if (upperFreqNum < 1023) {
				upperFrequency = this.frequencies[upperFreqNum];
				const upperFreqDiff = upperFrequency - frequency;
				const lowerFrequency = this.frequencies[upperFreqNum + 1];
				const lowerFreqDiff = frequency - lowerFrequency;
				freqNum = upperFreqDiff < lowerFreqDiff ? upperFreqNum : upperFreqNum + 1;
				frequencyNums[i] = freqNum;
			} else {
				break;
			}
		}
		const frequencies = new Array(128);
		for (let i = 0; i < 128; i++) {
			const idealFrequency = frequencies[i] || a4Pitch * (2 ** ((i - 69) / 12));
			const freqNum = frequencyNums[i];
			const approxFrequency = this.frequencies[freqNum];

			if (freqNum === undefined) {
				// Low notes are outside the range of the original chip
				frequencies[i] = idealFrequency;
			} else if (freqNum === frequencyNums[i - 1]) {
				const error = Math.abs((approxFrequency - idealFrequency) / idealFrequency);
				const prevIdealFrequency = a4Pitch * (2 ** ((i - 70) / 12))
				const prevError = Math.abs((approxFrequency - prevIdealFrequency) / prevIdealFrequency);
				if (error > prevError && idealFrequency > approxFrequency) {
					// Use ideal frequency
					frequencyNums[i] = undefined;
				} else {
					// Use original chip frequency, previous note uses ideal frequency
					frequencies[i] = approxFrequency;
					frequencies[i - 1] = prevIdealFrequency;
				}
			} else if (frequencyNums[i - 1] === undefined) {
				if (approxFrequency > frequencies[i - 1]) {
					frequencies[i] = approxFrequency;
				} else {
					frequencies[i] = idealFrequency;
					frequencyNums[i] = undefined;
				}
			} else {
				frequencies[i] = approxFrequency;
			}
		}
		return frequencies;
	}

	frequencyNumToNote(frequencyNum) {
		let lb = 0;
		let ub = 127;
		while (lb < ub) {
			let mid = Math.trunc((lb + ub) / 2);
			const noteFreqNum = this.noteFrequencies[mid];
			if (frequencyNum < noteFreqNum) {
				lb = mid + 1;
			} else if (frequencyNum > noteFreqNum) {
				ub = mid - 1;
			} else {
				return mid;
			}
		}
		return lb;
	}

	getLFO(n) {
		return n === 1 ? this.lfo1 : this.lfo2;
	}

	calcKeyCode(frequency) {
		const multiple = frequency / this.opnBaseNote;
		const octave = Math.log2(multiple) + 1;
		const block = Math.max(Math.trunc(octave) - 2, 0);
		const lsbs = Math.ceil(octave - block);
		return (block << 2) + lsbs;
	}

}

export {
	PSGChannel, PSG,
	AM_PRESETS, CLOCK_RATE, CLOCK_RATIO
}