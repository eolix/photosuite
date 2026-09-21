/**
 * File metadata (XMP) inspector dialog.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { Layer } from "../../document/model/layer.js";
import { XMPData } from "../../document/formats/metadata/xmp-metadata.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, clearElement, makeElement } from "../../core/dom.js";
import { iconImgHtml } from "../../assets/icon-registry.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";

function isLowercaseLetter(char) {
  return char === char.toLowerCase();
}

/** Insert spaces before interior capitals in an XMP local name segment. */
function camelCaseXmpLocalName(localNamePart) {
  for (let charIdx = 1; charIdx < localNamePart.length - 1; charIdx++) {
    if (localNamePart[charIdx] === localNamePart[charIdx].toUpperCase()
      && (isLowercaseLetter(localNamePart[charIdx + 1]) || isLowercaseLetter(localNamePart[charIdx - 1]))) {
      localNamePart = localNamePart.slice(0, charIdx) + " " + localNamePart.slice(charIdx);
      charIdx++;
    }
  }
  return localNamePart;
}

/**
 * Metadata groups, in the order they are shown. A key joins the group whose
 * longest prefix it matches, so `exif:GPS` claims its fields before plain
 * `exif`; anything unmatched falls into the first group.
 */
const XMP_SECTIONS = [
  { labelKey: "dialogs.fileInfo.sections.description", prefixes: ["dc:", "tiff:"] },
  { labelKey: "dialogs.fileInfo.sections.camera", prefixes: ["exif:"] },
  { labelKey: "dialogs.fileInfo.sections.location", prefixes: ["exif:GPS"] },
];

/** Index into {@link XMP_SECTIONS} for an XMP key. */
function xmpSectionIndex(xmpFieldKey) {
  let matchedIndex = 0,
    matchedLength = 0;
  for (let sectionIdx = 0; sectionIdx < XMP_SECTIONS.length; sectionIdx++) {
    const prefixes = XMP_SECTIONS[sectionIdx].prefixes;
    for (let prefixIdx = 0; prefixIdx < prefixes.length; prefixIdx++) {
      const prefix = prefixes[prefixIdx];
      if (xmpFieldKey.startsWith(prefix) && prefix.length > matchedLength) {
        matchedIndex = sectionIdx;
        matchedLength = prefix.length;
      }
    }
  }
  return matchedIndex;
}

function FileInfoDialog() {
  BaseDialog.call(this, "file.fileInfo", "finfo");
  this.committedXmpSnapshot = null;
  this.xmpFieldInputsByKey = null;
  this.selectableMissingKeysOrdered = null;
  this.formDiv = makeElement("div", "form scrollable finfo-fields");
  this.body.appendChild(this.formDiv);
  const actionsFooterDiv = makeElement("div", "finfo-actions");
  this.body.appendChild(actionsFooterDiv);
  this.missingFieldDropdown = new Dropdown(null, []);
  actionsFooterDiv.appendChild(this.missingFieldDropdown.el);
  this.addMissingFieldButton = new Button("dialogs.fileInfo.addParameter", false, null, true);
  actionsFooterDiv.appendChild(this.addMissingFieldButton.el);
  this.addMissingFieldButton.on("click", this.addSelectedMissingField, this);
  this.saveXmpButton = new Button("dialogs.fileInfo.saveButton", true, null, true);
  actionsFooterDiv.appendChild(this.saveXmpButton.el);
  this.saveXmpButton.on("click", this.saveXmpChanges, this);
  this.gpsMapQueryString = ""
}
FileInfoDialog.prototype = Object.create(BaseDialog.prototype);
FileInfoDialog.prototype.constructor = FileInfoDialog;
FileInfoDialog.prototype.getOffset = function(dialogWidth, dialogHeight) {
  return dialogWidth < 450 || dialogHeight < 450 ? new Point(0, 0) : new Point(150, 100);
};
FileInfoDialog.prototype.addSelectedMissingField = function(clickEvent) {
  if (this.selectableMissingKeysOrdered.length == 0) return;
  const selectedKey = this.selectableMissingKeysOrdered[this.missingFieldDropdown.getValue()],
    editedFields = this.collectEditableXmpFromInputs();
  editedFields[selectedKey] = XMPData.FIELD_MAP[selectedKey][0];
  this.renderXmpFields(editedFields);
  this.xmpFieldInputsByKey[selectedKey].el.scrollIntoView();
  this.xmpFieldInputsByKey[selectedKey].focusAndSelectAll()
};
FileInfoDialog.prototype.removeMetadataField = function(widgetEvent) {
  const editedFields = this.collectEditableXmpFromInputs();
  delete editedFields[widgetEvent.currentTarget.xmpFieldKey];
  this.renderXmpFields(editedFields)
};
FileInfoDialog.prototype.saveXmpChanges = function(clickEvent) {
  const editedFields = this.collectEditableXmpFromInputs(),
    priorSnapshot = this.committedXmpSnapshot;
  let unchanged = true;
  for (let metadataKey in priorSnapshot)
    if (JSON.stringify(priorSnapshot[metadataKey]) != JSON.stringify(editedFields[metadataKey])) unchanged = false;
  for (let metadataKey in editedFields)
    if (JSON.stringify(priorSnapshot[metadataKey]) != JSON.stringify(editedFields[metadataKey])) unchanged = false;
  if (unchanged) return;
  const dispatchEvent = new AppEvent(EventType.documentAction, true);
  dispatchEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  dispatchEvent.data = {
    actionKind: Layer.updateMetadata,
    xmpMetadataAfter: editedFields
  };
  this.dispatch(dispatchEvent);
  this.committedXmpSnapshot = editedFields;
  this.renderXmpFields(editedFields)
};
FileInfoDialog.formatXmpDisplayName = function(xmpFieldKey) {
  return camelCaseXmpLocalName(xmpFieldKey.split(":").pop());
};
FileInfoDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.committedXmpSnapshot = currentDoc.xmpMetadata;
  this.renderXmpFields(currentDoc.xmpMetadata)
};
FileInfoDialog.prototype.renderXmpFields = function(xmpFieldsByKey) {
  const formDiv = this.formDiv;
  clearElement(formDiv);
  const inputsByKey = this.xmpFieldInputsByKey = {},
    missingKeys = this.selectableMissingKeysOrdered = [],
    missingLabels = [],
    presentKeysBySection = XMP_SECTIONS.map(function() { return []; });

  for (let fieldKey in XMPData.FIELD_MAP) {
    if (xmpFieldsByKey[fieldKey] == null) {
      missingKeys.push(fieldKey);
      missingLabels.push(FileInfoDialog.formatXmpDisplayName(fieldKey));
      continue;
    }
    presentKeysBySection[xmpSectionIndex(fieldKey)].push(fieldKey);
  }

  // Fields are declared interleaved, so they are grouped here rather than
  // relying on declaration order to keep a section contiguous.
  for (let sectionIdx = 0; sectionIdx < XMP_SECTIONS.length; sectionIdx++) {
    const sectionKeys = presentKeysBySection[sectionIdx];
    if (sectionKeys.length == 0) continue;
    const headingEl = makeElement("div", "finfo-section");
    headingEl.textContent = Locale.get(XMP_SECTIONS[sectionIdx].labelKey);
    formDiv.appendChild(headingEl);
    for (let keyIdx = 0; keyIdx < sectionKeys.length; keyIdx++) {
      this.appendXmpFieldRow(formDiv, inputsByKey, sectionKeys[keyIdx], xmpFieldsByKey);
    }
  }

  this.missingFieldDropdown.setItems(missingLabels);
  this.missingFieldDropdown.setValue(0);
  this.addMissingFieldButton.setEnabled(missingLabels.length > 0)
};

/** One editable metadata row: label, value, and a control to drop the field. */
FileInfoDialog.prototype.appendXmpFieldRow = function(formDiv, inputsByKey, fieldKey, xmpFieldsByKey) {
  const displayLabel = FileInfoDialog.formatXmpDisplayName(fieldKey),
    isLongText = fieldKey == "tiff:ImageDescription" || fieldKey == "dc:Keywords",
    textInput = new TextInput(displayLabel, null, null, isLongText ? 3 : null),
    rowEl = makeElement("div", "finfo-field");
  inputsByKey[fieldKey] = textInput;

  let fieldValue = xmpFieldsByKey[fieldKey];
  if (fieldValue instanceof Array) fieldValue = fieldValue[1] == 0 ? "---" : fieldValue[0] + "/" + fieldValue[1];
  textInput.setValue(fieldValue);
  rowEl.appendChild(textInput.el);

  const removeButton = new Button(
    iconImgHtml("cross", "", "autoscale"),
    false,
    "clipboard.delete"
  );
  addClass(removeButton.el, "finfo-remove");
  removeButton.on("click", this.removeMetadataField, this);
  removeButton.xmpFieldKey = fieldKey;
  rowEl.appendChild(removeButton.el);
  formDiv.appendChild(rowEl);

  if (fieldKey == "exif:GPSLongitude" && xmpFieldsByKey["exif:GPSLatitude"]) {
    this.gpsMapQueryString =
      FileInfoDialog.parseExifGpsRationalToDecimal(xmpFieldsByKey["exif:GPSLatitude"]) + "," +
      FileInfoDialog.parseExifGpsRationalToDecimal(xmpFieldsByKey["exif:GPSLongitude"]);
    const mapButton = new Button("dialogs.fileInfo.showOnMap", false, null, true);
    addClass(mapButton.el, "finfo-map");
    mapButton.on("click", this.openGpsCoordinatesOnMap, this);
    formDiv.appendChild(mapButton.el)
  }
};

FileInfoDialog.prototype.collectEditableXmpFromInputs = function() {
  const inputsByKey = this.xmpFieldInputsByKey,
    fieldMap = XMPData.FIELD_MAP,
    collectedFields = {};
  for (let fieldKey in fieldMap) {
    const defaultValue = fieldMap[fieldKey][0],
      defaultType = typeof defaultValue;
    if (defaultValue == null || inputsByKey[fieldKey] == null) continue;
    let rawValue = inputsByKey[fieldKey].getValue();
    const fieldDisplayName = FileInfoDialog.formatXmpDisplayName(fieldKey);
    if (defaultType == "number") {
      rawValue = parseFloat(rawValue);
      if (isNaN(rawValue)) {
        showToast(Locale.get(["dialogs.fileInfo.mustBeNumber", fieldDisplayName]));
        rawValue = defaultValue
      }
    } else if (defaultValue instanceof Array && defaultValue.length == 2) {
      if (rawValue.indexOf("/") == -1) {
        showToast(Locale.get(["dialogs.fileInfo.mustBeFraction", fieldDisplayName]));
        rawValue = defaultValue.slice(0)
      } else {
        rawValue = rawValue.split("/").map(parseFloat);
        if (isNaN(rawValue[0]) || isNaN(rawValue[1])) {
          rawValue = defaultValue.slice(0)
        }
      }
    }
    collectedFields[fieldKey] = rawValue
  }
  return collectedFields
};
FileInfoDialog.parseExifGpsRationalToDecimal = function(gpsRationalString) {
  const strLen = gpsRationalString.length,
    dmsParts = gpsRationalString.slice(0, strLen - 1).split(",").map(parseFloat),
    hemisphere = gpsRationalString.slice(strLen - 1);
  let decimalDegrees = dmsParts[0] + dmsParts[1] / 60 + dmsParts[2] / 3600;
  if (hemisphere != "N" && hemisphere != "E") decimalDegrees = -decimalDegrees;
  return decimalDegrees
};
FileInfoDialog.prototype.openGpsCoordinatesOnMap = function(clickEvent) {
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openTranslateLink,
    link: "https://maps.google.com?q=" + this.gpsMapQueryString
  };
  this.dispatch(dispatchEvent)
};

export { FileInfoDialog };
