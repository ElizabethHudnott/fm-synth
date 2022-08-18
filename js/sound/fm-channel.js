import {
	modulationIndex, outputLevelToGain, cancelAndHoldAtTime, panningMap,
	MAX_FLOAT, VIBRATO_PRESETS, PROCESSING_TIME
} from './common.js';
import Operator from './operator.js';

const FadeParameter = Object.freeze({
	DEPTH: 0,
	RATE: 1,
});

const Pan = Object.freeze({
	FIXED: 0,
	NOTE: 1,
	VELOCITY: 2,
	LFO: 3,
});

class AbstractChannel {

	// 0db, 1.4db, 5.9db, 11.8db
	static tremoloPresets = [0, 15, 63, 126].map(x => x / 2046);

	static glideRates = [0].concat([
		     254, 243, 232, 211, 202, 193, 185, 178, 171,
		165, 159, 153, 147, 141, 135, 130, 125, 120, 115,
		110, 106, 102,  98,  94,  91,  88,  85,  82,  79,
		 76,  74,  72,  70,  68,  66,  64,  62,  60,  58,
		 56,  54,  53,  51,  49,  47,  46,  44,  42,  41,
		 39,  38,  37,  36,  34,  33,  31,  30,  28,  27,
		 26,  25,  24,  23,  22,  21,  20,  19,  18,  17.5,
		 17,  16, 15.5, 15,  14, 13.5, 13, 12.5, 12,  11.5,
		 11, 10.5, 10, 9.5,   9,  8.5,  8,  7.5,  7,   6.5,
		  6,  5.5,  5, 4.5,   4,  3.5,  3,  2.5,  2,   1
	].map(x => 10 / x));

	frequencyToNote(block, frequencyNum) {
		let lb = 0;
		let ub = 127;
		while (lb < ub) {
			const mid = Math.trunc((lb + ub) / 2);
			const noteBlock = this.noteFreqBlockNumbers[mid];
			const noteFreqNum = this.noteFrequencyNumbers[mid];
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

	componentsToFullFreq(blockNumber, frequencyNumber) {
		return Math.trunc(frequencyNumber * 2 ** (blockNumber - 1));
	}

	fullFreqToComponents(fullFrequencyNumber) {
		let block = 1, freqNum = fullFrequencyNumber;
		if (freqNum < 1023.5) {
			block = 0;
			freqNum = Math.round(freqNum) * 2;
		}
		while (freqNum >= 2047.5 || (block < 7 && freqNum >= this.octaveThreshold)) {
			freqNum /= 2;
			block++;
		}
		return [block, Math.round(freqNum)];
	}

	multiplyFreqComponents(block, frequencyNumber, multiple) {
		const fullFreqNumber = this.componentsToFullFreq(block, frequencyNumber) * multiple;
		return this.fullFreqToComponents(fullFreqNumber);
	}

}

class Channel extends AbstractChannel {

	static algorithms = [
		/*	[
				[op1To2Level, op1To3Level, op1To4Level, op2To3Level, op2To4Level, op3To4Level],
				[op1OutputLevel, op2OutputLevel, op3OutputLevel, op4OutputLevel]
			]
		 */

		// 1 -> 2 -> 3 -> 4
		[[99, 0, 0, 99, 0, 99], [0, 0, 0, 99]],

		// 1 \
		//    |--> 3 -> 4
		// 2 /
		[[0, 99, 0, 99, 0, 99], [0, 0, 0, 99]],

		// 1 -----\
		//         |--> 4
		// 2 -> 3 /
		[[0, 0, 99, 99, 0, 99], [0, 0, 0, 99]],


		// 1 -> 2 \
		//        |--> 4
		// 3 -----/
		[[99, 0, 0, 0, 99, 99], [0, 0, 0, 99]],

		// 1 -> 2
		// 3 -> 4
		[[99, 0, 0, 0, 0, 99], [0, 99, 0, 99]],

		//   /--> 2
		// 1 |--> 3
		//   \--> 4
		[[99, 99, 99, 0, 0, 0], [0, 99, 99, 99]],

		// 1 -> 2
		//      3
		//      4
		[[99, 0, 0, 0, 0, 0], [0, 99, 99, 99]],

		// No modulation
		[[0, 0, 0, 0, 0, 0], [99, 99, 99, 99]],

		//           1
		// 2 -> 3 -> 4
		[[0, 0, 0, 99, 0, 99], [99, 0, 0, 99]],
	];

	constructor(synth, context, output, dbCurve) {
		super();
		this.synth = synth;
		this.tuneEqualTemperament();

		const shaper = new WaveShaperNode(context, {curve: [-1, 0, 1]});

		const cutoffNote = 106;
		this.cutoffNote = cutoffNote;
		this.cutoffHz = this.componentsToFullFreq(
			this.noteFreqBlockNumbers[cutoffNote + 12], this.noteFrequencyNumbers[cutoffNote + 12]
		) * synth.frequencyStep;	// 3728 Hz
		this.resonance = 0;

		const filter = new BiquadFilterNode(
			context, {frequency: this.cutoffHz, Q: this.resonance}
		);
		this.filter = filter;
		shaper.connect(filter);

		const gain = new GainNode(context);
		this.gainControl = gain.gain;
		this.filter.connect(gain);

		const panner = new StereoPannerNode(context);
		this.pan = 0;
		// The range is plus or minus this value, so it represents half of the total range.
		this.panRange = 1;
		this.panDirection = 1; // 1 or -1
		this.panInputCentre = 64;
		this.panInputRange = 63; // +- this value. Half the total range.
		this.panMode = Pan.FIXED;

		gain.connect(panner);
		this.panner = panner;
		const mute = new GainNode(context);
		panner.connect(mute);
		mute.connect(output);
		this.muteControl = mute.gain;

		this.lfoRateNode = new ConstantSourceNode(context, {offset: 0});
		this.lfoRate = 0;
		this.lfoShape = 'triangle';
		this.lfoKeySync = false;
		this.lfo = undefined;
		const lfoEnvelope = new GainNode(context);
		this.lfoEnvelope = lfoEnvelope;
		this.lfoDelay = 0;
		this.lfoFade = 0;
		this.fadeLFORate = false;	// false = fade LFO depth, true = fade LFO rate

		const autoPan = new GainNode(context, {gain: 0});
		this.autoPan = autoPan.gain;
		lfoEnvelope.connect(autoPan);
		autoPan.connect(panner.pan);

		const op1 = new Operator(this, context, lfoEnvelope, shaper, dbCurve);
		const op2 = new Operator(this, context, lfoEnvelope, shaper, dbCurve);
		const op3 = new Operator(this, context, lfoEnvelope, shaper, dbCurve);
		const op4 = new Operator(this, context, lfoEnvelope, shaper, dbCurve);
		this.operators = [op1, op2, op3, op4];

		const minDelay = 128 / context.sampleRate;
		const op1To1 = new GainNode(context, {gain: 0});
		op1.connectOut(op1To1);
		const feedbackFilter1 = new BiquadFilterNode(context, {type: 'highpass', frequency: 0, Q: 0});
		op1.connectFrequency(feedbackFilter1.frequency);
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
		const feedbackFilter3 = new BiquadFilterNode(context, {type: 'highpass', frequency: 0, Q: 0});
		op3.connectFrequency(feedbackFilter3.frequency);
		op3To3.connect(feedbackFilter3);
		const delay3To3 = new DelayNode(context, {delayTime: minDelay, maxDelayTime: minDelay});
		feedbackFilter3.connect(delay3To3);
		op3.connectIn(delay3To3);

		const op3To4 = new GainNode(context, {gain: 0});
		op3.connectOut(op3To4);
		op4.connectIn(op3To4);

		this.gains = [
			op1To1.gain, op3To3.gain,
			op1To2.gain, op1To3.gain, op1To4.gain,
			op2To3.gain, op2To4.gain,
			op3To4.gain
		];
		this.modulationDepths = new Array(this.gains.length);
		// Initialize feedback registers
		this.modulationDepths[0] = 0;
		this.modulationDepths[1] = 0;

		this.freqBlockNumbers = [3, 3, 3, 3];
		this.frequencyNumbers = [1093, 1093, 1093, 1093];
		this.frequencyMultiples = [1, 1, 1, 1];
		this.fixedFrequency = [false, false, false, false];
		this.glideRate = 0;

		this.outputLevel = 99;
		this.tremoloDepth = 0;	// linear scale
		this.vibratoDepth = 0;
		this.tremoloEnabled = [false, false, false, false];
		this.vibratoEnabled = [true, true, true, true];
		this.operatorDelay = [0, 0, 0, 0];
		this.muted = false;

		this.stopTime = 0;
		this.oldStopTime = 0;	// Value before the key-on/off currently being processed.

		this.useAlgorithm(0);
	}

	copyOperator(from, to) {
		const fromOperator = this.operators[from - 1];
		const toOperator = this.operators[to - 1];
		fromOperator.copyTo(toOperator);

		let block = this.freqBlockNumbers[from - 1];
		let freqNum = this.frequencyNumbers[from - 1];
		const multiple = this.frequencyMultiples[from - 1];
		const fixedFrequency = this.fixedFrequency[from - 1];

		if (to !== 4 || fixedFrequency) {
			this.freqBlockNumbers[to - 1] = block;
			this.frequencyNumbers[to - 1] = freqNum;
		}
		this.frequencyMultiples[to - 1] = multiple;
		this.fixedFrequency[to - 1] = fixedFrequency;

		if (fixedFrequency) {
			toOperator.setFrequency(block, freqNum, 1);
		} else {
			this.setFrequency(this.freqBlockNumbers[3], this.frequencyNumbers[3]);
		}
		this.tremoloEnabled[to - 1] = this.tremoloEnabled[from - 1];
		this.vibratoEnabled[to - 1] = this.vibratoEnabled[from - 1];
		this.operatorDelay[to - 1] = this.operatorDelay[from - 1];
	}

	copyEnvelope(from, to) {
		const fromOperator = this.operators[from - 1];
		const toOperator = this.operators[to - 1];
		fromOperator.copyEnvelopeTo(toOperator);
	}

	start(time) {
		for (let operator of this.operators) {
			operator.start(time);
		}
		this.lfoRateNode.start(time);
	}

	stop(time = 0) {
		for (let operator of this.operators) {
			operator.stop(time);
		}
		this.lfoRateNode.stop(time);
		this.lfoRateNode = undefined;
		if (this.lfo) {
			this.lfo.stop(time);
			this.lfo = undefined;
		}
	}

	getOperator(operatorNum) {
		return this.operators[operatorNum - 1];
	}

	splitChannel(context, split, time = 0) {
		if (split) {
			this.setVolume(this.outputLevel / 2, time);
			this.setLFOKeySync(context, false, time);
			this.applyLFO(time);
		} else {
			this.setVolume(this.outputLevel, time);
			this.setLFOKeySync(context, this.lfoKeySync, time);
		}
	}

	setAlgorithm(modulations, outputLevels, time = 0, method = 'setValueAtTime') {
		for (let i = 0; i < 6; i++) {
			const depth = modulations[i] || 0;
			this.gains[i + 2][method](modulationIndex(depth) / 2, time);
			this.modulationDepths[i + 2] = depth;
		}
		for (let i = 0; i < 4; i++) {
			const operator = this.operators[i];
			const outputLevel = outputLevels[i] || 0;
			operator.enable();
			operator.setOutputLevel(outputLevel, time, method);
		}
	}

	useAlgorithm(algorithmNum, time = 0, method = 'setValueAtTime') {
		const algorithm = Channel.algorithms[algorithmNum];
		this.setAlgorithm(algorithm[0], algorithm[1], time, method);
	}

	getAlgorithm() {
		algorithm: for (let i = 0; i < Channel.algorithms.length; i++) {
			const algorithm = Channel.algorithms[i];
			const modulations = algorithm[0];
			for (let j = 0; j < modulations.length; j++) {
				const algorithmModulates = modulations[j] !== 0;
				const thisModulates = this.modulationDepths[j + 2] !== 0;
				if (algorithmModulates !== thisModulates) {
					continue algorithm;
				}
			}
			const outputLevels = algorithm[1];
			for (let j = 0; j < 4; j++) {
				const algorithmOutputs = outputLevels[j] !== 0;
				const thisOutputs = this.operators[j].getOutputLevel() !== 0;
				if (algorithmOutputs !== thisOutputs) {
					continue algorithm;
				}
			}
			return i;
		} // end for each algorithm
		return -1;
	}

	#indexOfGain(modulatorOpNum, carrierOpNum) {
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

	/**
	 * @param {number} depth Range -99..99
	 */
	setModulationDepth(modulatorOpNum, carrierOpNum, depth, time = 0, method = 'setValueAtTime') {
		const index = this.#indexOfGain(modulatorOpNum, carrierOpNum);
		this.gains[index][method](modulationIndex(depth) / 2, time);
		this.modulationDepths[index] = depth;
	}

	getModulationDepth(modulatorOpNum, carrierOpNum) {
		const index = this.#indexOfGain(modulatorOpNum, carrierOpNum);
		return index === -1 ? 0 : this.modulationDepths[index];
	}

	normalizeLevels(distortion = 0) {
		const maxLevel = 10 ** (distortion / 20);
		const currentGains = new Array(4);
		let total = 0;
		for (let i = 0; i < 4; i++) {
			const operator = this.operators[i];
			if (!operator.isDisabled()) {
				const gain = operator.getGain();
				currentGains[i] = gain;
				total += Math.abs(gain);
			}
		}
		if (total === 0) {
			return;
		}

		for (let i = 0; i < 4; i++) {
			const operator = this.operators[i];
			if (!operator.isDisabled()) {
				let gain = maxLevel * currentGains[i] / total;
				gain = Math.max(Math.min(gain, MAX_FLOAT), -MAX_FLOAT);
				operator.setGain(gain);
			}
		}
	}

	disableOperator(operatorNum, time = 0) {
		this.operators[operatorNum - 1].disable(time);
	}

	enableOperator(operatorNum) {
		this.operators[operatorNum - 1].enable();
	}

	setGlideRate(glideRate) {
		this.glideRate = AbstractChannel.glideRates[glideRate];
	}

	getGlideRate() {
		const glideRate = this.glideRate;
		if (glideRate === 0) {
			return 0;
		}
		return Math.round(10 / this.glideRate);
	}

	fixFrequency(operatorNum, fixed = true, time = 0) {
		const operator = this.operators[operatorNum - 1];

		if (fixed) {
			// Restore a fixed frequency from a register.
			const block = this.freqBlockNumbers[operatorNum - 1];
			const freqNum = this.frequencyNumbers[operatorNum - 1];
			operator.setFrequency(block, freqNum, 1, time);
		} else {
			// Restore a frequency ratio
			const block = this.freqBlockNumbers[3];
			const freqNum = this.frequencyNumbers[3];
			const multiple = this.frequencyMultiples[operatorNum - 1];
			operator.setFrequency(block, freqNum, multiple, time);
		}
		this.fixedFrequency[operatorNum - 1] = fixed;
	}

	isOperatorFixed(operatorNum) {
		return this.fixedFrequency[operatorNum - 1];
	}

	setFrequency(blockNumber, frequencyNumber, time = 0, glide = true) {
		const glideRate = glide ? this.glideRate : 0;
		for (let i = 0; i < 4; i++) {
			if (!this.fixedFrequency[i]) {
				const operator = this.operators[i];
				const multiple = this.frequencyMultiples[i];
				operator.setFrequency(blockNumber, frequencyNumber, multiple, time, glideRate);
			}
		}
		this.freqBlockNumbers[3] = blockNumber;
		this.frequencyNumbers[3] = frequencyNumber;
	}

	setOperatorFrequency(operatorNum, blockNumber, frequencyNumber, time = 0, glide = true) {
		if (this.fixedFrequency[operatorNum - 1]) {
			const operator = this.operators[operatorNum - 1];
			const glideRate = glide ? this.glideRate : 0;
			operator.setFrequency(blockNumber, frequencyNumber, 1, time, glideRate);
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

	/**
	 * @param {number} multiple Fractions in 1/16 resolution are supported on OPZ via the "fine"
	 * ratio parameter. These combine with detune2 to effectively create even more ratios. OPM,
	 * OPN and OPL only support integers and the value 0.5. OPN and OPL don't support detune2
	 * either. The DX7 supports 1/100 resolution (without detune2).
	 */
	setFrequencyMultiple(operatorNum, multiple, time = undefined) {
		this.frequencyMultiples[operatorNum - 1] = multiple;
		if (time !== undefined && !this.fixedFrequency[operatorNum - 1]) {
			const block = this.freqBlockNumbers[3];
			const freqNum = this.frequencyNumbers[3];
			const operator = this.operators[operatorNum - 1];
			operator.setFrequency(block, freqNum, multiple, time);
		}
	}

	getFrequencyMultiple(operatorNum) {
		return this.frequencyMultiples[operatorNum - 1];
	}

	setMIDINote(noteNumber, time = 0, glide = true) {
		const block = this.noteFreqBlockNumbers[noteNumber];
		const freqNum = this.noteFrequencyNumbers[noteNumber];
		const glideRate = glide ? this.glideRate : 0;
		this.setFrequency(block, freqNum, time, glideRate);
		if (this.panMode === Pan.NOTE) {
			this.#adjustPan(noteNumber, time);
		}
	}

	cancelGlide(time) {
		for (let i = 0; i < 4; i++) {
			this.operators[i].cancelGlide(time);
		}
	}

	/**
	 * @param {PitchBend} bend The pitch bend to apply, relative to the last note set using
	 * setMIDINote() or setFrequency().
	 * @param {boolean} release True to apply the note off portion of the bend, or false to
	 * apply the note on portion.
	 * @param {number} time The time to begin pitch bending from.
	 * @param {Array<number>} timesPerStep Any array formed using one of the following
	 * techniques.
	 * a) A list of the durations of tracker lines in seconds.
	 * b) An absolute value in seconds. Useful if you don't want the effect tempo synced, for
	 * example if you want to create a pitch envelope effect.
	 *
	 * Use multiple values to account for a groove (or a tempo change) and the system will
	 * rotate through them.
	 *
	 * @param {number} [scaling=1] Scales the bend's values before applying them. Useful for
	 * making the effect velocity sensitive. Negative values are also supported, in case you
	 * need to force the bend to head in particular direction without knowing which direction
	 * that's going to be when you create the bend.
	 * @param {number} [operatorMask] A number between 1 and 15. Each bit decides whether the
	 * corresponding operator will have its pitch bent or not.
	 * @param {number} [maxSteps] The maximum number of bend steps to perform. Useful if you
	 * want to cut the bend short to trigger a new note.
	 */
	pitchBend(
		bend, release, startTime, timesPerStep, scaling = 1, operatorMask = undefined,
		maxSteps = bend.getLength(release)
	) {
		this.cancelGlide(startTime);
		if (operatorMask === undefined) {
			operatorMask = 0;
			for (let i = 0; i < 4; i++) {
				operatorMask |= (!this.fixedFrequency[i]) << i;
			}
		}
		for (let i = 0; i < 4; i++) {
			if (operatorMask & (1 << i)) {
				const operator = this.operators[i];
				bend.execute(
					operator.frequencyParam, release, startTime, timesPerStep, scaling,
					operator.frequency, maxSteps
				);
			}
		}
	}

	setOperatorNote(operatorNum, noteNumber, multiple = 1, time = 0, glide = true) {
		this.fixedFrequency[operatorNum - 1] = true;
		let block = this.noteFreqBlockNumbers[noteNumber];
		let freqNum = this.noteFrequencyNumbers[noteNumber];
		if (multiple !== 1) {
			[block, freqNum] = this.multiplyFreqComponents(block, freqNum, multiple);
		}
		const glideRate = glide ? this.glideRate : 0;
		this.setOperatorFrequency(operatorNum, block, freqNum, time, glideRate);
	}

	getMIDINote(operatorNum = 4) {
		const block = this.freqBlockNumbers[operatorNum - 1];
		const freqNum = this.frequencyNumbers[operatorNum - 1];
		return this.frequencyToNote(block, freqNum);
	}

	setFeedback(amount, operatorNum = 1, time = 0, method = 'setValueAtTime') {
		const index = (operatorNum - 1) / 2;
		this.gains[index][method](amount, time);
		this.modulationDepths[index] = amount;
	}

	getFeedback(operatorNum = 1) {
		return this.modulationDepths[(operatorNum - 1) / 2];
	}

	useFeedbackPreset(n, operatorNum = 1, time = 0, method = 'setValueAtTime') {
		const amount = n === 0 ? 0 : -this.synth.feedbackCallibration * 2 ** (n - 6);
		this.setFeedback(amount, operatorNum, time, method);
	}

	getFeedbackPreset(operatorNum = 1) {
		const amount = this.getFeedback(operatorNum);
		if (amount === 0) {
			return 0;
		}
		let logAmount;
		logAmount = Math.log2(amount / -this.synth.feedbackCallibration) + 6;
		// Convert to a precision comparable to the output level.
		logAmount = Math.round(logAmount * 28) / 28;
		return logAmount;
	}

	/**
	 * @param {number} depth The amount of tremolo effect to apply in the range of -511.5 to
	 * +511.5 (though 510 is equivalent to the largest amount permitted by Yamaha). Values
	 * between 512 and 1023 will introduce ring modulation. The tremolo is modelled on
	 * OPM's combinations of 128 modulation depths and 3 amplitude modulation sensitivities.
	 */
	setTremoloDepth(depth, time = 0, method = 'setValueAtTime') {
		const scaledDepth = depth / 1023;
		for (let i = 0; i < 4; i++) {
			if (this.tremoloEnabled[i]) {
				this.operators[i].setTremoloDepth(scaledDepth, time, method);
			}
		}
		this.tremoloDepth = scaledDepth;
	}

	getTremoloDepth() {
		return Math.round(this.tremoloDepth * 1023);
	}

	useTremoloPreset(presetNum, time = 0, method = 'setValueAtTime') {
		const scaledDepth = AbstractChannel.tremoloPresets[presetNum];
		for (let i = 0; i < 4; i++) {
			if (this.tremoloEnabled[i]) {
				this.operators[i].setTremoloDepth(scaledDepth, time, method);
			}
		}
		this.tremoloDepth = scaledDepth;
	}

	getTremoloPreset() {
		const depth = Math.round(this.tremoloDepth * 1023);
		return AbstractChannel.tremoloPresets.indexOf(depth);
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
		const linearAmount = Math.sign(cents) * (2 ** (Math.abs(cents) / 1200) - 1);
		for (let i = 0; i < 4; i++) {
			if (this.vibratoEnabled[i]) {
				this.operators[i].setVibratoDepth(linearAmount, time, method);
			}
		}
		this.vibratoDepth = linearAmount;
	}

	getVibratoDepth() {
		return Math.round(Math.log2(this.vibratoDepth + 1) * 12000) / 10;
	}

	useVibratoPreset(presetNum, time = 0) {
		this.setVibratoDepth(VIBRATO_PRESETS[presetNum], time);
	}

	getVibratoPreset() {
		return VIBRATO_PRESETS.indexOf(this.getVibratoDepth());
	}

	enableVibrato(operatorNum, enabled = true, time = 0, method = 'setValueAtTime') {
		const operator = this.operators[operatorNum - 1];
		operator.setVibratoDepth(enabled ? this.vibratoDepth : 0, time, method);
		this.vibratoEnabled[operatorNum - 1] = enabled;
	}

	isVibratoEnabled(operatorNum) {
		return this.vibratoEnabled[operatorNum - 1];
	}

	setLFODelay(seconds) {
		this.lfoDelay = seconds;
	}

	getLFODelay() {
		return this.lfoDelay;
	}

	/**
	 * @param {number} seconds Positive values create an attack, negative values create a decay
	 */
	setLFOFade(seconds) {
		this.lfoFade = seconds;
	}

	getLFOFade() {
		return this.lfoFade;
	}

	setFadeParameter(mode, time = 0) {
		if (this.lfoFade < 0) {
			if (this.fadeLFORate && mode === FadeParameter.DEPTH) {
				// Switch from slowing down the rate to reducing the depth
				this.lfoRateNode.offset.setValueAtTime(this.lfoRate, time);
			} else if (!this.fadeLFORate && mode === FadeParameter.RATE) {
				// Switch from reducing the depth to slowing down the rate
				this.lfoEnvelope.gain.setValueAtTime(1, time);
			}
		}
		this.fadeLFORate = Boolean(mode);
	}

	getFadeParameter() {
		return Number(this.fadeLFORate);
	}

	setLFORate(context, frequency, time = 0, method = 'setValueAtTime') {
		this.lfoRateNode.offset[method](frequency, time);
		if (this.lfo) {
			if (frequency === 0) {
				this.lfo.stop(time);
				this.lfo = undefined;
			}
		} else if (frequency !== 0 && !this.lfoKeySync) {
			// Start LFO running in the background.
			const lfo = new OscillatorNode(context, {frequency: 0, type: this.lfoShape});
			this.lfoRateNode.connect(lfo.frequency);
			lfo.start(time);
			lfo.connect(this.lfoEnvelope);
			this.lfo = lfo;
		}
		this.lfoRate = frequency;
	}

	setLFOShape(context, shape, time = undefined) {
		if (shape === this.lfoShape) {
			return;
		}
		if (this.lfo && (time !== undefined || !this.lfoKeySync)) {
			// Change LFO shape immediately.
			// Frequency will never be 0 when this.lfo is defined.
			const lfo = new OscillatorNode(context, {frequency: 0, type: shape});
			this.lfoRateNode.connect(lfo.frequency);
			lfo.start(time);
			lfo.connect(this.lfoEnvelope);
			this.lfo.stop(time);
			this.lfo = lfo;
		}
		this.lfoShape = shape;
	}

	setLFOKeySync(context, enabled, time = 0) {
		if (!enabled && this.lfo) {
			this.lfo.stop(context.currentTime + NEVER);
		}
		this.lfoKeySync = enabled;
	}

	getLFORate() {
		return this.lfoRate;
	}

	getLFOShape() {
		return this.lfoShape;
	}

	getLFOKeySync() {
		return this.lfoKeySync;
	}

	useLFOPreset(context, presetNum, time = 0, method = 'setValueAtTime') {
		const rate = this.synth.lfoPresetToFrequency(presetNum);
		this.setLFORate(context, rate, time, method);
	}

	getLFOPreset() {
		return this.synth.frequencyToLFOPreset(this.lfoRate);
	}

	/**Gets the *effective* LFO delay time.
	 */
	getEffectiveLFODelay() {
		let fadeTime = this.lfoFade;
		if (!this.fadeLFORate || fadeTime >= 0 || !this.lfoKeySync) {
			return this.lfoDelay;
		}

		const rate = this.lfoRate;
		const delay = this.lfoDelay;
		fadeTime = -fadeTime;
		let phase = rate * (delay + 0.5 * fadeTime);
		phase = Math.ceil(phase * 2) / 2;
		return phase / rate - 0.5 * fadeTime;
	}

	triggerLFO(context, time) {
		const rate = this.lfoRate;
		if (rate === 0) {
			return;
		}

		let initialAmount = this.lfoFade >= 0 ? 0 : 1;
		let finalAmount = 1 - initialAmount;
		const endDelay = time + this.getEffectiveLFODelay();
		let fadeTime = Math.abs(this.lfoFade);
		let param;
		if (this.fadeLFORate) {
			param = this.lfoRateNode.offset;
			initialAmount *= rate;
			finalAmount *= rate;
		} else {
			param = this.lfoEnvelope.gain;
		}
		cancelAndHoldAtTime(param, initialAmount, time);

		if (this.lfoKeySync) {
			// Reset LFO phase
			const lfo = new OscillatorNode(context, {frequency: 0, type: this.lfoShape});
			this.lfoRateNode.connect(lfo.frequency);
			lfo.start(initialAmount === 0 ? endDelay : time);
			lfo.connect(this.lfoEnvelope);
			if (this.lfo) {
				this.lfo.stop(time);
			}
			this.lfo = lfo;
		}

		param.setValueAtTime(initialAmount, endDelay)
		param.linearRampToValueAtTime(finalAmount, endDelay + fadeTime);
	}

	applyLFO(time) {
		cancelAndHoldAtTime(this.lfoRateNode.offset, this.lfoRate, time);
		cancelAndHoldAtTime(this.lfoEnvelope.gain, 1, time);
	}

	scheduleSoundOff(operator, time) {
		if (operator.getOutputLevel() !== 0) {
			this.stopTime = Math.max(this.stopTime, time);
		}
	}

	scheduleOscillators() {
		let lastOpOff = 1;
		for (let i = 4; i >= 1; i--) {
			const operator = this.operators[i - 1];
			if (operator.keyIsOn) {
				// Any lower numbered operator may be modulating this one and the algorithm can
				// change while the gate is open.
				lastOpOff = i + 1;
				break;
			}
		}
		const stopTime = this.stopTime;
		for (let i = 4; i >= lastOpOff; i--) {
			this.operators[i - 1].stopOscillator(stopTime);
		}
		if (lastOpOff === 1 && this.lfo && this.lfoKeySync) {
			this.lfo.stop(stopTime);
		}
		this.oldStopTime = stopTime;
	}

	newOscillators(context, time) {
		for (let i = 0; i < 4; i++) {
			const operator = this.operators[i];
			if (!operator.disabled) {
				operator.newOscillator(context, time);
			}
		}
	}

	applyFilter(time = 0) {
		this.filter.frequency.setValueAtTime(this.cutoffHz, time);
	}

	/**
	 * N.B. Doesn't fade in the LFO if a delay has been set. Use {@link Channel.keyOn} for that.
	 */
	keyOnOff(
		context, velocity = 127, time = context.currentTime + PROCESSING_TIME,
		op1 = velocity !== 0, op2 = op1, op3 = op1, op4 = op1
	) {
		const operators = this.operators;
		if (op1) {
			operators[0].keyOn(context, velocity, time + this.operatorDelay[0]);
		} else {
			operators[0].keyOff(time);
		}
		if (op2) {
			operators[1].keyOn(context, velocity, time + this.operatorDelay[1]);
		} else {
			operators[1].keyOff(time);
		}
		if (op3) {
			operators[2].keyOn(context, velocity, time + this.operatorDelay[2]);
		} else {
			operators[2].keyOff(time);
		}
		if (op4) {
			operators[3].keyOn(context, velocity, time + this.operatorDelay[3]);
		} else {
			operators[3].keyOff(time);
		}
		this.scheduleOscillators();
		this.applyFilter(time);
	}

	keyOn(context, velocity = 127, time = context.currentTime + PROCESSING_TIME) {
		this.triggerLFO(context, time);
		this.keyOnOff(context, velocity, time);
		if (this.panMode === Pan.VELOCITY) {
			this.#adjustPan(velocity, time);
		}
	}

	keyOff(context, time = context.currentTime) {
		this.keyOnOff(context, 0, time);
	}

	setOperatorDelay(operatorNum, delay) {
		this.operatorDelay[operatorNum - 1] = delay / 1000;
	}

	getOperatorDelay(operatorNum) {
		return this.operatorDelay[operatorNum - 1] * 1000;
	}

	soundOff(time = 0) {
		for (let operator of this.operators) {
			operator.soundOff(time);
		}
		if (this.lfo && this.lfoKeySync) {
			this.lfo.stop(time);
		}
	}

	/**
	 * @param {number} midiNote MIDI notes scale, though can be higher than 127 in order to
	 * refer to the higher harmonics
	 */
	setFilterCutoff(midiNote, time = 0, method = 'setValueAtTime') {
		let tableIndex = midiNote + 12;
		let octaveShift = 0;
		if (tableIndex > 127) {
			octaveShift = Math.ceil((tableIndex - 127) / 12);
			tableIndex -= 12 * octaveShift;
		}
		const frequency = this.componentsToFullFreq(
			this.noteFreqBlockNumbers[tableIndex], this.noteFrequencyNumbers[tableIndex]
		) * this.synth.frequencyStep * (1 << octaveShift);

		this.filter.frequency[method](frequency, time);
		this.cutoffNote = midiNote;
		this.cutoffHz = frequency;
	}

	getFilterCutoff() {
		return this.cutoffNote;
	}

	setFilterResonance(decibels, time = 0, method = 'setValueAtTime') {
		this.filter.Q[method](decibels, time);
		this.resonance = decibels;
	}

	getFilterResonance() {
		return this.resonance;
	}

	/**
	 * @param {number} panning -1 = left channel only, 0 = centre, 1 = right channel only
	 */
	setPan(panning, time = 0) {
		this.panner.pan.setValueAtTime(panningMap(panning), time);
		this.pan = panning;
		this.panMode = Pan.FIXED;
	}

	rampPan(panning, time) {
		this.panner.pan.linearRampToValueAtTime(panningMap(panning), time);
		this.pan = panning;
	}

	getPan() {
		return this.pan;
	}

	setPanModulationSource(mode, time = 0) {
		if (mode === Pan.LFO) {
			this.panner.pan.setValueAtTime(0, time);
			this.autoPan.setValueAtTime(-panningMap(this.panRange), time);
			this.pan = 0;
		} else {
			if (mode === Pan.FIXED) {
				if (this.panMode !== Pan.FIXED) {
					// Switching from another mode to fixed position mode places panning in the
					// centre.
					this.panner.pan.setValueAtTime(0, time);
				}
			} else {
				// Switching to a mode other than fixed resets the fixed panning position to the
				// centre.
				this.pan = 0;
			}
			this.autoPan.setValueAtTime(0, time);
		}
		this.panMode = mode;
	}

	getPanModulationSource() {
		return this.panMode;
	}

	setStereoWidth(width, time = 0, method = 'setValueAtTime') {
		const range = this.panDirection * width / 2;
		if (this.panMode === Pan.LFO) {
			this.autoPan[method](-panningMap(range), time);
		}
		this.panRange = range;
	}

	getStereoWidth() {
		return Math.abs(this.panRange) * 2;
	}

	/**
	 * @param {number} direction 1 = left to right, -1 = right to left
	 */
	setPanModulationDirection(direction, time = 0) {
		const range = direction * Math.abs(this.panRange);
		if (this.panMode === Pan.LFO) {
			this.autoPan.setValueAtTime(-panningMap(range), time);
		}
		this.panRange = range;
		this.panDirection = direction;
	}

	getPanModulationDirection() {
		return this.panDirection;
	}

	setPanControllerCentre(value) {
		this.panInputCentre = value;
	}

	getPanControllerCentre() {
		return this.panInputCentre;
	}

	/**
	 * @param {number} range Between 0 and 2
	 */
	setPanControllerRange(range) {
		this.panInputRange = range / 2;
	}

	getPanControllerRange() {
		return this.panInputRange * 2;
	}

	#adjustPan(input, time) {
		let relativePosition = (input - this.panInputCentre) / this.panInputRange;
		if (relativePosition < -1) {
			relativePosition = -1;
		} else if (relativePosition > 1) {
			relativePosition = 1;
		}
		const pan = relativePosition * this.panRange;
		this.panner.pan.setValueAtTime(panningMap(pan), time);
		this.pan = pan;
	}

	/**
	 * @param {number} volume Range -99..99
	 */
	setVolume(volume, time = 0, method = 'setValueAtTime') {
		this.gainControl[method](outputLevelToGain(volume), time);
		this.outputLevel = volume;
	}

	setGain(gain, time = 0, method = 'setValueAtTime') {
		this.gainControl[method](gain, time);
	}

	mute(muted, time = 0) {
		this.muteControl.setValueAtTime(muted ? 0 : 1, time);
		this.muted = muted;
	}

	isMuted() {
		return this.muted;
	}

	volumeAutomation(
		automation, release, startTime, timesPerStep, maxSteps = automation.getLength(release)
	) {
		automation.execute(
			this.gainControl, release, startTime, timesPerStep, 1, undefined, maxSteps
		);
	}

	get numberOfOperators() {
		return 4;
	}

	/**Calculates frequency data for a scale of 128 MIDI notes.
	 * @param {number} detune The amount of detuning to apply, in 1/100ths of a half step
	 * @param {number} interval The default value of 2 separates consecutive copies of the root
	 * note using a 2:1 frequency ratio (1 octave). Different values can produce stretched
	 * octaves, which can help mimic instruments such as the piano. More dramatic variations can
	 * produce unusual scales, such as Wendy Carlos' alpha, beta and gamma scales.
	 * @param {number} divisions How many notes the chromatic scale should have.
	 * @param {number[]} steps A pattern of scale increments used to move from one keyboard key
	 * to the next. The pattern will be repeated up and down the keyboard from middle C.
	 *
	 * Examples:
	 * [1] A regular equal tempered scale.
	 * [0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1] Equal tempered notes on the white keys only. Black
	 * keys have the same pitch as one of their adjacent white keys. Useful for creating a 7 EDO
	 * scale.
	 * [1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0] Equal tempered notes on the black keys only. White
	 * keys have the same pitch as one of their adjacent black keys. Useful for creating a 5 EDO
	 * scale.
	 *
	 * @param {number} startIndex The point to begin from within the sequence of intervals or
	 * equivalently, which note to centre the scale on.
	 */
	tuneEqualTemperament(detune = 0, interval = 2, divisions = 12, steps = [1], startIndex = 0) {
		const tuning = this.synth.equalTemperament(detune, interval, divisions, steps, startIndex);
		this.octaveThreshold = tuning.octaveThreshold;
		this.noteFreqBlockNumbers = tuning.freqBlockNumbers;
		this.noteFrequencyNumbers = tuning.frequencyNumbers;
	}

	/**
	 * @param {number[]} ratios
	 * E.g. 5-limit: [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 16/9, 15/8, 2]
	 * E.g. Harmonic scale: [1, 17/16, 18/16, 19/16, 20/16, 21/16, 22/16, 24/16, 26/16, 27/16, 28/16, 30/16, 2]
	 * @param {number} startNote 0 = C, 1 = C# ... 11 = B
	 */
	tuneRatios(ratios, startNote = 0) {
		const tuning = this.synth.ratioTuning(ratios, startNote);
		this.octaveThreshold = tuning.octaveThreshold;
		this.noteFreqBlockNumbers = tuning.freqBlockNumbers;
		this.noteFrequencyNumbers = tuning.frequencyNumbers;
	}

}

export {FadeParameter, Pan, AbstractChannel, Channel as default};
