// Expose Mozilla pdf.js's JS image decoders as the global `PDFJS`, matching the
// API the app uses (PDFJS.JpegImage / .JpxImage / .Jbig2Image). Bundled by build.sh.
import { JpegImage } from "../../pdfjs/src/core/jpg.js";
import { JpxImage } from "../../pdfjs/src/core/jpx.js";
import { Jbig2Image } from "../../pdfjs/src/core/jbig2.js";
globalThis.PDFJS = { JpegImage, JpxImage, Jbig2Image };
