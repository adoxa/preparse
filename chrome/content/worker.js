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
			new_js = moveTableForm(new_js);
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
		let use_map = importmap ? "u=window.importmap[u]||u;" : "";
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


/*
  Move a FORM outside of a TABLE:

    <table>...<form>...</form>...</table>

  becomes:

    <form><table>.........</table></form>

  and inside a TD:

	<form><td>...</td></form>

  becomes:

	<td><form>...</form></td>
*/
function moveTableForm(html) {
	html = moveTags(html, "table", "form", "table|form");
	return moveTags(html, "form", "td", "form|tr|td");
}


function moveTags(html, outer_tag, inner_tag, search_tags) {
	let re = new RegExp(`<(/?(?:${search_tags}))\\b[^>]*>\\s*`, "gi");
	let tags = Array.from(html.matchAll(re)).map(t => (t.tag = t[1].toLowerCase(), t));
	// Remove outer tags that don't have inner.
	for (let i = tags.length; --i > 0;) {
		if (tags[i].tag == "/" + outer_tag && tags[i-1].tag == outer_tag) {
			tags.splice(i - 1, 2);
			if (i > tags.length) {
				--i;
			}
		}
	}
	for (let i = 0; i < tags.length - 3; ++i) {
		if (tags[i].tag == outer_tag && tags[i+1].tag == inner_tag &&
			tags[i+2].tag == "/" + inner_tag && tags[i+3].tag == "/" + outer_tag) {
			let outer_pos = tags[i].index,
				outer_end = outer_pos + tags[i][0].length,
				inner_pos = tags[i+1].index,
				inner_end = inner_pos + tags[i+1][0].length,
				inner_close_pos = tags[i+2].index,
				inner_close_end = inner_close_pos + tags[i+2][0].length,
				outer_close_pos = tags[i+3].index,
				outer_close_end = outer_close_pos + tags[i+3][0].length;
			html = html.slice(0, outer_pos) +
				   html.slice(inner_pos, inner_end) +
				   html.slice(outer_pos, inner_pos) +
				   html.slice(inner_end, inner_close_pos) +
				   html.slice(inner_close_end, outer_close_end) +
				   html.slice(inner_close_pos, inner_close_end) +
				   html.slice(outer_close_end);
			i += 3;
		}
	}
	return html;
}
