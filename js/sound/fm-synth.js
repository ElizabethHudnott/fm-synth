/* This source code is copyright of Elizabeth Hudnott.
 * © Elizabeth Hudnott 2021-2022. All rights reserved.
 * Any redistribution or reproduction of part or all of the source code in any form is
 * prohibited by law other than downloading the code for your own personal non-commercial use
 * only. You may not distribute or commercially exploit the source code. Nor may you transmit
 * it or store it in any other website or other form of electronic retrieval system. Nor may
 * you translate it into another language.
 */
import {nextQuantum, logToLinear, outputLevelToGain, ClockRate, LFO_DIVISORS} from './common.js';
import {KeySync, Channel} from './fm-channel.js';
import TwoOperatorChannel from './two-op-channel.js';
import {EffectUnit} from './effect-unit.js';

export default class Synth {

	static sampleRate(clockRate, clockDivider1 = 7, clockDivider2 = 144) {
		return clockRate / (clockDivider1 * clockDivider2);
	}

	static keyCode(blockNumber, frequencyNumber) {
		const f11 = frequencyNumber >= 1024;
		const lsb = frequencyNumber >= 1152 || (!f11 && frequencyNumber >= 896);
		return (blockNumber << 2) + (f11 << 1) + lsb;
	}

	/**
	 * @param {number} tuningPrecision The highest precision supported by OPN is 1. For OPZ it's
	 * 0.5 and for OPL it's 2.
	 */
	constructor(
		context, numChannels = 6, output = context.destination, tuningPrecision = 1,
		clockRate = ClockRate.NTSC, clockDivider1 = 7, clockDivider2 = 144
	) {
		// Tuning data
		this.referencePitch = 440;
		this.referenceNote = 69;
		this.feedbackCallibration = 2.5;
		this.lfoFirstOnEnabled = 0;	// Bit mask of channel numbers
		this.keysOn = 0;
		this.setClockRate(clockRate, clockDivider1, clockDivider2);

		const channelGain = new GainNode(context, {gain: 1 / (2 * numChannels)});
		channelGain.connect(output);
		this.channelGain = channelGain.gain;

		const effects = new EffectUnit(context);
		this.effects = effects;
		effects.connectOut(channelGain);

		const dbCurve = new Float32Array(2047);
		dbCurve.fill(0, 0, 1024);
		for (let i = 1024; i < 2047; i++) {
			dbCurve[i] = logToLinear(i - 1023);
		}

		const channels = new Array(numChannels);
		const tuning = this.equalTemperament(0, tuningPrecision);
		for (let i = 0; i < numChannels; i++) {
			channels[i] = new Channel(this, context, channelGain, dbCurve, tuning, 1 << i);
		}
		this.channels = channels;

		const twoOpChannels = new Array(numChannels * 2 - 2);
		for (let i = 0; i < numChannels; i++) {
			const channel = channels[i];
			twoOpChannels[2 * i] = new TwoOperatorChannel(channel, 1, tuning, 1 << i);
			twoOpChannels[2 * i + 1] = new TwoOperatorChannel(channel, 3, tuning, 1 << i);
		}
		this.twoOpChannels = twoOpChannels;

		const pcmAmp = new GainNode(context, {gain: 0});
		pcmAmp.connect(channels[numChannels - 1].panner);
		this.pcmAmp = pcmAmp;
		this.dacRegister = undefined;
		this.pcmLevel = 0;
	}

	get numberOfChannels() {
		return this.channels.length;
	}

	enablePCMRegister(context) {
		const dacRegister = new ConstantSourceNode(context, {offset: 0});
		dacRegister.connect(this.pcmAmp);
		dacRegister.start();
		this.dacRegister = dacRegister;
	}

	/**Configures internal timings, etc. to match the real chip's behaviour in different
	 * settings such as PAL versus NTSC game consoles.
	 * @param {number} divider1 Use 15 for OPM
	 * @param {number} divider2 Use 64 for OPM
	 */
	setClockRate(clockRate, divider1 = 7, divider2 = 144) {
		clockRate /= divider1;
		this.envelopeTick = divider2 * 3 / clockRate;
		this.lfoRateDividend = clockRate / (divider2 * 128);
		this.frequencyStep = clockRate / (divider2 * 2 ** 20);
	}

	lfoPresetToFrequency(presetNum) {
		return presetNum === 0 ? 0 : this.lfoRateDividend / LFO_DIVISORS[presetNum - 1];
	}

	frequencyToLFOPreset(frequency) {
		if (frequency === 0) {
			return 0;
		}
		const divisor = Math.round(this.lfoRateDividend / frequency);
		const index = LFO_DIVISORS.indexOf(divisor);
		return index === -1 ? -1 : index + 1;
	}

	setFreeLFORate(context, frequency, time = nextQuantum(context), method = 'setValueAtTime') {
		for (let i = 0; i < this.channels.length; i++) {
			const channel = this.channels[i];
			if (channel.getLFOKeySync() === KeySync.OFF) {
				channel.setLFORate(context, frequency, time, method);
			}
		}
	}

	syncFreeLFOs(context, frequency = this.channels[0].getLFORate(), time = nextQuantum(context)) {
		const numChannels = this.channels.length;
		let channelMask = 0;
		for (let i = 0; i < numChannels; i++) {
			const channel = this.channels[i];
			if (channel.getLFOKeySync() === KeySync.OFF) {
				channelMask |= 1 << i;
				channel.setLFORate(context, 0, time);	// Destroy current LFO
			}
		}
		for (let i = 0; i < numChannels; i++) {
			if (channelMask & (1 << i)) {
				this.channels[i].setLFORate(context, frequency, time);
			}
		}
	}

	setKeySyncFirstOn(channelID, enabled) {
		let channelMask = this.lfoFirstOnEnabled;
		this.lfoFirstOnEnabled = (channelMask & ~channelID) | (channelID * enabled);
	}

	keyOn(context, channelID, time) {
		const firstOnMask = this.lfoFirstOnEnabled;
		if (!(this.keysOn & firstOnMask) && (firstOnMask & channelID)) {
			const numChannels = this.channels.length;
			for (let i = 0; i < numChannels; i++) {
				if (firstOnMask & (1 << i)) {
					this.channels[i].resetLFO(context, time);
				}
			}
		}
		this.keysOn |= channelID;
	}

	keyOff(channelID) {
		this.keysOn &= ~channelID;
	}

	start(time) {
		for (let channel of this.channels) {
			channel.start(time);
		}
	}

	stop(time = 0) {
		for (let channel of this.channels) {
			channel.stop(time);
		}
		if (this.dacRegister) {
			this.dacRegister.stop(time);
			this.dacRegister = undefined;
		}
	}

	soundOff(time = 0) {
		for (let channel of this.channels) {
			channel.soundOff(time);
		}
	}

	getChannel(channelNum) {
		return this.channels[channelNum - 1];
	}

	get2OperatorChannel(channelNum) {
		return this.twoOpChannels[channelNum - 1];
	}

	/**
	 * @param {number} pcmLevel The output level of the PCM channel. Values in the range 1..99
	 * (or -99..-1) will fade down the volume of the highest numbered FM channel to make space
	 * in the mix for the PCM content. Values greater than 99 (or less than -99) will
	 * additionally reduce the volume of the other FM channels as well as silencing the last
	 * one. PCM volume values up to 141 can be used for a six channel synth.
	 */
	mixPCM(pcmLevel, time = 0, method = 'setValueAtTime') {
		const numChannels = this.channels.length;
		const pcmGain = Math.min(outputLevelToGain(Math.abs(pcmLevel)), numChannels);

		let lastChannelGain, otherChannelsGain;
		if (pcmGain <= 1) {
			lastChannelGain = 1 - pcmGain;
			otherChannelsGain = 1;
		} else {
			lastChannelGain = 0;
			otherChannelsGain = 1 - (pcmGain - 1) / (numChannels - 1);
		}

		let channel = this.channels[numChannels - 1];
		lastChannelGain *= outputLevelToGain(channel.outputLevel);
		channel.setGain(lastChannelGain, time, method);

		for (let i = 0; i < numChannels - 1; i++) {
			const channel = this.channels[i];
			const gain = otherChannelsGain * outputLevelToGain(channel.outputLevel);
			channel.setGain(gain, time, method);
		}
		this.pcmAmp.gain[method](Math.sign(pcmLevel) * pcmGain, time);
		this.pcmLevel = pcmLevel
	}

	getPCMMix() {
		return this.pcmLevel;
	}

	writePCM(value, time) {
		const floatValue = (value - 128) / 128;
		this.dacRegister.offset.setValueAtTime(floatValue, time);
	}

	setChannelGain(level, time = 0, method = 'setValueAtTime') {
		// SQRT(2) comes from the Web Audio panning algorithm
		// https://webaudio.github.io/web-audio-api/#stereopanner-algorithm
		this.channelGain[method](level / (Math.SQRT2 * this.channels.length), time);
	}

	copyTuning(fromChannel, toChannel) {
		const source = this.channels[fromChannel - 1];
		const destination = this.channels[toChannel - 1];
		destination.octaveThreshold = source.octaveThreshold;
		destination.noteFreqBlockNumbers = source.noteFreqBlockNumbers;
		destination.noteFrequencyNumbers = source.noteFrequencyNumbers;
	}

	/**
	 * @param {number} frequency The pitch to tune the reference note to, in Hertz.
	 * @param {number} noteNumber The MIDI note number that gets tuned to the specified
	 * frequency, usually 69 (A4).
	 */
	setReferencePitch(frequency, noteNumber = 69) {
		this.referencePitch = frequency;
		this.referenceNote = noteNumber;
	}

	equalTemperament(
		detune = 0, precision = 1, interval = 2, divisions = 12, steps = [1], startIndex = 0
	) {
		const referencePitch = this.referencePitch;
		const referenceNote = this.referenceNote;
		const frequencyData = new Array(127);
		const numIntervals = steps.length;
		let noteNumber = 60;
		let stepIndex = startIndex;
		for (let i = 60; i < 127; i++) {
			const frequency = referencePitch *
				(interval ** ((noteNumber - referenceNote + detune / 100) / divisions));
			frequencyData[i] = frequency / this.frequencyStep;
			noteNumber  += steps[stepIndex];
			stepIndex = (stepIndex + 1) % numIntervals;
		}
		noteNumber = 60;
		stepIndex = startIndex - 1;
		for (let i = 59; i >= 0; i--) {
			if (stepIndex < 0) {
				stepIndex = numIntervals - 1;
			}
			noteNumber -= steps[stepIndex];
			const frequency = referencePitch *
				(interval ** ((noteNumber - referenceNote + detune / 100) / divisions));
			frequencyData[i] = frequency / this.frequencyStep;
			stepIndex--;
		}
		const ratio = interval ** (1 / divisions);
		return this.#spreadKeyCodes(frequencyData, ratio, precision);
	}

	ratioTuning(detune, ratios, startNote = 0, precision = 1) {
		const frequencyData = new Array(127);
		const numRatios = ratios.length - 1;
		const octaveInterval = ratios[numRatios];
		let referencePitch = this.referencePitch * 2 ** (detune / 1200);
		let referenceNote = this.referenceNote;
		// Start mapping from C by default (when startNote = 0)
		referencePitch /= ratios[(referenceNote - startNote) % 12];
		referenceNote = Math.trunc(referenceNote / 12) * 12 + startNote;
		let ratioCycles = 0, ratioIndex = 0;
		for (let i = referenceNote; i < 127; i++) {
			frequencyData[i] = referencePitch *
				(octaveInterval ** ratioCycles * ratios[ratioIndex]) / this.frequencyStep;
			ratioIndex++;
			if (ratioIndex === numRatios) {
				ratioCycles++;
				ratioIndex = 0;
			}
		}
		ratioCycles = -1;
		ratioIndex = numRatios - 1;
		for (let i = referenceNote - 1; i >= 0; i--) {
			frequencyData[i] = referencePitch *
				(octaveInterval ** ratioCycles * ratios[ratioIndex]) / this.frequencyStep;
			ratioIndex--;
			if (ratioIndex === -1) {
				ratioCycles--;
				ratioIndex = numRatios - 1;
			}
		}
		// Filter key tracking has to use equal temperament :(
		const ratio = octaveInterval ** (1 / numRatios);
		return this.#spreadKeyCodes(frequencyData, ratio, precision);
	}

	#spreadKeyCodes(frequencyData, ratio, precision) {
		let blocks = [], freqNums = [], keyCodes = [];
		const numInstances = new Array(32);
		numInstances.fill(0);
		const maxFreqNum = 2048 - 0.5 * precision;
		const lowOctavePrecision = Math.max(1, precision);
		for (let i = 0; i < 127; i++) {
			let block;
			let freqNum = frequencyData[i];
			let roundedFreqNum = Math.round(freqNum / lowOctavePrecision) * lowOctavePrecision;
			if (roundedFreqNum < 1023) {
				block = 0;
				freqNum = roundedFreqNum * 2;
			} else {
				block = 1;
				while (freqNum >= maxFreqNum) {
					freqNum /= 2;
					block++;
				}
				freqNum = Math.round(freqNum / precision) * precision;
			}
			blocks[i] = block;
			freqNums[i] = freqNum;
			const keyCode = Synth.keyCode(block, freqNums[i]);
			keyCodes[i] = keyCode;
			numInstances[keyCode]++;
		}
		// Don't worry about frequencies outside the range of most acoustic instruments
		let minIndex = 0;
		const standardA0 = 27.5 / this.frequencyStep;
		while (frequencyData[minIndex + 1] <= standardA0 && keyCodes[minIndex] === 0) {
			numInstances[0]--;
			minIndex++;
		}
		let maxIndex = 127;
		const standardC8 = 440 * (2 ** (39 / 12)) / this.frequencyStep;
		while (frequencyData[maxIndex - 1] >= standardC8 && keyCodes[maxIndex] === 31) {
			numInstances[31]--;
			maxIndex--;
		}

		let freqNumThreshold = 2048;
		let variance, newVariance = Infinity;
		let thresholdHistory = [2048, 2048];
		let changes;
		do {
			// Compute variance in key code tally
			variance = newVariance;
			let minKeyCode = keyCodes[minIndex];
			let maxKeyCode = keyCodes[maxIndex];
			let sum = 0;
			let sumSquares = 0;
			for (let i = minKeyCode; i <= maxKeyCode; i++) {
				const count = numInstances[i];
				sum += count;
				sumSquares += count * count;
			}
			const keyCodeRange = maxKeyCode - minKeyCode + 1;
			const mean = sum / keyCodeRange;
			newVariance = sumSquares / keyCodeRange - mean * mean;

			let newFreqNumThreshold = 0;
			for (let i = minIndex; i <= maxIndex; i++) {
				if (freqNums[i] < freqNumThreshold) {
					newFreqNumThreshold = Math.max(newFreqNumThreshold, freqNums[i]);
				}
			}
			thresholdHistory[0] = thresholdHistory[1];
			thresholdHistory[1] = freqNumThreshold;
			freqNumThreshold = newFreqNumThreshold;

			changes = false;
			for (let i = 0; i <= 127; i++) {
				if (freqNums[i] === freqNumThreshold && blocks[i] < 7) {
					blocks[i]++;
					freqNums[i] = Math.round(freqNums[i] / 2);
					const oldKeyCode = keyCodes[i];
					const keyCode = Synth.keyCode(blocks[i], freqNums[i]);
					keyCodes[i] = keyCode;
					numInstances[oldKeyCode]--;
					numInstances[keyCode]++;
					changes = true;
				}
			}

		} while (newVariance < variance || !changes);
		return {
			ratio: ratio,
			octaveThreshold: 	thresholdHistory[0] - 0.5,
			freqBlockNumbers: blocks,
			frequencyNumbers: freqNums,
		};
	}

}
