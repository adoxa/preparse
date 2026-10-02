Implement or work around some things missing from UXP.

* AVIF support (assuming AV1 is enabled);
* renames private elements to include the class name;
* implements import maps;
* implements `import.meta.resolve`;
* provides a `commit` stub for `IDBTransaction`;
* implements `formatToParts` for `Intl.RelativeTimeFormat` (overriding the bundled one);
* implements `narrowSymbol` for currency `NumberFormat`;
* implements basic `unit` style for `NumberFormat` (U.S. English only, no "per" or `supportedValuesOf` support);
* moves `<form>` outside of `<table>` or inside `<td>`;
* implements `replaceSync` for `CSSStyleSheet` (if you haven't updated, yet);
* implements `text` for `Blob`.

In addition it detects Discourse and succeeds its browser check; allows Google searches
to work with Javascript disabled; and passes some of IMDb's polyfill tests.

The default is to auto-detect what it can (Discourse & import maps are detected on load;
private elements & `import.meta.resolve` will be detected on error, causing a reload).
