var EXPORTED_SYMBOLS = ["preparse"];

//Components.utils.import("resource://gre/modules/Console.jsm");

preparse = {
	windows: [],
	
	add: function(browser, worker) {
		this.windows.push({browser: browser, cfg: {active: false}, worker: worker});
	},
	
	getConfig: function(browser) {
		for (var i = 0; i < this.windows.length; ++i) {
			if (this.windows[i].browser == browser) {
				return this.windows[i].cfg;
			}
		}
	},
	
	remove: function(browser) {
		/* when tabs are migrated we get a TabOpen followed by a TabClose */
		for (var i = 0; i < this.windows.length; ++i) {
			if (this.windows[i].browser == browser) {
				this.windows.splice(i, 1);
				break;
			}
		}
	}
};

var pp = function() {

	const Cc = Components.classes;
	const Ci = Components.interfaces;
	
	var contentTypes = ["text/javascript", "application/javascript", "application/x-javascript"];
	
		
	var prefsObserver = {
		observe: function(subject, topic, data) {
			if (topic != "nsPref:changed") {
				return;
			}
			
			if (data == "contenttypes") {
				this.updateContentTypes();
			}
		},
		
		updateContentTypes: function() {
			var str = this.prefs.getCharPref("contenttypes");
			if (str == null) {
				return;
			}
			
			contentTypes = str.split(",");
		},
		
		register: function() {
			this.prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService).getBranch("extensions.preparse.");
			this.prefs.QueryInterface(Components.interfaces.nsIPrefBranch2);
			this.prefs.addObserver("", this, false);
			this.updateContentTypes();
		},
		
		QueryInterface: function(aIID) {
			if (aIID.equals(Ci.nsIObserver) ||
				aIID.equals(Ci.nsISupports))
			{
				return this;
			}
	
			throw Components.results.NS_NOINTERFACE;
		}
	};
	
	var httpRequestObserver = {
		observe: function(subject, topic, data) {
			if ((topic == 'http-on-examine-response' || topic == 'http-on-examine-cached-response')) {
				if (subject instanceof Ci.nsIHttpChannel) {
					subject.QueryInterface(Ci.nsITraceableChannel);
					subject.QueryInterface(Ci.nsIHttpChannel);
					
					var context = this.getContext(this.getWindowFromChannel(subject));

					if (context?.cfg.active) {
						if (subject.isMainDocumentChannel) {
							delete context.cfg.importmap;
						}
						var newListener = new preparseListener(context.cfg);
						newListener.worker = context.worker;
						newListener.originalListener = subject.setNewListener(newListener);
					}
				}
			}
		},
		
		getWindowFromChannel: function(aChannel) {
			var ctx = this.getLoadContext(aChannel);
			if (ctx) {
				try {
					return ctx.associatedWindow;
				}
				catch (e) { }
			}
			
			return null;
		},
		
		getContext: function(win)
		{
			for (; win; win = win.parent) {
				for (var i = 0; i < preparse.windows.length; ++i) {
					var entry = preparse.windows[i];
					if (entry.browser.contentWindow == win) {
						return entry;
					}
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
			var observerService = Cc["@mozilla.org/observer-service;1"]
				.getService(Ci.nsIObserverService);

			observerService.addObserver(this,
				"http-on-examine-cached-response", false);
			observerService.addObserver(this,
				"http-on-examine-response", false);
		},
		
		QueryInterface: function(aIID) {
			if (aIID.equals(Ci.nsIObserver) ||
				aIID.equals(Ci.nsISupports))
			{
				return this;
			}
	
			throw Components.results.NS_NOINTERFACE;
		}
	};
	
	
	function CCIN(cName, ifaceName) {
    	return Cc[cName].createInstance(Ci[ifaceName]);
	}


	function preparseListener(cfg) {
		this.cfg = cfg;
		this.intercept = false;
		this.receivedData = [];
	}
	
	preparseListener.prototype.isJavascript = function(subject) {
		try {
			this.html = false;

			if (subject instanceof Components.interfaces.nsIHttpChannel) {
				var contentType = subject.getResponseHeader("Content-Type");
				if (contentType == null) {
					return false;
				}

				if (contentType.startsWith("text/html")) {
					this.html = true;
					return true;
				}

				for (var i = 0; i < contentTypes.length; ++i) {
					if (contentType.includes(contentTypes[i])) {
						return true;
					}
				}

				return false;
			}
		} catch (err) {
			// ignore
		}

		return false;
	};
		
	preparseListener.prototype.onDataAvailable = function(request, context, inputStream, offset, count) {
		if (this.intercept) {
			var binaryInputStream = CCIN("@mozilla.org/binaryinputstream;1",
					"nsIBinaryInputStream");
	
			binaryInputStream.setInputStream(inputStream);
			var data = binaryInputStream.readBytes(count);
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
		var worker = new this.worker("chrome://preparse/content/worker.js");
		worker.postMessage([this.receivedData, this.html, this.cfg.importmap]);
		this.receivedData = null;
		
		var t = this;
		var onMessage = function(event) {
			var new_js = event.data[0];
			if (request.isMainDocumentChannel) {
				new_js = addPolyfills(new_js);
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
			var storageStream = CCIN("@mozilla.org/storagestream;1", "nsIStorageStream");
			storageStream.init(8192, new_js.length, null);
			if (new_js.length) {
				var os = storageStream.getOutputStream(0);
				os.write(new_js, new_js.length);
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
			if (aIID.equals(Ci.nsIStreamListener) ||
				aIID.equals(Ci.nsISupports))
			{
				return this;
			}
			throw Components.results.NS_NOINTERFACE;
	};
	
	prefsObserver.register();
	httpRequestObserver.register();


	function raw(strings) {
		return strings.raw[0];
	}

	function addPolyfills(html) {
		let polyfills = "";
		if (!IDBTransaction.prototype.commit) {
			polyfills += `IDBTransaction.prototype.commit = () => {};`;
		}
		if (!Intl.RelativeTimeFormat.prototype.formatToParts) {
			polyfills += raw`
				Intl.RelativeTimeFormat.prototype.formatToParts = function(value, unit) {
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
			polyfills += raw`
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
			`;
		}
		// Place it before the first script, to prevent moving a possible
		// charset definition too far from the start (if there is no script
		// then it's not necessary).
		return html.replace("<script", `<script>${polyfills}</script>$&`);
	}
}();
