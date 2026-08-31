(function() {
	Components.utils.import("resource://preparse_js/module.js");

	function selected_config() {
		var browser = gBrowser.selectedBrowser;
		if (browser != null) {
			return preparse.getConfig(browser);
		}
		return null;
	}

	function update_text() {
		var enabled = get_enabled();
		update_status_text(enabled);
		update_menu(enabled);
	}

	function get_enabled() {
		var cfg = selected_config();
		return cfg == null ? false : cfg.active;
	}

	function update_menu(enabled) {
		document.getElementById("enable_preparse").setAttribute("checked", enabled ? "true" : "false");
		document.getElementById("disable_preparse").setAttribute("checked", enabled ? "false" : "true");
	}

	function update_status_text(enabled) {
		document.getElementById("preparseStatus").label = enabled ? "# ON" : "# OFF";
	}

	function toggle() {
		var cfg = selected_config();
		if (cfg != null) {
			cfg.active = !cfg.active;
			update_text();
		}
	}

	function set_active(active) {
		var cfg = selected_config();
		if (cfg != null) {
			cfg.active = active;
			update_text();
		}
	}

	function disable() {
		set_active(false);
	}

	function enable() {
		set_active(true);
	}

	function load() {
		hookup_tabs();
		document.getElementById("preparseStatus").addEventListener("click", toggle, false);
		document.getElementById("enable_preparse").addEventListener("command", enable, false);
		document.getElementById("disable_preparse").addEventListener("command", disable, false);
		update_text();
	}

	function unload() {
		var container = gBrowser.tabContainer;
		container.childNodes.forEach(c => preparse.remove(gBrowser.getBrowserForTab(c)));
		container.removeEventListener("TabOpen", tabOpen, false);
		container.removeEventListener("TabClose", tabClose, false);
		container.removeEventListener("TabSelect", tabSelect, false);
	}

	function tabOpen(event) {
		var browser = gBrowser.getBrowserForTab(event.target);
		preparse.add(browser, window.Worker);
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

	window.addEventListener("load", load, false);
	window.addEventListener("unload", unload, false);
})();
