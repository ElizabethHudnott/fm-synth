/* This source code is copyright of Elizabeth Hudnott.
 * © Elizabeth Hudnott 2021-2023. All rights reserved.
 * Any redistribution or reproduction of part or all of the source code in any form is
 * prohibited by law other than downloading the code for your own personal non-commercial use
 * only. You may not distribute or commercially exploit the source code. Nor may you transmit
 * it or store it in any other website or other form of electronic retrieval system. Nor may
 * you translate it into another language.
 */
const LONG_REGISTER = Object.freeze({
	FREQUENCY: 0,		// 0-5
	CH3_FREQUENCY: 6,	// 6-8
});

const PCM_LEVELS = [0, 99, 141, 141];

const write = [];

export default class YM2612 {
	constructor(synth, context) {
		this.synth = synth;
		this.context = context;
		const channel = synth.getChannel(1);
		const highFrequencyByte = (channel.getFrequencyBlock() << 3) + (channel.getFrequencyNumber() >> 8);
		this.longRegisters = [
			highFrequencyByte, highFrequencyByte, highFrequencyByte, highFrequencyByte
		];
		synth.enablePCMRegister(context);
		this.pcmLevel = 0; // Bit 0 = DAC enable, Bit 1 = Loud PCM (test register)
	}

	write(address, value, port = 0, time = 0) {
		write[address](this, value, time, port);
	}

	enablePCM(bit, enabled, time) {
		this.pcmLevel = ((this.pcmLevel & ~bit) | (bit * enabled)) & 3;
		this.synth.mixPCM(PCM_LEVELS[this.pcmLevel], time);
	}

}

write[0x22] = (chip, preset, t) => {
	if (preset & 8) {
		preset &= 7;
		for (let i = 1; i <= 6; i++) {
			chip.synth.getChannel(i).useLFOPreset(chip.context, preset + 1, t);
		}
	} else {
		for (let i = 1; i <= 6; i++) {
			chip.synth.getChannel(i).setLFORate(chip.context, 0, t);
		}
	}
}

write[0x2b] = (chip, n, t) => chip.enablePCM(1, (n & 128) === 128, t);
write[0x2c] = (chip, n, t) => chip.enablePCM(2, (n & 16) === 16, t);

write[0x27] = (chip, b, t) => {
	const fixed = (b & 96) > 0;
	const channel = chip.synth.getChannel(3);
	for (let i = 1; i <= 4; i++) {
		channel.fixFrequency(i, fixed, t);
	}
}

write[0x28] = (chip, b, t) => {
	const channelNum = b & 7;
	const op1 = (b & 16) === 16;
	const op2 = (b & 32) === 32;
	const op3 = (b & 64) === 64;
	const op4 = (b & 128) === 128;
	chip.synth.getChannel(channelNum + 1).keyOnOff(chip.context, 127, t, op1, op2, op3, op4);
}

function multiplyAndDetune(chip, port, relativeChannelNum, operatorNum, value, time) {
	const synth = chip.synth;
	const channelNum = port * 2 + relativeChannelNum;
	const multiple = value & 15;
	const detune = (value >> 4) & 7;
	const channel = synth.getChannel(channelNum);
	channel.getOperator(operatorNum).setDetune(detune, time);
	channel.setFrequencyMultiple(operatorNum, multiple, time);
}

write[0x30] = (chip, b, t, port) => multiplyAndDetune(chip, port, 1, 1, b, t);
write[0x31] = (chip, b, t, port) => multiplyAndDetune(chip, port, 2, 1, b, t);
write[0x32] = (chip, b, t, port) => multiplyAndDetune(chip, port, 3, 1, b, t);
write[0x34] = (chip, b, t, port) => multiplyAndDetune(chip, port, 1, 3, b, t);
write[0x35] = (chip, b, t, port) => multiplyAndDetune(chip, port, 2, 3, b, t);
write[0x36] = (chip, b, t, port) => multiplyAndDetune(chip, port, 3, 3, b, t);
write[0x38] = (chip, b, t, port) => multiplyAndDetune(chip, port, 1, 2, b, t);
write[0x39] = (chip, b, t, port) => multiplyAndDetune(chip, port, 2, 2, b, t);
write[0x3A] = (chip, b, t, port) => multiplyAndDetune(chip, port, 3, 2, b, t);
write[0x3C] = (chip, b, t, port) => multiplyAndDetune(chip, port, 1, 4, b, t);
write[0x3D] = (chip, b, t, port) => multiplyAndDetune(chip, port, 2, 4, b, t);
write[0x3E] = (chip, b, t, port) => multiplyAndDetune(chip, port, 3, 4, b, t);

// ...

function setFrequency(chip, port, relativeChannelNum, lowerByte, time) {
	const channelNum = port * 2 + relativeChannelNum;
	const upperByte = chip.longRegisters[LONG_REGISTER.FREQUENCY + channelNum - 1];
	const block = upperByte >> 3;
	const freqNum = ((upperByte & 7) << 8) + lowerByte;
	chip.synth.getChannel(channelNum).setFrequency(block, freqNum, time);
}

function setCh3Frequency(chip, operatorNum, lowerByte, time) {
	const upperByte = chip.longRegisters[LONG_REGISTER.CH3_FREQUENCY + operatorNum - 1];
	const block = upperByte >> 3;
	const freqNum = ((upperByte & 7) << 8) + lowerByte;
	chip.synth.getChannel(3).setOperatorFrequency(operatorNum, block, freqNum, time);
}

write[0xA0] = (chip, b, t, port) => setFrequency(chip, port, 1, b, t);
write[0xA1] = (chip, b, t, port) => setFrequency(chip, port, 2, b, t);
write[0xA2] = (chip, b, t, port) => {
	// Channel 3 main frequency register or Channel 6 frequency register
	const channelNum = port * 2 + 3;
	const upperByte = chip.longRegisters[LONG_REGISTER.FREQUENCY + channelNum - 1];
	const block = upperByte >> 3;
	const freqNum = ((upperByte & 7) << 8) + b;
	const channel = chip.synth.getChannel(3);
	if (channel.isOperatorFixed(4)) {
		channel.setOperatorFrequency(4, block, freqNum, t);
	} else {
		channel.setFrequency(block, freqNum, t);
	}
}

write[0xA4] = (chip, b, t, port) => chip.longRegisters[LONG_REGISTER.FREQUENCY + port * 3] = b;
write[0xA5] = (chip, b, t, port) => chip.longRegisters[LONG_REGISTER.FREQUENCY + port * 3 + 1] = b;
write[0xA6] = (chip, b, t, port) => chip.longRegisters[LONG_REGISTER.FREQUENCY + port * 3 + 2] = b;
write[0xA8] = (chip, b, t) => setCh3Frequency(chip, 3, b, t);
write[0xA9] = (chip, b, t) => setCh3Frequency(chip, 1, b, t);
write[0xAA] = (chip, b, t) => setCh3Frequency(chip, 2, b, t);
write[0xAC] = (chip, b) => chip.longRegisters[LONG_REGISTER.CH3_FREQUENCY + 2] = b;
write[0xAD] = (chip, b) => chip.longRegisters[LONG_REGISTER.CH3_FREQUENCY] = b;
write[0xAE] = (chip, b) => chip.longRegisters[LONG_REGISTER.CH3_FREQUENCY + 1] = b;

function setAlgorithmAndFeedback(chip, port, relativeChannelNum, value, time) {
	const channelNum = port * 2 + relativeChannelNum;
	const algorithmNum = value & 7;
	const feedbackNum = value >> 3;
	const channel = chip.synth.getChannel(channelNum);
	channel.setAlgorithmNumber(algorithmNum, time);
	channel.setFeedbackNumber(feedbackNum, 1, time);
}

write[0xB0] = (chip, b, t, port) => setAlgorithmAndFeedback(chip, port, 1, b, t);
write[0xB1] = (chip, b, t, port) => setAlgorithmAndFeedback(chip, port, 2, b, t);
write[0xB2] = (chip, b, t, port) => setAlgorithmAndFeedback(chip, port, 3, b, t);

function setPanAndLFO(chip, port, relativeChannelNum, value, time) {
	const channelNum = port * 2 + relativeChannelNum;
	const pmDepth = value & 7;
	const amDepth = (value & 48) >> 4;
	const channel = chip.synth.getChannel(channelNum);
	channel.useVibratoPreset(pmDepth, time);
	channel.useTremoloPreset(amDepth, time);
	if ((value && 192) === 0) {
		channel.mute(true, time);
		return;
	}
	const pan = ((value & 128) ? -1 : 0) + ((value & 64) ? 1 : 0);
	channel.setPan(pan, time);
	channel.mute(false, time);
}

write[0xB4] = (chip, b, t, port) => setPanAndLFO(chip, port, 1, b, t);
write[0xB5] = (chip, b, t, port) => setPanAndLFO(chip, port, 2, b, t);
write[0xB6] = (chip, b, t, port) => setPanAndLFO(chip, port, 3, b, t);
