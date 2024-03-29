window.drawWaveform = function (waveform, canvasContext, numCycles = 1) {
	const width = canvasContext.canvas.width;
	const height = canvasContext.canvas.height;
	const imageData = canvasContext.getImageData(0, 0, width, height);
	const pixels = imageData.data;
	const sampleLength = waveform.length;
	const length = sampleLength * numCycles;
	const halfHeight = (height - 1) / 2 - 1;
	let x = 0, total = 0, numSamples = 0, prevY;

	const whiteness = 96;
	const pinkness = 64;

	function fillPixel(x, y) {
		let offset = 4 * (y * width + x);
		pixels[offset] = 255;
		pixels[offset + 1] = whiteness;
		pixels[offset + 2] = whiteness;
		pixels[offset + 3] = 255;

		offset = 4 * ((y + 1) * width + x);
		pixels[offset] = 255;
		pixels[offset + 1] = pinkness;
		pixels[offset + 2] = pinkness;
		pixels[offset + 3] = 255;
	}

	for (let i = 0; i < length; i++) {
		const newX = Math.trunc(i / length * width);
		if (newX >= x + 1) {
			const average = total / numSamples;
			const pixelY = height - Math.round(average * halfHeight + halfHeight + 1.5);
			if (x > 0) {
				const dir = Math.sign(pixelY - prevY);
				for (let y = prevY; y != pixelY; y += dir) {
					fillPixel(x - 1, y);
				}
			}
			fillPixel(x, pixelY);

			total = 0;
			numSamples = 0;
			x = newX;
			prevY = pixelY;
		}
		total += waveform[i % sampleLength];
		numSamples++;
	}
	canvasContext.putImageData(imageData, 0, 0);
}

window.drawWaveforms = function () {
	const height = 24;
	//const width = 4 * Math.round(height * Math.PI / 2);
	const width = 4 * Math.ceil(2 * height / 4);	// squashed version

	const sine = new Array(1024);
	const saw = new Array(1024);
	for (let x = 0; x < 1024; x++) {
		sine[x] = Math.sin(2 * Math.PI * (x + 0.5) / 1024);
		saw[x] = ((x + 512) % 1024) / 512 - 1;
	}

	const waveforms = [sine];
	const cycles = [1];

	const square = new Array(1024)
	square.fill(1, 0, 512);
	square.fill(-1, 512);
	waveforms.push(square);
	cycles.push(1);

	waveforms.push(saw);
	cycles.push(1);

	const triangle = new Array(1024);
	for (let x = 0; x < 512; x++) {
		const fraction = x / 256;
		triangle[(x + 768) % 1024] = fraction - 1;
		triangle[x + 256] = 1 - fraction;
	}
	waveforms.push(triangle);
	cycles.push(1);

	for (let i = 0; i < waveforms.length; i++) {
		const canvas = document.createElement('CANVAS');
		canvas.width = width;
		canvas.height = height;
		const canvasContext = canvas.getContext('2d');
		drawWaveform(waveforms[i], canvasContext, cycles[i]);
		document.body.appendChild(canvas);
		document.body.appendChild(document.createElement('BR'));
	}
}
