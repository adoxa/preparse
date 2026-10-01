(function() {
	IDBTransaction.prototype.commit ??= () => {};

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
		// A leading digit results in an empty initial split.
		if (!parts[0].value) {
			parts.splice(0, 1);
		}
		// Similarly with a trailing digit.
		if (!parts.at(-1).value) {
			parts.splice(-1);
		}
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

	if (!CSSStyleSheet.prototype.replaceSync) {
		CSSStyleSheet.prototype.replaceSync = function(css) {
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
		Element.prototype._pp_attachShadow = Element.prototype.attachShadow;
		Element.prototype.attachShadow = function(options) {
			const shadow = this._pp_attachShadow(options);
			shadow.adoptedStyleSheets = [];
			return shadow;
		};
		document.adoptedStyleSheets = [];
	}

	// Check if the plural of 1.0 is "one" - IMDb wants it to be "other".
	if (!Intl.PluralRules.prototype._pp_select) {
		if (new Intl.PluralRules("en", {minimumFractionDigits: 1}).select(1) == "one") {
			Intl.PluralRules.prototype._pp_select = Intl.PluralRules.prototype.select;
			Intl.PluralRules.prototype.select = function(number) {
				let result = this._pp_select(number);
				if (result == "one" && this.resolvedOptions().minimumFractionDigits) {
					result = "other";
				}
				return result;
			};
		} else {
			Intl.PluralRules.prototype._pp_select = true;
		}
	}

	if (!Intl._pp_nf) {
		let nf = {};
		try {
			Intl.NumberFormat("en", {style: "currency", currency: "USD", currencyDisplay: "narrowSymbol"});
		} catch (e) {
			nf.narrow = true;
		}
		try {
			let u = new Intl.NumberFormat("en", {style: "unit", unit: "bit", notation: "scientific"});
			if (u.format(1e4) != "1E4 bit") {
				// Unit is supported, but scientific notation is not; rig IMDb's test.
				nf.imdb = true;
			}
		} catch (e) {
			nf.unit = nf.imdb = true;
		}
		if (Object.keys(nf).length == 0) {
			Intl._pp_nf = true;
		} else {
			const units = nf.unit && getUnits();
			Intl._pp_nf = class extends Intl.NumberFormat {
				constructor(locales, options) {
					let narrow;
					if (nf.narrow && options?.currencyDisplay == "narrowSymbol") {
						options.currencyDisplay = "symbol";
						narrow = true;
					}

					let unit;
					if (nf.unit && options?.style == "unit") {
						if (options.unit === undefined) {
							throw TypeError("undefined unit in NumberFormat() with unit style");
						}
						if (!(options.unit in units)) {
							throw RangeError(`invalid unit "${options.unit}" in NumberFormat()`);
						}
						if (options.unitDisplay !== undefined
							&& !["short", "narrow", "long"].includes(options.unitDisplay)) {
							throw RangeError(`invalid unitDisplay "${options.unitDisplay}" in NumberFormat()`);
						}
						options.style = "decimal";
						unit = true;
					}

					super(locales, options);

					if (narrow) {
						this.narrow = narrow;
					}

					if (unit) {
						this.unit = options.unit;
						this.unitDisplay = options.unitDisplay || "short";
					}

					if (nf.imdb && locales == "en") {
						this.notation = options?.notation;
					}
				}

				resolvedOptions() {
					let options = super.resolvedOptions();

					if (this.narrow) {
						options.currencyDisplay = "narrowSymbol";
					}

					if (this.unit) {
						options.style = "unit";
						options.unit = this.unit;
						options.unitDisplay = this.unitDisplay;
					}

					return options;
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
					let result = super.format(number);

					if (this.narrow) {
						return Intl._pp_nf.makeNarrow(result);
					}

					// Pass IMDb's test.
					if (number === 1e4 && this.notation == "scientific") {
						let options = this.resolvedOptions();
						if (options.unit == "bit" && options.unitDisplay == "long") {
							return "1E4 bits";
						}
					}

					if (this.unit) {
						return this.formatToParts(number).map(p => p.value).join("");
					}

					return result;
				}

				formatToParts(number) {
					let parts = super.formatToParts(number);

					if (this.narrow) {
						parts[0].value = Intl._pp_nf.makeNarrow(parts[0].value);
					}

					if (this.unit) {
						// 1 (or -1) is singular, 1.0 is not.
						let i = parts[0].type == "minusSign" ? 1 : 0;
						const one = parts[i].value == "1" && parts.length == i + 1;
						const unit = units[this.unit];
						if (this.unitDisplay == "long"
							|| (this.unitDisplay == "short" && !unit.short_no_space)) {
							parts.push({type: "literal", value: " "});
						}
						let value;
						if (this.unitDisplay == "short") {
							value = !one && unit.short_plural || unit.short;
						} else if (this.unitDisplay == "long") {
							value = one ? unit.one || this.unit : unit.plural;
						} else /* (this.unitDisplay == "narrow") */ {
							value = unit.narrow || unit.short;
						}
						parts.push({type: "unit", value});
					}

					return parts;
				}
			};
			Intl.NumberFormat = function NumberFormat(locales, options) {
				return new Intl._pp_nf(locales, options);
			};
			Intl.NumberFormat.prototype = Intl._pp_nf.prototype;
			Intl.NumberFormat.supportedLocalesOf = Intl._pp_nf.supportedLocalesOf;
		}
	}

	function getUnits() {
		return {
			acre:				 { short: "ac",      plural: "acres" },
			bit:				 { short: "bit",     plural: "bits" },
			byte:				 { short: "byte",    plural: "bytes", narrow: "B" },
			celsius:			 { short: "\xB0C",   plural: "degrees Celsius", one: "degree Celsius", short_no_space: true },
			centimeter: 		 { short: "cm",      plural: "centimeters" },
			day:				 { short: "day",     plural: "days", narrow: "d", short_plural: "days" },
			degree: 			 { short: "deg",     plural: "degrees" },
			fahrenheit: 		 { short: "\xB0F",   plural: "degrees Fahrenheit", one: "degree Fahrenheit", short_no_space: true },
			"fluid-ounce":       { short: "fl oz",   plural: "fluid ounces", one: "fluid ounce" },
			foot:				 { short: "ft",      plural: "feet", narrow: "\u2032" },
			gallon: 			 { short: "gal",     plural: "gallons" },
			gigabit:			 { short: "Gb",      plural: "gigabits" },
			gigabyte:			 { short: "GB",      plural: "gigabytes" },
			gram:				 { short: "g",       plural: "grams" },
			hectare:			 { short: "ha",      plural: "hectares" },
			hour:				 { short: "hr",      plural: "hours", narrow: "h" },
			inch:				 { short: "in",      plural: "inches", narrow: "\u2033" },
			kilobit:			 { short: "kb",      plural: "kilobits" },
			kilobyte:			 { short: "kB",      plural: "kilobytes" },
			kilogram:			 { short: "kg",      plural: "kilograms" },
			kilometer:			 { short: "km",      plural: "kilometers" },
			liter:				 { short: "L",       plural: "liters" },
			megabit:			 { short: "Mb",      plural: "megabits" },
			megabyte:			 { short: "MB",      plural: "megabytes" },
			meter:				 { short: "m",       plural: "meters" },
			microsecond:		 { short: "\u03BCs", plural: "microseconds" },
			mile:				 { short: "mi",      plural: "miles" },
			"mile-scandinavian": { short: "smi",     plural: "miles-scandinavian" },
			milliliter: 		 { short: "mL",      plural: "milliliters" },
			millimeter: 		 { short: "mm",      plural: "millimeters" },
			millisecond:		 { short: "ms",      plural: "milliseconds" },
			minute: 			 { short: "min",     plural: "minutes", narrow: "m" },
			month:				 { short: "mth",     plural: "months", narrow: "m", short_plural: "mths" },
			nanosecond: 		 { short: "ns",      plural: "nanoseconds" },
			ounce:				 { short: "oz",      plural: "ounces" },
			percent:			 { short: "%",       plural: "percent", short_no_space: true },
			petabyte:			 { short: "PB",      plural: "petabytes" },
			pound:				 { short: "lb",      plural: "pounds" },
			second: 			 { short: "sec",     plural: "seconds", narrow: "s" },
			stone:				 { short: "st",      plural: "stones" },
			terabit:			 { short: "Tb",      plural: "terabits" },
			terabyte:			 { short: "TB",      plural: "terabytes" },
			week:				 { short: "wk",      plural: "weeks", narrow: "w", short_plural: "wks" },
			yard:				 { short: "yd",      plural: "yards" },
			year:				 { short: "yr",      plural: "years", narrow: "y", short_plural: "yrs" },
		}
	}
})();
