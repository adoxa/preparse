var EXPORTED_SYMBOLS = ["preparse"];

Components.utils.import("resource://gre/modules/Services.jsm");
//Components.utils.import("resource://gre/modules/Console.jsm");


preparse = {
	windows: [],

	prefs: Services.prefs.getBranch("extensions.preparse."),

	add: function(browser, worker, cfg) {
		var state = cfg?.state ?? this.prefs.getCharPref("initstate");
		this.windows.push({
			browser, worker,
			cfg: {
				state,
				active: cfg?.active ?? state == "on",
				reload: false,
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
		},

		QueryInterface: function(aIID) {
			if (aIID.equals(Ci.nsIObserver) || aIID.equals(Ci.nsISupports)) {
				return this;
			}
			throw Components.results.NS_NOINTERFACE;
		}
	};


	function setActive(cfg, active) {
		if (cfg.active != active) {
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
					subject.QueryInterface(Ci.nsITraceableChannel);
					subject.QueryInterface(Ci.nsIHttpChannel);

					var context = this.getContext(this.getWindowFromChannel(subject));
					if (!context) {
						return;
					}

					var listen = context.cfg.active ||
								 (context.cfg.state != "off" &&
								  subject.contentType.startsWith("image/avif"));
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
								context.cfg.reload = false;
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
						setActive(context.cfg, context.cfg.state == "on");
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
		var worker;
		if (this.avif) {
			worker = new this.worker("chrome://preparse/content/avif.js");
			worker.postMessage({type: "avif", data: this.receivedData}, this.receivedData);
		} else {
			worker = new this.worker("chrome://preparse/content/worker.js");
			worker.postMessage([this.receivedData, this.html, this.cfg.importmap]);
		}
		this.receivedData = null;

		var t = this;
		var onMessage = function(event) {
			var new_js = "";
			if (t.avif) {
				if (event.data.type == "avif") {
					decodeMov(event.data.data, t.browser._contentWindow)
					.then(bmp => worker.postMessage({type: "bmp", ...bmp}, [bmp.data]))
					.catch(err => worker.postMessage({type: "err", data: err}));
					return;
				} else /* ("bmp" or "err") */ {
					new_js = event.data.data;
				}
			} else {
				new_js = event.data[0];
				if (request.isMainDocumentChannel) {
					new_js = checkCharset(new_js);
					new_js = addPolyfills(new_js);
					// Special case: allow Google to work without Javascript.
					if (request.URI.host.includes("google")) {
						new_js = googleNoscript(new_js);
					}
					if (!t.cfg.active) {
						if (event.data[1]	// has an import map
							|| new_js.includes('generator" content="Discourse')) {
							setActive(t.cfg, true);
						}
					}
				}
				if (event.data[1]) {
					t.cfg.importmap = event.data[1];
					for (let i in t.cfg.importmap) {
						let imp = t.cfg.importmap[i];
						if (!(imp[0] == "/" || /^\w+:/.test(imp))) {
							let path = request.URI.filePath;
							if (!path.endsWith("/")) {
								path += "/../";
							}
							t.cfg.importmap[i] = path + imp;
						}
					}
					new_js = new_js.replace("[[IMPORTMAP]]", JSON.stringify(t.cfg.importmap));
				}
			}
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
		};
		worker.onmessage = onMessage;
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
		}).then(vid => {
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


	// The meta charset value must be within the first 1024 bytes, otherwise
	// the page will reload.  With my own reload activation that causes an
	// infinite loop (since I reset the reload flag immediately).  Copy the tag
	// immediately after head (assuming that to be within range).
	function checkCharset(html) {
		let charset = /<meta [^>]*charset=[^>]+>/i.exec(html);
		if (charset && charset.index + charset[0].length >= 1024) {
			return html.replace(/<head[^>]*>/i, "$&" + charset[0]);
		}
		return html;
	}


	function trim(strings) {
		return strings.raw[0].replace(/\/\/.*$/gm, "").replace(/\s{2,}/g, " ");
	}


	// Google searches use a noscript tag to redirect when Javascript is
	// disabled.  Replace it so it works, with a bit of tidying up.
	function googleNoscript(html) {
		// Move the search options to where they should be (and remove the
		// script that normally does the move).
		var src = /(<div data-st-tgt="fb".*?)<script[^>]*>\(function\(\)\{var.*?frt\);\}\)\(\);<\/script><\/div>/s.exec(html);
		if (src) {
			html = html.replace(src[0], "");
			html = html.replace('data-st-cnt="fb">', `$&${src[1]}</div>`);
		}
		return html.replace(/<noscript>.*?<\/noscript>/, trim`
			<noscript>
				<style>
					g-loading-icon {
						display: none !important;
					}
				</style>
			</noscript>
		`);
	}


	function addPolyfills(html) {
		let polyfills = "";
		if (!IDBTransaction.prototype.commit) {
			polyfills += `IDBTransaction.prototype.commit ??= () => {};`;
		}
		if (!Intl.RelativeTimeFormat.prototype.formatToParts) {
			polyfills += trim`
				Intl.RelativeTimeFormat.prototype.formatToParts ??= function(value, unit) {
					let fraction = value % 1;
					value = this.format(value, unit);
					if (unit.endsWith("s")) {
						unit = unit.slice(0, -1);
					}
					let parts = value.split(/(\d+)/).map(p => ({
						type: /\d/.test(p[0]) ? "integer" : "literal",
						value: p
					}));
					for (let i = parts.length; --i >= 0;) {
						if (parts[i].type == "integer") {
							if (fraction) {
								parts[i].type = "fraction";
								fraction = false;
							}
							parts[i].unit = unit;
						} else if (parts[i+1]?.type == "fraction") {
							parts[i].type = "decimal";
							parts[i].unit = unit;
						} else if (parts[i-1]?.type == "integer" && parts[i+1]?.type == "integer") {
							parts[i].type = "group";
							parts[i].unit = unit;
						}
					}
					return parts;
				};
			`;
		}
		try {
			new Intl.NumberFormat(undefined, {
				style: "currency", currency: "USD", currencyDisplay: "narrowSymbol"
			});
		} catch (e) {
			polyfills += trim`
				if (!Intl.NumberFormat.makeNarrow) {
					Intl.NumberFormat = class extends Intl.NumberFormat {
						constructor(locales, options) {
							let narrow;
							if (options?.currencyDisplay == "narrowSymbol") {
								options.currencyDisplay = "symbol";
								narrow = true;
							}
							super(locales, options);
							this.narrow = narrow;
						}
						static makeNarrow(fmt) {
							// There's "Cg." for Caribbean guilder.
							let narrow = fmt.replace(/^[\sA-Za-z.]*/, "");
							if (/\D/.test(narrow[0])) {
								return narrow;
							}
							return fmt;
						}
						format(number) {
							let result= super.format(number);
							if (this.narrow) {
								return Intl.NumberFormat.makeNarrow(result);
							}
							return result;
						}
						formatToParts(number) {
							let parts = super.formatToParts(number);
							if (this.narrow) {
								parts[0].value = Intl.NumberFormat.makeNarrow(parts[0].value);
							}
							return parts;
						}
					};
				}
			`;
		}
		if (preparse.replaceSync) {
			polyfills += trim`
				CSSStyleSheet.prototype.replaceSync ??= function(css) {
					while (this.cssRules.length) {
						this.deleteRule(0);
					}
					try {
						this.insertRule(css, this.cssRules.length);
						return;
					} catch (e) {
						// assume multiple rules
					}
					css = css.replace('@charset "UTF-8";', '');
					let start = 0;
					while (start < css.length) {
						let end = rule(start);
						try {
							this.insertRule(css.slice(start, end), this.cssRules.length);
						} catch (e) {
						  // ignore it
						}
						start = end;
					}
					function rule(start) {
						// Braces tend to be balanced, even in quotes & comments, so keep it simple.
						let braces = 0;
						while (css[start] !== undefined) {
							if (css[start] == '{') {
								++braces;
							} else if (css[start] == '}') {
								if (--braces == 0) {
								  return start + 1;
								}
							}
							++start;
						}
						return start;
					}
				};
				// If replaceSync exists, adoptedStyleSheets is also expected.
				if (!Element.prototype._pp_attachShadow) {
					Element.prototype._pp_attachShadow = Element.prototype.attachShadow;
					Element.prototype.attachShadow = function(options) {
						const shadow = this._pp_attachShadow(options);
						shadow.adoptedStyleSheets = [];
						return shadow;
					};
					document.adoptedStyleSheets = [];
				}
			`;
		}
		// Make it the first script (if there is no script then it's not necessary).
		html = html.replace(/(\s*)<script/i, `\
$1<!--Preparse begin-->\
$1<script>setTimeout(()=>{${polyfills}},1)</script>\
$1<!--Preparse end-->$&`);
		return html;
	}
}();
