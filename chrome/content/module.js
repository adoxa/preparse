var EXPORTED_SYMBOLS = ["preparse"];


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
						var newListener = new preparseListener();
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


	function preparseListener() {
		this.intercept = false;
		this.receivedData = [];
	}
	
	preparseListener.prototype.isJavascript = function(subject) {
		try {
			this.html = false;

			if (subject instanceof Components.interfaces.nsIHttpChannel) {
				//Components.utils.import("resource://gre/modules/Console.jsm");
				//console.log(subject.URI.path);
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
		worker.postMessage([this.receivedData, this.html, preparse.importmap]);
		this.receivedData = null;
		
		var t = this;
		var onMessage = function(event) {
			if (event.data[1]) {
				preparse.importmap = event.data[1];
				for (let i in preparse.importmap) {
					let imp = preparse.importmap[i];
					if (!(imp.startsWith("http") || imp[0] == "/")) {
						let path = request.URI.filePath;
						if (!path.endsWith("/")) {
							path += "/../";
						}
						preparse.importmap[i] = path + imp;
					}
				}
			}
			var new_js = event.data[0];
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
}();
