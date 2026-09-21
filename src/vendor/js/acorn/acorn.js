var acorn = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../../acorn/src/index.js
  var index_exports = {};
  __export(index_exports, {
    Node: () => Node,
    Parser: () => Parser,
    Position: () => Position,
    SourceLocation: () => SourceLocation,
    TokContext: () => TokContext,
    Token: () => Token,
    TokenType: () => TokenType,
    defaultOptions: () => defaultOptions,
    getLineInfo: () => getLineInfo,
    isIdentifierChar: () => isIdentifierChar,
    isIdentifierStart: () => isIdentifierStart,
    isNewLine: () => isNewLine,
    lineBreak: () => lineBreak,
    lineBreakG: () => lineBreakG,
    parse: () => parse,
    parseExpressionAt: () => parseExpressionAt,
    plugins: () => plugins,
    tokContexts: () => types2,
    tokTypes: () => types,
    tokenizer: () => tokenizer,
    version: () => version
  });

  // ../../acorn/src/identifier.js
  var reservedWords = {
    3: "abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
    5: "class enum extends super const export import",
    6: "enum",
    7: "enum",
    strict: "implements interface let package private protected public static yield",
    strictBind: "eval arguments"
  };
  var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";
  var keywords = {
    5: ecma5AndLessKeywords,
    6: ecma5AndLessKeywords + " const class extends export import super"
  };
  var nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B4\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FD5\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AD\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
  var nonASCIIidentifierChars = "\u200C\u200D\xB7\u0300-\u036F\u0387\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0D01-\u0D03\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D82\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1369-\u1371\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19D0-\u19DA\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF2-\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF5\u1DFC-\u1DFF\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\uA620-\uA629\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA880\uA881\uA8B4-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F1\uA900-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F";
  var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
  var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");
  nonASCIIidentifierStartChars = nonASCIIidentifierChars = null;
  var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 17, 26, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 99, 39, 9, 51, 157, 310, 10, 21, 11, 7, 153, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 71, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 26, 45, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 785, 52, 76, 44, 33, 24, 27, 35, 42, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 85, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 287, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 86, 25, 391, 63, 32, 0, 449, 56, 1288, 921, 103, 110, 18, 195, 2749, 1070, 4050, 582, 8634, 568, 8, 30, 114, 29, 19, 47, 17, 3, 32, 20, 6, 18, 881, 68, 12, 0, 67, 12, 16481, 1, 3071, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 4149, 196, 1340, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42710, 42, 4148, 12, 221, 3, 5761, 10591, 541];
  var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 1306, 2, 54, 14, 32, 9, 16, 3, 46, 10, 54, 9, 7, 2, 37, 13, 2, 9, 52, 0, 13, 2, 49, 13, 10, 2, 4, 9, 83, 11, 168, 11, 6, 9, 7, 3, 57, 0, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 316, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 84, 14, 5, 9, 423, 9, 20855, 9, 135, 4, 60, 6, 26, 9, 1016, 45, 17, 3, 19723, 1, 5319, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 3617, 6, 792618, 239];
  function isInAstralSet(code, set) {
    let pos = 65536;
    for (let i = 0; i < set.length; i += 2) {
      pos += set[i];
      if (pos > code) return false;
      pos += set[i + 1];
      if (pos >= code) return true;
    }
  }
  function isIdentifierStart(code, astral) {
    if (code < 65) return code === 36;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123) return true;
    if (code <= 65535) return code >= 170 && nonASCIIidentifierStart.test(String.fromCharCode(code));
    if (astral === false) return false;
    return isInAstralSet(code, astralIdentifierStartCodes);
  }
  function isIdentifierChar(code, astral) {
    if (code < 48) return code === 36;
    if (code < 58) return true;
    if (code < 65) return false;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123) return true;
    if (code <= 65535) return code >= 170 && nonASCIIidentifier.test(String.fromCharCode(code));
    if (astral === false) return false;
    return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
  }

  // ../../acorn/src/tokentype.js
  var TokenType = class {
    constructor(label, conf = {}) {
      this.label = label;
      this.keyword = conf.keyword;
      this.beforeExpr = !!conf.beforeExpr;
      this.startsExpr = !!conf.startsExpr;
      this.isLoop = !!conf.isLoop;
      this.isAssign = !!conf.isAssign;
      this.prefix = !!conf.prefix;
      this.postfix = !!conf.postfix;
      this.binop = conf.binop || null;
      this.updateContext = null;
    }
  };
  function binop(name, prec) {
    return new TokenType(name, { beforeExpr: true, binop: prec });
  }
  var beforeExpr = { beforeExpr: true };
  var startsExpr = { startsExpr: true };
  var types = {
    num: new TokenType("num", startsExpr),
    regexp: new TokenType("regexp", startsExpr),
    string: new TokenType("string", startsExpr),
    name: new TokenType("name", startsExpr),
    eof: new TokenType("eof"),
    // Punctuation token types.
    bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
    bracketR: new TokenType("]"),
    braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
    braceR: new TokenType("}"),
    parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
    parenR: new TokenType(")"),
    comma: new TokenType(",", beforeExpr),
    semi: new TokenType(";", beforeExpr),
    colon: new TokenType(":", beforeExpr),
    dot: new TokenType("."),
    question: new TokenType("?", beforeExpr),
    arrow: new TokenType("=>", beforeExpr),
    template: new TokenType("template"),
    ellipsis: new TokenType("...", beforeExpr),
    backQuote: new TokenType("`", startsExpr),
    dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),
    // Operators. These carry several kinds of properties to help the
    // parser use them properly (the presence of these properties is
    // what categorizes them as operators).
    //
    // `binop`, when present, specifies that this operator is a binary
    // operator, and will refer to its precedence.
    //
    // `prefix` and `postfix` mark the operator as a prefix or postfix
    // unary operator.
    //
    // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
    // binary operators with a very low precedence, that should result
    // in AssignmentExpression nodes.
    eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
    assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
    incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
    prefix: new TokenType("prefix", { beforeExpr: true, prefix: true, startsExpr: true }),
    logicalOR: binop("||", 1),
    logicalAND: binop("&&", 2),
    bitwiseOR: binop("|", 3),
    bitwiseXOR: binop("^", 4),
    bitwiseAND: binop("&", 5),
    equality: binop("==/!=", 6),
    relational: binop("</>", 7),
    bitShift: binop("<</>>", 8),
    plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
    modulo: binop("%", 10),
    star: binop("*", 10),
    slash: binop("/", 10),
    starstar: new TokenType("**", { beforeExpr: true })
  };
  var keywords2 = {};
  function kw(name, options = {}) {
    options.keyword = name;
    keywords2[name] = types["_" + name] = new TokenType(name, options);
  }
  kw("break");
  kw("case", beforeExpr);
  kw("catch");
  kw("continue");
  kw("debugger");
  kw("default", beforeExpr);
  kw("do", { isLoop: true, beforeExpr: true });
  kw("else", beforeExpr);
  kw("finally");
  kw("for", { isLoop: true });
  kw("function", startsExpr);
  kw("if");
  kw("return", beforeExpr);
  kw("switch");
  kw("throw", beforeExpr);
  kw("try");
  kw("var");
  kw("const");
  kw("while", { isLoop: true });
  kw("with");
  kw("new", { beforeExpr: true, startsExpr: true });
  kw("this", startsExpr);
  kw("super", startsExpr);
  kw("class");
  kw("extends", beforeExpr);
  kw("export");
  kw("import");
  kw("null", startsExpr);
  kw("true", startsExpr);
  kw("false", startsExpr);
  kw("in", { beforeExpr: true, binop: 7 });
  kw("instanceof", { beforeExpr: true, binop: 7 });
  kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true });
  kw("void", { beforeExpr: true, prefix: true, startsExpr: true });
  kw("delete", { beforeExpr: true, prefix: true, startsExpr: true });

  // ../../acorn/src/whitespace.js
  var lineBreak = /\r\n?|\n|\u2028|\u2029/;
  var lineBreakG = new RegExp(lineBreak.source, "g");
  function isNewLine(code) {
    return code === 10 || code === 13 || code === 8232 || code == 8233;
  }
  var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
  var skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;

  // ../../acorn/src/util.js
  function isArray(obj) {
    return Object.prototype.toString.call(obj) === "[object Array]";
  }
  function has(obj, propName) {
    return Object.prototype.hasOwnProperty.call(obj, propName);
  }

  // ../../acorn/src/locutil.js
  var Position = class _Position {
    constructor(line, col) {
      this.line = line;
      this.column = col;
    }
    offset(n) {
      return new _Position(this.line, this.column + n);
    }
  };
  var SourceLocation = class {
    constructor(p, start, end) {
      this.start = start;
      this.end = end;
      if (p.sourceFile !== null) this.source = p.sourceFile;
    }
  };
  function getLineInfo(input, offset) {
    for (let line = 1, cur = 0; ; ) {
      lineBreakG.lastIndex = cur;
      let match = lineBreakG.exec(input);
      if (match && match.index < offset) {
        ++line;
        cur = match.index + match[0].length;
      } else {
        return new Position(line, offset - cur);
      }
    }
  }

  // ../../acorn/src/options.js
  var defaultOptions = {
    // `ecmaVersion` indicates the ECMAScript version to parse. Must
    // be either 3, or 5, or 6. This influences support for strict
    // mode, the set of reserved words, support for getters and
    // setters and other features. The default is 6.
    ecmaVersion: 6,
    // Source type ("script" or "module") for different semantics
    sourceType: "script",
    // `onInsertedSemicolon` can be a callback that will be called
    // when a semicolon is automatically inserted. It will be passed
    // th position of the comma as an offset, and if `locations` is
    // enabled, it is given the location as a `{line, column}` object
    // as second argument.
    onInsertedSemicolon: null,
    // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
    // trailing commas.
    onTrailingComma: null,
    // By default, reserved words are only enforced if ecmaVersion >= 5.
    // Set `allowReserved` to a boolean value to explicitly turn this on
    // an off. When this option has the value "never", reserved words
    // and keywords can also not be used as property names.
    allowReserved: null,
    // When enabled, a return at the top level is not considered an
    // error.
    allowReturnOutsideFunction: false,
    // When enabled, import/export statements are not constrained to
    // appearing at the top of the program.
    allowImportExportEverywhere: false,
    // When enabled, hashbang directive in the beginning of file
    // is allowed and treated as a line comment.
    allowHashBang: false,
    // When `locations` is on, `loc` properties holding objects with
    // `start` and `end` properties in `{line, column}` form (with
    // line being 1-based and column 0-based) will be attached to the
    // nodes.
    locations: false,
    // A function can be passed as `onToken` option, which will
    // cause Acorn to call that function with object in the same
    // format as tokens returned from `tokenizer().getToken()`. Note
    // that you are not allowed to call the parser from the
    // callback—that will corrupt its internal state.
    onToken: null,
    // A function can be passed as `onComment` option, which will
    // cause Acorn to call that function with `(block, text, start,
    // end)` parameters whenever a comment is skipped. `block` is a
    // boolean indicating whether this is a block (`/* */`) comment,
    // `text` is the content of the comment, and `start` and `end` are
    // character offsets that denote the start and end of the comment.
    // When the `locations` option is on, two more parameters are
    // passed, the full `{line, column}` locations of the start and
    // end of the comments. Note that you are not allowed to call the
    // parser from the callback—that will corrupt its internal state.
    onComment: null,
    // Nodes have their start and end characters offsets recorded in
    // `start` and `end` properties (directly on the node, rather than
    // the `loc` object, which holds line/column data. To also add a
    // [semi-standardized][range] `range` property holding a `[start,
    // end]` array with the same numbers, set the `ranges` option to
    // `true`.
    //
    // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
    ranges: false,
    // It is possible to parse multiple files into a single AST by
    // passing the tree produced by parsing the first file as
    // `program` option in subsequent parses. This will add the
    // toplevel forms of the parsed file to the `Program` (top) node
    // of an existing parse tree.
    program: null,
    // When `locations` is on, you can pass this to record the source
    // file in every node's `loc` object.
    sourceFile: null,
    // This value, if given, is stored in every node, whether
    // `locations` is on or off.
    directSourceFile: null,
    // When enabled, parenthesized expressions are represented by
    // (non-standard) ParenthesizedExpression nodes
    preserveParens: false,
    plugins: {}
  };
  function getOptions(opts) {
    let options = {};
    for (let opt in defaultOptions)
      options[opt] = opts && has(opts, opt) ? opts[opt] : defaultOptions[opt];
    if (options.allowReserved == null)
      options.allowReserved = options.ecmaVersion < 5;
    if (isArray(options.onToken)) {
      let tokens = options.onToken;
      options.onToken = (token) => tokens.push(token);
    }
    if (isArray(options.onComment))
      options.onComment = pushComment(options, options.onComment);
    return options;
  }
  function pushComment(options, array) {
    return function(block, text, start, end, startLoc, endLoc) {
      let comment = {
        type: block ? "Block" : "Line",
        value: text,
        start,
        end
      };
      if (options.locations)
        comment.loc = new SourceLocation(this, startLoc, endLoc);
      if (options.ranges)
        comment.range = [start, end];
      array.push(comment);
    };
  }

  // ../../acorn/src/state.js
  var plugins = {};
  function keywordRegexp(words) {
    return new RegExp("^(" + words.replace(/ /g, "|") + ")$");
  }
  var Parser = class {
    constructor(options, input, startPos) {
      this.options = options = getOptions(options);
      this.sourceFile = options.sourceFile;
      this.keywords = keywordRegexp(keywords[options.ecmaVersion >= 6 ? 6 : 5]);
      let reserved = options.allowReserved ? "" : reservedWords[options.ecmaVersion] + (options.sourceType == "module" ? " await" : "");
      this.reservedWords = keywordRegexp(reserved);
      let reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict;
      this.reservedWordsStrict = keywordRegexp(reservedStrict);
      this.reservedWordsStrictBind = keywordRegexp(reservedStrict + " " + reservedWords.strictBind);
      this.input = String(input);
      this.containsEsc = false;
      this.loadPlugins(options.plugins);
      if (startPos) {
        this.pos = startPos;
        this.lineStart = Math.max(0, this.input.lastIndexOf("\n", startPos));
        this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length;
      } else {
        this.pos = this.lineStart = 0;
        this.curLine = 1;
      }
      this.type = types.eof;
      this.value = null;
      this.start = this.end = this.pos;
      this.startLoc = this.endLoc = this.curPosition();
      this.lastTokEndLoc = this.lastTokStartLoc = null;
      this.lastTokStart = this.lastTokEnd = this.pos;
      this.context = this.initialContext();
      this.exprAllowed = true;
      this.strict = this.inModule = options.sourceType === "module";
      this.potentialArrowAt = -1;
      this.inFunction = this.inGenerator = false;
      this.labels = [];
      if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!")
        this.skipLineComment(2);
    }
    // DEPRECATED Kept for backwards compatibility until 3.0 in case a plugin uses them
    isKeyword(word) {
      return this.keywords.test(word);
    }
    isReservedWord(word) {
      return this.reservedWords.test(word);
    }
    extend(name, f) {
      this[name] = f(this[name]);
    }
    loadPlugins(pluginConfigs) {
      for (let name in pluginConfigs) {
        let plugin = plugins[name];
        if (!plugin) throw new Error("Plugin '" + name + "' not found");
        plugin(this, pluginConfigs[name]);
      }
    }
    parse() {
      let node = this.options.program || this.startNode();
      this.nextToken();
      return this.parseTopLevel(node);
    }
  };

  // ../../acorn/src/parseutil.js
  var pp = Parser.prototype;
  pp.isUseStrict = function(stmt) {
    return this.options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && stmt.expression.raw.slice(1, -1) === "use strict";
  };
  pp.eat = function(type) {
    if (this.type === type) {
      this.next();
      return true;
    } else {
      return false;
    }
  };
  pp.isContextual = function(name) {
    return this.type === types.name && this.value === name;
  };
  pp.eatContextual = function(name) {
    return this.value === name && this.eat(types.name);
  };
  pp.expectContextual = function(name) {
    if (!this.eatContextual(name)) this.unexpected();
  };
  pp.canInsertSemicolon = function() {
    return this.type === types.eof || this.type === types.braceR || lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
  };
  pp.insertSemicolon = function() {
    if (this.canInsertSemicolon()) {
      if (this.options.onInsertedSemicolon)
        this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
      return true;
    }
  };
  pp.semicolon = function() {
    if (!this.eat(types.semi) && !this.insertSemicolon()) this.unexpected();
  };
  pp.afterTrailingComma = function(tokType) {
    if (this.type == tokType) {
      if (this.options.onTrailingComma)
        this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
      this.next();
      return true;
    }
  };
  pp.expect = function(type) {
    this.eat(type) || this.unexpected();
  };
  pp.unexpected = function(pos) {
    this.raise(pos != null ? pos : this.start, "Unexpected token");
  };
  pp.checkPatternErrors = function(refDestructuringErrors, andThrow) {
    let pos = refDestructuringErrors && refDestructuringErrors.trailingComma;
    if (!andThrow) return !!pos;
    if (pos) this.raise(pos, "Comma is not permitted after the rest element");
  };
  pp.checkExpressionErrors = function(refDestructuringErrors, andThrow) {
    let pos = refDestructuringErrors && refDestructuringErrors.shorthandAssign;
    if (!andThrow) return !!pos;
    if (pos) this.raise(pos, "Shorthand property assignments are valid only in destructuring patterns");
  };

  // ../../acorn/src/statement.js
  var pp2 = Parser.prototype;
  pp2.parseTopLevel = function(node) {
    let first = true;
    if (!node.body) node.body = [];
    while (this.type !== types.eof) {
      let stmt = this.parseStatement(true, true);
      node.body.push(stmt);
      if (first) {
        if (this.isUseStrict(stmt)) this.setStrict(true);
        first = false;
      }
    }
    this.next();
    if (this.options.ecmaVersion >= 6) {
      node.sourceType = this.options.sourceType;
    }
    return this.finishNode(node, "Program");
  };
  var loopLabel = { kind: "loop" };
  var switchLabel = { kind: "switch" };
  pp2.isLet = function() {
    if (this.type !== types.name || this.options.ecmaVersion < 6 || this.value != "let") return false;
    skipWhiteSpace.lastIndex = this.pos;
    let skip = skipWhiteSpace.exec(this.input);
    let next = this.pos + skip[0].length, nextCh = this.input.charCodeAt(next);
    if (nextCh === 91 || nextCh == 123) return true;
    if (isIdentifierStart(nextCh, true)) {
      for (var pos = next + 1; isIdentifierChar(this.input.charCodeAt(pos, true)); ++pos) {
      }
      let ident = this.input.slice(next, pos);
      if (!this.isKeyword(ident)) return true;
    }
    return false;
  };
  pp2.parseStatement = function(declaration, topLevel) {
    let starttype = this.type, node = this.startNode(), kind;
    if (this.isLet()) {
      starttype = types._var;
      kind = "let";
    }
    switch (starttype) {
      case types._break:
      case types._continue:
        return this.parseBreakContinueStatement(node, starttype.keyword);
      case types._debugger:
        return this.parseDebuggerStatement(node);
      case types._do:
        return this.parseDoStatement(node);
      case types._for:
        return this.parseForStatement(node);
      case types._function:
        if (!declaration && this.options.ecmaVersion >= 6) this.unexpected();
        return this.parseFunctionStatement(node);
      case types._class:
        if (!declaration) this.unexpected();
        return this.parseClass(node, true);
      case types._if:
        return this.parseIfStatement(node);
      case types._return:
        return this.parseReturnStatement(node);
      case types._switch:
        return this.parseSwitchStatement(node);
      case types._throw:
        return this.parseThrowStatement(node);
      case types._try:
        return this.parseTryStatement(node);
      case types._const:
      case types._var:
        kind = kind || this.value;
        if (!declaration && kind != "var") this.unexpected();
        return this.parseVarStatement(node, kind);
      case types._while:
        return this.parseWhileStatement(node);
      case types._with:
        return this.parseWithStatement(node);
      case types.braceL:
        return this.parseBlock();
      case types.semi:
        return this.parseEmptyStatement(node);
      case types._export:
      case types._import:
        if (!this.options.allowImportExportEverywhere) {
          if (!topLevel)
            this.raise(this.start, "'import' and 'export' may only appear at the top level");
          if (!this.inModule)
            this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
        }
        return starttype === types._import ? this.parseImport(node) : this.parseExport(node);
      // If the statement does not start with a statement keyword or a
      // brace, it's an ExpressionStatement or LabeledStatement. We
      // simply start parsing an expression, and afterwards, if the
      // next token is a colon and the expression was a simple
      // Identifier node, we switch to interpreting it as a label.
      default:
        let maybeName = this.value, expr = this.parseExpression();
        if (starttype === types.name && expr.type === "Identifier" && this.eat(types.colon))
          return this.parseLabeledStatement(node, maybeName, expr);
        else return this.parseExpressionStatement(node, expr);
    }
  };
  pp2.parseBreakContinueStatement = function(node, keyword) {
    let isBreak = keyword == "break";
    this.next();
    if (this.eat(types.semi) || this.insertSemicolon()) node.label = null;
    else if (this.type !== types.name) this.unexpected();
    else {
      node.label = this.parseIdent();
      this.semicolon();
    }
    for (var i = 0; i < this.labels.length; ++i) {
      let lab = this.labels[i];
      if (node.label == null || lab.name === node.label.name) {
        if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
        if (node.label && isBreak) break;
      }
    }
    if (i === this.labels.length) this.raise(node.start, "Unsyntactic " + keyword);
    return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
  };
  pp2.parseDebuggerStatement = function(node) {
    this.next();
    this.semicolon();
    return this.finishNode(node, "DebuggerStatement");
  };
  pp2.parseDoStatement = function(node) {
    this.next();
    this.labels.push(loopLabel);
    node.body = this.parseStatement(false);
    this.labels.pop();
    this.expect(types._while);
    node.test = this.parseParenExpression();
    if (this.options.ecmaVersion >= 6)
      this.eat(types.semi);
    else
      this.semicolon();
    return this.finishNode(node, "DoWhileStatement");
  };
  pp2.parseForStatement = function(node) {
    this.next();
    this.labels.push(loopLabel);
    this.expect(types.parenL);
    if (this.type === types.semi) return this.parseFor(node, null);
    let isLet = this.isLet();
    if (this.type === types._var || this.type === types._const || isLet) {
      let init2 = this.startNode(), kind = isLet ? "let" : this.value;
      this.next();
      this.parseVar(init2, true, kind);
      this.finishNode(init2, "VariableDeclaration");
      if ((this.type === types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && init2.declarations.length === 1 && !(kind !== "var" && init2.declarations[0].init))
        return this.parseForIn(node, init2);
      return this.parseFor(node, init2);
    }
    let refDestructuringErrors = { shorthandAssign: 0, trailingComma: 0 };
    let init = this.parseExpression(true, refDestructuringErrors);
    if (this.type === types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) {
      this.checkPatternErrors(refDestructuringErrors, true);
      this.toAssignable(init);
      this.checkLVal(init);
      return this.parseForIn(node, init);
    } else {
      this.checkExpressionErrors(refDestructuringErrors, true);
    }
    return this.parseFor(node, init);
  };
  pp2.parseFunctionStatement = function(node) {
    this.next();
    return this.parseFunction(node, true);
  };
  pp2.parseIfStatement = function(node) {
    this.next();
    node.test = this.parseParenExpression();
    node.consequent = this.parseStatement(false);
    node.alternate = this.eat(types._else) ? this.parseStatement(false) : null;
    return this.finishNode(node, "IfStatement");
  };
  pp2.parseReturnStatement = function(node) {
    if (!this.inFunction && !this.options.allowReturnOutsideFunction)
      this.raise(this.start, "'return' outside of function");
    this.next();
    if (this.eat(types.semi) || this.insertSemicolon()) node.argument = null;
    else {
      node.argument = this.parseExpression();
      this.semicolon();
    }
    return this.finishNode(node, "ReturnStatement");
  };
  pp2.parseSwitchStatement = function(node) {
    this.next();
    node.discriminant = this.parseParenExpression();
    node.cases = [];
    this.expect(types.braceL);
    this.labels.push(switchLabel);
    for (var cur, sawDefault = false; this.type != types.braceR; ) {
      if (this.type === types._case || this.type === types._default) {
        let isCase = this.type === types._case;
        if (cur) this.finishNode(cur, "SwitchCase");
        node.cases.push(cur = this.startNode());
        cur.consequent = [];
        this.next();
        if (isCase) {
          cur.test = this.parseExpression();
        } else {
          if (sawDefault) this.raiseRecoverable(this.lastTokStart, "Multiple default clauses");
          sawDefault = true;
          cur.test = null;
        }
        this.expect(types.colon);
      } else {
        if (!cur) this.unexpected();
        cur.consequent.push(this.parseStatement(true));
      }
    }
    if (cur) this.finishNode(cur, "SwitchCase");
    this.next();
    this.labels.pop();
    return this.finishNode(node, "SwitchStatement");
  };
  pp2.parseThrowStatement = function(node) {
    this.next();
    if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start)))
      this.raise(this.lastTokEnd, "Illegal newline after throw");
    node.argument = this.parseExpression();
    this.semicolon();
    return this.finishNode(node, "ThrowStatement");
  };
  var empty = [];
  pp2.parseTryStatement = function(node) {
    this.next();
    node.block = this.parseBlock();
    node.handler = null;
    if (this.type === types._catch) {
      let clause = this.startNode();
      this.next();
      this.expect(types.parenL);
      clause.param = this.parseBindingAtom();
      this.checkLVal(clause.param, true);
      this.expect(types.parenR);
      clause.body = this.parseBlock();
      node.handler = this.finishNode(clause, "CatchClause");
    }
    node.finalizer = this.eat(types._finally) ? this.parseBlock() : null;
    if (!node.handler && !node.finalizer)
      this.raise(node.start, "Missing catch or finally clause");
    return this.finishNode(node, "TryStatement");
  };
  pp2.parseVarStatement = function(node, kind) {
    this.next();
    this.parseVar(node, false, kind);
    this.semicolon();
    return this.finishNode(node, "VariableDeclaration");
  };
  pp2.parseWhileStatement = function(node) {
    this.next();
    node.test = this.parseParenExpression();
    this.labels.push(loopLabel);
    node.body = this.parseStatement(false);
    this.labels.pop();
    return this.finishNode(node, "WhileStatement");
  };
  pp2.parseWithStatement = function(node) {
    if (this.strict) this.raise(this.start, "'with' in strict mode");
    this.next();
    node.object = this.parseParenExpression();
    node.body = this.parseStatement(false);
    return this.finishNode(node, "WithStatement");
  };
  pp2.parseEmptyStatement = function(node) {
    this.next();
    return this.finishNode(node, "EmptyStatement");
  };
  pp2.parseLabeledStatement = function(node, maybeName, expr) {
    for (let i = 0; i < this.labels.length; ++i)
      if (this.labels[i].name === maybeName) this.raise(expr.start, "Label '" + maybeName + "' is already declared");
    let kind = this.type.isLoop ? "loop" : this.type === types._switch ? "switch" : null;
    for (let i = this.labels.length - 1; i >= 0; i--) {
      let label = this.labels[i];
      if (label.statementStart == node.start) {
        label.statementStart = this.start;
        label.kind = kind;
      } else break;
    }
    this.labels.push({ name: maybeName, kind, statementStart: this.start });
    node.body = this.parseStatement(true);
    this.labels.pop();
    node.label = expr;
    return this.finishNode(node, "LabeledStatement");
  };
  pp2.parseExpressionStatement = function(node, expr) {
    node.expression = expr;
    this.semicolon();
    return this.finishNode(node, "ExpressionStatement");
  };
  pp2.parseBlock = function(allowStrict) {
    let node = this.startNode(), first = true, oldStrict;
    node.body = [];
    this.expect(types.braceL);
    while (!this.eat(types.braceR)) {
      let stmt = this.parseStatement(true);
      node.body.push(stmt);
      if (first && allowStrict && this.isUseStrict(stmt)) {
        oldStrict = this.strict;
        this.setStrict(this.strict = true);
      }
      first = false;
    }
    if (oldStrict === false) this.setStrict(false);
    return this.finishNode(node, "BlockStatement");
  };
  pp2.parseFor = function(node, init) {
    node.init = init;
    this.expect(types.semi);
    node.test = this.type === types.semi ? null : this.parseExpression();
    this.expect(types.semi);
    node.update = this.type === types.parenR ? null : this.parseExpression();
    this.expect(types.parenR);
    node.body = this.parseStatement(false);
    this.labels.pop();
    return this.finishNode(node, "ForStatement");
  };
  pp2.parseForIn = function(node, init) {
    let type = this.type === types._in ? "ForInStatement" : "ForOfStatement";
    this.next();
    node.left = init;
    node.right = this.parseExpression();
    this.expect(types.parenR);
    node.body = this.parseStatement(false);
    this.labels.pop();
    return this.finishNode(node, type);
  };
  pp2.parseVar = function(node, isFor, kind) {
    node.declarations = [];
    node.kind = kind;
    for (; ; ) {
      let decl = this.startNode();
      this.parseVarId(decl);
      if (this.eat(types.eq)) {
        decl.init = this.parseMaybeAssign(isFor);
      } else if (kind === "const" && !(this.type === types._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
        this.unexpected();
      } else if (decl.id.type != "Identifier" && !(isFor && (this.type === types._in || this.isContextual("of")))) {
        this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
      } else {
        decl.init = null;
      }
      node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
      if (!this.eat(types.comma)) break;
    }
    return node;
  };
  pp2.parseVarId = function(decl) {
    decl.id = this.parseBindingAtom();
    this.checkLVal(decl.id, true);
  };
  pp2.parseFunction = function(node, isStatement, allowExpressionBody) {
    this.initFunction(node);
    if (this.options.ecmaVersion >= 6)
      node.generator = this.eat(types.star);
    var oldInGen = this.inGenerator;
    this.inGenerator = node.generator;
    if (isStatement || this.type === types.name)
      node.id = this.parseIdent();
    this.parseFunctionParams(node);
    this.parseFunctionBody(node, allowExpressionBody);
    this.inGenerator = oldInGen;
    return this.finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
  };
  pp2.parseFunctionParams = function(node) {
    this.expect(types.parenL);
    node.params = this.parseBindingList(types.parenR, false, false, true);
  };
  pp2.parseClass = function(node, isStatement) {
    this.next();
    this.parseClassId(node, isStatement);
    this.parseClassSuper(node);
    let classBody = this.startNode();
    let hadConstructor = false;
    classBody.body = [];
    this.expect(types.braceL);
    while (!this.eat(types.braceR)) {
      if (this.eat(types.semi)) continue;
      let method = this.startNode();
      let isGenerator = this.eat(types.star);
      let isMaybeStatic = this.type === types.name && this.value === "static";
      this.parsePropertyName(method);
      method.static = isMaybeStatic && this.type !== types.parenL;
      if (method.static) {
        if (isGenerator) this.unexpected();
        isGenerator = this.eat(types.star);
        this.parsePropertyName(method);
      }
      method.kind = "method";
      let isGetSet = false;
      if (!method.computed) {
        let { key } = method;
        if (!isGenerator && key.type === "Identifier" && this.type !== types.parenL && (key.name === "get" || key.name === "set")) {
          isGetSet = true;
          method.kind = key.name;
          key = this.parsePropertyName(method);
        }
        if (!method.static && (key.type === "Identifier" && key.name === "constructor" || key.type === "Literal" && key.value === "constructor")) {
          if (hadConstructor) this.raise(key.start, "Duplicate constructor in the same class");
          if (isGetSet) this.raise(key.start, "Constructor can't have get/set modifier");
          if (isGenerator) this.raise(key.start, "Constructor can't be a generator");
          method.kind = "constructor";
          hadConstructor = true;
        }
      }
      this.parseClassMethod(classBody, method, isGenerator);
      if (isGetSet) {
        let paramCount = method.kind === "get" ? 0 : 1;
        if (method.value.params.length !== paramCount) {
          let start = method.value.start;
          if (method.kind === "get")
            this.raiseRecoverable(start, "getter should have no params");
          else
            this.raiseRecoverable(start, "setter should have exactly one param");
        }
        if (method.kind === "set" && method.value.params[0].type === "RestElement")
          this.raise(method.value.params[0].start, "Setter cannot use rest params");
      }
    }
    node.body = this.finishNode(classBody, "ClassBody");
    return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
  };
  pp2.parseClassMethod = function(classBody, method, isGenerator) {
    method.value = this.parseMethod(isGenerator);
    classBody.body.push(this.finishNode(method, "MethodDefinition"));
  };
  pp2.parseClassId = function(node, isStatement) {
    node.id = this.type === types.name ? this.parseIdent() : isStatement ? this.unexpected() : null;
  };
  pp2.parseClassSuper = function(node) {
    node.superClass = this.eat(types._extends) ? this.parseExprSubscripts() : null;
  };
  pp2.parseExport = function(node) {
    this.next();
    if (this.eat(types.star)) {
      this.expectContextual("from");
      node.source = this.type === types.string ? this.parseExprAtom() : this.unexpected();
      this.semicolon();
      return this.finishNode(node, "ExportAllDeclaration");
    }
    if (this.eat(types._default)) {
      let parens = this.type == types.parenL;
      let expr = this.parseMaybeAssign();
      let needsSemi = true;
      if (!parens && (expr.type == "FunctionExpression" || expr.type == "ClassExpression")) {
        needsSemi = false;
        if (expr.id) {
          expr.type = expr.type == "FunctionExpression" ? "FunctionDeclaration" : "ClassDeclaration";
        }
      }
      node.declaration = expr;
      if (needsSemi) this.semicolon();
      return this.finishNode(node, "ExportDefaultDeclaration");
    }
    if (this.shouldParseExportStatement()) {
      node.declaration = this.parseStatement(true);
      node.specifiers = [];
      node.source = null;
    } else {
      node.declaration = null;
      node.specifiers = this.parseExportSpecifiers();
      if (this.eatContextual("from")) {
        node.source = this.type === types.string ? this.parseExprAtom() : this.unexpected();
      } else {
        for (let i = 0; i < node.specifiers.length; i++) {
          if (this.keywords.test(node.specifiers[i].local.name) || this.reservedWords.test(node.specifiers[i].local.name)) {
            this.unexpected(node.specifiers[i].local.start);
          }
        }
        node.source = null;
      }
      this.semicolon();
    }
    return this.finishNode(node, "ExportNamedDeclaration");
  };
  pp2.shouldParseExportStatement = function() {
    return this.type.keyword || this.isLet();
  };
  pp2.parseExportSpecifiers = function() {
    let nodes = [], first = true;
    this.expect(types.braceL);
    while (!this.eat(types.braceR)) {
      if (!first) {
        this.expect(types.comma);
        if (this.afterTrailingComma(types.braceR)) break;
      } else first = false;
      let node = this.startNode();
      node.local = this.parseIdent(this.type === types._default);
      node.exported = this.eatContextual("as") ? this.parseIdent(true) : node.local;
      nodes.push(this.finishNode(node, "ExportSpecifier"));
    }
    return nodes;
  };
  pp2.parseImport = function(node) {
    this.next();
    if (this.type === types.string) {
      node.specifiers = empty;
      node.source = this.parseExprAtom();
    } else {
      node.specifiers = this.parseImportSpecifiers();
      this.expectContextual("from");
      node.source = this.type === types.string ? this.parseExprAtom() : this.unexpected();
    }
    this.semicolon();
    return this.finishNode(node, "ImportDeclaration");
  };
  pp2.parseImportSpecifiers = function() {
    let nodes = [], first = true;
    if (this.type === types.name) {
      let node = this.startNode();
      node.local = this.parseIdent();
      this.checkLVal(node.local, true);
      nodes.push(this.finishNode(node, "ImportDefaultSpecifier"));
      if (!this.eat(types.comma)) return nodes;
    }
    if (this.type === types.star) {
      let node = this.startNode();
      this.next();
      this.expectContextual("as");
      node.local = this.parseIdent();
      this.checkLVal(node.local, true);
      nodes.push(this.finishNode(node, "ImportNamespaceSpecifier"));
      return nodes;
    }
    this.expect(types.braceL);
    while (!this.eat(types.braceR)) {
      if (!first) {
        this.expect(types.comma);
        if (this.afterTrailingComma(types.braceR)) break;
      } else first = false;
      let node = this.startNode();
      node.imported = this.parseIdent(true);
      if (this.eatContextual("as")) {
        node.local = this.parseIdent();
      } else {
        node.local = node.imported;
        if (this.isKeyword(node.local.name)) this.unexpected(node.local.start);
        if (this.reservedWordsStrict.test(node.local.name)) this.raise(node.local.start, "The keyword '" + node.local.name + "' is reserved");
      }
      this.checkLVal(node.local, true);
      nodes.push(this.finishNode(node, "ImportSpecifier"));
    }
    return nodes;
  };

  // ../../acorn/src/lval.js
  var pp3 = Parser.prototype;
  pp3.toAssignable = function(node, isBinding) {
    if (this.options.ecmaVersion >= 6 && node) {
      switch (node.type) {
        case "Identifier":
        case "ObjectPattern":
        case "ArrayPattern":
          break;
        case "ObjectExpression":
          node.type = "ObjectPattern";
          for (let i = 0; i < node.properties.length; i++) {
            let prop = node.properties[i];
            if (prop.kind !== "init") this.raise(prop.key.start, "Object pattern can't contain getter or setter");
            this.toAssignable(prop.value, isBinding);
          }
          break;
        case "ArrayExpression":
          node.type = "ArrayPattern";
          this.toAssignableList(node.elements, isBinding);
          break;
        case "AssignmentExpression":
          if (node.operator === "=") {
            node.type = "AssignmentPattern";
            delete node.operator;
          } else {
            this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
            break;
          }
        case "AssignmentPattern":
          if (node.right.type === "YieldExpression")
            this.raise(node.right.start, "Yield expression cannot be a default value");
          break;
        case "ParenthesizedExpression":
          node.expression = this.toAssignable(node.expression, isBinding);
          break;
        case "MemberExpression":
          if (!isBinding) break;
        default:
          this.raise(node.start, "Assigning to rvalue");
      }
    }
    return node;
  };
  pp3.toAssignableList = function(exprList, isBinding) {
    let end = exprList.length;
    if (end) {
      let last = exprList[end - 1];
      if (last && last.type == "RestElement") {
        --end;
      } else if (last && last.type == "SpreadElement") {
        last.type = "RestElement";
        let arg = last.argument;
        this.toAssignable(arg, isBinding);
        if (arg.type !== "Identifier" && arg.type !== "MemberExpression" && arg.type !== "ArrayPattern")
          this.unexpected(arg.start);
        --end;
      }
      if (isBinding && last.type === "RestElement" && last.argument.type !== "Identifier")
        this.unexpected(last.argument.start);
    }
    for (let i = 0; i < end; i++) {
      let elt = exprList[i];
      if (elt) this.toAssignable(elt, isBinding);
    }
    return exprList;
  };
  pp3.parseSpread = function(refDestructuringErrors) {
    let node = this.startNode();
    this.next();
    node.argument = this.parseMaybeAssign(refDestructuringErrors);
    return this.finishNode(node, "SpreadElement");
  };
  pp3.parseRest = function(allowNonIdent) {
    let node = this.startNode();
    this.next();
    if (allowNonIdent) node.argument = this.type === types.name ? this.parseIdent() : this.unexpected();
    else node.argument = this.type === types.name || this.type === types.bracketL ? this.parseBindingAtom() : this.unexpected();
    return this.finishNode(node, "RestElement");
  };
  pp3.parseBindingAtom = function() {
    if (this.options.ecmaVersion < 6) return this.parseIdent();
    switch (this.type) {
      case types.name:
        return this.parseIdent();
      case types.bracketL:
        let node = this.startNode();
        this.next();
        node.elements = this.parseBindingList(types.bracketR, true, true);
        return this.finishNode(node, "ArrayPattern");
      case types.braceL:
        return this.parseObj(true);
      default:
        this.unexpected();
    }
  };
  pp3.parseBindingList = function(close, allowEmpty, allowTrailingComma, allowNonIdent) {
    let elts = [], first = true;
    while (!this.eat(close)) {
      if (first) first = false;
      else this.expect(types.comma);
      if (allowEmpty && this.type === types.comma) {
        elts.push(null);
      } else if (allowTrailingComma && this.afterTrailingComma(close)) {
        break;
      } else if (this.type === types.ellipsis) {
        let rest = this.parseRest(allowNonIdent);
        this.parseBindingListItem(rest);
        elts.push(rest);
        if (this.type === types.comma) this.raise(this.start, "Comma is not permitted after the rest element");
        this.expect(close);
        break;
      } else {
        let elem = this.parseMaybeDefault(this.start, this.startLoc);
        this.parseBindingListItem(elem);
        elts.push(elem);
      }
    }
    return elts;
  };
  pp3.parseBindingListItem = function(param) {
    return param;
  };
  pp3.parseMaybeDefault = function(startPos, startLoc, left) {
    left = left || this.parseBindingAtom();
    if (this.options.ecmaVersion < 6 || !this.eat(types.eq)) return left;
    let node = this.startNodeAt(startPos, startLoc);
    node.left = left;
    node.right = this.parseMaybeAssign();
    return this.finishNode(node, "AssignmentPattern");
  };
  pp3.checkLVal = function(expr, isBinding, checkClashes) {
    switch (expr.type) {
      case "Identifier":
        if (this.strict && this.reservedWordsStrictBind.test(expr.name))
          this.raiseRecoverable(expr.start, (isBinding ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
        if (checkClashes) {
          if (has(checkClashes, expr.name))
            this.raiseRecoverable(expr.start, "Argument name clash");
          checkClashes[expr.name] = true;
        }
        break;
      case "MemberExpression":
        if (isBinding) this.raiseRecoverable(expr.start, (isBinding ? "Binding" : "Assigning to") + " member expression");
        break;
      case "ObjectPattern":
        for (let i = 0; i < expr.properties.length; i++)
          this.checkLVal(expr.properties[i].value, isBinding, checkClashes);
        break;
      case "ArrayPattern":
        for (let i = 0; i < expr.elements.length; i++) {
          let elem = expr.elements[i];
          if (elem) this.checkLVal(elem, isBinding, checkClashes);
        }
        break;
      case "AssignmentPattern":
        this.checkLVal(expr.left, isBinding, checkClashes);
        break;
      case "RestElement":
        this.checkLVal(expr.argument, isBinding, checkClashes);
        break;
      case "ParenthesizedExpression":
        this.checkLVal(expr.expression, isBinding, checkClashes);
        break;
      default:
        this.raise(expr.start, (isBinding ? "Binding" : "Assigning to") + " rvalue");
    }
  };

  // ../../acorn/src/expression.js
  var pp4 = Parser.prototype;
  pp4.checkPropClash = function(prop, propHash) {
    if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand))
      return;
    let { key } = prop, name;
    switch (key.type) {
      case "Identifier":
        name = key.name;
        break;
      case "Literal":
        name = String(key.value);
        break;
      default:
        return;
    }
    let { kind } = prop;
    if (this.options.ecmaVersion >= 6) {
      if (name === "__proto__" && kind === "init") {
        if (propHash.proto) this.raiseRecoverable(key.start, "Redefinition of __proto__ property");
        propHash.proto = true;
      }
      return;
    }
    name = "$" + name;
    let other = propHash[name];
    if (other) {
      let isGetSet = kind !== "init";
      if ((this.strict || isGetSet) && other[kind] || !(isGetSet ^ other.init))
        this.raiseRecoverable(key.start, "Redefinition of property");
    } else {
      other = propHash[name] = {
        init: false,
        get: false,
        set: false
      };
    }
    other[kind] = true;
  };
  pp4.parseExpression = function(noIn, refDestructuringErrors) {
    let startPos = this.start, startLoc = this.startLoc;
    let expr = this.parseMaybeAssign(noIn, refDestructuringErrors);
    if (this.type === types.comma) {
      let node = this.startNodeAt(startPos, startLoc);
      node.expressions = [expr];
      while (this.eat(types.comma)) node.expressions.push(this.parseMaybeAssign(noIn, refDestructuringErrors));
      return this.finishNode(node, "SequenceExpression");
    }
    return expr;
  };
  pp4.parseMaybeAssign = function(noIn, refDestructuringErrors, afterLeftParse) {
    if (this.inGenerator && this.isContextual("yield")) return this.parseYield();
    let validateDestructuring = false;
    if (!refDestructuringErrors) {
      refDestructuringErrors = { shorthandAssign: 0, trailingComma: 0 };
      validateDestructuring = true;
    }
    let startPos = this.start, startLoc = this.startLoc;
    if (this.type == types.parenL || this.type == types.name)
      this.potentialArrowAt = this.start;
    let left = this.parseMaybeConditional(noIn, refDestructuringErrors);
    if (afterLeftParse) left = afterLeftParse.call(this, left, startPos, startLoc);
    if (this.type.isAssign) {
      if (validateDestructuring) this.checkPatternErrors(refDestructuringErrors, true);
      let node = this.startNodeAt(startPos, startLoc);
      node.operator = this.value;
      node.left = this.type === types.eq ? this.toAssignable(left) : left;
      refDestructuringErrors.shorthandAssign = 0;
      this.checkLVal(left);
      this.next();
      node.right = this.parseMaybeAssign(noIn);
      return this.finishNode(node, "AssignmentExpression");
    } else {
      if (validateDestructuring) this.checkExpressionErrors(refDestructuringErrors, true);
    }
    return left;
  };
  pp4.parseMaybeConditional = function(noIn, refDestructuringErrors) {
    let startPos = this.start, startLoc = this.startLoc;
    let expr = this.parseExprOps(noIn, refDestructuringErrors);
    if (this.checkExpressionErrors(refDestructuringErrors)) return expr;
    if (this.eat(types.question)) {
      let node = this.startNodeAt(startPos, startLoc);
      node.test = expr;
      node.consequent = this.parseMaybeAssign();
      this.expect(types.colon);
      node.alternate = this.parseMaybeAssign(noIn);
      return this.finishNode(node, "ConditionalExpression");
    }
    return expr;
  };
  pp4.parseExprOps = function(noIn, refDestructuringErrors) {
    let startPos = this.start, startLoc = this.startLoc;
    let expr = this.parseMaybeUnary(refDestructuringErrors, false);
    if (this.checkExpressionErrors(refDestructuringErrors)) return expr;
    return this.parseExprOp(expr, startPos, startLoc, -1, noIn);
  };
  pp4.parseExprOp = function(left, leftStartPos, leftStartLoc, minPrec, noIn) {
    let prec = this.type.binop;
    if (prec != null && (!noIn || this.type !== types._in)) {
      if (prec > minPrec) {
        let logical = this.type === types.logicalOR || this.type === types.logicalAND;
        let op = this.value;
        this.next();
        let startPos = this.start, startLoc = this.startLoc;
        let right = this.parseExprOp(this.parseMaybeUnary(null, false), startPos, startLoc, prec, noIn);
        let node = this.buildBinary(leftStartPos, leftStartLoc, left, right, op, logical);
        return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, noIn);
      }
    }
    return left;
  };
  pp4.buildBinary = function(startPos, startLoc, left, right, op, logical) {
    let node = this.startNodeAt(startPos, startLoc);
    node.left = left;
    node.operator = op;
    node.right = right;
    return this.finishNode(node, logical ? "LogicalExpression" : "BinaryExpression");
  };
  pp4.parseMaybeUnary = function(refDestructuringErrors, sawUnary) {
    let startPos = this.start, startLoc = this.startLoc, expr;
    if (this.type.prefix) {
      let node = this.startNode(), update = this.type === types.incDec;
      node.operator = this.value;
      node.prefix = true;
      this.next();
      node.argument = this.parseMaybeUnary(null, true);
      this.checkExpressionErrors(refDestructuringErrors, true);
      if (update) this.checkLVal(node.argument);
      else if (this.strict && node.operator === "delete" && node.argument.type === "Identifier")
        this.raiseRecoverable(node.start, "Deleting local variable in strict mode");
      else sawUnary = true;
      expr = this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
    } else {
      expr = this.parseExprSubscripts(refDestructuringErrors);
      if (this.checkExpressionErrors(refDestructuringErrors)) return expr;
      while (this.type.postfix && !this.canInsertSemicolon()) {
        let node = this.startNodeAt(startPos, startLoc);
        node.operator = this.value;
        node.prefix = false;
        node.argument = expr;
        this.checkLVal(expr);
        this.next();
        expr = this.finishNode(node, "UpdateExpression");
      }
    }
    if (!sawUnary && this.eat(types.starstar))
      return this.buildBinary(startPos, startLoc, expr, this.parseMaybeUnary(null, false), "**", false);
    else
      return expr;
  };
  pp4.parseExprSubscripts = function(refDestructuringErrors) {
    let startPos = this.start, startLoc = this.startLoc;
    let expr = this.parseExprAtom(refDestructuringErrors);
    let skipArrowSubscripts = expr.type === "ArrowFunctionExpression" && this.input.slice(this.lastTokStart, this.lastTokEnd) !== ")";
    if (this.checkExpressionErrors(refDestructuringErrors) || skipArrowSubscripts) return expr;
    return this.parseSubscripts(expr, startPos, startLoc);
  };
  pp4.parseSubscripts = function(base, startPos, startLoc, noCalls) {
    for (; ; ) {
      if (this.eat(types.dot)) {
        let node = this.startNodeAt(startPos, startLoc);
        node.object = base;
        node.property = this.parseIdent(true);
        node.computed = false;
        base = this.finishNode(node, "MemberExpression");
      } else if (this.eat(types.bracketL)) {
        let node = this.startNodeAt(startPos, startLoc);
        node.object = base;
        node.property = this.parseExpression();
        node.computed = true;
        this.expect(types.bracketR);
        base = this.finishNode(node, "MemberExpression");
      } else if (!noCalls && this.eat(types.parenL)) {
        let node = this.startNodeAt(startPos, startLoc);
        node.callee = base;
        node.arguments = this.parseExprList(types.parenR, false);
        base = this.finishNode(node, "CallExpression");
      } else if (this.type === types.backQuote) {
        let node = this.startNodeAt(startPos, startLoc);
        node.tag = base;
        node.quasi = this.parseTemplate();
        base = this.finishNode(node, "TaggedTemplateExpression");
      } else {
        return base;
      }
    }
  };
  pp4.parseExprAtom = function(refDestructuringErrors) {
    let node, canBeArrow = this.potentialArrowAt == this.start;
    switch (this.type) {
      case types._super:
        if (!this.inFunction)
          this.raise(this.start, "'super' outside of function or class");
      case types._this:
        let type = this.type === types._this ? "ThisExpression" : "Super";
        node = this.startNode();
        this.next();
        return this.finishNode(node, type);
      case types.name:
        let startPos = this.start, startLoc = this.startLoc;
        let id = this.parseIdent(this.type !== types.name);
        if (canBeArrow && !this.canInsertSemicolon() && this.eat(types.arrow))
          return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id]);
        return id;
      case types.regexp:
        let value = this.value;
        node = this.parseLiteral(value.value);
        node.regex = { pattern: value.pattern, flags: value.flags };
        return node;
      case types.num:
      case types.string:
        return this.parseLiteral(this.value);
      case types._null:
      case types._true:
      case types._false:
        node = this.startNode();
        node.value = this.type === types._null ? null : this.type === types._true;
        node.raw = this.type.keyword;
        this.next();
        return this.finishNode(node, "Literal");
      case types.parenL:
        return this.parseParenAndDistinguishExpression(canBeArrow);
      case types.bracketL:
        node = this.startNode();
        this.next();
        node.elements = this.parseExprList(types.bracketR, true, true, refDestructuringErrors);
        return this.finishNode(node, "ArrayExpression");
      case types.braceL:
        return this.parseObj(false, refDestructuringErrors);
      case types._function:
        node = this.startNode();
        this.next();
        return this.parseFunction(node, false);
      case types._class:
        return this.parseClass(this.startNode(), false);
      case types._new:
        return this.parseNew();
      case types.backQuote:
        return this.parseTemplate();
      default:
        this.unexpected();
    }
  };
  pp4.parseLiteral = function(value) {
    let node = this.startNode();
    node.value = value;
    node.raw = this.input.slice(this.start, this.end);
    this.next();
    return this.finishNode(node, "Literal");
  };
  pp4.parseParenExpression = function() {
    this.expect(types.parenL);
    let val = this.parseExpression();
    this.expect(types.parenR);
    return val;
  };
  pp4.parseParenAndDistinguishExpression = function(canBeArrow) {
    let startPos = this.start, startLoc = this.startLoc, val;
    if (this.options.ecmaVersion >= 6) {
      this.next();
      let innerStartPos = this.start, innerStartLoc = this.startLoc;
      let exprList = [], first = true;
      let refDestructuringErrors = { shorthandAssign: 0, trailingComma: 0 }, spreadStart, innerParenStart;
      while (this.type !== types.parenR) {
        first ? first = false : this.expect(types.comma);
        if (this.type === types.ellipsis) {
          spreadStart = this.start;
          exprList.push(this.parseParenItem(this.parseRest()));
          break;
        } else {
          if (this.type === types.parenL && !innerParenStart) {
            innerParenStart = this.start;
          }
          exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem));
        }
      }
      let innerEndPos = this.start, innerEndLoc = this.startLoc;
      this.expect(types.parenR);
      if (canBeArrow && !this.canInsertSemicolon() && this.eat(types.arrow)) {
        this.checkPatternErrors(refDestructuringErrors, true);
        if (innerParenStart) this.unexpected(innerParenStart);
        return this.parseParenArrowList(startPos, startLoc, exprList);
      }
      if (!exprList.length) this.unexpected(this.lastTokStart);
      if (spreadStart) this.unexpected(spreadStart);
      this.checkExpressionErrors(refDestructuringErrors, true);
      if (exprList.length > 1) {
        val = this.startNodeAt(innerStartPos, innerStartLoc);
        val.expressions = exprList;
        this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
      } else {
        val = exprList[0];
      }
    } else {
      val = this.parseParenExpression();
    }
    if (this.options.preserveParens) {
      let par = this.startNodeAt(startPos, startLoc);
      par.expression = val;
      return this.finishNode(par, "ParenthesizedExpression");
    } else {
      return val;
    }
  };
  pp4.parseParenItem = function(item) {
    return item;
  };
  pp4.parseParenArrowList = function(startPos, startLoc, exprList) {
    return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList);
  };
  var empty2 = [];
  pp4.parseNew = function() {
    let node = this.startNode();
    let meta = this.parseIdent(true);
    if (this.options.ecmaVersion >= 6 && this.eat(types.dot)) {
      node.meta = meta;
      node.property = this.parseIdent(true);
      if (node.property.name !== "target")
        this.raiseRecoverable(node.property.start, "The only valid meta property for new is new.target");
      if (!this.inFunction)
        this.raiseRecoverable(node.start, "new.target can only be used in functions");
      return this.finishNode(node, "MetaProperty");
    }
    let startPos = this.start, startLoc = this.startLoc;
    node.callee = this.parseSubscripts(this.parseExprAtom(), startPos, startLoc, true);
    if (this.eat(types.parenL)) node.arguments = this.parseExprList(types.parenR, false);
    else node.arguments = empty2;
    return this.finishNode(node, "NewExpression");
  };
  pp4.parseTemplateElement = function() {
    let elem = this.startNode();
    elem.value = {
      raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, "\n"),
      cooked: this.value
    };
    this.next();
    elem.tail = this.type === types.backQuote;
    return this.finishNode(elem, "TemplateElement");
  };
  pp4.parseTemplate = function() {
    let node = this.startNode();
    this.next();
    node.expressions = [];
    let curElt = this.parseTemplateElement();
    node.quasis = [curElt];
    while (!curElt.tail) {
      this.expect(types.dollarBraceL);
      node.expressions.push(this.parseExpression());
      this.expect(types.braceR);
      node.quasis.push(curElt = this.parseTemplateElement());
    }
    this.next();
    return this.finishNode(node, "TemplateLiteral");
  };
  pp4.parseObj = function(isPattern, refDestructuringErrors) {
    let node = this.startNode(), first = true, propHash = {};
    node.properties = [];
    this.next();
    while (!this.eat(types.braceR)) {
      if (!first) {
        this.expect(types.comma);
        if (this.afterTrailingComma(types.braceR)) break;
      } else first = false;
      let prop = this.startNode(), isGenerator, startPos, startLoc;
      if (this.options.ecmaVersion >= 6) {
        prop.method = false;
        prop.shorthand = false;
        if (isPattern || refDestructuringErrors) {
          startPos = this.start;
          startLoc = this.startLoc;
        }
        if (!isPattern)
          isGenerator = this.eat(types.star);
      }
      this.parsePropertyName(prop);
      this.parsePropertyValue(prop, isPattern, isGenerator, startPos, startLoc, refDestructuringErrors);
      this.checkPropClash(prop, propHash);
      node.properties.push(this.finishNode(prop, "Property"));
    }
    return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
  };
  pp4.parsePropertyValue = function(prop, isPattern, isGenerator, startPos, startLoc, refDestructuringErrors) {
    if (this.eat(types.colon)) {
      prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors);
      prop.kind = "init";
    } else if (this.options.ecmaVersion >= 6 && this.type === types.parenL) {
      if (isPattern) this.unexpected();
      prop.kind = "init";
      prop.method = true;
      prop.value = this.parseMethod(isGenerator);
    } else if (this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type != types.comma && this.type != types.braceR)) {
      if (isGenerator || isPattern) this.unexpected();
      prop.kind = prop.key.name;
      this.parsePropertyName(prop);
      prop.value = this.parseMethod(false);
      let paramCount = prop.kind === "get" ? 0 : 1;
      if (prop.value.params.length !== paramCount) {
        let start = prop.value.start;
        if (prop.kind === "get")
          this.raiseRecoverable(start, "getter should have no params");
        else
          this.raiseRecoverable(start, "setter should have exactly one param");
      }
      if (prop.kind === "set" && prop.value.params[0].type === "RestElement")
        this.raiseRecoverable(prop.value.params[0].start, "Setter cannot use rest params");
    } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
      prop.kind = "init";
      if (isPattern) {
        if (this.keywords.test(prop.key.name) || (this.strict ? this.reservedWordsStrictBind : this.reservedWords).test(prop.key.name) || this.inGenerator && prop.key.name == "yield")
          this.raiseRecoverable(prop.key.start, "Binding " + prop.key.name);
        prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
      } else if (this.type === types.eq && refDestructuringErrors) {
        if (!refDestructuringErrors.shorthandAssign)
          refDestructuringErrors.shorthandAssign = this.start;
        prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
      } else {
        prop.value = prop.key;
      }
      prop.shorthand = true;
    } else this.unexpected();
  };
  pp4.parsePropertyName = function(prop) {
    if (this.options.ecmaVersion >= 6) {
      if (this.eat(types.bracketL)) {
        prop.computed = true;
        prop.key = this.parseMaybeAssign();
        this.expect(types.bracketR);
        return prop.key;
      } else {
        prop.computed = false;
      }
    }
    return prop.key = this.type === types.num || this.type === types.string ? this.parseExprAtom() : this.parseIdent(true);
  };
  pp4.initFunction = function(node) {
    node.id = null;
    if (this.options.ecmaVersion >= 6) {
      node.generator = false;
      node.expression = false;
    }
  };
  pp4.parseMethod = function(isGenerator) {
    let node = this.startNode(), oldInGen = this.inGenerator;
    this.inGenerator = isGenerator;
    this.initFunction(node);
    this.expect(types.parenL);
    node.params = this.parseBindingList(types.parenR, false, false);
    if (this.options.ecmaVersion >= 6)
      node.generator = isGenerator;
    this.parseFunctionBody(node, false);
    this.inGenerator = oldInGen;
    return this.finishNode(node, "FunctionExpression");
  };
  pp4.parseArrowExpression = function(node, params) {
    let oldInGen = this.inGenerator;
    this.inGenerator = false;
    this.initFunction(node);
    node.params = this.toAssignableList(params, true);
    this.parseFunctionBody(node, true);
    this.inGenerator = oldInGen;
    return this.finishNode(node, "ArrowFunctionExpression");
  };
  pp4.parseFunctionBody = function(node, isArrowFunction) {
    let isExpression = isArrowFunction && this.type !== types.braceL;
    if (isExpression) {
      node.body = this.parseMaybeAssign();
      node.expression = true;
    } else {
      let oldInFunc = this.inFunction, oldLabels = this.labels;
      this.inFunction = true;
      this.labels = [];
      node.body = this.parseBlock(true);
      node.expression = false;
      this.inFunction = oldInFunc;
      this.labels = oldLabels;
    }
    if (this.strict || !isExpression && node.body.body.length && this.isUseStrict(node.body.body[0])) {
      let oldStrict = this.strict;
      this.strict = true;
      if (node.id)
        this.checkLVal(node.id, true);
      this.checkParams(node);
      this.strict = oldStrict;
    } else if (isArrowFunction) {
      this.checkParams(node);
    }
  };
  pp4.checkParams = function(node) {
    let nameHash = {};
    for (let i = 0; i < node.params.length; i++)
      this.checkLVal(node.params[i], true, nameHash);
  };
  pp4.parseExprList = function(close, allowTrailingComma, allowEmpty, refDestructuringErrors) {
    let elts = [], first = true;
    while (!this.eat(close)) {
      if (!first) {
        this.expect(types.comma);
        if (allowTrailingComma && this.afterTrailingComma(close)) break;
      } else first = false;
      let elt;
      if (allowEmpty && this.type === types.comma)
        elt = null;
      else if (this.type === types.ellipsis) {
        elt = this.parseSpread(refDestructuringErrors);
        if (this.type === types.comma && refDestructuringErrors && !refDestructuringErrors.trailingComma) {
          refDestructuringErrors.trailingComma = this.lastTokStart;
        }
      } else
        elt = this.parseMaybeAssign(false, refDestructuringErrors);
      elts.push(elt);
    }
    return elts;
  };
  pp4.parseIdent = function(liberal) {
    let node = this.startNode();
    if (liberal && this.options.allowReserved == "never") liberal = false;
    if (this.type === types.name) {
      if (!liberal && (this.strict ? this.reservedWordsStrict : this.reservedWords).test(this.value) && (this.options.ecmaVersion >= 6 || this.input.slice(this.start, this.end).indexOf("\\") == -1))
        this.raiseRecoverable(this.start, "The keyword '" + this.value + "' is reserved");
      if (!liberal && this.inGenerator && this.value === "yield")
        this.raiseRecoverable(this.start, "Can not use 'yield' as identifier inside a generator");
      node.name = this.value;
    } else if (liberal && this.type.keyword) {
      node.name = this.type.keyword;
    } else {
      this.unexpected();
    }
    this.next();
    return this.finishNode(node, "Identifier");
  };
  pp4.parseYield = function() {
    let node = this.startNode();
    this.next();
    if (this.type == types.semi || this.canInsertSemicolon() || this.type != types.star && !this.type.startsExpr) {
      node.delegate = false;
      node.argument = null;
    } else {
      node.delegate = this.eat(types.star);
      node.argument = this.parseMaybeAssign();
    }
    return this.finishNode(node, "YieldExpression");
  };

  // ../../acorn/src/location.js
  var pp5 = Parser.prototype;
  pp5.raise = function(pos, message) {
    let loc = getLineInfo(this.input, pos);
    message += " (" + loc.line + ":" + loc.column + ")";
    let err = new SyntaxError(message);
    err.pos = pos;
    err.loc = loc;
    err.raisedAt = this.pos;
    throw err;
  };
  pp5.raiseRecoverable = pp5.raise;
  pp5.curPosition = function() {
    if (this.options.locations) {
      return new Position(this.curLine, this.pos - this.lineStart);
    }
  };

  // ../../acorn/src/node.js
  var Node = class {
    constructor(parser, pos, loc) {
      this.type = "";
      this.start = pos;
      this.end = 0;
      if (parser.options.locations)
        this.loc = new SourceLocation(parser, loc);
      if (parser.options.directSourceFile)
        this.sourceFile = parser.options.directSourceFile;
      if (parser.options.ranges)
        this.range = [pos, 0];
    }
  };
  var pp6 = Parser.prototype;
  pp6.startNode = function() {
    return new Node(this, this.start, this.startLoc);
  };
  pp6.startNodeAt = function(pos, loc) {
    return new Node(this, pos, loc);
  };
  function finishNodeAt(node, type, pos, loc) {
    node.type = type;
    node.end = pos;
    if (this.options.locations)
      node.loc.end = loc;
    if (this.options.ranges)
      node.range[1] = pos;
    return node;
  }
  pp6.finishNode = function(node, type) {
    return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc);
  };
  pp6.finishNodeAt = function(node, type, pos, loc) {
    return finishNodeAt.call(this, node, type, pos, loc);
  };

  // ../../acorn/src/tokencontext.js
  var TokContext = class {
    constructor(token, isExpr, preserveSpace, override) {
      this.token = token;
      this.isExpr = !!isExpr;
      this.preserveSpace = !!preserveSpace;
      this.override = override;
    }
  };
  var types2 = {
    b_stat: new TokContext("{", false),
    b_expr: new TokContext("{", true),
    b_tmpl: new TokContext("${", true),
    p_stat: new TokContext("(", false),
    p_expr: new TokContext("(", true),
    q_tmpl: new TokContext("`", true, true, (p) => p.readTmplToken()),
    f_expr: new TokContext("function", true)
  };
  var pp7 = Parser.prototype;
  pp7.initialContext = function() {
    return [types2.b_stat];
  };
  pp7.braceIsBlock = function(prevType) {
    if (prevType === types.colon) {
      let parent = this.curContext();
      if (parent === types2.b_stat || parent === types2.b_expr)
        return !parent.isExpr;
    }
    if (prevType === types._return)
      return lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
    if (prevType === types._else || prevType === types.semi || prevType === types.eof || prevType === types.parenR)
      return true;
    if (prevType == types.braceL)
      return this.curContext() === types2.b_stat;
    return !this.exprAllowed;
  };
  pp7.updateContext = function(prevType) {
    let update, type = this.type;
    if (type.keyword && prevType == types.dot)
      this.exprAllowed = false;
    else if (update = type.updateContext)
      update.call(this, prevType);
    else
      this.exprAllowed = type.beforeExpr;
  };
  types.parenR.updateContext = types.braceR.updateContext = function() {
    if (this.context.length == 1) {
      this.exprAllowed = true;
      return;
    }
    let out = this.context.pop();
    if (out === types2.b_stat && this.curContext() === types2.f_expr) {
      this.context.pop();
      this.exprAllowed = false;
    } else if (out === types2.b_tmpl) {
      this.exprAllowed = true;
    } else {
      this.exprAllowed = !out.isExpr;
    }
  };
  types.braceL.updateContext = function(prevType) {
    this.context.push(this.braceIsBlock(prevType) ? types2.b_stat : types2.b_expr);
    this.exprAllowed = true;
  };
  types.dollarBraceL.updateContext = function() {
    this.context.push(types2.b_tmpl);
    this.exprAllowed = true;
  };
  types.parenL.updateContext = function(prevType) {
    let statementParens = prevType === types._if || prevType === types._for || prevType === types._with || prevType === types._while;
    this.context.push(statementParens ? types2.p_stat : types2.p_expr);
    this.exprAllowed = true;
  };
  types.incDec.updateContext = function() {
  };
  types._function.updateContext = function(prevType) {
    if (prevType.beforeExpr && prevType !== types.semi && prevType !== types._else && (prevType !== types.colon || this.curContext() !== types2.b_stat))
      this.context.push(types2.f_expr);
    this.exprAllowed = false;
  };
  types.backQuote.updateContext = function() {
    if (this.curContext() === types2.q_tmpl)
      this.context.pop();
    else
      this.context.push(types2.q_tmpl);
    this.exprAllowed = false;
  };

  // ../../acorn/src/tokenize.js
  var Token = class {
    constructor(p) {
      this.type = p.type;
      this.value = p.value;
      this.start = p.start;
      this.end = p.end;
      if (p.options.locations)
        this.loc = new SourceLocation(p, p.startLoc, p.endLoc);
      if (p.options.ranges)
        this.range = [p.start, p.end];
    }
  };
  var pp8 = Parser.prototype;
  var isRhino = typeof Packages == "object" && Object.prototype.toString.call(Packages) == "[object JavaPackage]";
  pp8.next = function() {
    if (this.options.onToken)
      this.options.onToken(new Token(this));
    this.lastTokEnd = this.end;
    this.lastTokStart = this.start;
    this.lastTokEndLoc = this.endLoc;
    this.lastTokStartLoc = this.startLoc;
    this.nextToken();
  };
  pp8.getToken = function() {
    this.next();
    return new Token(this);
  };
  if (typeof Symbol !== "undefined")
    pp8[Symbol.iterator] = function() {
      let self = this;
      return { next: function() {
        let token = self.getToken();
        return {
          done: token.type === types.eof,
          value: token
        };
      } };
    };
  pp8.setStrict = function(strict) {
    this.strict = strict;
    if (this.type !== types.num && this.type !== types.string) return;
    this.pos = this.start;
    if (this.options.locations) {
      while (this.pos < this.lineStart) {
        this.lineStart = this.input.lastIndexOf("\n", this.lineStart - 2) + 1;
        --this.curLine;
      }
    }
    this.nextToken();
  };
  pp8.curContext = function() {
    return this.context[this.context.length - 1];
  };
  pp8.nextToken = function() {
    let curContext = this.curContext();
    if (!curContext || !curContext.preserveSpace) this.skipSpace();
    this.start = this.pos;
    if (this.options.locations) this.startLoc = this.curPosition();
    if (this.pos >= this.input.length) return this.finishToken(types.eof);
    if (curContext.override) return curContext.override(this);
    else this.readToken(this.fullCharCodeAtPos());
  };
  pp8.readToken = function(code) {
    if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92)
      return this.readWord();
    return this.getTokenFromCode(code);
  };
  pp8.fullCharCodeAtPos = function() {
    let code = this.input.charCodeAt(this.pos);
    if (code <= 55295 || code >= 57344) return code;
    let next = this.input.charCodeAt(this.pos + 1);
    return (code << 10) + next - 56613888;
  };
  pp8.skipBlockComment = function() {
    let startLoc = this.options.onComment && this.curPosition();
    let start = this.pos, end = this.input.indexOf("*/", this.pos += 2);
    if (end === -1) this.raise(this.pos - 2, "Unterminated comment");
    this.pos = end + 2;
    if (this.options.locations) {
      lineBreakG.lastIndex = start;
      let match;
      while ((match = lineBreakG.exec(this.input)) && match.index < this.pos) {
        ++this.curLine;
        this.lineStart = match.index + match[0].length;
      }
    }
    if (this.options.onComment)
      this.options.onComment(
        true,
        this.input.slice(start + 2, end),
        start,
        this.pos,
        startLoc,
        this.curPosition()
      );
  };
  pp8.skipLineComment = function(startSkip) {
    let start = this.pos;
    let startLoc = this.options.onComment && this.curPosition();
    let ch = this.input.charCodeAt(this.pos += startSkip);
    while (this.pos < this.input.length && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
      ++this.pos;
      ch = this.input.charCodeAt(this.pos);
    }
    if (this.options.onComment)
      this.options.onComment(
        false,
        this.input.slice(start + startSkip, this.pos),
        start,
        this.pos,
        startLoc,
        this.curPosition()
      );
  };
  pp8.skipSpace = function() {
    loop: while (this.pos < this.input.length) {
      let ch = this.input.charCodeAt(this.pos);
      switch (ch) {
        case 32:
        case 160:
          ++this.pos;
          break;
        case 13:
          if (this.input.charCodeAt(this.pos + 1) === 10) {
            ++this.pos;
          }
        case 10:
        case 8232:
        case 8233:
          ++this.pos;
          if (this.options.locations) {
            ++this.curLine;
            this.lineStart = this.pos;
          }
          break;
        case 47:
          switch (this.input.charCodeAt(this.pos + 1)) {
            case 42:
              this.skipBlockComment();
              break;
            case 47:
              this.skipLineComment(2);
              break;
            default:
              break loop;
          }
          break;
        default:
          if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
            ++this.pos;
          } else {
            break loop;
          }
      }
    }
  };
  pp8.finishToken = function(type, val) {
    this.end = this.pos;
    if (this.options.locations) this.endLoc = this.curPosition();
    let prevType = this.type;
    this.type = type;
    this.value = val;
    this.updateContext(prevType);
  };
  pp8.readToken_dot = function() {
    let next = this.input.charCodeAt(this.pos + 1);
    if (next >= 48 && next <= 57) return this.readNumber(true);
    let next2 = this.input.charCodeAt(this.pos + 2);
    if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
      this.pos += 3;
      return this.finishToken(types.ellipsis);
    } else {
      ++this.pos;
      return this.finishToken(types.dot);
    }
  };
  pp8.readToken_slash = function() {
    let next = this.input.charCodeAt(this.pos + 1);
    if (this.exprAllowed) {
      ++this.pos;
      return this.readRegexp();
    }
    if (next === 61) return this.finishOp(types.assign, 2);
    return this.finishOp(types.slash, 1);
  };
  pp8.readToken_mult_modulo_exp = function(code) {
    let next = this.input.charCodeAt(this.pos + 1);
    let size = 1;
    let tokentype = code === 42 ? types.star : types.modulo;
    if (this.options.ecmaVersion >= 7 && next === 42) {
      ++size;
      tokentype = types.starstar;
      next = this.input.charCodeAt(this.pos + 2);
    }
    if (next === 61) return this.finishOp(types.assign, size + 1);
    return this.finishOp(tokentype, size);
  };
  pp8.readToken_pipe_amp = function(code) {
    let next = this.input.charCodeAt(this.pos + 1);
    if (next === code) return this.finishOp(code === 124 ? types.logicalOR : types.logicalAND, 2);
    if (next === 61) return this.finishOp(types.assign, 2);
    return this.finishOp(code === 124 ? types.bitwiseOR : types.bitwiseAND, 1);
  };
  pp8.readToken_caret = function() {
    let next = this.input.charCodeAt(this.pos + 1);
    if (next === 61) return this.finishOp(types.assign, 2);
    return this.finishOp(types.bitwiseXOR, 1);
  };
  pp8.readToken_plus_min = function(code) {
    let next = this.input.charCodeAt(this.pos + 1);
    if (next === code) {
      if (next == 45 && this.input.charCodeAt(this.pos + 2) == 62 && lineBreak.test(this.input.slice(this.lastTokEnd, this.pos))) {
        this.skipLineComment(3);
        this.skipSpace();
        return this.nextToken();
      }
      return this.finishOp(types.incDec, 2);
    }
    if (next === 61) return this.finishOp(types.assign, 2);
    return this.finishOp(types.plusMin, 1);
  };
  pp8.readToken_lt_gt = function(code) {
    let next = this.input.charCodeAt(this.pos + 1);
    let size = 1;
    if (next === code) {
      size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
      if (this.input.charCodeAt(this.pos + size) === 61) return this.finishOp(types.assign, size + 1);
      return this.finishOp(types.bitShift, size);
    }
    if (next == 33 && code == 60 && this.input.charCodeAt(this.pos + 2) == 45 && this.input.charCodeAt(this.pos + 3) == 45) {
      if (this.inModule) this.unexpected();
      this.skipLineComment(4);
      this.skipSpace();
      return this.nextToken();
    }
    if (next === 61) size = 2;
    return this.finishOp(types.relational, size);
  };
  pp8.readToken_eq_excl = function(code) {
    let next = this.input.charCodeAt(this.pos + 1);
    if (next === 61) return this.finishOp(types.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
    if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
      this.pos += 2;
      return this.finishToken(types.arrow);
    }
    return this.finishOp(code === 61 ? types.eq : types.prefix, 1);
  };
  pp8.getTokenFromCode = function(code) {
    switch (code) {
      // The interpretation of a dot depends on whether it is followed
      // by a digit or another two dots.
      case 46:
        return this.readToken_dot();
      // Punctuation tokens.
      case 40:
        ++this.pos;
        return this.finishToken(types.parenL);
      case 41:
        ++this.pos;
        return this.finishToken(types.parenR);
      case 59:
        ++this.pos;
        return this.finishToken(types.semi);
      case 44:
        ++this.pos;
        return this.finishToken(types.comma);
      case 91:
        ++this.pos;
        return this.finishToken(types.bracketL);
      case 93:
        ++this.pos;
        return this.finishToken(types.bracketR);
      case 123:
        ++this.pos;
        return this.finishToken(types.braceL);
      case 125:
        ++this.pos;
        return this.finishToken(types.braceR);
      case 58:
        ++this.pos;
        return this.finishToken(types.colon);
      case 63:
        ++this.pos;
        return this.finishToken(types.question);
      case 96:
        if (this.options.ecmaVersion < 6) break;
        ++this.pos;
        return this.finishToken(types.backQuote);
      case 48:
        let next = this.input.charCodeAt(this.pos + 1);
        if (next === 120 || next === 88) return this.readRadixNumber(16);
        if (this.options.ecmaVersion >= 6) {
          if (next === 111 || next === 79) return this.readRadixNumber(8);
          if (next === 98 || next === 66) return this.readRadixNumber(2);
        }
      // Anything else beginning with a digit is an integer, octal
      // number, or float.
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        return this.readNumber(false);
      // Quotes produce strings.
      case 34:
      case 39:
        return this.readString(code);
      // Operators are parsed inline in tiny state machines. '=' (61) is
      // often referred to. `finishOp` simply skips the amount of
      // characters it is given as second argument, and returns a token
      // of the type given by its first argument.
      case 47:
        return this.readToken_slash();
      case 37:
      case 42:
        return this.readToken_mult_modulo_exp(code);
      case 124:
      case 38:
        return this.readToken_pipe_amp(code);
      case 94:
        return this.readToken_caret();
      case 43:
      case 45:
        return this.readToken_plus_min(code);
      case 60:
      case 62:
        return this.readToken_lt_gt(code);
      case 61:
      case 33:
        return this.readToken_eq_excl(code);
      case 126:
        return this.finishOp(types.prefix, 1);
    }
    this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
  };
  pp8.finishOp = function(type, size) {
    let str = this.input.slice(this.pos, this.pos + size);
    this.pos += size;
    return this.finishToken(type, str);
  };
  function tryCreateRegexp(src, flags, throwErrorAt, parser) {
    try {
      return new RegExp(src, flags);
    } catch (e) {
      if (throwErrorAt !== void 0) {
        if (e instanceof SyntaxError) parser.raise(throwErrorAt, "Error parsing regular expression: " + e.message);
        throw e;
      }
    }
  }
  var regexpUnicodeSupport = !!tryCreateRegexp("\uFFFF", "u");
  pp8.readRegexp = function() {
    let escaped, inClass, start = this.pos;
    for (; ; ) {
      if (this.pos >= this.input.length) this.raise(start, "Unterminated regular expression");
      let ch = this.input.charAt(this.pos);
      if (lineBreak.test(ch)) this.raise(start, "Unterminated regular expression");
      if (!escaped) {
        if (ch === "[") inClass = true;
        else if (ch === "]" && inClass) inClass = false;
        else if (ch === "/" && !inClass) break;
        escaped = ch === "\\";
      } else escaped = false;
      ++this.pos;
    }
    let content = this.input.slice(start, this.pos);
    ++this.pos;
    let mods = this.readWord1();
    let tmp = content;
    if (mods) {
      let validFlags = /^[gim]*$/;
      if (this.options.ecmaVersion >= 6) validFlags = /^[gimuy]*$/;
      if (!validFlags.test(mods)) this.raise(start, "Invalid regular expression flag");
      if (mods.indexOf("u") >= 0 && !regexpUnicodeSupport) {
        tmp = tmp.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_match, code, offset) => {
          code = Number("0x" + code);
          if (code > 1114111) this.raise(start + offset + 3, "Code point out of bounds");
          return "x";
        });
        tmp = tmp.replace(/\\u([a-fA-F0-9]{4})|[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "x");
      }
    }
    let value = null;
    if (!isRhino) {
      tryCreateRegexp(tmp, void 0, start, this);
      value = tryCreateRegexp(content, mods);
    }
    return this.finishToken(types.regexp, { pattern: content, flags: mods, value });
  };
  pp8.readInt = function(radix, len) {
    let start = this.pos, total = 0;
    for (let i = 0, e = len == null ? Infinity : len; i < e; ++i) {
      let code = this.input.charCodeAt(this.pos), val;
      if (code >= 97) val = code - 97 + 10;
      else if (code >= 65) val = code - 65 + 10;
      else if (code >= 48 && code <= 57) val = code - 48;
      else val = Infinity;
      if (val >= radix) break;
      ++this.pos;
      total = total * radix + val;
    }
    if (this.pos === start || len != null && this.pos - start !== len) return null;
    return total;
  };
  pp8.readRadixNumber = function(radix) {
    this.pos += 2;
    let val = this.readInt(radix);
    if (val == null) this.raise(this.start + 2, "Expected number in radix " + radix);
    if (isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");
    return this.finishToken(types.num, val);
  };
  pp8.readNumber = function(startsWithDot) {
    let start = this.pos, isFloat = false, octal = this.input.charCodeAt(this.pos) === 48;
    if (!startsWithDot && this.readInt(10) === null) this.raise(start, "Invalid number");
    let next = this.input.charCodeAt(this.pos);
    if (next === 46) {
      ++this.pos;
      this.readInt(10);
      isFloat = true;
      next = this.input.charCodeAt(this.pos);
    }
    if (next === 69 || next === 101) {
      next = this.input.charCodeAt(++this.pos);
      if (next === 43 || next === 45) ++this.pos;
      if (this.readInt(10) === null) this.raise(start, "Invalid number");
      isFloat = true;
    }
    if (isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");
    let str = this.input.slice(start, this.pos), val;
    if (isFloat) val = parseFloat(str);
    else if (!octal || str.length === 1) val = parseInt(str, 10);
    else if (/[89]/.test(str) || this.strict) this.raise(start, "Invalid number");
    else val = parseInt(str, 8);
    return this.finishToken(types.num, val);
  };
  pp8.readCodePoint = function() {
    let ch = this.input.charCodeAt(this.pos), code;
    if (ch === 123) {
      if (this.options.ecmaVersion < 6) this.unexpected();
      let codePos = ++this.pos;
      code = this.readHexChar(this.input.indexOf("}", this.pos) - this.pos);
      ++this.pos;
      if (code > 1114111) this.raise(codePos, "Code point out of bounds");
    } else {
      code = this.readHexChar(4);
    }
    return code;
  };
  function codePointToString(code) {
    if (code <= 65535) return String.fromCharCode(code);
    code -= 65536;
    return String.fromCharCode((code >> 10) + 55296, (code & 1023) + 56320);
  }
  pp8.readString = function(quote) {
    let out = "", chunkStart = ++this.pos;
    for (; ; ) {
      if (this.pos >= this.input.length) this.raise(this.start, "Unterminated string constant");
      let ch = this.input.charCodeAt(this.pos);
      if (ch === quote) break;
      if (ch === 92) {
        out += this.input.slice(chunkStart, this.pos);
        out += this.readEscapedChar(false);
        chunkStart = this.pos;
      } else {
        if (isNewLine(ch)) this.raise(this.start, "Unterminated string constant");
        ++this.pos;
      }
    }
    out += this.input.slice(chunkStart, this.pos++);
    return this.finishToken(types.string, out);
  };
  pp8.readTmplToken = function() {
    let out = "", chunkStart = this.pos;
    for (; ; ) {
      if (this.pos >= this.input.length) this.raise(this.start, "Unterminated template");
      let ch = this.input.charCodeAt(this.pos);
      if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) {
        if (this.pos === this.start && this.type === types.template) {
          if (ch === 36) {
            this.pos += 2;
            return this.finishToken(types.dollarBraceL);
          } else {
            ++this.pos;
            return this.finishToken(types.backQuote);
          }
        }
        out += this.input.slice(chunkStart, this.pos);
        return this.finishToken(types.template, out);
      }
      if (ch === 92) {
        out += this.input.slice(chunkStart, this.pos);
        out += this.readEscapedChar(true);
        chunkStart = this.pos;
      } else if (isNewLine(ch)) {
        out += this.input.slice(chunkStart, this.pos);
        ++this.pos;
        switch (ch) {
          case 13:
            if (this.input.charCodeAt(this.pos) === 10) ++this.pos;
          case 10:
            out += "\n";
            break;
          default:
            out += String.fromCharCode(ch);
            break;
        }
        if (this.options.locations) {
          ++this.curLine;
          this.lineStart = this.pos;
        }
        chunkStart = this.pos;
      } else {
        ++this.pos;
      }
    }
  };
  pp8.readEscapedChar = function(inTemplate) {
    let ch = this.input.charCodeAt(++this.pos);
    ++this.pos;
    switch (ch) {
      case 110:
        return "\n";
      // 'n' -> '\n'
      case 114:
        return "\r";
      // 'r' -> '\r'
      case 120:
        return String.fromCharCode(this.readHexChar(2));
      // 'x'
      case 117:
        return codePointToString(this.readCodePoint());
      // 'u'
      case 116:
        return "	";
      // 't' -> '\t'
      case 98:
        return "\b";
      // 'b' -> '\b'
      case 118:
        return "\v";
      // 'v' -> '\u000b'
      case 102:
        return "\f";
      // 'f' -> '\f'
      case 13:
        if (this.input.charCodeAt(this.pos) === 10) ++this.pos;
      // '\r\n'
      case 10:
        if (this.options.locations) {
          this.lineStart = this.pos;
          ++this.curLine;
        }
        return "";
      default:
        if (ch >= 48 && ch <= 55) {
          let octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
          let octal = parseInt(octalStr, 8);
          if (octal > 255) {
            octalStr = octalStr.slice(0, -1);
            octal = parseInt(octalStr, 8);
          }
          if (octalStr !== "0" && (this.strict || inTemplate)) {
            this.raise(this.pos - 2, "Octal literal in strict mode");
          }
          this.pos += octalStr.length - 1;
          return String.fromCharCode(octal);
        }
        return String.fromCharCode(ch);
    }
  };
  pp8.readHexChar = function(len) {
    let codePos = this.pos;
    let n = this.readInt(16, len);
    if (n === null) this.raise(codePos, "Bad character escape sequence");
    return n;
  };
  pp8.readWord1 = function() {
    this.containsEsc = false;
    let word = "", first = true, chunkStart = this.pos;
    let astral = this.options.ecmaVersion >= 6;
    while (this.pos < this.input.length) {
      let ch = this.fullCharCodeAtPos();
      if (isIdentifierChar(ch, astral)) {
        this.pos += ch <= 65535 ? 1 : 2;
      } else if (ch === 92) {
        this.containsEsc = true;
        word += this.input.slice(chunkStart, this.pos);
        let escStart = this.pos;
        if (this.input.charCodeAt(++this.pos) != 117)
          this.raise(this.pos, "Expecting Unicode escape sequence \\uXXXX");
        ++this.pos;
        let esc = this.readCodePoint();
        if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral))
          this.raise(escStart, "Invalid Unicode escape");
        word += codePointToString(esc);
        chunkStart = this.pos;
      } else {
        break;
      }
      first = false;
    }
    return word + this.input.slice(chunkStart, this.pos);
  };
  pp8.readWord = function() {
    let word = this.readWord1();
    let type = types.name;
    if ((this.options.ecmaVersion >= 6 || !this.containsEsc) && this.keywords.test(word))
      type = keywords2[word];
    return this.finishToken(type, word);
  };

  // ../../acorn/src/index.js
  var version = "3.1.0";
  function parse(input, options) {
    return new Parser(options, input).parse();
  }
  function parseExpressionAt(input, pos, options) {
    let p = new Parser(options, input, pos);
    p.nextToken();
    return p.parseExpression();
  }
  function tokenizer(input, options) {
    return new Parser(options, input);
  }
  return __toCommonJS(index_exports);
})();
