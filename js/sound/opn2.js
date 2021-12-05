import {
	decibelReductionToAmplitude, amplitudeToDecibels, TIMER_IMPRECISION, CLOCK_RATE,
	LFO_FREQUENCIES, VIBRATO_PRESETS
} from './common.js';

let supportsCancelAndHold;

function cancelAndHoldAtTime(param, holdValue, time) {
	if (supportsCancelAndHold) {
		param.cancelAndHoldAtTime(time);
	} else {
		param.cancelScheduledValues(time);
	}
	param.setValueAtTime(holdValue, time);
}

function logToLinear(x) {
	return Math.sign(x) * 10 ** (54 / 20 * (Math.abs(x) - 1));
}

function linearToLog(y) {
	return y === 0 ? 0 : Math.sign(y) * (20 / 54 * Math.log10(Math.abs(y)) + 1);
}

function calcKeyCode(blockNumber, frequencyNumber) {
	const f11 = frequencyNumber >= 1024;
	const lsb = frequencyNumber >= 1152 || (!f11 && frequencyNumber >= 896);
	return (blockNumber << 2) + (f11 << 1) + lsb;
}

function componentsToFullFreq(blockNumber, frequencyNumber) {
	return Math.trunc(0.5 * (frequencyNumber << blockNumber));
}

function fullFreqToComponents(fullFrequencyNumber) {
	let freqNum = fullFrequencyNumber;
	let block;
	if (freqNum < 1023.75) {
		block = 0;
		freqNum *= 2;
	} else {
		block = 1;
		while (freqNum >= 2047.5) {
			freqNum /= 2;
			block++;
		}
	}
	return [block, Math.round(freqNum)];
}

const ENV_INCREMENT_MOD = [0, 0, 4, 4, 4, 4, 6, 6];
for (let i = 8; i < 60; i++) {
	ENV_INCREMENT_MOD[i] = (i % 4) + 4;
}
for (let i = 60; i <= 63; i++) {
	ENV_INCREMENT_MOD[i] = 4;
}

// For decay, sustain and release
const ENV_INCREMENT = new Array(64);
for (let i = 0; i < 60; i++) {
	const power = Math.trunc(i / 4) - 14;
	ENV_INCREMENT[i] =  ENV_INCREMENT_MOD[i] * (2 ** power);
}

const SSG_RAMPS = new Array(8);
{
	// Ramp 4 units per 8 ticks
	SSG_RAMPS[0] = new Float32Array(343);
	SSG_RAMPS[4] = new Float32Array(343);
	// Ramp 5 units per 8 ticks
	SSG_RAMPS[1] = new Float32Array(275);
	SSG_RAMPS[5] = new Float32Array(275);
	// Ramp 6 units per 8 ticks
	SSG_RAMPS[2] = new Float32Array(229);
	SSG_RAMPS[6] = new Float32Array(229);
	// Ramp 7 units per 8 ticks
	SSG_RAMPS[3] = new Float32Array(197);
	SSG_RAMPS[7] = new Float32Array(197);

	const patterns = [
		[0, 1, 0, 1, 0, 1, 0, 1],
		[0, 1, 0, 1, 1, 1, 0, 1],
		[0, 1, 1, 1, 0, 1, 1, 1],
		[0, 1, 1, 1, 1, 1, 1, 1]
	]
	for (let i = 0; i <= 3; i++) {
		SSG_RAMPS[i][0] = 1;
		SSG_RAMPS[4 + i][0] = 0;
		const pattern = patterns[i];
		const length = SSG_RAMPS[i].length;

		let counter = 0;
		for (let j = 1; j < length; j++) {
			counter = Math.min(counter + 6 * pattern[(j - 1) % 8], 1023);
			// Ramp down
			SSG_RAMPS[i][j] = (1023 - counter) / 1023;
			// Ramp up
			SSG_RAMPS[i + 4][j] = counter / 1023;
		}
	}
}

function makeEnvelopeSample(decayRate, sustainLevel, sustainRate, invert, mirror, sampleRate) {
	const decayPower = Math.trunc(decayRate / 4) - 14;
	const decayMod = ENV_INCREMENT_MOD[decayRate] - 4;
	let buffer, outputSamples, playbackRate;

	if (sustainLevel === 0 || decayRate === sustainRate) {

		const values = SSG_RAMPS[decayMod + (invert ? 4 : 0)];
		const length = values.length * (mirror ? 2 : 1);
		buffer = new AudioBuffer({length: length, sampleRate: sampleRate});
		outputSamples = buffer.getChannelData(0);
		outputSamples.set(values);
		playbackRate = 2 ** decayPower;

	} else {

		const sustainPower = Math.trunc(sustainRate / 4) - 14;
		const sustainMod = ENV_INCREMENT_MOD[sustainRate] - 4;

		let arr1, arr2;
		if (invert) {
			arr1 = SSG_RAMPS[4 + decayMod];
			arr2 = SSG_RAMPS[4 + sustainMod];
		} else {
			arr1 = SSG_RAMPS[decayMod];
			arr2 = SSG_RAMPS[sustainMod];
		}

		const arr1Len = Math.ceil((1023 - sustainLevel) * 8 / (4 + decayMod)) + 1;
		arr1 = arr1.subarray(0, arr1Len);
		const sustainOffset = Math.ceil((1023 - sustainLevel) * 8 / (4 + sustainMod)) + 1;
		arr2 = arr2.subarray(sustainOffset);
		const arr2Len = arr2.length;

		if (decayPower === sustainPower) {

			const length = (arr1Len + arr2Len) * (mirror ? 2 : 1);
			buffer = new AudioBuffer({length: length, sampleRate: sampleRate});
			outputSamples = buffer.getChannelData(0);
			outputSamples.set(arr1);
			outputSamples.set(arr2, arr1Len);
			playbackRate = 2 ** decayPower;

		} else if (decayPower > sustainPower) {

			const stretch = 2 ** (decayPower - sustainPower);
			const length = (arr1Len * stretch + arr2Len) * (mirror ? 2 : 1);
			buffer = new AudioBuffer({length: length, sampleRate: sampleRate});
			outputSamples = buffer.getChannelData(0);
			let endOffset = 0;
			for (let i = 0; i < arr1Len; i++) {
				const startOffset = endOffset;
				endOffset += stretch;
				outputSamples.fill(arr1[i], startOffset, endOffset);
			}
			outputSamples.set(arr2, arr1Len * stretch);
			playbackRate = 2 ** sustainPower;

		} else {

			const stretch = 2 ** (sustainPower - decayPower);
			const length = (arr1Len + arr2Len * stretch) * (mirror ? 2 : 1);
			buffer = new AudioBuffer({length: length, sampleRate: sampleRate});
			outputSamples = buffer.getChannelData(0);
			outputSamples.set(arr1);
			let endOffset = arr1Len;
			for (let i = 0; i < arr2Len; i++) {
				const startOffset = endOffset;
				endOffset += stretch;
				outputSamples.fill(arr2[i], startOffset, endOffset);
			}
			playbackRate = 2 ** decayPower;

		}

	}

	if (mirror) {
		const length = outputSamples.length / 2;
		for (let i = 0; i < length; i++) {
			outputSamples[2 * length - 1 - i] = outputSamples[i]
		}
	}

	return [buffer, playbackRate];
}

class Envelope {

	/**Creates an envelope.
	 * @param {GainNode} output The GainNode to be controlled by the envelope.
	 */
	constructor(synth, context, output, dbCurve) {
		this.synth = synth;
		output.gain.value = 0;
		const gainNode = new ConstantSourceNode(context, {offset: 0});
		this.gainNode = gainNode;
		this.gain = gainNode.offset;

		const totalLevelNode = new ConstantSourceNode(context, {offset: 0});
		this.totalLevelNode = totalLevelNode;
		this.totalLevel = totalLevelNode.offset;
		const shaper = new WaveShaperNode(context, {curve: dbCurve});
		gainNode.connect(shaper);
		totalLevelNode.connect(shaper);
		shaper.connect(output.gain);

		this.rateScaling = 0;
		this.attackRate = 16;
		this.decayRate = 0;
		this.sustainRate = 0;
		this.releaseRate = 17;
		this.sustain = 1023;	// Already converted into an attenuation value.

		// Values stored during key on.
		this.beginLevel = 0;
		this.hasAttack = true;
		this.beginAttack = 0;
		this.prevAttackRate = 0;
		this.endAttack = 0;
		this.endDecay = 0;
		this.endSustain = 0;
		this.beginRelease = 0;
		this.releaseLevel = 0;
		this.endRelease = 0;

		this.ssgEnabled = false;
		this.inverted = false;
		this.jump = false;	// Jump to high level at end of envelope (or low if inverted)
		this.looping = false;
		this.ssgSamples = [];
	}

	start(time = 0) {
		this.gainNode.start(time);
		this.totalLevelNode.start(time);
	}

	stop(time = 0) {
		this.gainNode.stop(time);
		this.totalLevelNode.stop(time);
	}

	/**
	 * For Algorithm 7, set total level to at least 29 to avoid distortion.
	 */
	setTotalLevel(level, time = 0, method = 'setValueAtTime') {
		this.totalLevel[method](-level / 128, time);
	}

	getTotalLevel() {
		return -Math.round(this.totalLevel.value * 128);
	}

	setRateScaling(amount) {
		this.rateScaling = amount;
	}

	getRateScaling() {
		return this.rateScaling;
	}

	setAttack(rate) {
		this.attackRate = rate;
	}

	getAttack() {
		return this.attackRate;
	}

	setDecay(rate) {
		this.decayRate = rate;
		this.ssgSamples = [];
	}

	getDecay() {
		return this.decayRate;
	}

	/**
	 * @param {number} level Between 0 and 16
	 */
	setSustain(level) {
		let gain = level === 0 ? 1023 : 1024 - level * 32;
		if (level > 14) {
			gain -= 512;
		}
		this.sustain = gain;
		this.ssgSamples = [];
	}

	getSustain() {
		let gain = this.sustain;
		if (gain === 1023) {
			return 0;
		} else if (gain < 512) {
			gain += 512;
		}
		return (1024 - gain) / 32;
	}

	setSustainRate(rate) {
		this.sustainRate = rate;
		this.ssgSamples = [];
	}

	getSustainRate() {
		return this.sustainRate;
	}

	setRelease(rate) {
		this.releaseRate = rate * 2 + 1;
	}

	getRelease() {
		return (this.releaseRate - 1) / 2;
	}

	setSSG(mode) {
		const oldInverted = this.inverted;
		const oldJump = this.jump;
		if (mode < 8) {
			// SSG disabled
			this.ssgEnabled = false;
			this.inverted = false;
			this.jump = false;
			this.looping = false;
		} else {
			mode -= 8;
			this.ssgEnabled = true;
			this.inverted = mode >= 4;
			this.jump = [0, 3, 4, 7].includes(mode);
			this.looping = mode % 2 === 0;
		}
		if (this.inverted !== oldInverted || this.jump !== oldJump) {
			this.ssgSamples = [];
		}
	}

	/**
	 * Don't call with rate = 0, because that means infinite time.
	 */
	decayTime(from, to, basicRate, rateAdjust) {
		const rate = Math.min(Math.round(2 * basicRate + rateAdjust), 63);
		const gradient = ENV_INCREMENT[rate];
		return this.synth.envelopeTick * (from - to) / gradient;
	}

	/**Opens the envelope at a specified time.
	 */
	keyOn(soundSource, keyCode, time) {
		const rateAdjust = Math.trunc(keyCode / 2 ** (3 - this.rateScaling));
		const tickRate = this.synth.envelopeTick;
		const gain = this.gain;
		const invert = this.inverted;
		const ssgScale = this.ssgEnabled ? 6 : 1;

		let beginLevel = 0;
		const endRelease = this.endRelease;
		if (endRelease > 0) {
			//I.e. it's not the first time the envelope ran.
			if (time >= endRelease) {
				// Release phase ended.
				beginLevel = this.jump ? 1023 : 0;
			} else {
				// Still in the release phase
				const beginRelease = this.beginRelease;
				const timeProportion = (time - beginRelease) / (endRelease - beginRelease);
				beginLevel = this.releaseLevel * (1 - timeProportion);
			}
			if (invert) {
				beginLevel = 1023 - beginLevel;
			}
		}

		this.beginLevel = beginLevel;
		this.hasAttack = true;
		let endAttack = time;
		if (invert) {
			cancelAndHoldAtTime(gain, 0, time);
		} else {
			let attackRate;
			if (this.attackRate === 0) {
				attackRate = 0;
			} else {
				attackRate = Math.min(Math.round(2 * this.attackRate) + rateAdjust, 63);
			}
			if (attackRate <= 1) {
				// Level never rises
				if (beginLevel === 0) {
					this.endSustain = time;
					soundSource.stop(time);
				} else {
					cancelAndHoldAtTime(gain, beginLevel, time);
					this.hasAttack = false;
					this.endAttack = time;
					this.endDecay = Infinity;
					this.endSustain = Infinity;
				}
				return;
			} else if (attackRate < 62 && beginLevel < 1023) {
				// Non-infinite attack
				cancelAndHoldAtTime(gain, beginLevel / 1023, time);
				const target = ATTACK_TARGET[attackRate - 2];
				const timeConstant = ATTACK_CONSTANT[attackRate - 2] * tickRate;
				gain.setTargetAtTime(target / 1023, time, timeConstant);
				this.beginAttack = time;
				this.prevAttackRate = attackRate;
				const attackTime = -timeConstant * Math.log((1023 - target) / (beginLevel - target));
				endAttack += attackTime;
			}
			cancelAndHoldAtTime(gain, 1, endAttack);
		}
		this.endAttack = endAttack;

		if (this.decayRate === 0) {
			let endTime;
			if (invert) {
				endTime = time;
				soundSource.stop(time);
			} else {
				endTime = Infinity;
			}
			this.endDecay = endTime;
			this.endSustain = endTime;
			return;
		}

		const decay = this.decayTime(1023, this.sustain, this.decayRate, rateAdjust) / ssgScale;
		const endDecay = endAttack + decay;
		const sustain = invert ? 1023 - this.sustain : this.sustain;
		gain.linearRampToValueAtTime(sustain / 1023, endDecay);
		this.endDecay = endDecay;
		if (this.sustainRate === 0) {
			if (sustain === 0) {
				this.endSustain = endDecay;
				soundSource.stop(endDecay);
			} else {
				this.endSustain = Infinity;
			}
			return;
		}

		const sustainTime = this.decayTime(this.sustain, 0, this.sustainRate, rateAdjust) / ssgScale;
		let endSustain = endDecay + sustainTime;
		let finalValue = invert ? 1 : 0
		gain.linearRampToValueAtTime(finalValue, endSustain);

		if (this.jump) {
			finalValue = 1 - finalValue;
			endSustain += tickRate;
			gain.linearRampToValueAtTime(finalValue, endSustain);
		}
		this.endSustain = endSustain;
		if (finalValue === 0) {
			soundSource.stop(endSustain);
		}
	}

	linearValueAtTime(time) {
		const endAttack = this.endAttack;
		const endDecay = this.endDecay;
		const endSustain = this.endSustain;
		let linearValue;

		if (time >= endSustain) {

			// Sustain decayed to zero
			linearValue = this.jump ? 1023 : 0;

		} else if (time >= endDecay) {

			// In the sustain phase.
			if (endSustain === Infinity) {
				linearValue = this.sustain;
			} else {
				const timeProportion = (time - endDecay) / (endSustain - endDecay);
				linearValue = this.sustain * (1 - timeProportion);
			}

		} else if (time >= endAttack) {

			// In the decay phase.
			if (endDecay === Infinity) {
				linearValue = 1023;
			} else {
				const timeProportion = (time - endAttack) / (endDecay - endAttack);
				linearValue = 1023 -  timeProportion * (1023 - this.sustain);
			}

		} else if (!this.hasAttack) {

			// Attack rate was 0.
			return this.beginLevel;

		} else {

			// In the attack phase.
			const attackRate = this.prevAttackRate;
			const target = ATTACK_TARGET[attackRate - 2];
			const timeConstant = ATTACK_CONSTANT[attackRate - 2] * this.synth.envelopeTick;
			const beginAttack = this.beginAttack;
			const beginLevel = this.beginLevel;
			return target + (beginLevel - target) * Math.exp(-(time - beginAttack) / timeConstant);

		}

		if (this.inverted) {
			linearValue = 1023 - linearValue;
		}
		return linearValue;
	}

	/**Closes the envelope at a specified time.
	 */
	keyOff(soundSource, keyCode, time) {
		const currentValue = this.linearValueAtTime(time);
		const rateAdjust = Math.trunc(keyCode / 2 ** (3 - this.rateScaling));
		const ssgScale = this.ssgEnabled ? 6 : 1;
		const releaseTime = this.decayTime(currentValue, 0, this.releaseRate, rateAdjust) / ssgScale;
		const gain = this.gain;
		cancelAndHoldAtTime(gain, currentValue / 1023, time);
		const endRelease = time + releaseTime;
		gain.linearRampToValueAtTime(0, endRelease);
		soundSource.stop(endRelease);
		this.beginRelease = time;
		this.releaseLevel = currentValue;
		this.endRelease = endRelease;
	}

	/**Cuts audio output without going through the envelope's release phase.
	 * @param {number} time When to stop outputting audio. Defaults to ceasing sound production immediately.
	 */
	soundOff(time = 0) {
		cancelAndHoldAtTime(this.gain, 0, time);
		this.endRelease = time;
	}

}


/**The amount to detune each note by when the various detuning settings are applied. The
 * array is organized into four sequential blocks of 32 values each. The first block
 * represents the changes in frequency from the basic scale when an operator's detuning
 * parameter is set to 0 (should be 32 zeros!). The second block represents the increases
 * in frequency when the detuning parameter is set to 1 and the decreases in frequency
 * when the detuning parameter is set to 5, and so on. Each block of 32 values contains a
 * single entry for each of the YM2612's "key codes". The find a note's key code you
 * multiply its block number by 4 and place the two most significant bits of its frequency
 * number into the two least significant bits of the key code. Each value in the array
 * (per detuning value, per key code) is a multiplier that's applied as a deviation from
 * the note's normal frequency. For example, a value of 0.05 represents a 5% increase or
 * decrease applied to the note's frequency in Hertz.
 * @type {Array<number}
 */
const DETUNE_AMOUNTS = [
/* Preset 0 */
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
/* Preset +-1 */
	0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2,
	2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 8,
/* Preset +-2 */
	1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5,
	5, 6, 6, 7, 8, 8, 9,10,11,12,13,14,16,16,16,16,
/* Preset +-3 */
	2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7,
	8 , 8, 9,10,11,12,13,14,16,17,19,20,22,22,22,22
];

/**Represents a single operator in the FM synthesizer. The synthesizer alters frequency
 * using phase modulation (PM). There are 4 operators per sound channel and 6 independent
 * channels by default.
 */
class Operator {

	/**Constructs an instance of an operator. Operators are normally created by
	 * invoking the {@link FMSynth} constructor.
	 * @param {AudioContext} context The Web Audio context.
	 * @param {AudioNode} lfo The signal used to control the operator's vibrato and tremolo effects.
	 * @param {AudioNode} output The destination to route the operator's audio output to
	 * or undefined if the operator will always be used as a modulator.
	 *
	 */
	constructor(synth, context, lfo, output, dbCurve) {
		this.synth = synth;
		this.freqBlockNumber = 4;
		this.frequencyNumber = 1093;
		this.frequency = synth.frequencyStep * componentsToFullFreq(this.freqBlockNumber, this.frequencyNumber);
		const frequencyNode = new ConstantSourceNode(context, {offset: this.frequency});

		this.frequencyNode = frequencyNode;
		this.frequencyParam = frequencyNode.offset;
		this.sourceType = 'sine';
		this.periodicWave = undefined;
		const sampleSpeedGain = new GainNode(context);
		frequencyNode.connect(sampleSpeedGain);
		this.sampleSpeedGain = sampleSpeedGain;
		this.source = undefined;

		const tremolo = new GainNode(context);
		this.tremoloNode = tremolo;
		this.tremolo = tremolo.gain;
		const tremoloGain = new GainNode(context, {gain: 0});
		tremoloGain.connect(tremolo.gain);
		this.tremoloAmp = tremoloGain.gain;
		lfo.connect(tremoloGain);

		const envelopeGain = new GainNode(context);
		tremolo.connect(envelopeGain);
		this.envelope = new Envelope(synth, context, envelopeGain, dbCurve);
		this.envelopeGain = envelopeGain;

		if (output !== undefined) {
			const mixer = new GainNode(context);
			envelopeGain.connect(mixer);
			mixer.connect(output);
			this.mixer = mixer.gain;
		}

		this.keyCode = calcKeyCode(4, 1093);
		this.frequencyMultiple = 1;
		this.detune = 0;
		this.keyIsOn = false;
		this.disabled = false;
	}

	makeSource(context) {
		let source;
		if (this.periodicWave !== undefined) {
			source = new OscillatorNode(context, {frequency: 0});
			this.frequencyNode.connect(source.frequency);
			oscillator.setPeriodicWave(this.periodicWave);
			return source;
		}

		const sourceType = this.sourceType;
		if (sourceType instanceof AudioBuffer) {
			source = new AudioBufferSourceNode(context,
				{buffer: sourceType, loop: true, loopEnd: Number.MAX_VALUE, playbackRate: 0}
			);
			this.sampleSpeedGain.connect(source.playbackRate);
		} else {
			source = new OscillatorNode(context, {frequency: 0, type: sourceType});
			this.frequencyNode.connect(source.frequency);
		}
		return source;
	}


	/**Starts the operator's oscillator.
	 * Operators are normally started by calling start() on an instance of {@link FMSynth}.
	 */
	start(time) {
		this.frequencyNode.start(time);
		this.envelope.start(time);
	}

	/**Stops the operator's oscillator so that the operator's system resources can be released.
	 * Operators are normally stopped by calling stop() on an instance of {@link FMSynth}.
	 */
	stop(time = 0) {
		if (this.source) {
			this.source.stop(time);
		}
		this.frequencyNode.stop(time);
		this.envelope.stop(time);
	}

	/**Configures this operator to modulate an external source (usually another operator).
	 * This method is usually called by the {@link Channel} constructor.
	 * @param {AudioNode} destination The signal to modulate.
	 */
	connectOut(destination) {
		this.envelopeGain.connect(destination);
	}

	/**Changes the operator's frequency. This method is usually invoked by an instance of
	 * {@link Channel} (e.g. by its setFrequency() method) but it can also be useful to
	 * invoke this method directly for individual operators to create dissonant sounds.
	 * @param {number} blockNumber A kind of octave measurement. See {@link FMSynth.noteFrequencies}.
	 * @param {number} frequencyNumber A linear frequency measurement. See {@link FMSynth.noteFrequencies}.
	 * @param {number} [frequencyMultiple] After the basic frequency in Hertz is calculated
	 * from the block number and frequency number the result is then multiplied by this
	 * number. Defaults to 1.
	 * @param {number} [time] When to change frequency. Defaults to immediately.
	 * @param {string} [method] How to change from one frequency to another. One of
	 * 'setValueAtTime', 'linearRampToValueAtTime' or 'exponentialRampToValueAtTime'.
	 * Defaults to 'setValueAtTime'.
	 */
	setFrequency(blockNumber, frequencyNumber, frequencyMultiple = 1, time = 0, method = 'setValueAtTime') {
		const keyCode = calcKeyCode(blockNumber, frequencyNumber);
		const detuneSetting = this.detune;
		const detuneTableOffset = (detuneSetting & 3) << 5;
		const detuneSign = (-1) ** (detuneSetting >> 2);
		const detuneSteps = detuneSign * DETUNE_AMOUNTS[detuneTableOffset + Math.min(keyCode, 31)];

		let fullFreqNumber = componentsToFullFreq(blockNumber, frequencyNumber) + detuneSteps;
		if (fullFreqNumber < 0) {
			fullFreqNumber += 0x1FFFF;
		}
		const frequencyStep = this.synth.frequencyStep;
		const frequency = fullFreqNumber * frequencyMultiple * frequencyStep;
		this.frequencyParam[method](frequency, time);
		this.frequency = frequency;
		this.freqBlockNumber = blockNumber;
		this.frequencyNumber = frequencyNumber;
		this.frequencyMultiple = frequencyMultiple;
		this.keyCode = keyCode;
	}


	/**Returns the block number associated with the operator's current frequency.
	 * See {@link FMSynth.noteFrequencies}.
	 */
	getFrequencyBlock() {
		return this.freqBlockNumber;
	}

	/**Returns the frequency number associated with the operator's current frequency.
	 * See {@link FMSynth.noteFrequencies}.
	 */
	getFrequencyNumber() {
		return this.frequencyNumber;
	}

	/** Configures the amount of detuning.
	 * @param {number} extent The amount of detuning. Zero means no detuning, 1 raises the
	 * pitch a little, 2 raises the pitch moderately, 3 raises the pitch a lot. 5 lowers
	 * the pitch a little, 6 lowers it moderately, 7 lowers it a lot.
	 * @param {number} [time] When to alter the detuning. Defaults to whenever
	 * setFrequency() is next called.
	 * @param {string} [method] Apply the change instantaneously (default), linearly or exponentially.
	 */
	setDetune(extent, time = undefined, method = 'setValueAtTime') {
		this.detune = extent;
		if (time !== undefined) {
			this.setFrequency(this.freqBlockNumber, this.frequencyNumber, this.frequencyMultiple, time, method);
		}
	}

	/**Returns the most recently set detuning value. */
	getDetune() {
		return this.detune;
	}

	/** Specifies the degree to which this operator's output undergoes amplitude
	 * modulation from the synthesizer's LFO. This method is usually invoked by an instance
	 * of {@link Channel}. Use its enableTremolo(), useTremoloPreset() and setTremoloDepth() methods to
	 * configure amplitude modulation for the operators. However, if you wish then you can
	 * instead manually initiate amplitude modulation by invoking this method directly. This
	 * allows different operators to have differing levels of amplitude modulation.
	 * @param {number} linearAmount The amount of amplitude modulation to apply between 0
	 * and 1. Unlike the {@link Channel} methods this method uses a linear scale. You'll
	 * probably first want to convert from an exponential (decibels) scale to a linear scale
	 * using the decibelReductionToAmplitude() function in order to match human perception of
	 * loudness.
	 * @param {number} [time] When to change the amplitude modulation depth. Defaults to immediately.
	 * @param {string} [method] Apply the change instantaneously (default), linearly or exponentially.
	 */
	setTremoloDepth(linearAmount, time = 0, method = 'setValueAtTime') {
		this.tremoloAmp[method](-linearAmount, time);
		this.tremolo[method](1 - linearAmount, time);
	}

	/**Gets the amount of amplitude modulation being applied to the operator on a 0..1 linear scale. */
	getTremoloDepth() {
		return this.tremoloAmp.value;
	}

	setVolume(level, time = 0, method = 'setValueAtTime') {
		this.mixer[method](level, time);
	}

	getVolume() {
		return this.mixer.value;
	}

	disable(time = 0) {
		if (this.source) {
			this.source.stop(time);
		}
		this.disabled = true;
	}

	enable() {
		this.disabled = false;
	}

	keyOn(time) {
		if (!this.disabled) {
			this.envelope.keyOn(this.source, this.keyCode, time);
			this.keyIsOn = true;
		}
	}

	keyOff(time) {
		if (this.keyIsOn) {
			this.envelope.keyOff(this.source, this.keyCode, time);
			this.keyIsOn = false;
		}
	}

	soundOff(time = 0) {
		this.source.stop(time);
		this.envelope.soundOff(time);
	}

	setTotalLevel(level, time = 0, method = 'setValueAtTime') {
		this.envelope.setTotalLevel(level, time, method);
	}

	getTotalLevel() {
		return this.envelope.getTotalLevel();
	}

	setRateScaling(amount) {
		this.envelope.setRateScaling(amount);
	}

	getRateScaling() {
		return this.envelope.getRateScaling();
	}

	setAttack(rate) {
		this.envelope.setAttack(rate);
	}

	getAttack() {
		return this.envelope.getAttack();
	}

	setDecay(rate) {
		this.envelope.setDecay(rate);
	}

	getDecay() {
		return this.envelope.getDecay();
	}

	setSustain(level) {
		this.envelope.setSustain(level);
	}

	getSustain() {
		return this.envelope.getSustain();
	}

	setSustainRate(rate) {
		this.envelope.setSustainRate(rate);
	}

	getSustainRate() {
		return this.envelope.getSustainRate();
	}

	setRelease(rate) {
		this.envelope.setRelease(rate);
	}

	getRelease() {
		return this.envelope.getRelease();
	}

	setSSG(mode) {
		this.envelope.setSSG(mode);
	}

}

class FMOperator extends Operator {

	constructor(synth, context, lfo, output, dbCurve) {
		super(synth, context, lfo, output, dbCurve);

		const fmModAmp = new GainNode(context, {gain: 440});
		fmModAmp.connect(this.frequencyParam);
		this.fmModAmp = fmModAmp;

		const vibratoGain = new GainNode(context, {gain: 0});
		lfo.connect(vibratoGain);
		vibratoGain.connect(fmModAmp);
		this.vibratoAmp = vibratoGain.gain;
	}

	connectIn(source) {
		source.connect(this.fmModAmp);
	}

	setFrequency(blockNumber, frequencyNumber, frequencyMultiple = 1, time = 0, method = 'setValueAtTime') {
		super.setFrequency(blockNumber, frequencyNumber, frequencyMultiple, time, method);
		this.fmModAmp.gain[method](this.frequency, time);
	}

	newWaveform(context, time = 0) {
		const newSource = this.makeSource(context)
		newSource.start(time);
		newSource.connect(this.tremoloNode);
		if (this.source) {
			this.source.stop(time);
		}
		this.source = newSource;
	}

	setVibratoDepth(linearAmount, time = 0, method = 'setValueAtTime') {
		this.vibratoAmp[method](linearAmount, time);
	}

	getVibratoDepth() {
		return this.vibratoAmp.value;
	}

	keyOn(context, time = context.currentTime + TIMER_IMPRECISION) {
		if (!this.keyIsOn) {
			this.newWaveform(context, time);
			super.keyOn(time);
		}
	}

	setWaveformNumber(context, waveformNumber, time = 0) {
		if (waveformNumber === undefined) throw new Error('Parameters: context, waveNumber, [time]');
		this.sourceType = this.synth.waveforms[waveformNumber];
		this.periodicWave = undefined;
		this.sampleSpeedGain.gain.setValueAtTime(this.synth.samplePeriods[waveformNumber], time);
	}

	getWaveformNumber() {
		if (this.periodicWave !== undefined) {
			return -1;
		} else {
			return this.synth.waveforms.indexOf(this.sourceType);
		}
	}

	getWaveformSample() {
		if (this.periodicWave === undefined && this.sourceType instanceof AudioBuffer) {
			return this.sourceType;
		} else {
			return null
		}
	}

	setPeriodicWave(context, wave, time = 0) {
		if (wave === undefined) throw new Error('Parameters: context, periodicWave, [time]');
		this.periodicWave = wave;
	}

	setWaveformSample(context, audioBuffer, length = audioBuffer.length, time = 0) {
		if (audioBuffer === undefined) throw new Error('Parameters: context, audioBuffer, [time]');
		this.sourceType = audioBuffer;
		this.periodicWave = undefined;
		this.sampleSpeedGain.gain.setValueAtTime(length / context.sampleRate, time);
	}

}

const FOUR_OP_ALGORITHMS = [
	/*	[
			[op1To2Gain, op1To3Gain, op1To4Gain, op2To3Gain, op2To4Gain, op3To4Gain],
			[op1OutputGain, op2OutputGain, op3OutputGain, op4OutputGain]
		]
	 */

	// 1 -> 2 -> 3 -> 4
	[[1, 0, 0, 1, 0, 1], [0, 0, 0, 1]],

	// 1 \
	//    |--> 3 -> 4
	// 2 /
	[[0, 1, 0, 1, 0, 1], [0, 0, 0, 1]],

	// 1 -----\
	//         |--> 4
	// 2 -> 3 /
	[[0, 0, 1, 1, 0, 1], [0, 0, 0, 1]],


	// 1 -> 2 \
	//        |--> 4
	// 3 -----/
	[[1, 0, 0, 0, 1, 1], [0, 0, 0, 1]],

	// 1 -> 2
	// 3 -> 4
	[[1, 0, 0, 0, 0, 1], [0, 1, 0, 1]],

	//   /--> 2 
	// 1 |--> 3
	//   \--> 4
	[[1, 1, 1, 0, 0, 0], [0, 1, 1, 1]],

	// 1 -> 2
	//      3
	//      4
	[[1, 0, 0, 0, 0, 0], [0, 1, 1, 1]],

	// No modulation
	[[0, 0, 0, 0, 0, 0], [1, 1, 1, 1]],

	//           1
	// 2 -> 3 -> 4
	[[0, 0, 0, 1, 0, 1], [1, 0, 0, 1]],
];

const TWO_OP_ALGORITHMS = [
	[[1], [0, 1]],	// FM
	[[0], [1, 1]]	// Additive
];

const TREMOLO_PRESETS = [0, 1.4, 5.9, 11.8];

function indexOfGain(modulatorOpNum, carrierOpNum) {
	if (modulatorOpNum === carrierOpNum) {
		switch (modulatorOpNum) {
		case 1: return 0;
		case 3: return 1;
		default: return - 1;
		}
	} else if (modulatorOpNum >= 4 || modulatorOpNum >= carrierOpNum) {
		return -1;
	}
	let index = 2;
	for (let i = modulatorOpNum - 1; i > 0; i--) {
		index += 4 - i;
	}
	index += carrierOpNum - modulatorOpNum - 1;
	return index;
}

class Channel {

	constructor(synth, context, lfo, output, dbCurve) {
		this.synth = synth;
		const shaper = new WaveShaperNode(context, {curve: [-1, 0, 1]});
		const volume = new GainNode(context);
		shaper.connect(volume);
		this.volumeControl = volume.gain;

		const panner = new StereoPannerNode(context);
		volume.connect(panner);
		this.panner = panner;
		const mute = new GainNode(context);
		panner.connect(mute);
		mute.connect(output);
		this.muteControl = mute.gain;

		const lfoEnvelope = new GainNode(context);
		lfo.connect(lfoEnvelope);
		this.lfoEnvelope = lfoEnvelope.gain;
		this.lfoAttack = 0;

		const op1 = new FMOperator(synth, context, lfoEnvelope, shaper, dbCurve);
		const op2 = new FMOperator(synth, context, lfoEnvelope, shaper, dbCurve);
		const op3 = new FMOperator(synth, context, lfoEnvelope, shaper, dbCurve);
		const op4 = new FMOperator(synth, context, lfoEnvelope, shaper, dbCurve);
		this.operators = [op1, op2, op3, op4];

		const minDelay = 128 / context.sampleRate;
		const dcBlock = 49 * 48000 / context.sampleRate;
		const op1To1 = new GainNode(context, {gain: 0});
		op1.connectOut(op1To1);
		const feedbackFilter1 = new BiquadFilterNode(context, {type: 'highpass', frequency: dcBlock, Q: 0});
		op1To1.connect(feedbackFilter1);
		const delay1To1 = new DelayNode(context, {delayTime: minDelay, maxDelayTime: minDelay});
		feedbackFilter1.connect(delay1To1);
		op1.connectIn(delay1To1);
		const op1To2 = new GainNode(context, {gain: 0});
		op1.connectOut(op1To2);
		op2.connectIn(op1To2);
		const op1To3 = new GainNode(context, {gain: 0});
		op1.connectOut(op1To3);
		op3.connectIn(op1To3);
		const op1To4 = new GainNode(context, {gain: 0});
		op1.connectOut(op1To4);
		op4.connectIn(op1To4);

		const op2To3 = new GainNode(context, {gain: 0});
		op2.connectOut(op2To3);
		op3.connectIn(op2To3);
		const op2To4 = new GainNode(context, {gain: 0});
		op2.connectOut(op2To4);
		op4.connectIn(op2To4);

		const op3To3 = new GainNode(context, {gain: 0});
		op3.connectOut(op3To3);
		const feedbackFilter3 = new BiquadFilterNode(context, {type: 'highpass', frequency: dcBlock, Q: 0});
		op3To3.connect(feedbackFilter3);
		const delay3To3 = new DelayNode(context, {delayTime: minDelay, maxDelayTime: minDelay});
		feedbackFilter3.connect(delay3To3);
		op3.connectIn(delay3To3);
		const op3To4 = new GainNode(context, {gain: 0});
		op3.connectOut(op3To4);
		op4.connectIn(op3To4);

		this.dcBlock = [feedbackFilter1.frequency, feedbackFilter3.frequency];

		this.gains = [
			op1To1.gain, op3To3.gain,
			op1To2.gain, op1To3.gain, op1To4.gain,
			op2To3.gain, op2To4.gain,
			op3To4.gain
		];

		this.freqBlockNumbers = [4, 4, 4, 4];
		this.frequencyNumbers = [1093, 1093, 1093, 1093];
		this.frequencyMultiples = [1, 1, 1, 1];
		this.fixedFrequency = [false, false, false, false];

		this.tremoloDepth = 0;
		this.tremoloEnabled = [false, false, false, false];
		this.vibratoDepth = 0;
		this.vibratoEnabled = [true, true, true, true];
		this.transpose = 0;
		this.keyVelocity = [1, 1, 1, 1];
		this.useAlgorithm(7);
	}

	start(time) {
		for (let operator of this.operators) {
			operator.start(time);
		}
	}

	stop(time = 0) {
		for (let operator of this.operators) {
			operator.stop(time);
		}
	}

	getOperator(operatorNum) {
		return this.operators[operatorNum - 1];
	}

	/**Switches out of two operator mode and back into four operator mode. You'll still
	 * need to reinitialize the channel with a new instrument patch and frequency setting
	 * before the normal four operator behaviour is completely restored.
	 * Things not covered here: algorithm, frequency, tremolo, vibrato, DAC/PCM
	 */
	activate(time = 0, method = 'setValueAtTime') {
		this.setVolume(1, time, method);
	}

	setAlgorithm(modulations, outputLevels, time = 0, method = 'setValueAtTime') {
		for (let i = 0; i < 6; i++) {
			this.gains[i + 2][method](modulations[i], time);
		}
		for (let i = 0; i < 4; i++) {
			const operator = this.operators[i];
			const outputLevel = outputLevels[i];
			operator.enable();
			operator.setVolume(outputLevel, time, method);
			this.keyVelocity[i] = outputLevel === 0 ? 0 : 1;
		}
	}

	useAlgorithm(algorithmNum, time = 0, method = 'setValueAtTime') {
		const algorithm = FOUR_OP_ALGORITHMS[algorithmNum];
		this.setAlgorithm(algorithm[0], algorithm[1], time, method);
		this.algorithmNum = algorithmNum;
	}

	getAlgorithm() {
		return this.algorithmNum;
	}

	setModulationDepth(modulatorOpNum, carrierOpNum, amount, time = 0, method = 'setValueAtTime') {
		this.gains[indexOfGain(modulatorOpNum, carrierOpNum)][method](amount, time);
	}

	getModulationDepth(modulatorOpNum, carrierOpNum) {
		const index = indexOfGain(modulatorOpNum, carrierOpNum);
		return index === -1 ? 0 : this.gains[index].value;
	}

	disableOperator(operatorNum, time = 0) {
		this.operators[operatorNum - 1].disable(time);
	}

	enableOperator(operatorNum) {
		this.operators[operatorNum - 1].enable();
	}

	fixFrequency(operatorNum, fixed, time = undefined, preserve = true, method = 'setValueAtTime') {
		const fixedFrequencyArr = this.fixedFrequency;
		const operator = this.operators[operatorNum - 1];
		const multiple = this.frequencyMultiples[operatorNum - 1];
		let block = this.freqBlockNumbers[3];
		let freqNum = this.frequencyNumbers[3];

		if (fixed) {
			if (preserve) {
				if (!fixedFrequencyArr[operatorNum - 1] &&
					(operatorNum !== 4 ||
						(fixedFrequencyArr[0] && fixedFrequencyArr[1] && fixedFrequencyArr[2])
					)
				) {
					// Turn a frequency multiple into a fixed frequency.
					const fullFreqNumber = componentsToFullFreq(block, freqNum) * multiple;
					[block, freqNum] = fullFreqToComponents(fullFreqNumber);
					this.freqBlockNumbers[operatorNum - 1] = block;
					this.frequencyNumbers[operatorNum - 1] = freqNum;
				}
			} else if (time !== undefined) {
				// Restore a fixed frequency from a register.
				block = this.freqBlockNumbers[operatorNum - 1];
				freqNum = this.frequencyNumbers[operatorNum - 1];
				operator.setFrequency(block, freqNum, 1, time, method);
			}
		} else if (time !== undefined) {
			// Restore a multiple of Operator 4's frequency.
			operator.setFrequency(block, freqNum, multiple, time, method);
		}
		fixedFrequencyArr[operatorNum - 1] = fixed;
	}

	isOperatorFixed(operatorNum) {
		return this.fixedFrequency[operatorNum - 1];
	}

	setFrequency(blockNumber, frequencyNumber, time = 0, method = 'setValueAtTime') {
		for (let i = 0; i < 4; i++) {
			if (!this.fixedFrequency[i]) {
				const multiple = this.frequencyMultiples[i];
				this.operators[i].setFrequency(blockNumber, frequencyNumber, multiple, time, method);
			}
		}
		this.freqBlockNumbers[3] = blockNumber;
		this.frequencyNumbers[3] = frequencyNumber;
	}

	setOperatorFrequency(operatorNum, blockNumber, frequencyNumber, time = 0, method = 'setValueAtTime') {
		if (this.fixedFrequency[operatorNum - 1]) {
			this.operators[operatorNum - 1].setFrequency(blockNumber, frequencyNumber, 1, time, method);
		}
		this.freqBlockNumbers[operatorNum - 1] = blockNumber;
		this.frequencyNumbers[operatorNum - 1] = frequencyNumber;
	}

	getFrequencyBlock(operatorNum = 4) {
		return this.freqBlockNumbers[operatorNum - 1];
	}

	getFrequencyNumber(operatorNum = 4) {
		return this.frequencyNumbers[operatorNum - 1];
	}

	setFrequencyMultiple(operatorNum, multiple, time = undefined, method = 'setValueAtTime') {
		this.frequencyMultiples[operatorNum - 1] = multiple;
		if (time !== undefined && !this.fixedFrequency[operatorNum - 1]) {
			const block = this.freqBlockNumbers[3];
			const freqNum = this.frequencyNumbers[3];
			const operator = this.operators[operatorNum - 1];
			operator.setFrequency(block, freqNum, multiple, time, method);
		}
	}

	getFrequencyMultiple(operatorNum) {
		return this.frequencyMultiples[operatorNum - 1];
	}

	setTranspose(transpose) {
		this.transpose = transpose;
	}

	getTranspose() {
		return this.transpose;
	}

	setMIDINote(noteNumber, time = 0, method = 'setValueAtTime') {
		noteNumber += this.transpose;
		const [block, freqNum] = this.synth.noteFrequencies[noteNumber];
		this.setFrequency(block, freqNum, time, method);
	}

	setOperatorNote(operatorNum, noteNumber, time = 0, method = 'setValueAtTime') {
		this.fixedFrequency[operatorNum - 1] = true;
		const [block, freqNum] = this.synth.noteFrequencies[noteNumber];
		this.setOperatorFrequency(operatorNum, block, freqNum, time, method);
	}

	getMIDINote(operatorNum = 4) {
		const block = this.freqBlockNumbers[operatorNum - 1];
		const freqNum = this.frequencyNumbers[operatorNum - 1];
		let note = this.synth.frequencyToNote(block, freqNum);
		if (!this.fixedFrequency[operatorNum - 1]) {
			note -= this.transpose;
		}
		return note;
	}

	setFeedback(amount, operatorNum = 1, time = 0, method = 'setValueAtTime') {
		this.gains[(operatorNum - 1) / 2][method](amount, time);
	}

	getFeedback(operatorNum = 1) {
		return this.gains[(operatorNum - 1) / 2].value;
	}

	useFeedbackPreset(n, operatorNum = 1, time = 0, method = 'setValueAtTime') {
		const amount = n === 0 ? 0 : 2 ** (n - 6);
		this.setFeedback(amount, operatorNum, time, method);
	}

	getFeedbackPreset(operatorNum = 1) {
		const amount = this.getFeedback(operatorNum);
		return amount === 0 ? 0 : Math.round(Math.log2(amount) + 6);
	}

	setFeedbackFilter(cutoff, operatorNum = 1, time = 0, method = 'setValueAtTime') {
		this.dcBlock[(operatorNum - 1) / 2][method](cutoff, time);
	}

	getFeedbackFilterFreq(operatorNum = 1) {
		return this.dcBlock[(operatorNum - 1) / 2].value;
	}

	setTremoloDepth(decibels, time = 0, method = 'setValueAtTime') {
		const linearAmount = 1 - decibelReductionToAmplitude(decibels);
		for (let i = 0; i < 4; i++) {
			if (this.tremoloEnabled[i]) {
				this.operators[i].setTremoloDepth(linearAmount, time, method);
			}
		}
		this.tremoloDepth = linearAmount;
	}

	getTremoloDepth() {
		return amplitudeToDecibels(this.tremoloDepth);
	}

	useTremoloPreset(presetNum, time = 0, method = 'setValueAtTime') {
		this.setTremoloDepth(TREMOLO_PRESETS[presetNum], time, method);
	}

	getTremoloPreset() {
		const depth = Math.round(this.getTremoloDepth() * 10) / 10;
		return TREMOLO_PRESETS.indexOf(depth);
	}

	enableTremolo(operatorNum, enabled = true, time = 0, method = 'setValueAtTime') {
		const operator = this.operators[operatorNum - 1];
		operator.setTremoloDepth(enabled ? this.tremoloDepth : 0, time, method);
		this.tremoloEnabled[operatorNum - 1] = enabled;
	}

	isTremoloEnabled(operatorNum) {
		return this.tremoloEnabled[operatorNum - 1];
	}

	setVibratoDepth(cents, time = 0, method = 'setValueAtTime') {
		const linearAmount = (2 ** (cents / 1200)) - 1;
		for (let i = 0; i < 4; i++) {
			if (this.vibratoEnabled[i]) {
				this.operators[i].setVibratoDepth(linearAmount, time, method);
			}
		}
		this.vibratoDepth = linearAmount;
	}

	getVibratoDepth() {
		return Math.log2(this.vibratoDepth + 1) * 1200;
	}

	useVibratoPreset(presetNum, time = 0) {
		this.setVibratoDepth(VIBRATO_PRESETS[presetNum], time);
	}

	getVibratoPreset() {
		const depth = Math.round(this.getVibratoDepth() * 10) / 10;
		return VIBRATO_PRESETS.indexOf(depth);
	}

	enableVibrato(operatorNum, enabled = true, time = 0, method = 'setValueAtTime') {
		const operator = this.operators[operatorNum - 1];
		operator.setVibratoDepth(enabled ? this.vibratoDepth : 0, time, method);
		this.vibratoEnabled[operatorNum - 1] = enabled;
	}

	isVibratoEnabled(operatorNum) {
		return this.vibratoEnabled[operatorNum - 1];
	}

	setLFOAttack(seconds, time = 0) {
		if (supportsCancelAndHold) {
			this.lfoEnvelope.cancelAndHoldAtTime(time);
		} else {
			this.lfoEnvelope.cancelScheduledValues(time);
		}
		this.lfoEnvelope.linearRampToValueAtTime(1, time);
		this.lfoAttack = seconds;
	}

	getLFOAttack() {
		return this.lfoAttack;
	}

	triggerLFO(time) {
		if (this.lfoAttack > 0) {
			cancelAndHoldAtTime(this.lfoEnvelope, 0, time);
			this.lfoEnvelope.linearRampToValueAtTime(1, time + this.lfoAttack);
		}
	}

	/**
	 * N.B. Doesn't fade in the LFO if a delay has been set. Use {@link Channel.keyOn} or
	 * {@link Channel.keyOnWithVelocity} for that.
	 */
	keyOnOff(context, time, op1, op2 = op1, op3 = op1, op4 = op1) {
		const operators = this.operators;
		if (op1) {
			operators[0].keyOn(context, time);
		} else {
			operators[0].keyOff(time);
		}
		if (op2) {
			operators[1].keyOn(context, time);
		} else {
			operators[1].keyOff(time);
		}
		if (op3) {
			operators[2].keyOn(context, time);
		} else {
			operators[2].keyOff(time);
		}
		if (op4) {
			operators[3].keyOn(context, time);
		} else {
			operators[3].keyOff(time);
		}
	}

	keyOn(context, time = context.currentTime + TIMER_IMPRECISION) {
		this.triggerLFO(time);
		this.keyOnOff(context, time, true);
	}

	keyOff(time) {
		this.keyOnOff(undefined, time, false);
	}

	setVelocity(velocity, time = 0, method = 'setValueAtTime') {
		const totalLevel = 127 - velocity;
		for (let i = 0; i < 4; i++) {
			const sensitivity = this.keyVelocity[i];
			if (sensitivity > 0) {
				this.operators[i].setTotalLevel(totalLevel, time);
			}
		}
	}

	/**When this method is used then the overall output level needs to be controlled using
	 * the channel's setModulationDepth() method rather than setTotalLevel().
	 */
	keyOnWithVelocity(context, velocity, time = context.currentTime + TIMER_IMPRECISION) {
		this.setVelocity(velocity, time);
		this.keyOn(context, time);
	}

	setKeyVelocity(operatorNum, sensitivity) {
		this.keyVelocity[operatorNum - 1] = sensitivity;
	}

	getKeyVelocity(operatorNum) {
		return this.keyVelocity[operatorNum - 1];
	}

	soundOff(time = 0) {
		for (let operator of this.operators) {
			operator.soundOff(time);
		}
	}

	/**
	 * @param {number} panning -1 = left channel only, 0 = centre, 1 = right channel only
	 */
	setPan(panning, time = 0, method = 'setValueAtTime') {
		this.panner.pan[method](panning, time);
	}

	getPan() {
		return this.panner.pan.value;
	}

	setVolume(volume, time = 0, method = 'setValueAtTime') {
		this.volumeControl[method](volume, time);
	}

	getVolume() {
		return this.volumeControl.value;
	}

	mute(muted, time = 0) {
		this.muteControl.setValueAtTime(muted ? 0 : 1, time);
	}

	isMuted() {
		return this.muteControl.value === 0;
	}

	get numberOfOperators() {
		return 4;
	}

}

class FMSynth {
	constructor(context, output = context.destination, numChannels = 6, clockRate = CLOCK_RATE.PAL) {
		const lfo = new OscillatorNode(context, {frequency: 0, type: 'triangle'});
		this.lfo = lfo;
		supportsCancelAndHold = lfo.frequency.cancelAndHoldAtTime !== undefined;
		this.setClockRate(clockRate);

		const channelGain = new GainNode(context, {gain: 1 / numChannels});
		channelGain.connect(output);
		this.channelGain = channelGain.gain;

		const dbCurve = new Float32Array(2047);
		dbCurve.fill(0, 0, 1024);
		for (let i = 1024; i < 2047; i++) {
			dbCurve[i] = logToLinear((i - 1023) / 1023);
		}

		/**Provides frequency information for each MIDI note in terms of the YM2612's block and
		 * frequency number notation. The block number is stored in the first element of each
		 * entry and the frequency number is stored in the nested array's second element. When the
		 * block number is zero then increasing the frequency number by one raises the note's
		 * frequency by 0.025157Hz. Increasing the block number by one multiplies the frequency in
		 * Hertz by two. You can edit this table if you want to tune to something other than A440
		 * pitch (see {@link tunedMIDINotes}). The only constraint is that the table is sorted
		 * first by block number and then by frequency number.
		 * @type {Array<Array<number>>}
		 */
		this.noteFrequencies = this.tunedMIDINotes(440);

		const doubleSampleLength = 2048;
		const sampleLength = 1024;
		const halfSampleLength = 512;
		const quarterSampleLength = 256;

		const halfSine = new AudioBuffer({length: sampleLength, sampleRate: context.sampleRate});
		let sampleData = halfSine.getChannelData(0);
		const absSine = new AudioBuffer({length: halfSampleLength, sampleRate: context.sampleRate});
		let sampleData2 = absSine.getChannelData(0);
		for (let i = 0; i < halfSampleLength; i++) {
			const value = Math.sin(2 * Math.PI * (i + 0.5) / sampleLength);
			sampleData[i] = value;
			sampleData2[i] = value;
		}

		const pulseSine = new AudioBuffer({length: halfSampleLength, sampleRate: context.sampleRate});
		sampleData = pulseSine.getChannelData(0);
		for (let i = 0; i < quarterSampleLength; i++) {
			sampleData[i] = Math.sin(2 * Math.PI * (i + 0.5) / sampleLength);
		}

		const evenSine = new AudioBuffer({length: doubleSampleLength, sampleRate: context.sampleRate});
		sampleData = evenSine.getChannelData(0);
		const absEvenSine = new AudioBuffer({length: doubleSampleLength, sampleRate: context.sampleRate});
		sampleData2 = absEvenSine.getChannelData(0);
		for (let i = 0; i < sampleLength; i++) {
			const value = Math.sin(2 * Math.PI * (i + 0.5) / sampleLength);
			sampleData[i] = value;
			sampleData2[i] = Math.abs(value);
		}

		this.waveforms = [
			'sine', halfSine, absSine, pulseSine,
			evenSine, absEvenSine,
			'square', 'sawtooth', 'triangle'
		];
		this.samplePeriods = [
			0, sampleLength, sampleLength, sampleLength,
			2 * sampleLength, 2 * sampleLength,
			0, 0, 0
		].map(x => x / context.sampleRate);

		const channels = new Array(numChannels);
		for (let i = 0; i < numChannels; i++) {
			channels[i] = new Channel(this, context, lfo, channelGain, dbCurve);
		}
		this.channels = channels;

		const twoOpChannels = new Array(numChannels * 2 - 2);
		for (let i = 0; i < numChannels - 1; i++) {
			const channel = channels[i];
			twoOpChannels[2 * i] = new TwoOperatorChannel(channel, 1);
			twoOpChannels[2 * i + 1] = new TwoOperatorChannel(channel, 3);
		}
		this.twoOpChannels = twoOpChannels;

		const pcmGain = new GainNode(context, {gain: 0});
		pcmGain.connect(channels[numChannels - 1].panner);
		this.pcmGain = pcmGain.gain;
		const dacRegister = new ConstantSourceNode(context, {offset: 0});
		dacRegister.connect(pcmGain);
		this.dacRegister = dacRegister;
	}

	setClockRate(clockRate) {
		const lfoPresetNum = this.getLFOPreset();
		this.envelopeTick = 72 * 6 / clockRate;
		this.frequencyStep = clockRate / (144 * 2 ** 20);
		this.lfoRateMultiplier = clockRate / 8000000;
	}

	start(time) {
		for (let channel of this.channels) {
			channel.start(time);
		}
		this.lfo.start(time);
		this.dacRegister.start(time);
	}

	stop(time = 0) {
		for (let channel of this.channels) {
			channel.stop(time);
		}
		this.lfo.stop(time);
		this.dacRegister.stop(time);
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

	setLFOFrequency(frequency, time = 0, method = 'setValueAtTime') {
		this.lfo.frequency[method](frequency, time);
	}

	getLFOFrequency() {
		return this.lfo.frequency.value;
	}

	useLFOPreset(n, time = 0, method = 'setValueAtTime') {
		this.setLFOFrequency(LFO_FREQUENCIES[n] * this.lfoRateMultiplier, time, method);
	}

	getLFOPreset() {
		let frequency = this.getLFOFrequency() / this.lfoRateMultiplier;
		frequency = Math.round(frequency * 100) / 100;
		return LFO_FREQUENCIES.indexOf(frequency);
	}

	/**
	 * @param {number} amount The gain to apply to the PCM channel, in the range [0..numChannels].
	 */
	mixPCM(amount, time = 0, method = 'setValueAtTime') {
		let lastChannelVolume, otherChannelsVolume;
		if (amount <= 1) {
			lastChannelVolume = 1 - amount;
			otherChannelsVolume = 1;
		} else {
			lastChannelVolume = 0;
			otherChannelsVolume = 1 - (amount - 1) / (this.channels.length - 1);
		}
		const numChannels = this.channels.length;
		this.channels[numChannels - 1].setVolume(lastChannelVolume, time, method);
		this.pcmGain[method](amount, time);
		for (let i = 0; i < numChannels - 1; i++) {
			this.channels[i].setVolume(otherChannelsVolume, time, method);
		}
	}

	getPCMMix() {
		return this.pcmGain.value;
	}

	writePCM(value, time) {
		const floatValue = (value - 128) / 128;
		this.dacRegister.offset.setValueAtTime(floatValue, time);
	}

	setChannelGain(level, time = 0, method = 'setValueAtTime') {
		this.channelGain[method](level / this.channels.length, time);
	}

	/**Calculates frequency data for a scale of 128 MIDI notes. The results are expressed in
	 * terms of the YM2612's block and frequency number notation.
	 * @param {number} a4Pitch The pitch to tune A4 to, in Hertz.
	 */
	tunedMIDINotes(a4Pitch = 440) {
		const frequencyData = new Array(128);
		for (let i = 0; i < 128; i++) {
			const frequency = a4Pitch * (2 ** ((i - 69) / 12));
			frequencyData[i] = fullFreqToComponents(frequency / this.frequencyStep);
		}
		return frequencyData;
	}

	frequencyToNote(block, frequencyNum) {
		let lb = 0;
		let ub = 127;
		while (lb < ub) {
			let mid = Math.trunc((lb + ub) / 2);
			const [noteBlock, noteFreqNum] = this.noteFrequencies[mid];
			if (block < noteBlock) {
				ub = mid - 1;
			} else if (block > noteBlock) {
				lb = mid + 1;
			} else if (frequencyNum < noteFreqNum) {
				ub = mid - 1;
			} else if (frequencyNum > noteFreqNum) {
				lb = mid + 1;
			} else {
				return mid;
			}
		}
		return lb;
	}

	getLFO() {
		return this.lfo;
	}

}

class TwoOperatorChannel {

	constructor(parentChannel, startingOperator) {
		this.parentChannel = parentChannel;
		this.operatorOffset = startingOperator - 1;
		this.algorithmNum = 1;
		this.transpose = 0;
		this.tremoloDepth = 0;
		this.vibratoDepth = 0;
	}

	getOperator(operatorNum) {
		return this.parentChannel.getOperator(this.operatorOffset + operatorNum);
	}

	/**Switches into two operator mode. A fixed panning setting for the pair of two
	 * operator channels needs to be configured on the parent channel.
	 */
	activate(time = 0, method = 'setValueAtTime') {
		const parent = this.parentChannel;
		parent.setVolume(0.5, time, method);
		parent.setLFOAttack(0, time);
		parent.mute(false, time);
	}

	setAlgorithm(modulations, outputLevels, time = 0, method = 'setValueAtTime') {
		const parent = this.parentChannel;
		const offset = this.operatorOffset;
		parent.setModulationDepth(offset + 1, offset + 2, modulations[0], time, method);
		for (let i = 1; i <= 2; i++) {
			const operator = parent.getOperator(offset + i);
			const outputLevel = outputLevels[i - 1];
			operator.enable();
			operator.setVolume(outputLevel, time, method);
			parent.setKeyVelocity(offset + i, outputLevel === 0 ? 0 : 1);
		}
	}

	useAlgorithm(algorithmNum, time = 0, method = 'setValueAtTime') {
		const algorithm = TWO_OP_ALGORITHMS[algorithmNum];
		this.setAlgorithm(algorithm[0], algorithm[1], time, method);
		this.algorithmNum = algorithmNum;
	}

	getAlgorithm() {
		return this.algorithmNum;
	}

	setModulationDepth(modulatorOpNum, carrierOpNum, amount, time = 0, method = 'setValueAtTime') {
		const offset = this.operatorOffset;
		this.parentChannel.setModulationDepth(offset + modulatorOpNum, offset + carrierOpNum, amount, time, method);
	}

	getModulationDepth(modulatorOpNum, carrierOpNum) {
		const offset = this.operatorOffset;
		return this.parentChannel.getModulationDepth(offset + modulatorOpNum, offset + carrierOpNum);
	}

	disableOperator(operatorNum, time = 0) {
		this.parentChannel.disableOperator(this.operatorOffset + operatorNum, time);
	}

	enableOperator(operatorNum) {
		this.parentChannel.enableOperator(this.operatorOffset + operatorNum);
	}

	fixFrequency(operatorNum, fixed, time = undefined, preserve = true, method = 'setValueAtTime') {
		this.parentChannel.fixFrequency(this.operatorOffset + operatorNum, fixed, time, preserve, method);
	}

	isOperatorFixed(operatorNum) {
		return this.parentChannel.isOperatorFixed(this.operatorOffset + operatorNum);
	}

	setFrequency(blockNumber, frequencyNumber, time = 0, method = 'setValueAtTime') {
		const parent = this.parentChannel;
		const offset = this.operatorOffset;
		for (let i = 1; i <= 2; i++) {
			const operatorNum = offset + i;
			if (!parent.isOperatorFixed(operatorNum)) {
				const multiple = parent.getFrequencyMultiple(operatorNum);
				parent.getOperator(operatorNum).setFrequency(blockNumber, frequencyNumber, multiple, time, method);
			}
		}
		parent.freqBlockNumbers[offset] = blockNumber;
		parent.frequencyNumbers[offset] = frequencyNumber;
	}

	setOperatorFrequency(operatorNum, blockNumber, frequencyNumber, time = 0, method = 'setValueAtTime') {
		this.parentChannel.setOperatorFrequency(this.operatorOffset + operatorNum, blockNumber, frequencyNumber, time, method);
	}

	getFrequencyBlock(operatorNum = 2) {
		return this.parentChannel.getFrequencyBlock(this.operatorOffset + operatorNum);
	}

	getFrequencyNumber(operatorNum = 2) {
		return this.parentChannel.getFrequencyNumber(this.operatorOffset + operatorNum);
	}

	setFrequencyMultiple(operatorNum, multiple, time = undefined, method = 'setValueAtTime') {
		const parent = this.parentChannel;
		const offset = this.operatorOffset;
		const effectiveOperatorNum = offset + operatorNum;
		parent.setFrequencyMultiple(effectiveOperatorNum, multiple);
		if (time !== undefined && !parent.isOperatorFixed(effectiveOperatorNum)) {
			const block = parent.getFrequencyBlock(offset + 1);
			const freqNum = parent.getFrequencyNumber(offset + 1);
			const operator = parent.getOperator(effectiveOperatorNum);
			operator.setFrequency(block, freqNum, multiple, time, method);
		}
	}

	getFrequencyMultiple(operatorNum) {
		return this.parentChannel.getFrequencyMultiple(this.operatorOffset + operatorNum);
	}

	setTranspose(transpose) {
		this.transpose = transpose;
	}

	getTranspose() {
		return this.transpose;
	}

	setMIDINote(noteNumber, time = 0, method = 'setValueAtTime') {
		noteNumber += this.transpose;
		const parent = this.parentChannel;
		const [block, freqNum] = parent.synth.noteFrequencies[noteNumber];
		this.setFrequency(block, freqNum, time, method);
	}

	setOperatorNote(operatorNum, noteNumber, time = 0, method = 'setValueAtTime') {
		const parent = this.parentChannel;
		const effectiveOperatorNum = this.operatorOffset + operatorNum;
		parent.fixFrequency(effectiveOperatorNum, true, undefined, false);
		const [block, freqNum] = parent.synth.noteFrequencies[noteNumber];
		parent.setOperatorFrequency(effectiveOperatorNum, block, freqNum, time, method);
	}

	getMIDINote(operatorNum = 2) {
		return this.parentChannel.getMIDINote(this.operatorOffset + operatorNum);
	}

	setFeedback(amount, time = 0, method = 'setValueAtTime') {
		this.parentChannel.setFeedback(amount, this.operatorOffset + 1, time, method);
	}

	getFeedback() {
		return this.parentChannel.getFeedback(this.operatorOffset + 1);
	}

	useFeedbackPreset(n, time = 0, method = 'setValueAtTime') {
		this.parentChannel.useFeedbackPreset(n, this.operatorOffset + 1, time, method);
	}

	getFeedbackPreset() {
		return this.parentChannel.getFeedbackPreset(this.operatorOffset + 1);
	}

	setFeedbackFilter(cutoff, time = 0, method = 'setValueAtTime') {
		this.parentChannel.setFeedbackFilter(cutoff, this.operatorOffset + 1, time, method);
	}

	getFeedbackFilterFreq() {
		return this.parentChannel.getFeedbackFilterFreq(this.operatorOffset + 1);
	}

	setTremoloDepth(decibels, time = 0, method = 'setValueAtTime') {
		const linearAmount = 1 - decibelReductionToAmplitude(decibels);
		const parent = this.parentChannel;
		const offset = this.operatorOffset;
		for (let i = 1; i <= 2; i++) {
			const operatorNum = offset + i;
			if (parent.isTremoloEnabled(operatorNum)) {
				parent.getOperator(operatorNum).setTremoloDepth(linearAmount, time, method);
			}
		}
		this.tremoloDepth = linearAmount;
	}

	getTremoloDepth() {
		return amplitudeToDecibels(this.tremoloDepth);
	}

	useTremoloPreset(presetNum, time = 0, method = 'setValueAtTime') {
		this.setTremoloDepth(TREMOLO_PRESETS[presetNum], time, method);
	}

	getTremoloPreset() {
		const depth = Math.round(this.getTremoloDepth() * 10) / 10;
		return TREMOLO_PRESETS.indexOf(depth);
	}

	enableTremolo(operatorNum, enabled = true, time = 0, method = 'setValueAtTime') {
		const effectiveOperatorNum = this.operatorOffset + operatorNum;
		const operator = this.parentChannel.getOperator(effectiveOperatorNum);
		operator.setTremoloDepth(enabled ? this.tremoloDepth : 0, time, method);
		parentChannel.tremoloEnabled[effectiveOperatorNum - 1] = enabled;
	}

	isTremoloEnabled(operatorNum) {
		return this.parentChannel.isTremoloEnabled(this.operatorOffset + operatorNum);
	}

	setVibratoDepth(cents, time = 0, method = 'setValueAtTime') {
		const linearAmount = (2 ** (cents / 1200)) - 1;
		const parent = this.parentChannel;
		const offset = this.operatorOffset;
		for (let i = 1; i <= 2; i++) {
			const operatorNum = offset + i;
			if (parent.isVibratoEnabled(operatorNum)) {
				parent.getOperator(operatorNum).setVibratoDepth(linearAmount, time, method);
			}
		}
		this.vibratoDepth = linearAmount;
	}

	getVibratoDepth() {
		return Math.log2(this.vibratoDepth + 1) * 1200;
	}

	useVibratoPreset(presetNum, time = 0) {
		this.setVibratoDepth(VIBRATO_PRESETS[presetNum], time);
	}

	getVibratoPreset() {
		const depth = Math.round(this.getVibratoDepth() * 10) / 10;
		return VIBRATO_PRESETS.indexOf(depth);
	}

	enableVibrato(operatorNum, enabled = true, time = 0, method = 'setValueAtTime') {
		const effectiveOperatorNum = this.operatorOffset + operatorNum;
		const operator = this.parentChannel.getOperator(effectiveOperatorNum);
		operator.setVibratoDepth(enabled ? this.vibratoDepth : 0, time, method);
		parentChannel.vibratoEnabled[effectiveOperatorNum - 1] = enabled;
	}

	isTremoloEnabled(operatorNum) {
		return this.parentChannel.isVibratoEnabled(this.operatorOffset + operatorNum);
	}

	keyOnOff(context, time, op1, op2 = op1) {
		const parent = this.parentChannel;
		const offset = this.operatorOffset;
		if (op1) {
			parent.getOperator(offset + 1).keyOn(context, time);
		} else {
			parent.getOperator(offset + 1).keyOff(time);
		}
		if (op2) {
			parent.getOperator(offset + 2).keyOn(context, time);
		} else {
			parent.getOperator(offset + 2).keyOff(time);
		}
	}

	keyOn(context, time = context.currentTime + TIMER_IMPRECISION) {
		this.keyOnOff(context, time, true);
	}

	keyOff(time) {
		this.keyOnOff(undefined, time, false);
	}

	keyOnWithVelocity(context, velocity, time = context.currentTime + TIMER_IMPRECISION) {
		const parent = this.parentChannel;
		const totalLevel = 127 - velocity;
		for (let i = 1; i <= 2; i++) {
			const operatorNum = this.operatorOffset + i;
			const sensitivity = parent.getKeyVelocity(operatorNum);
			if (sensitivity > 0) {
				parent.getOperator(operatorNum).setTotalLevel(totalLevel, time);
			}
		}
		this.keyOn(context, time);
	}

	setKeyVelocity(operatorNum, sensitivity) {
		this.parentChannel.setKeyVelocity(this.operatorOffset + operatorNum, sensitivity);
	}

	getKeyVelocity(operatorNum) {
		return this.parentChannel.getKeyVelocity(this.operatorOffset + operatorNum);
	}

	soundOff(time = 0) {
		for (let i = 1; i <= 2; i++) {
			this.parentChannel.getOperator(this.operatorOffset + i).soundOff(time);
		}
	}

	get numberOfOperators() {
		return 2;
	}

}

export {
	Envelope, FMOperator, Channel, FMSynth,
	decibelReductionToAmplitude, amplitudeToDecibels, logToLinear, linearToLog,
	DETUNE_AMOUNTS, TREMOLO_PRESETS, CLOCK_RATE
};

const ATTACK_TARGET = [1032.48838867428, 1032.48838867428, 1032.48838867428,
1032.48838867428, 1032.53583418919, 1032.53583418919, 1032.48838867428, 1032.47884850242,
1032.53583418919, 1032.32194631456, 1032.48838867428, 1032.47884850242, 1032.53583418919,
1032.32194631456, 1032.48838867428, 1032.47884850242, 1032.53583418919, 1032.32194631456,
1032.48838867428, 1032.47884850242, 1032.53583418919, 1032.32194631456, 1032.48838867428,
1032.47884850242, 1032.53583418919, 1032.32194631456, 1032.48838867428, 1032.47884850242,
1032.53583418919, 1032.32194631456, 1032.48838867428, 1032.47884850242, 1032.53583418919,
1032.32194631456, 1032.48838867428, 1032.47884850242, 1032.53583418919, 1032.32194631456,
1032.48838867428, 1032.47884850242, 1032.53583418919, 1032.32194631456, 1032.48838867428,
1032.47884850242, 1032.53583418919, 1032.32194631456, 1032.48840023324, 1031.31610973218,
1031.52352501199, 1031.65420794345, 1033.03574873511, 1033.43041057801, 1033.37306598363,
1035.4171820433, 1035.39653268357, 1034.15032097183, 1032.96478469666, 1029.17518847789,
1030.84690128005, 1030.84690128005];

const ATTACK_CONSTANT = [63279.2004921133, 63279.2004921133, 31639.6002460567,
31639.6002460567, 21091.98357754, 21091.98357754, 15819.8001230283, 12657.5084839186,
10545.99178877, 9032.5441919039, 7909.90006151416, 6328.75424195932, 5272.995894385,
4516.27209595195, 3954.95003075708, 3164.37712097966, 2636.4979471925, 2258.13604797597,
1977.47501537854, 1582.18856048983, 1318.24897359625, 1129.06802398799, 988.73750768927,
791.094280244915, 659.124486798125, 564.534011993994, 494.368753844635, 395.547140122458,
329.562243399062, 282.267005996997, 247.184376922318, 197.773570061229, 164.781121699531,
141.133502998498, 123.592188461159, 98.8867850306144, 82.3905608497656, 70.5667514992492,
61.7960942305794, 49.4433925153072, 41.1952804248828, 35.2833757496246, 30.8980471152897,
24.7216962576536, 20.5976402124414, 17.6416878748123, 15.4490240655454, 12.2013635004957,
10.1012241857225, 8.60768940429353, 7.51608965104502, 5.82598001278768, 4.78058630318776,
4.03544786153862, 3.49406413913649, 2.59733598774052, 2.05386854284152, 1.6949173421721,
1.42848405503094, 1.42848405503094];