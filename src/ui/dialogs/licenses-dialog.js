/**
 * Licences dialog: the third-party notices shipped with the application.
 *
 * The LGPL asks for its notice to appear in the work itself, not only in a file
 * beside it, so the text a binary recipient needs is reachable from the menu
 * rather than only from the repository. The host reads
 * `THIRD-PARTY-NOTICES.md` out of the bundle's resource directory; this renders
 * it.
 *
 * The rendering is a deliberately small Markdown subset — headings, tables,
 * paragraphs, lists, code blocks, emphasis — because that is all the notices
 * file uses. Every line is HTML-escaped before any of it is applied, and link
 * targets are dropped: an anchor inside the webview would navigate the
 * application away from itself, and the URLs are in the file and the repository
 * for anyone who wants them.
 */

import { BaseDialog } from "./base-dialog.js";
import { escapeHtml, makeElement } from "../../core/dom.js";
import { readThirdPartyNotices } from "../../core/tauri-host.js";

const TABLE_SEPARATOR_ROW = /^\|[\s|:-]+\|$/;

/** Inline spans, applied to already-escaped text. */
function renderInline(escapedText) {
  return escapedText
    // [label](url) — the label alone; see the note at the top of the file.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|\s)_([^_]+)_(?=$|\s|\.|,)/g, "$1<em>$2</em>");
}

function renderTableRow(line, isHeaderRow) {
  const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|");
  const tag = isHeaderRow ? "th" : "td";
  let rowHtml = "<tr>";
  for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
    rowHtml += "<" + tag + ">" + renderInline(cells[cellIdx].trim()) + "</" + tag + ">";
  }
  return rowHtml + "</tr>";
}

/**
 * Render the notices Markdown as HTML.
 * @param {string} markdownText
 * @returns {string}
 */
export function renderNoticesHtml(markdownText) {
  const lines = String(markdownText == null ? "" : markdownText).split(/\r?\n/);
  let html = "";
  let paragraph = [];
  let inCodeBlock = false;
  let inTable = false;
  let tableHasHeader = false;
  let inList = false;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html += "<p>" + renderInline(paragraph.join(" ")) + "</p>";
    paragraph = [];
  }
  function closeTable() {
    if (!inTable) return;
    html += "</table>";
    inTable = false;
    tableHasHeader = false;
  }
  function closeList() {
    if (!inList) return;
    html += "</ul>";
    inList = false;
  }
  function closeBlocks() {
    flushParagraph();
    closeTable();
    closeList();
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        html += "</pre>";
        inCodeBlock = false;
      } else {
        closeBlocks();
        html += "<pre>";
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      html += escapeHtml(rawLine) + "\n";
      continue;
    }
    // HTML comments carry the generated-section markers; they are not content.
    if (line.startsWith("<!--")) continue;
    if (line === "") {
      closeBlocks();
      continue;
    }
    if (line === "---" || line === "***") {
      closeBlocks();
      html += "<hr/>";
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line);
    if (headingMatch) {
      closeBlocks();
      const level = headingMatch[1].length;
      html += "<h" + level + ">" + renderInline(escapeHtml(headingMatch[2])) + "</h" + level + ">";
      continue;
    }

    if (line.startsWith("|")) {
      flushParagraph();
      closeList();
      const escaped = escapeHtml(line);
      if (TABLE_SEPARATOR_ROW.test(line)) {
        // The dashed row only marks the header above it.
        continue;
      }
      if (!inTable) {
        html += "<table>";
        inTable = true;
        tableHasHeader = false;
      }
      html += renderTableRow(escaped, !tableHasHeader);
      tableHasHeader = true;
      continue;
    }
    closeTable();

    if (line.startsWith("- ")) {
      flushParagraph();
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += "<li>" + renderInline(escapeHtml(line.slice(2))) + "</li>";
      continue;
    }
    closeList();

    paragraph.push(escapeHtml(line));
  }

  if (inCodeBlock) html += "</pre>";
  closeBlocks();
  return html;
}

function LicensesDialog() {
  BaseDialog.call(this, "dialogs.licences", "licenses");
  const scrollRoot = this.scrollRoot = makeElement("div", "scrollable");
  scrollRoot.setAttribute("style", "min-width:700px; max-height:500px; padding:1.5em; line-height:1.5em;");
  this.body.appendChild(scrollRoot);
  /** Markdown text once the host has handed it over; null until then. */
  this.noticesMarkdown = null;
}

LicensesDialog.prototype = Object.create(BaseDialog.prototype);
LicensesDialog.prototype.constructor = LicensesDialog;

LicensesDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.renderNotices();
};

LicensesDialog.prototype.open = function() {
  this.renderNotices();
  if (this.noticesMarkdown != null) return;
  const self = this;
  readThirdPartyNotices().then(function(markdownText) {
    self.noticesMarkdown = markdownText;
    self.renderNotices();
  }, function(err) {
    console.error("[licences] could not read the third-party notices:", err);
    self.scrollRoot.innerHTML =
      "<p>The third-party notices could not be read from this installation. " +
      "They are in <code>THIRD-PARTY-NOTICES.md</code> beside the application " +
      "and in the project's source repository.</p>";
  });
};

LicensesDialog.prototype.renderNotices = function() {
  if (this.scrollRoot == null) return;
  this.scrollRoot.innerHTML = this.noticesMarkdown == null
    ? "<p>Loading…</p>"
    : renderNoticesHtml(this.noticesMarkdown);
};

export { LicensesDialog };
