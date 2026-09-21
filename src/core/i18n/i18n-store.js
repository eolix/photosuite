/**
 * Read/write access to `globalThis.I18N_DATA`, populated synchronously from
 * `index.html` before ESM modules load (`core/i18n/locales/*.json`).
 */

/**
 * @returns {{ langs: Array<{name: string, code: string, table: number}>, tables: any[] } | null}
 */
function getStartupI18nData() {
  const candidate = globalThis.I18N_DATA;
  return candidate && typeof candidate === "object" ? candidate : null;
}

export function getAvailableLanguages() {
  const i18nData = getStartupI18nData();
  if (i18nData == null || i18nData.langs == null) return [];
  return i18nData.langs;
}

export function getTranslationTables() {
  const i18nData = getStartupI18nData();
  if (i18nData == null || i18nData.tables == null) return [];
  return i18nData.tables;
}

export function getTranslationTableByIndex(index) {
  return getTranslationTables()[index];
}

export function setTranslationTableByIndex(index, value) {
  const i18nData = getStartupI18nData();
  if (!i18nData) throw new Error("No i18n data found to mutate");
  if (!Array.isArray(i18nData.tables)) i18nData.tables = [];
  i18nData.tables[index] = value;
}
