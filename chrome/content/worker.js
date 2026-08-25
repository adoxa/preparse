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

	// Provide import.meta.resolve, if necessary.
	if (new_script.includes("import.meta.resolve")) {
		let use_map = importmap ? "u=window.importmap[u]||u;" : "";
		new_script = `import.meta.resolve=function(u){${use_map}return new URL(u,import.meta.url).href};` + new_script;
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
