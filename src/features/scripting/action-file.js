// Feature: Photoshop actions file (.atn) codec for the Actions panel and
// resource picker. Parses a set/action/step tree and serialises it back.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";
import { DescriptorCodec } from "../../document/formats/psd/descriptor-codec.js";

// Event names stored as a 4-byte "long" FourCC instead of a length-prefixed TEXT.
const LONG_FOURCC_EVENT_NAMES = "LqFy Avrg GEfc PbPl Fbrs Bokh LnCr".split(" ");

function ActionParser() {}

function readUnicodeField(bytes, cursor) {
  const value = BinaryUtils.readUnicodeName(bytes, cursor);
  return {
    value: value,
    cursor: cursor + 4 + value.length * 2 + 2
  };
}

function writeFlagByte(buffer, cursor, flag) {
  buffer.ensureCapacity(cursor, 1);
  buffer.data[cursor] = flag ? 1 : 0;
  return cursor + 1;
}

function usesLongFourCcEventName(eventName) {
  return LONG_FOURCC_EVENT_NAMES.indexOf(eventName) != -1;
}

function readActionStep(bytes, cursor) {
  const step = {};
  step.expanded = bytes[cursor++] == 1;
  step.enabled = bytes[cursor++] == 1;
  step.dialogOptionsEnabled = bytes[cursor++] == 1;
  step.dialogOptions = bytes[cursor++];
  const nameEncoding = BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  if (nameEncoding == "TEXT") {
    step.uf = ActionParser.readLengthPrefixedString(bytes, cursor);
    cursor += 4 + step.uf.length;
  } else if (nameEncoding == "long") {
    step.uf = BinaryUtils.readString(bytes, cursor, 4);
    cursor += 4;
  } else {
    throw new Error("Unknown action step name encoding: " + nameEncoding);
  }
  step.eventClassName = ActionParser.readLengthPrefixedString(bytes, cursor);
  cursor += 4 + step.eventClassName.length;
  const descriptorMarker = BinaryUtils.readInt32BE(bytes, cursor);
  cursor += 4;
  if (descriptorMarker == -1) {
    step.actionDescriptor = {};
    cursor += DescriptorCodec.parseDescriptor(bytes, step.actionDescriptor, cursor);
  }
  return {
    step: step,
    cursor: cursor
  };
}

function writeActionStep(buffer, cursor, step) {
  buffer.ensureCapacity(cursor, 4);
  buffer.data[cursor++] = step.expanded ? 1 : 0;
  buffer.data[cursor++] = step.enabled ? 1 : 0;
  buffer.data[cursor++] = step.dialogOptionsEnabled ? 1 : 0;
  buffer.data[cursor++] = step.dialogOptions;
  const useLongName = usesLongFourCcEventName(step.uf);
  BinaryUtils.writeAscii(buffer, cursor, useLongName ? "long" : "TEXT");
  cursor += 4;
  if (!useLongName) {
    ActionParser.writeLengthPrefixedString(buffer, cursor, step.uf);
    cursor += 4 + step.uf.length;
  } else {
    BinaryUtils.writeAscii(buffer, cursor, step.uf);
    cursor += 4;
  }
  ActionParser.writeLengthPrefixedString(buffer, cursor, step.eventClassName);
  cursor += 4 + step.eventClassName.length;
  BinaryUtils.writeInt32(buffer, cursor, step.actionDescriptor ? -1 : 0);
  cursor += 4;
  if (step.actionDescriptor) {
    cursor += DescriptorCodec.writeDescriptor(buffer, step.actionDescriptor, cursor);
  }
  return cursor;
}

function readAction(bytes, cursor) {
  const action = {};
  action.index = BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  action.shift = bytes[cursor++] == 1;
  action.commandKeyEnabled = bytes[cursor++] == 1;
  action.color = BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  const nameField = readUnicodeField(bytes, cursor);
  action.name = nameField.value;
  cursor = nameField.cursor;
  action.expanded = bytes[cursor++] == 1;
  action.children = [];
  const stepCount = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  for (let stepIdx = 0; stepIdx < stepCount; stepIdx++) {
    const parsedStep = readActionStep(bytes, cursor);
    action.children.push(parsedStep.step);
    cursor = parsedStep.cursor;
  }
  return {
    action: action,
    cursor: cursor
  };
}

function writeAction(buffer, cursor, action) {
  BinaryUtils.writeUint16(buffer, cursor, action.index);
  cursor += 2;
  buffer.ensureCapacity(cursor, 2);
  buffer.data[cursor++] = action.shift ? 1 : 0;
  buffer.data[cursor++] = action.commandKeyEnabled ? 1 : 0;
  BinaryUtils.writeUint16(buffer, cursor, action.color);
  cursor += 2;
  BinaryUtils.writeUnicodeString(buffer, cursor, action.name + "\0");
  cursor += 4 + action.name.length * 2 + 2;
  cursor = writeFlagByte(buffer, cursor, action.expanded);
  const stepCount = action.children.length;
  BinaryUtils.writeSize(buffer, cursor, stepCount);
  cursor += 4;
  for (let stepIdx = 0; stepIdx < stepCount; stepIdx++) {
    cursor = writeActionStep(buffer, cursor, action.children[stepIdx]);
  }
  return cursor;
}

function readActionSet(bytes, cursor) {
  const actionSet = {};
  const nameField = readUnicodeField(bytes, cursor);
  actionSet.name = nameField.value;
  cursor = nameField.cursor;
  actionSet.expanded = bytes[cursor++] == 1;
  actionSet.children = [];
  const actionCount = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  for (let actionIdx = 0; actionIdx < actionCount; actionIdx++) {
    const parsedAction = readAction(bytes, cursor);
    actionSet.children.push(parsedAction.action);
    cursor = parsedAction.cursor;
  }
  return {
    actionSet: actionSet,
    cursor: cursor
  };
}

function writeActionSet(buffer, cursor, actionSet) {
  BinaryUtils.writeSize(buffer, cursor, 16);
  cursor += 4;
  BinaryUtils.writeUnicodeString(buffer, cursor, actionSet.name + "\0");
  cursor += 4 + actionSet.name.length * 2 + 2;
  cursor = writeFlagByte(buffer, cursor, actionSet.expanded);
  const actionCount = actionSet.children.length;
  BinaryUtils.writeSize(buffer, cursor, actionCount);
  cursor += 4;
  for (let actionIdx = 0; actionIdx < actionCount; actionIdx++) {
    cursor = writeAction(buffer, cursor, actionSet.children[actionIdx]);
  }
  return cursor;
}

ActionParser.parse = function(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const parsed = readActionSet(bytes, 4);
  return [parsed.actionSet];
};

ActionParser.readLengthPrefixedString = function(bytes, offset) {
  const strLen = BinaryUtils.readUint32BE(bytes, offset);
  return BinaryUtils.readString(bytes, offset + 4, strLen);
};

ActionParser.writeLengthPrefixedString = function(buf, offset, str) {
  BinaryUtils.writeSize(buf, offset, str.length);
  BinaryUtils.writeAscii(buf, offset + 4, str);
};

ActionParser.serialize = function(actionSet) {
  const buffer = new RenderBuffer;
  let cursor = writeActionSet(buffer, 0, actionSet);
  return buffer.data.slice(0, cursor).buffer;
};

export { ActionParser };
