onmessage = function(event) {
	var old_js = event.data[0].join("");
	var new_js = old_js;
	var importmap = event.data[2];
	var imports;
	try {
		if (event.data[1]) { // html
			function process(match, tag, script) {
				tag = tag.replaceAll("integrity", "no-integrity");
				script = script.trim();
				if (tag.includes("importmap")) {
					imports = importmap = JSON.parse(script).imports;
					script = "window.importmap = [[IMPORTMAP]]";
					tag = tag.replace("importmap", "");
				} else if (script.length) {
					script = rename(script, importmap);
				}
				return tag + script + "</script>";
			}
			new_js = old_js.replaceAll(/(<script.*?>)(.*?)<\/script>/gs, process);
		} else {
			// Discourse's browser-detect.
			if (old_js.startsWith("/* eslint-disable no-var */") && old_js.includes("!check")) {
				new_js = old_js.replaceAll("window.unsupportedBrowser = true", "");
			} else {
				new_js = rename(old_js, importmap);
			}
		}
	} catch (e) {
		console.error(e);
	}

	postMessage([new_js, imports]);
	this.close();
}


function rename(script, importmap) {
	if (importmap) {
		function map_import(match, quote, name) {
			if (name in importmap)
				return `from${quote}${importmap[name]}${quote}`;
			return match;
		}
		script = script.replaceAll(/from\s*(['"])(.*?)\1/g, map_import);
	}

	// Prefix private elements from extended classes with the new class name.
	// E.g. "class Y extends X { #e }" becomes "#Y_e".  It doesn't do a syntax
	// scan, only detecting one or two characters after a hash, with a symbol
	// after that.	That should eliminate RGB colors (needing three characters)
	// and hopefully ids won't be matched.
	let classes = Array.from(script.matchAll(/([$\w]+)\s*=\s*(?:[$\w]+\))?class(?: [$\w]+)? extends|class ([$\w]+) extends/g));
	let new_script = script.slice(0, classes[0]?.index);
	for (let i = 0; i < classes.length; ++i) {
		let id = classes[i][1] || classes[i][2];
		let start = classes[i].index;
		let end = region(script, start);
		new_script += script.slice(start, end).replace(/#([$a-zA-Z_][$\w]?\W)/g, `#${id}_$1`);
		// Skip nested classes.
		while (end > classes[i+1]?.index) {
			++i;
		}
		new_script += script.slice(end, classes[i+1]?.index);
	}

	// If ".commit()" occurs, add a stub for IDBTransaction, should it be that.
	if (!IDBTransaction.prototype.commit && new_script.includes(".commit()")) {
		new_script = 'IDBTransaction.prototype.commit=()=>{};' + new_script;
	}

	// Provide import.meta.resolve, if necessary.
	if (new_script.includes("import.meta.resolve")) {
		let use_map = importmap ? "u=window.importmap[u]||u;" : "";
		new_script = `import.meta.resolve=function(u){${use_map}return new URL(u,import.meta.url).href};` + new_script;
	}

	function raw(strings) {
		return strings.raw[0];
	}

	// Provide RelativeTimeFormat.formatToParts, if assumed necessary.
	if (!Intl.RelativeTimeFormat.prototype.formatToParts && new_script.includes(".formatToParts")) {
		new_script = raw`
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
		` + new_script;
	}

	// If "narrowSymbol" occurs, provide it for Intl.NumberFormat.
	if (new_script.includes("narrowSymbol")) {
		let unsupported;
		try {
			new Intl.NumberFormat(undefined, {
				style: "currency", currency: "USD", currencyDisplay: "narrowSymbol"
			});
		} catch (e) {
			unsupported = true;
		}
		if (unsupported) {
			new_script = raw`
				if (!window.PP_Intl_NumberFormat) {
					class PP_Intl_NumberFormat extends Intl.NumberFormat {
						constructor(locales, options) {
							let narrow;
							if (options?.currencyDisplay == "narrowSymbol") {
								options.currencyDisplay = "symbol";
								narrow = true;
							}
							super(locales, options);
							this.narrow = narrow;
						}
						format(number) {
							let result= super.format(number);
							if (this.narrow) {
								result = result.replace(/^\w*/, "");
							}
							return result;
						}
						formatToParts(number) {
							let parts = super.formatToParts(number);
							if (this.narrow) {
								parts[0].value = parts[0].value.replace(/^\w*/, "");
							}
							return parts;
						}
					}
					Intl.NumberFormat = PP_Intl_NumberFormat;
				}
			` + new_script;
		}
	}

	return new_script;
}


// Return the index of the closing brace that matches the one after start.
function region(script, start) {
	// Braces tend to be balanced, even in quotes & comments, so keep it simple.
	let braces = 0;
	while (script[start] !== undefined) {
		if (script[start] == '{') {
			++braces;
		} else if (script[start] == '}') {
			if (--braces == 0) {
				break;
			}
		}
		++start;
	}
	return start;
}
