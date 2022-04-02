import {logToLinear, cancelAndHoldAtTime} from './opn2.js';

class Point {
	constructor(time, value) {
		this.time = time;	// in steps
		this.value = value;
	}
}

const IntervalType = Object.freeze({
	SMOOTH: 0,		// A smooth transition
	GLISSANDO: 1,	// A sequence of jumps within one or more pitch bend steps
	JUMP: 2,			// A single jump
});

class Bend {

	static NUM_TIME_CONSTANTS = 4;
	static STEP_OPTIONS = [1];

	constructor(initialValue, stepResolutionOption = 0) {
		this.points = [ new Point(0, initialValue) ];
		this.intervalTypes = [];
		// For the GUI only.
		this.stepsPerInteger = this.stepOptions[stepResolutionOption];
		this.releasePoint = Infinity;		// Note on bend only.
	}

	/**
	 * @param {AudioParam} param The audio parameter to modify.
	 * @param {boolean} release True to execute the key off portion of the bend, or false to
	 * execute the key on portion.
	 * @param {number} startTime The time relative to the AudioContext to begin making changes
	 * from.
	 * @param {number} timesPerStep Either the duration of a line (fine changes, i.e. slower) or
	 * the duration of a tick, in seconds, or an absolute value if you don't want the effect
	 * tempo synced. Use multiple values to account for a groove or a tempo change and
	 * this method will rotate through them.
	 * @param {number} maxSteps The maximum number of bend steps to perform. If the bend is
	 * longer than the number of steps provided then only the beginning of the bend will be
	 * performed.
	 * @param {number} [initialValue] The audio parameter's initial value. Required for pitch
	 * bends, ignored for other types of bend.
	 * @param {number} [scaling=1] Scales the bend's values (y-axis) before applying them, for
	 * applying a greater or less extreme bend. Negative values inverts a pitch bend.
	 */
	execute(
		param, release, startTime, timesPerStep, scaling = 1, initialValue = undefined,
		maxSteps = this.getLength(release),
	) {
		const points = this.points;
		let startStep, firstPointIndex;
		if (release) {
			firstPointIndex = this.releasePoint;
			if (firstPointIndex >= points.length) {
				// Bend doesn't contain any note off changes.
				return;
			}
			startStep = points[firstPointIndex].time;
			maxSteps += startStep;
		} else if (this.releasePoint === 0) {
			// Bend only contains note off changes.
			return;
		} else {
			firstPointIndex = 0;
			startStep = 0;
			if (this.releasePoint < points.length) {
				// Don't go further than the release point.
				maxSteps = Math.min(maxSteps, points[this.releasePoint].time);
			}
		}
		// Don't go further than the last point.
		maxSteps = Math.min(maxSteps, points[points.length - 1].time);

		const time = new Array(maxSteps + 1);
		time[0] = 0;
		for (let i = 1; i <= maxSteps; i++) {
			time[i] = time[i - 1] + timesPerStep[(i - 1) % timesPerStep.length];
		}

		let from = points[firstPointIndex].value * scaling;
		param.setValueAtTime(this.encodeValue(from, initialValue), startTime);

		for (let i = firstPointIndex + 1; i < points.length; i++) {
			let to = points[i].value * scaling;
			let endStep = points[i].time;
			let encodedValue;
			switch (this.intervalTypes[i - 1]) {

			case IntervalType.JUMP:
				// Jumps occur at the beginning of the step. Smooth transitions flow till the end.
				endStep--;
				if (endStep > maxSteps) {
					return;
				}
				param.setValueAtTime(this.encodeValue(to, initialValue), startTime + time[endStep]);
				break;

			case IntervalType.SMOOTH:

				// Smooth transition
				encodedValue = this.encodeValue(to, initialValue);

				if (startStep >= maxSteps) {

					return;

				} else if (this.isExponential) {

					const duration = time[endStep] - time[startStep];

					if (to > from) {

						let encodedFrom = this.encodeValue(from, initialValue);
						if (encodedFrom === 0) {
							encodedFrom = this.minNonZero;
						}
						param.setValueAtTime(encodedFrom, startTime + time[startStep]);

						if (encodedValue === 0) {
							encodedValue = -this.minNonZero;
							param.setValueAtTime(encodedValue, startTime + time[endStep]);
						}

						param. exponentialRampToValueAtTime(encodedValue, startTime + time[endStep]);

						if (endStep > maxSteps) {
							const value = encodedFrom * (encodedValue / encodedFrom) **
								((time[maxSteps] - time[startStep]) / duration);
							cancelAndHoldAtTime(param, value, startTime + time[maxSteps]);
							return;
						}

					} else {

						const timeConstant = duration / Bend.NUM_TIME_CONSTANTS;
						param.setTargetAtTime(
							encodedValue,
							startTime + time[startStep],
							timeConstant
						);
						if (endStep > maxSteps) {
							const value = to + (from - to) *
								Math.exp((time[startStep] - time[maxSteps]) / timeConstant);
							encodedValue = this.encodeValue(value, initialValue);
							param.setValueAtTime(encodedValue, startTime + time[maxSteps]);
							return;
						}

					}

				} else {

					// Linear
					if (endStep > maxSteps) {
						to = from + (to - from) * (maxSteps - startStep) / (endStep - startStep);
						encodedValue = this.encodeValue(to, initialValue);
						param.linearRampToValueAtTime(encodedValue, startTime + time[maxSteps]);
						return;
					} else {
						param.linearRampToValueAtTime(encodedValue, startTime + time[endStep]);
					}

				}
				break;

			default:

				// Glissando
				if (startStep >= maxSteps) {
					return;
				}

				const gradient = (to - from) / (endStep - startStep);
				endStep = Math.min(endStep, maxSteps);
				encodedValue = this.encodeValue(from, initialValue);
				const round = to >= from ? Math.trunc : Math.ceil;
				let prevIntValue = round(from);
				to = from;
				for (let j = startStep + 1; j <= endStep; j++) {
					const intValue = round(from + (j - startStep) * gradient);
					if (prevIntValue !== intValue) {
						encodedValue = this.encodeValue(intValue, initialValue);
						param.setValueAtTime(encodedValue, startTime + time[j]);
						to = intValue;
						prevIntValue = intValue;
					}
				}
				param.setValueAtTime(encodedValue, startTime + time[endStep]);

			}

			from = to;
			startStep = endStep;
		}
	}

	getLength(release = false) {
		const points = this.points;
		const numSteps = points[points.length - 1].time;
		const releasePointIndex = this.releasePoint;
		if (release) {
			if (releasePointIndex < points.length) {
				return numSteps - points[releasePointIndex].time;
			} else {
				return 0;
			}
		} else {
			if (releasePointIndex < points.length) {
				return points[releasePointIndex].time;
			} else {
				return numSteps;
			}
		}
	}

	get isExponential() {
		return true;
	}

	get allowSmmoth() {
		return true;
	}

	get allowStepped() {
		return false;
	}

	get stepOptions() {
		return Bend.STEP_OPTIONS;
	}

}

class PitchBend extends Bend {

	static STEP_OPTIONS = [1, 4, 16, 100];

	constructor() {
		super(0, 2);	// Default to 1/16 semitone increments
		this.maxUp = 2;
		this.maxDown = 2;
	}

	get min() {
		return -this.maxDown;
	}

	get max() {
		return this.maxUp;
	}

	get stepOptions() {
		return PitchBend.STEP_OPTIONS;
	}

	get allowStepped() {
		return true;
	}

	encodeValue(semitones, startFrequency) {
		return startFrequency * 2 ** (semitones / 12);
	}

	get minNonZero() {
		return 2;	// in Hertz
	}

}

class VolumeAutomation extends Bend {

	constructor() {
		super(1);
	}

	get min() {
		return 0;
	}

	get max() {
		return 63;	// Amiga style volume measurement
	}

	encodeValue(volume) {
		return logToLinear(Math.round(volume * 1023 / 63));
	}

	get minNonZero() {
		return 2 ** (-10 * 1023 / 1024);
	}

}

class AttenuationAutomation extends Bend {

	constructor() {
		super(127);
	}

	get isExponential() {
		return false;
	}

	get min() {
		return 127;
	}

	get max() {
		return 0;
	}

	encodeValue(totalLevel) {
		return -totalLevel / 128;
	}

}

export {PitchBend, VolumeAutomation, AttenuationAutomation};
