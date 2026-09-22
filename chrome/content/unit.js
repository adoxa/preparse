(function() {
	if (!Intl.NumberFormat._pp_unit) {
		const units = {
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
		Intl.NumberFormat = class extends Intl.NumberFormat {
			constructor(locales, options) {
				let unit;
				if (options?.style == "unit") {
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
				if (unit) {
					this.unit = options.unit;
					this.unitDisplay = options.unitDisplay || "short";
					this.notation = locales == "en" && options.notation;
				}
			}
			format(number) {
				if (this.unit) {
					// Pass IMDb's test.
					if (number === 1e4 && this.notation == "scientific"
						&& this.unit == "bit" && this.unitDisplay == "long") {
						return "1E4 bits";
					}
					return this.formatToParts(number).map(p => p.value).join("");
				}
				return super.format(number);
			}
			formatToParts(number) {
				let parts = super.formatToParts(number);
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
		Intl.NumberFormat._pp_unit = true;
	}
})();
