var EXPORTED_SYMBOLS = ["preparse"];

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/Console.jsm");
Components.utils.import("chrome://preparse/content/worker.js");


preparse = {
	windows: [],

	prefs: Services.prefs.getBranch("extensions.preparse."),

	add: function(browser, cfg) {
		var state = cfg?.state ?? this.prefs.getCharPref("initstate");
		this.windows.push({
			browser,
			cfg: {
				state,
				active: cfg ? cfg.active : state == "auto" ? null : state == "on",
				reload: null,
				importmap: null,
				domain: null,
			}
		});
	},

	getConfig: function(browser) {
		return this.windows.find(w => w.browser == browser)?.cfg;
	},

	remove: function(browser) {
		/* when tabs are migrated we get a TabOpen followed by a TabClose */
		var i = this.windows.findIndex(w => w.browser == browser);
		if (i != -1) {
			this.windows.splice(i, 1);
		}
	}
};

var pp = function() {

	const Cc = Components.classes;
	const Ci = Components.interfaces;

	var state, domains_on, domains_off, contentTypes;
	var AV1enabled = Services.prefs.getBoolPref("media.av1.enabled");


	var prefsObserver = {
		observe: function(subject, topic, data) {
			if (topic != "nsPref:changed") {
				return;
			}

			switch (data) {
				case "contenttypes": this.updateContentTypes(); break;
				case "domains":
				case "domains_off":  this.updateDomains(data); break;
				case "initstate":    this.updateState(); break;
				case "showstate":
					Services.obs.notifyObservers(null, "preparse-show-changed", null);
					break;
				case "media.av1.enabled":
					AV1enabled = Services.prefs.getBoolPref("media.av1.enabled");
					break;
			}
		},

		updateState: function() {
			state = preparse.prefs.getCharPref("initstate");
		},

		updateDomains: function(pref) {
			var str = preparse.prefs.getCharPref(pref).toLowerCase();
			str = str.split(",");
			if (pref == "domains") {
				domains_on = str;
			} else {
				domains_off = str;
			}
		},

		updateContentTypes: function() {
			var str = preparse.prefs.getCharPref("contenttypes");
			contentTypes = str.split(",");
		},

		register: function() {
			preparse.prefs.addObserver("", this, false);
			this.updateState();
			this.updateDomains("domains");
			this.updateDomains("domains_off");
			this.updateContentTypes();
			Services.prefs.addObserver("media.av1.", this, false);
		},

		QueryInterface: function(aIID) {
			if (aIID.equals(Ci.nsIObserver) || aIID.equals(Ci.nsISupports)) {
				return this;
			}
			throw Components.results.NS_NOINTERFACE;
		}
	};


	function setActive(cfg, active) {
		if (cfg.active !== active) {
			cfg.active = active;
			Services.obs.notifyObservers(null, "preparse-active-changed", null);
		}
	}


	function domainFind(domains, domain) {
		domain = domain.toLowerCase();
		return domains.find(d => domain == d || domain.endsWith("." + d));
	}

	function domainActive(domains, domain) {
		return !!domainFind(domains, domain);
	}

	function domainName(domains, domain) {
		return domainFind(domains, domain) || domain.toLowerCase();
	}


	var httpRequestObserver = {
		observe: function(subject, topic, data) {
			if (topic == 'http-on-examine-response' ||
				topic == 'http-on-examine-cached-response') {
				if (subject instanceof Ci.nsIHttpChannel) {
					const contentType = subject.contentType;
					if (!(contentType == "text/html" ||
						  contentType.endsWith("javascript") ||
						  contentType.endsWith("unknown-content-type") ||
						  contentType.startsWith("image/avif"))) {
						return;
					}
					subject.QueryInterface(Ci.nsITraceableChannel);
					subject.QueryInterface(Ci.nsIHttpChannel);

					var context = this.getContext(this.getWindowFromChannel(subject));
					if (!context) {
						// No window, could be a GitHub worker (we wouldn't
						// be here if Preparse was off).
						if (subject.URI.spec.startsWith(GHWORKER)) {
							context = {cfg: {active: true}};
						} else {
							return;
						}
					}

					var listen = context.cfg.active ||
								 (context.cfg.state != "off" &&
								  (contentType.startsWith("image/avif") ||
								   subject.URI.spec.includes(".avif")));
					if (subject.isMainDocumentChannel) {
						context.cfg.importmap = null;
						// Keep the main domain, not iframes, unless it was reloaded.
						var initial = (subject.loadFlags & subject.LOAD_INITIAL_DOCUMENT_URI)
									  || context.cfg.reload;
						if (initial) {
							context.cfg.domain = subject.URI.host.toLowerCase();
						}
						if (context.cfg.state != "on" && domainActive(domains_on, subject.URI.host)) {
							context.cfg.domain = domainName(domains_on, subject.URI.host);
							setActive(context.cfg, true);
							listen = true;
						} else if (context.cfg.state != "off" && domainActive(domains_off, subject.URI.host)) {
							context.cfg.domain = domainName(domains_off, subject.URI.host);
							setActive(context.cfg, false);
							listen = false;
						} else if (context.cfg.state == "auto") {
							// Keep the current state for iframes.
							if (initial) {
								setActive(context.cfg, context.cfg.reload);
								context.cfg.reload = null;
							}
							listen = true;
						} else {
							listen = context.cfg.state == "on";
							setActive(context.cfg, listen);
						}
					}
					if (listen) {
						var newListener = new preparseListener();
						Object.assign(newListener, context);
						newListener.originalListener = subject.setNewListener(newListener);
					}
				}
			} else if (topic == "chrome-document-global-created" ||
					   topic == "content-document-global-created") {
				if (data == "null") {
					// Not http, restore initial state.
					var context = this.getContext(subject);
					if (context) {
						setActive(context.cfg, context.cfg.state == "auto" ? null : context.cfg.state == "on");
					}
				}
			}
		},

		getWindowFromChannel: function(aChannel) {
			var ctx = this.getLoadContext(aChannel);
			if (ctx) {
				try {
					return ctx.associatedWindow;
				} catch (e) { }
			}

			return null;
		},

		getContext: function(win) {
			for (; win; win = win.parent) {
				var entry = preparse.windows.find(w => w.browser.contentWindow == win);
				if (entry) {
					return entry;
				}

				if (win.parent == win) {
					return null;
				}
			}
			return null;
		},

		getLoadContext: function(aChannel) {
			try {
				if (aChannel.notificationCallbacks) {
					return aChannel.notificationCallbacks.getInterface(Ci.nsILoadContext);
				}
			} catch (e) { }

			try {
				if (aChannel?.loadGroup?.notificationCallbacks) {
					return aChannel.loadGroup.notificationCallbacks.getInterface(Ci.nsILoadContext);
				}
			} catch (e) { }

			return null;
		},

		register: function() {
			Services.obs.addObserver(this, "http-on-examine-cached-response", false);
			Services.obs.addObserver(this, "http-on-examine-response", false);
			Services.obs.addObserver(this, "chrome-document-global-created", false);
			Services.obs.addObserver(this, "content-document-global-created", false);
		},

		QueryInterface: function(aIID) {
			if (aIID.equals(Ci.nsIObserver) || aIID.equals(Ci.nsISupports)) {
				return this;
			}
			throw Components.results.NS_NOINTERFACE;
		}
	};


	function CCIN(cName, ifaceName) {
		return Cc[cName].createInstance(Ci[ifaceName]);
	}


	function preparseListener() {
		this.intercept = false;
		this.receivedData = [];
	}

	preparseListener.prototype.isJavascript = function(subject) {
		try {
			this.html = this.avif = false;

			if (subject instanceof Components.interfaces.nsIHttpChannel) {
				var contentType = subject.getResponseHeader("Content-Type");
				if (contentType == null) {
					return false;
				}

				if (contentType.startsWith("text/html")) {
					this.html = true;
					return true;
				}

				if (contentType.startsWith("image/avif")) {
					this.avif = true;
					subject.contentType = "image/bmp";
					return true;
				}

				return contentTypes.some(c => contentType.includes(c));
			}
		} catch (err) {
			// ignore
		}

		return false;
	};

	preparseListener.prototype.onDataAvailable = function(request, context, inputStream, offset, count) {
		if (this.intercept) {
			var binaryInputStream = CCIN("@mozilla.org/binaryinputstream;1", "nsIBinaryInputStream");
			binaryInputStream.setInputStream(inputStream);
			var data;
			if (this.avif) {
				data = new ArrayBuffer(count);
				binaryInputStream.readArrayBuffer(count, data);
			} else {
				data = binaryInputStream.readBytes(count);
			}
			this.receivedData.push(data);
		} else {
			try {
				this.originalListener.onDataAvailable(request, context, inputStream, offset, count);
			} catch (err) {
				request.cancel(err.result);
			}
		}
	};

	preparseListener.prototype.onStartRequest = function(request, context) {
		this.intercept = this.isJavascript(request);
		try {
			this.originalListener.onStartRequest(request, context);
		} catch (err) {
			request.cancel(err.result);
		}
	};

	preparseListener.prototype.spawnWorker = function(request, context, statusCode) {
		var new_js;
		var t = this;
		if (t.avif) {
			if (t.receivedData.length) {
				try {
					var worker = new preparse.worker("chrome://preparse/content/avif.js");
					worker.postMessage({type: "avif", data: t.receivedData}, t.receivedData);
					worker.onmessage = function onmessage(event) {
						if (event.data.type == "avif") {
							decodeMov(event.data.data, t.browser._contentWindow)
							.then(bmp => worker.postMessage({type: "bmp", ...bmp}, [bmp.data]))
							.catch(err => worker.postMessage({type: "err", data: err}));
						} else /* ("bmp" or "err") */ {
							new_js = event.data.data;
							write();
						}
					}
				} catch (e) {
					console.error("[preparse] AVIF worker failed", e);
					new_js = "";
				}
			} else {
				new_js = "";
			}
		} else {
			new_js = preparseWorker(request, t);
			if (t.activate) {
				setActive(t.cfg, true);
				delete t.activate;
			}
		}
		t.receivedData = null;
		if (new_js !== undefined) {
			write();
		}

		function write() {
			var storageStream = CCIN("@mozilla.org/storagestream;1", "nsIStorageStream");
			storageStream.init(8192, new_js.length, null);
			if (new_js.length) {
				var os = storageStream.getOutputStream(0);
				if (t.avif) {
					var binaryStream = CCIN("@mozilla.org/binaryoutputstream;1", "nsIBinaryOutputStream");
					binaryStream.setOutputStream(os);
					binaryStream.writeByteArray(new_js, new_js.length);
					binaryStream.close();
				} else {
					os.write(new_js, new_js.length);
				}
				os.close();
			}

			try {
				t.originalListener.onDataAvailable(request, context, storageStream.newInputStream(0), 0, new_js.length);
			} catch (err) {
				// ignore .. this is after onStopRequest.. so there is not much we can do..
			}

			try {
				t.originalListener.onStopRequest(request, context, statusCode);
			} catch (err) {
				// ignore .. this is after onStopRequest.. so there is not much we can do..
			}
		}
	};

	preparseListener.prototype.onStopRequest = function(request, context, statusCode) {
		if (this.intercept) {
			this.spawnWorker(request, context, statusCode);
		} else {
			try {
				this.originalListener.onStopRequest(request, context, statusCode);
			} catch (err) {
				// ignore
			}
		}
	};

	preparseListener.prototype.QueryInterface = function(aIID) {
		if (aIID.equals(Ci.nsIStreamListener) || aIID.equals(Ci.nsISupports)) {
			return this;
		}
		throw Components.results.NS_NOINTERFACE;
	};

	prefsObserver.register();
	httpRequestObserver.register();


	// Decode AVIF data using native browser's AV1 decoder.
	function decodeMov(arr, window) {
		const blob = new window.Blob([arr], {type: "video/mp4"});
		const blobURL = window.URL.createObjectURL(blob);
		let disableAV1;
		return new Promise((resolve, reject) => {
			const vid = window.document.createElement("video");
			vid.addEventListener("loadeddata", () => {
				if (vid.mozDecodedFrames > 0) {
					resolve(vid);
				} else {
					reject("partial AV1 frame");
				}
			});
			vid.addEventListener("error", () => reject("cannot decode AV1 frame"));
			vid.muted = true;
			vid.src = blobURL;
			vid.play();
			if (!AV1enabled) {
				Services.prefs.setBoolPref("media.av1.enabled", true);
				disableAV1 = true;
			}
		}).then(vid => {
			if (disableAV1) {
				Services.prefs.setBoolPref("media.av1.enabled", false);
			}
			const c = window.document.createElement("canvas");
			const ctx = c.getContext("2d");
			c.width = vid.videoWidth;
			c.height = vid.videoHeight;
			ctx.drawImage(vid, 0, 0, c.width, c.height);
			const imgData = ctx.getImageData(0, 0, c.width, c.height);
			return {
				width: c.width,
				height: c.height,
				data: imgData.data.buffer,
			}
		}).then(res => {
			window.URL.revokeObjectURL(blobURL);
			return res;
		}, err => {
			window.URL.revokeObjectURL(blobURL);
			throw err;
		});
	}
}();
