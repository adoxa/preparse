onmessage = function(event) {
	var old_js = event.data[0].join("");
	var new_js = old_js;
	var importmap = event.data[2];
	var imports;
	try {
		if (event.data[1]) { // html
			function process(match, tag, script, tag_close) {
				tag = tag.replaceAll("integrity", "no-integrity");
				if (tag.includes("importmap")) {
					imports = importmap = JSON.parse(script).imports;
					script = "window.importmap = [[IMPORTMAP]]";
					tag = tag.replace("importmap", "");
				} else if (script.length) {
					script = rename(script, importmap, false);
				}
				return tag + script + tag_close;
			}
			new_js = old_js.replaceAll(/(<script.*?>)(.*?)(<\/script>)/gis, process);
			new_js = addTableFormIds(new_js);
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


function rename(script, importmap, importmeta=true) {
	if (importmap) {
		function map_import(match, kw, quote, name) {
			let importname;
			if (name in importmap) {
				importname = importmap[name];
			} else if (name.startsWith("./")) {
				const base = name.slice(2);
				for (const imp in importmap) {
					if (imp.endsWith(base)) {
						importname = importmap[imp];
						break;
					}
				}
			} else {
				for (const imp in importmap) {
					if (name.startsWith(imp)) {
						importname = name.replace(imp, importmap[imp]);
						break;
					}
				}
			}
			if (importname)
				return `${kw}${quote}${importname}${quote}`;
			return match;
		}
		script = script.replaceAll(/(from|import)\s*(['"])(.*?)\2/g, map_import);
		if (/\bimport\(/.test(script)) {
			function trim(strings) {
				return strings.raw[0].replace(/\/\/.*$/gm, "").replace(/\s{2,}/g, " ");
			}
			script = trim`function importPP(name) {
				if (window.importmap && typeof name == "string" && !/^https?:/.test(name)) {
					if (name in window.importmap) {
						name = window.importmap[name];
					} else if (name.startsWith("./")) {
						const base = name.slice(2);
						for (const imp in window.importmap) {
							if (imp.endsWith(base)) {
								name = window.importmap[imp];
								break;
							}
						}
					} else {
						for (const imp in window.importmap) {
							if (name.startsWith(imp)) {
								name = name.replace(imp, window.importmap[imp]);
								break;
							}
						}
					}
				}
				return import(name);
			}` + script.replaceAll(/\bimport\(/g, "importPP(");
		}
	}

	// Prefix private elements from extended classes with the new class name.
	// E.g. "class Y extends X { #e }" becomes "#Y_e".
	let classes = Array.from(script.matchAll(/[^$\w]([$\w]+)\s*=\s*(?:[$\w]+\))?class(?: [$\w]+)? extends|class ([$\w]+) extends/g));
	let new_script = [script.slice(0, classes[0]?.index)];
	for (let i = 0; i < classes.length; ++i) {
		let id = (classes[i][1] || classes[i][2]) + "_";
		let start = classes[i].index;
		let end = privateRename(script, start, id, new_script);
		// Skip nested classes.
		while (end > classes[i+1]?.index) {
			++i;
		}
		new_script.push(script.slice(end, classes[i+1]?.index));
	}
	new_script = new_script.join("");

	// Provide import.meta.resolve, if necessary.
	if (importmeta && new_script.includes("import.meta.resolve")) {
		let use_map = importmap ? "u=window.importmap?.[u]||u;" : "";
		new_script = `import.meta.resolve=function(u){${use_map}return new URL(u,import.meta.url).href};` + new_script;
	}

	return new_script;
}


// Return the index of the closing brace that matches the opening one after pos,
// prefixing private elements as we go.
function privateRename(script, pos, id, new_script) {
	let ch, braces = 0, instring = false, intemplate = false;
	let start = pos;
	while ((ch = script[pos]) !== undefined) {
		if (instring) {
			if (ch == instring) {
				instring = false;
			} else if (ch == '\\') {
				++pos;
			}
		} else if (ch == "'" || ch == '"') {
			instring = ch;
		} else if (intemplate) {
			if (ch == "`") {
				intemplate = false;
			} else if (ch == '$' && script[pos+1] == '{') {
				new_script.push(script.slice(start, pos));
				start = pos = privateRename(script, pos, id, new_script);
			} else if (ch == '\\') {
				++pos;
			}
		} else if (ch == "`") {
			intemplate = true;
		} else if (ch == '/') {
			let block = script[pos+1] == '*';
			if (block || script[pos+1] == '/') {
				pos = script.indexOf(block ? "*/" : '\n', pos + 2);
				if (pos == -1) {
					pos = script.length;
				} else if (block) {
					++pos;
				}
			} else {
				// Assume a regex if the previous character is '('
				// (function or comparison), '=' (assignment or comparison) or
				// '!' (comparison).
				let prev = pos;
				while (--prev > 0 && /\s/.test(script[prev])) ;
				if ("(=!".includes(script[prev])) {
					instring = ch;
				}
			}
		} else if (ch == '{') {
			++braces;
		} else if (ch == '}') {
			if (--braces == 0) {
				break;
			}
		} else if (ch == '#') {
			new_script.push(script.slice(start, pos + 1));
			new_script.push(id);
			start = pos + 1;
		}
		++pos;
	}
	new_script.push(script.slice(start, pos));
	return pos;
}


// Ensure forms inside tables have an id and use that id for the form elements.
function addTableFormIds(html) {
	let table, form, element;
	let tables, forms = 0, start = 0, new_html = [];
	const reTable = /<table\b/gi;
	const reForm = /<form\b([^>]*)|<\/?table\b/gi;
	const reElement = /<(?:button|fieldset|input|object|output|select|textarea)\b([^>]*)|<\/form\b/gi;
	while ((table = reTable.exec(html))) {
		tables = 1;
		reForm.lastIndex = reTable.lastIndex;
		while ((form = reForm.exec(html))) {
			tag = form[0][1].toLowerCase();
			if (tag == "t") {
				++tables;
			} else if (tag == "/") {
				if (--tables == 0) {
					break;
				}
			} else /* tag == "f" */ {
				let id = /\bid\s*=\s*((['"])?[-\w]+\2)/i.exec(form[0])?.[1];
				if (!id) {
					++forms;
					id = "ppform" + forms;
					new_html.push(html.slice(start, form.index + 5), " id=", id);
					start = form.index + 5;
				}
				reElement.lastIndex = reForm.lastIndex;
				while ((element = reElement.exec(html))) {
					if (element[0][1] == "/") {
						reForm.lastIndex = reElement.lastIndex;
						break;
					}
					if (!/\bform\s*=/i.test(element[1])) {
						let end = element.index + element[0].length;
						new_html.push(html.slice(start, end), " form=", id);
						start = end;
					}
				}
			}
		}
		if (reForm.lastIndex == 0) {
			break;
		}
		reTable.lastIndex = reForm.lastIndex;
	}
	if (start == 0) {
		return html;
	}
	new_html.push(html.slice(start));
	return new_html.join("");
}
