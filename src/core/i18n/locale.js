import {
  getAvailableLanguages,
  getTranslationTableByIndex,
  setTranslationTableByIndex,
} from "./i18n-store.js";

/**
 * UI string resolver: dot-path lookups in per-language tables loaded from
 * `window.I18N_DATA`, with English fallback and `VAR0`/`VAR1` template filling.
 */
const Locale = {
  activeTableIndex: 0,
  numericKeyCache: {},
};

/**
 * Parse bracket/semicolon wire tables into nested arrays.
 * Format: `segment;segment;[nested;segments]` (used when a table is still a string).
 */
Locale.parseBracketDelimitedTable = function parseBracketDelimitedTable(raw) {
  const stack = [];
  let sliceStart = 0;
  let cursor = 0;
  let current = [];
  const len = raw.length;

  while (cursor !== len) {
    const ch = raw[cursor];
    if (ch === "[") {
      stack.push(current);
      current = [];
      cursor = sliceStart = cursor + 1;
    } else if (ch === "]") {
      current.push(sliceStart === cursor ? null : raw.substring(sliceStart, cursor));
      const finished = current;
      current = stack.pop();
      current.push(finished);
      cursor = sliceStart = cursor + 1;
    } else if (ch === ";") {
      if (raw[cursor - 1] !== "]") {
        current.push(sliceStart === cursor ? null : raw.substring(sliceStart, cursor));
      }
      cursor = sliceStart = cursor + 1;
    } else {
      cursor++;
    }
  }

  return current;
};

Locale.getTable = function getTable(tableIndex) {
  let table = getTranslationTableByIndex(tableIndex);
  if (typeof table === "string") {
    table = Locale.parseBracketDelimitedTable(table);
    setTranslationTableByIndex(tableIndex, table);
  }
  return table;
};

Locale.walkDotPath = function walkDotPath(tableRoot, dotPath) {
  const segments = dotPath.split(".");
  let node = tableRoot;
  for (let i = 0; i < segments.length; i++) {
    if (node == null || typeof node !== "object") return null;
    node = node[segments[i]];
  }
  return node;
};

Locale.resolveDotPathMessage = function resolveDotPathMessage(dotPath) {
  const activeTable = Locale.getTable(Locale.activeTableIndex);
  const englishTable = Locale.getTable(0);
  let raw = Locale.walkDotPath(activeTable, dotPath);
  if (raw == null) raw = Locale.walkDotPath(englishTable, dotPath);
  if (typeof raw !== "string") return null;
  return raw.split("::")[0];
};

function fillMessageTemplate(template, partPaths) {
  let message = template;
  for (let partIdx = 1; partIdx < partPaths.length; partIdx++) {
    const partRaw = Locale.get(partPaths[partIdx]);
    const partValue = partRaw == null ? "" : partRaw;
    const markerIdx = message.indexOf("VAR" + (partIdx - 1));
    if (markerIdx < 0) continue;
    message = message.slice(0, markerIdx) + partValue + message.slice(markerIdx + 4);
  }
  return message;
}

/**
 * Resolve a message.
 * - String argument: dot-path lookup (`"layer.newLayer"`).
 * - Array argument: `[templatePath, ...partPaths]` with `VAR0`, `VAR1`, … placeholders.
 * - Numeric-array paths: valid only once registered via {@link Locale.registerNumericKeys}.
 */
Locale.get = function get(pathOrTemplate) {
  if (typeof pathOrTemplate === "string") {
    const resolved = Locale.resolveDotPathMessage(pathOrTemplate);
    return resolved != null ? resolved : pathOrTemplate;
  }

  const headType = typeof pathOrTemplate[0];
  if (headType === "number") {
    for (let checkIdx = 1; checkIdx < pathOrTemplate.length; checkIdx++) {
      if (typeof pathOrTemplate[checkIdx] !== "number") {
        console.log(pathOrTemplate);
        throw "locale: numeric path must contain only numbers";
      }
    }
    const frozenKey = JSON.stringify(pathOrTemplate);
    if (Locale.numericKeyCache[frozenKey] != null) {
      return Locale.numericKeyCache[frozenKey];
    }
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        "Locale.get: numeric path not registered — replace with dot-path string",
        JSON.stringify(pathOrTemplate),
        new Error().stack
      );
    }
    return null;
  }

  const template = Locale.get(pathOrTemplate[0]);
  if (typeof template !== "string") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        "Locale.get: template head resolved to non-string",
        pathOrTemplate,
        template
      );
    }
    return "";
  }

  return fillMessageTemplate(template, pathOrTemplate);
};

Locale.getSortedLanguages = function getSortedLanguages() {
  function compareLanguages(langA, langB) {
    const codeA = langA.code;
    const codeB = langB.code;
    if (codeA === "en") return -1;
    if (codeB === "en") return 1;

    const browserLangs = navigator.languages;
    const aPreferred = browserLangs.indexOf(codeA) !== -1;
    const bPreferred = browserLangs.indexOf(codeB) !== -1;
    if (aPreferred && bPreferred) return codeA > codeB ? 1 : -1;
    if (aPreferred) return -1;
    if (bPreferred) return 1;
    return codeA > codeB ? 1 : -1;
  }

  const langs = getAvailableLanguages().slice(0);
  langs.sort(compareLanguages);
  return langs;
};

Locale.setActiveTableIndex = function setActiveTableIndex(activeTableIndex) {
  Locale.activeTableIndex = activeTableIndex;
};

Locale.setLanguageByCode = function setLanguageByCode(languageCode) {
  const langs = getAvailableLanguages();
  for (let langIdx = 0; langIdx < langs.length; langIdx++) {
    if (langs[langIdx].code === languageCode) {
      Locale.activeTableIndex = langIdx;
    }
  }
};

Locale.getCurrentLanguageCode = function getCurrentLanguageCode() {
  const langs = getAvailableLanguages();
  return langs[Locale.activeTableIndex] ? langs[Locale.activeTableIndex].code : "en";
};

Locale.registerNumericKeys = function registerNumericKeys(frozenPairs) {
  for (let pairIdx = 0; pairIdx < frozenPairs.length; pairIdx += 2) {
    if (frozenPairs[pairIdx + 1].indexOf(">") === -1) {
      Locale.numericKeyCache[JSON.stringify(frozenPairs[pairIdx])] = frozenPairs[pairIdx + 1];
    }
  }
};

Locale.findLanguageIndex = function findLanguageIndex(languageCode) {
  let foundIndex = -1;
  const langs = getAvailableLanguages();
  for (let langIdx = 0; langIdx < langs.length; langIdx++) {
    if (langs[langIdx].code === languageCode) foundIndex = langIdx;
  }
  return foundIndex;
};

export { Locale };
