// Wrapper: expose the parse-exr module as the global `EXRLoader.parse(buffer)`,
// returning Float32 RGBA pixels (FloatType) like the app expects.
import parseExr from "../../parse-exr/index.js";
globalThis.EXRLoader = { parse: function (buffer) { return parseExr(buffer, 1015 /* FloatType */); } };
