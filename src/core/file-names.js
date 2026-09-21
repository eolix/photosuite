/**
 * File-name and file-size helpers shared by document loading, saving and exporting.
 *
 * A document keeps the name of the file it was opened from, extension and all,
 * so tab titles, the recent-files list and Save-As defaults read the same as
 * the file on disk. The helpers here are the single place where a name is cut
 * into its parts.
 */

/** Matches the final extension of a name, ignoring a leading dot (".gitignore"). */
const EXTENSION_PATTERN = /(?!^)\.[^./\\]+$/;

/**
 * Last segment of a path, for both `/` and `\` separators.
 * `"C:\photos\sun.jpg"` -> `"sun.jpg"`.
 */
export function basenameFromPath(filePath) {
  const segments = String(filePath).split(/[/\\]/);
  return segments[segments.length - 1];
}

/**
 * Extension of a file name, lowercased and without the dot.
 * `"Sun.JPG"` -> `"jpg"`, `"sun"` -> `""`.
 */
export function fileExtension(fileName) {
  const match = EXTENSION_PATTERN.exec(String(fileName));
  return match ? match[0].slice(1).toLowerCase() : "";
}

/**
 * File name without its final extension.
 * `"my.photo.jpg"` -> `"my.photo"`, `"sun"` -> `"sun"`.
 */
export function stripFileExtension(fileName) {
  return String(fileName).replace(EXTENSION_PATTERN, "");
}

/**
 * File name carrying `extension` instead of the one it has.
 * `("sun.jpg", "psd")` -> `"sun.psd"`.
 */
export function replaceFileExtension(fileName, extension) {
  return stripFileExtension(fileName) + "." + extension;
}

/**
 * Format a byte count the way a file listing does: the largest binary unit that
 * keeps the number under 1024, to one decimal place (e.g. `1536` → `"1.5 KB"`).
 */
export function formatByteSize(byteCount) {
  const binaryDigits = byteCount.toString(2);
  let magnitudeExponent = 0;
  while (magnitudeExponent + 10 < binaryDigits.length) magnitudeExponent += 10;
  const scaledSize = (byteCount / Math.pow(2, magnitudeExponent)).toFixed(1);
  const unitLabel = "B KB MB GB TB PB".split(" ")[Math.floor(magnitudeExponent / 10)];
  return scaledSize + " " + unitLabel;
}
