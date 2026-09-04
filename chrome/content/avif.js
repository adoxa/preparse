importScripts("mov.js", "bmp.js");

onmessage = function(event) {
	var data = event.data.data;
	var out = [];
	try {
		if (event.data.type == "avif") {
			var avif = new Uint8Array(data.reduce((t, a) => t + a.byteLength, 0));
			data.reduce((o, a) => (avif.set(new Uint8Array(a), o), o + a.byteLength), 0);
			out = avif2mov(avif.buffer);
		} else if (event.data.type == "bmp") {
			out = rgba2bmp(data, event.data.width, event.data.height);
		} else /* (event.data.type == "err") */ {
			console.error(data);
		}
	} catch (e) {
		console.error(e);
		event.data.type = "err";
	}

	out = new Uint8Array(out);
	postMessage({type: event.data.type, data: out}, [out.buffer]);
}
