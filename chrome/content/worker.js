var EXPORTED_SYMBOLS = ["preparseWorker", "GHWORKER"];

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/Console.jsm");

const GHWORKER = "https://github.com/assets-cdn/worker/";


function preparseWorker(request, listener) {
	var importmap = listener.cfg.importmap;
	var old_js = listener.receivedData.join("");
	var new_js = old_js;
	try {
		if (listener.html) {
			function process(match, tag, script, tag_close) {
				tag = tag.replaceAll("integrity", "no-integrity");
				if (tag.includes("importmap")) {
					importmap = JSON.parse(script).imports;
					for (let i in importmap) {
						let imp = importmap[i];
						if (!(imp[0] == "/" || /^\w+:/.test(imp))) {
							let path = request.URI.filePath;
							if (!path.endsWith("/")) {
								path += "/../";
							}
							importmap[i] = path + imp;
						}
					}
					listener.cfg.importmap = importmap;
					script = "window.importmap = " + JSON.stringify(importmap);
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
				if (request.URI?.spec.startsWith(GHWORKER)) {
					// GitHub uses module workers, replace with script import.
					// The script checks performance, which isn't available to
					// the worker, provide it.
					let imp = /^import ('.*')$/.exec(new_js)?.[1];
					if (imp) {
						new_js = `const performance={mark:()=>{}};importScripts(${imp})`;
					}
				}
			}
		}
		if (request.isMainDocumentChannel) {
			try {
				Services.scriptloader.loadSubScript("chrome://preparse/content/polyfills.js", listener.browser._contentWindow);
			} catch (e) {
				console.error("[preparse] load polyfills failed", e);
			}
			new_js = checkCharset(new_js);
			// Special case: allow Google to work without Javascript.
			if (request.URI.host.includes("google")) {
				new_js = googleNoscript(new_js);
			}
			if (!listener.cfg.active) {
				if (importmap || new_js.includes('generator" content="Discourse')) {
					listener.activate = true;
				}
			}
		}
	} catch (e) {
		console.error(e);
	}

	return new_js;
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
	if (classes.length) {
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
		script = new_script.join("");
	}

	// Provide import.meta.resolve, if necessary.
	if (importmeta && script.includes("import.meta.resolve")) {
		let use_map = importmap ? "u=window.importmap?.[u]||u;" : "";
		script = `import.meta.resolve=function(u){${use_map}return new URL(u,import.meta.url).href};` + script;
	}

	return script;
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
			new_script.push(script.slice(start, pos + 1), id);
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
	var src = /(<div data-st-tgt="fb".*?)<script[^>]*>\(function\(\)\{var.*?tor\);\}\)\(\);<\/script><\/div>/s.exec(html);
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
