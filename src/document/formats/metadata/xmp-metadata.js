// Image metadata interchange. A document's metadata is held as a flat dictionary
// keyed by XMP property names ("dc:Title", "exif:FNumber", …). This module reads
// that dictionary out of, and writes it into, the three containers the codecs
// deal with: TIFF/EXIF IFDs, PSD image-resource blocks, and XMP packet XML.
import { BinaryUtils } from "../../../core/binary/binary-utils.js";

function XMPData() {}

// XMP property → [sample value, EXIF/TIFF tag id, Dublin-Core element].
// The tag id drives EXIF read/write; the DC element drives XMP-packet read/write.
// A null tag/element means that container does not carry the property.
XMPData.FIELD_MAP = {
  "dc:Title": ["", null, "dc:title"],
  "tiff:Artist": ["", 315, "dc:creator"],
  "tiff:ImageDescription": ["", 270, "dc:description"],
  "dc:Keywords": ["", null, "dc:subject"],
  "tiff:Copyright": ["", 33432],
  "tiff:Make": ["", 271],
  "tiff:Model": ["", 272],
  "exif:ExposureTime": [[1, 200], 33434],
  "exif:FNumber": [[16, 1], 33437],
  "exif:ExposureProgram": [1, 34850],
  "exif:ISOSpeedRatings": [200, 34855],
  "exif:DateTimeOriginal": ["", 36867],
  "exif:ShutterSpeedValue": [[1, 1], 37377],
  "exif:ApertureValue": [[8, 1], 37378],
  "exif:ExposureBiasValue": [[1, 1], 37380],
  "exif:MaxApertureValue": [[1, 1], 37381],
  "exif:MeteringMode": [5, 37383],
  "exif:LightSource": [0, 37384],
  "exif:Flash": [0, 37385],
  "exif:FocalLength": [[60, 1], 37386],
  "exif:PixelXDimension": [1, 40962],
  "exif:PixelYDimension": [1, 40963],
  "exif:FocalPlaneXResolution": [[1, 1], 41486],
  "exif:FocalPlaneYResolution": [[1, 1], 41487],
  "exif:FocalPlaneResolutionUnit": [2, 41488],
  "exif:DigitalZoomRatio": [[100, 100], 41988],
  "exif:FocalLengthIn35mmFilm": [1, 41989],
  "exif:SceneCaptureType": [0, 41990],
  "exif:LensInfo": ["", 42034],
  "exif:Lens": ["", 42036],
  "exif:LensSerialNumber": ["", 42037],
  "exif:SensitivityType": [2, 34864],
  "exif:RecommendedExposureIndex": [100, 34866],
  "exif:GPSVersionID": ["2.3.0.0", 0],
  "exif:GPSLatitude": ["48,35,57.646N", 2],
  "exif:GPSLongitude": ["22,56,42.238E", 4],
  "exif:GPSAltitudeRef": [0, 5],
  "exif:GPSAltitude": [[1, 1], 6],
  "exif:GPSStatus": ["A", 9],
  "exif:GPSMapDatum": ["", 18]
};

// PSD image-resource-block id → XMP property carried in that resource.
XMPData.PSD_RESOURCE_FIELDS = {
  "5": "dc:Title",
  "55": "exif:DateTimeOriginal",
  "80": "tiff:Artist",
  "120": "tiff:ImageDescription"
};

// ---------------------------------------------------------------------------
// Rational <-> decimal (EXIF stores rationals as [numerator, denominator])
// ---------------------------------------------------------------------------

XMPData.rationalsToDecimals = function(rationals) {
  var decimals = [];
  for (var i = 0; i < rationals.length; i++)
    decimals[i] = rationals[i][1] == 0 ? 0 : rationals[i][0] / rationals[i][1];
  return decimals;
};

XMPData.decimalsToRationals = function(decimals) {
  var rationals = [];
  for (var i = 0; i < decimals.length; i++) {
    var value = decimals[i], denominator = 1;
    if (value != Math.round(value)) {
      denominator = 1e3;
      value = Math.round(value * denominator);
    }
    rationals[i] = [value, denominator];
  }
  return rationals;
};

// ---------------------------------------------------------------------------
// TIFF / EXIF IFD <-> field dictionary
// ---------------------------------------------------------------------------

XMPData.readExifMetadata = function(ifd, fields) {
  var fieldMap = XMPData.FIELD_MAP;
  if (fields == null) fields = {};
  for (var xmpKey in fieldMap) {
    var exifTag = fieldMap[xmpKey][1],
      tagKey = "t" + exifTag;
    if (exifTag != null && ifd[tagKey] != null) {
      var value = ifd[tagKey];
      if (exifTag == 0) value = value.join(".");
      else if (exifTag == 2 || exifTag == 4) {
        var ref = ifd["t" + (exifTag - 1)];
        if (ref == null) ref = [exifTag == 2 ? "N" : "E"];
        value = XMPData.rationalsToDecimals(value).join(",") + ref[0];
      } else if (exifTag == 42034) value = XMPData.rationalsToDecimals(value).join(" ");
      else if (exifTag == 270 || exifTag == 315) {
        var ascii = value[0],
          asciiBytes = new Uint8Array(ascii.length);
        BinaryUtils.writeAsciiRaw(asciiBytes, 0, ascii);
        value = BinaryUtils.readUtf8(asciiBytes);
      } else value = value[0];
      fields[xmpKey] = value;
    }
  }
  if (ifd.exifIFD) XMPData.readExifMetadata(ifd.exifIFD, fields);
  if (ifd.gpsiIFD) XMPData.readExifMetadata(ifd.gpsiIFD, fields);
  return fields;
};

XMPData.writeExifMetadata = function(fields, ifd, omitTimestamp) {
  var fieldMap = XMPData.FIELD_MAP,
    exifCount = 0,
    gpsCount = 0;
  if (ifd == null) ifd = {};
  var exifIfd = {},
    gpsIfd = {};
  for (var xmpKey in fieldMap) {
    if (fields[xmpKey] == null || fieldMap[xmpKey][1] == null) continue;
    var exifTag = fieldMap[xmpKey][1],
      tagKey = "t" + exifTag,
      targetIfd = ifd;
    if (xmpKey.startsWith("exif:")) {
      targetIfd = exifIfd;
      exifCount++;
      if (xmpKey.startsWith("exif:GPS")) {
        targetIfd = gpsIfd;
        gpsCount++;
      }
    }
    var value = fields[xmpKey];
    if (exifTag == 0) value = new Uint8Array(value.split(".").map(parseFloat));
    else if (exifTag == 2 || exifTag == 4) {
      targetIfd["t" + (exifTag - 1)] = [value.slice(value.length - 1)];
      value = XMPData.decimalsToRationals(value.split(",").map(parseFloat));
    } else if (exifTag == 42034) value = XMPData.decimalsToRationals(value.split(" ").map(parseFloat));
    else if (exifTag == 270 || exifTag == 315) {
      var utf8 = BinaryUtils.encodeUtf8(value);
      value = [BinaryUtils.readString(utf8, 0, utf8.length)];
    } else value = [value];
    targetIfd[tagKey] = value;
  }
  if (exifCount != 0) {
    ifd.exifIFD = exifIfd;
    ifd.t34665 = [0];
  }
  if (gpsCount != 0) {
    ifd.gpsiIFD = gpsIfd;
    ifd.t34853 = [0];
  }
  var now = new Date,
    parts = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()];
  for (var i = 0; i < 6; i++) parts[i] = (parts[i] + "").padStart(2, "0");
  ifd.t305 = ["PhotoSuite (PhotoSuite.app)"];
  if (omitTimestamp != true) ifd.t306 = [parts[0] + ":" + parts[1] + ":" + parts[2] + " " + parts[3] + ":" + parts[4] + ":" + parts[5]];
  return ifd;
};

// ---------------------------------------------------------------------------
// PSD image-resource blocks <-> field dictionary
// ---------------------------------------------------------------------------

XMPData.readPsdResources = function(resources, fields) {
  if (fields == null) fields = {};
  var resourceFields = XMPData.PSD_RESOURCE_FIELDS,
    keywords = [];
  for (var i = 0; i < resources.length; i++) {
    var resource = resources[i],
      xmpKey = resourceFields[resource[0] + ""];
    // Resource id 25 is a keyword (one entry each); every other id maps to a
    // single field. (The original conflated these and dropped the first keyword
    // into an "undefined" field.)
    if (resource[0] == 25) keywords.push(resource[1]);
    else if (xmpKey != null && fields[xmpKey] == null) fields[xmpKey] = resource[1];
  }
  if (keywords.length != 0 && fields["dc:Keywords"] == null) fields["dc:Keywords"] = keywords.join(";");
  return fields;
};

XMPData.writePsdResources = function(fields) {
  var resourceFields = XMPData.PSD_RESOURCE_FIELDS,
    resources = [];
  for (var resourceId in resourceFields)
    if (fields[resourceFields[resourceId]]) resources.push([parseInt(resourceId), fields[resourceFields[resourceId]]]);
  if (fields["dc:Keywords"]) {
    var keywords = fields["dc:Keywords"].split(";");
    for (var i = 0; i < keywords.length; i++) resources.push([25, keywords[i].trim()]);
  }
  return resources;
};

// ---------------------------------------------------------------------------
// XMP packet XML <-> field dictionary
// ---------------------------------------------------------------------------

XMPData.readXmpXml = function(xml, fields) {
  if (fields == null) fields = {};
  var description = new DOMParser().parseFromString(xml, "image/svg+xml").getElementsByTagName("rdf:Description")[0];
  if (description == null) return fields;
  var fieldMap = XMPData.FIELD_MAP;
  for (var xmpKey in fieldMap) {
    var dcElement = fieldMap[xmpKey][2];
    if (dcElement == null) continue;
    var container = description.getElementsByTagName(dcElement)[0];
    if (container == null) continue;
    var items = container.getElementsByTagName("rdf:li"),
      values = [];
    for (var i = 0; i < items.length; i++) values.push(items[i].textContent);
    fields[xmpKey] = values.join("; ");
  }
  return fields;
};

XMPData.writeXmpXml = function(fields) {
  var lines = [
    "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
    "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Adobe XMP Core 5.6-c145 79.163499, 2018/08/13-16:40:22\">",
    "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
    "<rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\" xmlns:stEvt=\"http://ns.adobe.com/xap/1.0/sType/ResourceEvent#\" xmlns:stRef=\"http://ns.adobe.com/xap/1.0/sType/ResourceRef#\">"
  ];
  var fieldMap = XMPData.FIELD_MAP;
  for (var xmpKey in fieldMap) {
    var value = fields[xmpKey],
      dcElement = fieldMap[xmpKey][2],
      containerType = "Seq",
      langAttr = "";
    if (value == null || dcElement == null) continue;
    if (dcElement == "dc:title" || dcElement == "dc:description") {
      containerType = "Alt";
      langAttr = " xml:lang=\"x-default\"";
    }
    if (dcElement == "dc:subject") containerType = "Bag";
    lines.push("\t<" + dcElement + "><rdf:" + containerType + ">");
    var values = dcElement == "dc:subject" ? value.split(";").join(",").split(",") : [value];
    for (var i = 0; i < values.length; i++) lines.push("\t\t<rdf:li" + langAttr + ">" + values[i].trim() + "</rdf:li>");
    lines.push("\t</rdf:" + containerType + "></" + dcElement + ">");
  }
  lines.push("</rdf:Description>", "</rdf:RDF>", "</x:xmpmeta>", "<?xpacket end=\"w\"?>");
  return lines.join("\n");
};

export { XMPData };
