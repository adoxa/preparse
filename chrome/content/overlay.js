(function() {
	Components.utils.import("resource://preparse_js/module.js");

	var domain_match, domain_pref;

	// CSSStyleSheet is not available to the module.
	if (!CSSStyleSheet.prototype.replaceSync) {
		preparse.replaceSync = true;
	}

	function selected_config() {
		var browser = gBrowser.selectedBrowser;
		if (browser != null) {
			return preparse.getConfig(browser);
		}
		return null;
	}

	function update_text() {
		var enabled = get_enabled();
		update_status_text(enabled[0], enabled[1]);
		update_menu(enabled[0]);
	}

	function get_enabled() {
		var cfg = selected_config();
		return cfg == null ? [false, false] : [cfg.active, cfg.state];
	}

	function update_menu(enabled) {
		document.getElementById("enable_preparse").setAttribute("checked", enabled ? "true" : "false");
		document.getElementById("disable_preparse").setAttribute("checked", enabled ? "false" : "true");
	}

	function update_status_text(enabled, state) {
		var str = `# ${enabled ? "ON" : "OFF"}`;
		if (state != "auto" && (state == "on") == enabled) {
			str += "!";
		}
		document.getElementById("preparseStatus").label = str;
		str = `Preparse ${state == "auto" ? "Auto" : state == "on" ? "On" : "Off"}`;
		document.getElementById("preparseStatus").setAttribute("tooltiptext", str);
	}

	function update_status_show() {
		var collapsed = !preparse.prefs.getBoolPref("showstate");
		document.getElementById("preparseStatus").collapsed = collapsed;
	}

	function toggle(event) {
		var cfg = selected_config();
		if (cfg != null) {
			if (event.button == 2) {
				var menu = document.getElementById("preparse-domain-item");
				if (menu && cfg.domain) {
					menu.setAttribute("disabled", false);
					var label;
					var domains = preparse.prefs.getCharPref("domains").toLowerCase();
					var re = new RegExp(`(?:^|,)${cfg.domain.replaceAll(".", "\\.")}(?=,|$)`);
					domain_match = re.exec(domains);
					if (domain_match) {
						domain_pref = "domains";
						label = `Remove '${cfg.domain}' from always on`;
					} else {
						domains = preparse.prefs.getCharPref("domains_off").toLowerCase();
						domain_match = re.exec(domains);
						if (domain_match) {
							domain_pref = "domains_off";
							label = `Remove '${cfg.domain}' from always off`;
						} else {
							label = `Add '${cfg.domain}' to always ${cfg.active ? "on" : "off"}`;
							domain_pref = cfg.active ? "domains" : "domains_off";
						}
					}
					menu.setAttribute("label", label);
				}
				return;
			}
			cfg.active = !cfg.active;
			var state = cfg.active ? "on" : "off";
			if (preparse.prefs.getCharPref("initstate") == "auto") {
				// off -> on! -> off! -> off
				// on -> off! -> on! -> on
				if (cfg.state == "auto") {
					cfg.next_state = true;
				} else if (cfg.next_state) {
					cfg.next_state = false;
				} else {
					state = "auto";
					cfg.active = !cfg.active;
				}
			}
			cfg.state = state;
			update_text();
		}
	}

	function domainCommand() {
		var cfg = selected_config();
		var domains = preparse.prefs.getCharPref(domain_pref).toLowerCase();
		if (domain_match) {
			var len = domain_match[0].length;
			if (domain_match.index == 0) {
				++len;
			}
			domains = domains.slice(0, domain_match.index)
					  + domains.slice(domain_match.index + len);
		} else {
			if (domains != "") {
				domains += ",";
			}
			domains += cfg.domain;
		}
		preparse.prefs.setCharPref(domain_pref, domains);
	}

	function set_active(active) {
		var cfg = selected_config();
		if (cfg != null) {
			cfg.active = active;
			cfg.state = active ? "on" : "off";
			update_text();
		}
	}

	function disable() {
		set_active(false);
	}

	function enable() {
		set_active(true);
	}

	var activationObserver = {
		observe: function(subject, topic, data) {
			if (topic == "preparse-active-changed") {
				update_text();
			} else if (topic == "preparse-show-changed") {
				update_status_show();
			}
		}
	};

	function load() {
		hookup_tabs();
		document.getElementById("preparseStatus").addEventListener("click", toggle, false);
		document.getElementById("enable_preparse").addEventListener("command", enable, false);
		document.getElementById("disable_preparse").addEventListener("command", disable, false);
		update_text();
		update_status_show();
		Services.obs.addObserver(activationObserver, "preparse-active-changed", false);
		Services.obs.addObserver(activationObserver, "preparse-show-changed", false);
		var menu = document.getElementById("toolbar-context-menu");
		if (menu) {
			menu.appendChild(document.createElement("menuseparator"));
			var domainItem = document.createElement("menuitem");
			domainItem.setAttribute("id", "preparse-domain-item");
			domainItem.setAttribute("label", "Add/remove domain");
			domainItem.setAttribute("disabled", true);
			domainItem.addEventListener("command", domainCommand, false);
			menu.appendChild(domainItem);
		}
	}

	function unload() {
		var container = gBrowser.tabContainer;
		container.childNodes.forEach(c => preparse.remove(gBrowser.getBrowserForTab(c)));
		container.removeEventListener("TabOpen", tabOpen, false);
		container.removeEventListener("TabClose", tabClose, false);
		container.removeEventListener("TabSelect", tabSelect, false);
		Services.obs.removeObserver(activationObserver, "preparse-active-changed", false);
		Services.obs.removeObserver(activationObserver, "preparse-show-changed", false);
		document.getElementById("preparse-domain-item")?.remove();
	}

	function tabOpen(event) {
		var browser = gBrowser.getBrowserForTab(event.target);
		var cfg;
		if (preparse.prefs.getBoolPref("copystate")) {
			cfg = selected_config();
		}
		preparse.add(browser, window.Worker, cfg);
	}

	function tabClose(event) {
		var browser = gBrowser.getBrowserForTab(event.target);
		preparse.remove(browser);
	}

	function tabSelect(event) {
		update_text();
	}

	function hookup_tabs() {
		var container = gBrowser.tabContainer;
		if (container) {
			container.addEventListener("TabOpen", tabOpen, false);
			container.addEventListener("TabClose", tabClose, false);
			container.addEventListener("TabSelect", tabSelect, false);
			container.childNodes.forEach(c => preparse.add(gBrowser.getBrowserForTab(c), window.Worker));
		}
	}

	function error(event) {
		var cfg = selected_config();
		if (cfg?.state == "auto" && !cfg.active) {
			if (event.message.startsWith("TypeError: this['#") ||
				event.message.includes("import.meta.resolve"))
			{
				cfg.reload = cfg.active = true;
				update_text();
				event.target.location.reload();
			}
		}
	}

	window.addEventListener("load", load, false);
	window.addEventListener("unload", unload, false);
	window.addEventListener("error", error, false);
})();
