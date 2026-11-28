export const SUPPORTED_LANGS = Object.freeze(['zh-CN', 'ja', 'en']);

/** 按使用者选择语言，服务端请求之间不共享当前语言。 */
export function createMessageCatalog(rows) {
  const dictionaries = new Map(SUPPORTED_LANGS.map((lang, index) => [
    lang, new Map(rows.map(row => [row[0], row[index + 1]])),
  ]));
  return language => {
    const dictionary = dictionaries.get(language) || dictionaries.get('zh-CN');
    return (key, vars) => {
      const value = dictionary.get(key) ?? key;
      if (!vars) return value;
      return value.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(vars, name) ? vars[name] : match);
    };
  };
}
