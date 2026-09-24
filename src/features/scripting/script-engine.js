/**
 * Interpreter for user scripts: PSD action strings, document script-host
 * payloads and launch scripts. Acorn parses the source and this module walks
 * the AST, so free identifiers resolve through `script-host-context.js` — the
 * script sees the names startup installed there and nothing else.
 */

import { Point } from "../../core/math/point.js";
import { BlendModes } from "../../document/model/blend-modes.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import {
  ensureFormatLoaders,
  hasFormatLoaders,
  lazyFormatIds,
} from "../../document/formats/registry/format-loader-imports.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { ActionDescUtil } from "./action-desc.js";
import { Document } from "../../document/model/document.js";
import { Layer } from "../../document/model/layer.js";
import { AdjustmentEngine } from "../adjustments/adjustment-engine.js";
import { FilterDefs } from "../filters/filter-registry.js";
import { TextEngineData } from "../text/text-engine.js";
import { TextLayout } from "../text/text-layout.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { DocumentWindowDialog } from "../../ui/dialogs/document-input-dialogs.js";
import { FileLoader } from "../../ui/shell/file-loader.js";
import { getScriptHostBinding, hasScriptHostBinding } from "./script-host-context.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { TransformToolBase } from "../../document/transform/transform-static.js";
import { CropToolBase } from "../../document/tools/crop-tools.js";
import { PaintTool } from "../../document/tools/paint-tools.js";
import { SelectTool } from "../../document/tools/selection-tools.js";
import { hexToRgb, rgbToHex } from "../../engine/compositing/color-math.js";
import { toRGBDesc } from "../../engine/compositing/psd-color-utils.js";


/**
 * Names already reported this run. A script that calls an unbound function in a
 * loop should get one banner, not one per iteration.
 */
const reportedUnavailableFunctions = new Set();

/** Tell the user, once per run, that a script called something it cannot reach. */
function reportUnavailableFunction(funcName) {
  console.log("Script called unavailable function " + funcName);
  if (reportedUnavailableFunctions.has(funcName)) return;
  reportedUnavailableFunctions.add(funcName);
  showToast(funcName + "() not available");
}

function createScriptEnvironment() {
  const scriptEnv = JSON.parse(JSON.stringify(ScriptEngine.ScriptEval.scriptBuiltinEnums));
  scriptEnv.__return = false;
  scriptEnv.__break = false;
  scriptEnv.__throw = false;
  scriptEnv.__fs = {};
  scriptEnv.__scriptGlobals = {};
  return scriptEnv;
}

function mapCharIdToActionVerb(charId) {
  const trimmedCharId = charId.trim();
  const typeIdAliasMap = {
    slct: "select",
    Dlt: "delete",
    Mk: "make"
  };
  return typeIdAliasMap[trimmedCharId] ? typeIdAliasMap[trimmedCharId] : trimmedCharId;
}

function mapStringIdToTypeId(stringId) {
  const trimmedStringId = stringId.trim();
  const stringIdAliasMap = {
    red: "Rd",
    blue: "Bl",
    color: "Clr",
    RGBColor: "RGBC",
    type: "Type",
    using: "Usng"
  };
  const mappedStringId = stringIdAliasMap[trimmedStringId];
  return mappedStringId == null ? trimmedStringId : mappedStringId;
}

function evalProgramOrBlock(astNode, doc, env) {
  const bodyStatements = astNode.body;
  for (let stmtIdx = 0; stmtIdx < bodyStatements.length; stmtIdx++) {
    const stmtType = bodyStatements[stmtIdx].type;
    if (stmtType == "FunctionDeclaration") env[bodyStatements[stmtIdx].id.name] = bodyStatements[stmtIdx];
  }
  for (let stmtIdx = 0; stmtIdx < bodyStatements.length; stmtIdx++) {
    const result = ScriptEngine.eval(bodyStatements[stmtIdx], doc, env);
    if (env.__return || env.__break || env.__throw) return result;
  }
}

function ScriptEngine() {}

/**
 * Deferred writers a script might reach for, by the format ids its source
 * mentions. `saveAs("out.psd")` and `{ fileFormatExtension: "psd" }` both name
 * the format in the text, so a word-boundary scan finds it without evaluating
 * anything. It over-approximates on purpose: a stray mention costs one import,
 * while a miss costs the script a writer that is not there when it writes.
 */
function deferredWritersNamedBy(scriptSource) {
  const lowerSource = scriptSource.toLowerCase();
  return lazyFormatIds().filter(
    (formatId) =>
      !hasFormatLoaders(formatId) && new RegExp("\\b" + formatId + "\\b").test(lowerSource),
  );
}

function runParsedScript(astRoot, doc) {
  reportedUnavailableFunctions.clear();
  const scriptEnv = createScriptEnvironment();
  ScriptEngine.eval(astRoot, doc, scriptEnv);
  const virtualFs = scriptEnv.__fs;
  if (Object.keys(virtualFs).length != 0) {
    const zipBytes = globalThis.UZIP.encode(virtualFs);
    FileLoader.save(zipBytes, "output.zip")
  }
}

ScriptEngine.execute = function(scriptSource, doc) {
  const parseStartMs = Date.now();
  let astRoot;
  try {
    astRoot = acorn.parse(scriptSource)
  } catch (parseError) {
    console.log(parseError);
    return
  }
  // `eval` below is synchronous, so there is nowhere inside a script to wait
  // for a writer that arrives on demand. Fetch them first, then run once.
  const deferredWriters = deferredWritersNamedBy(scriptSource);
  if (deferredWriters.length != 0) {
    Promise.all(deferredWriters.map(ensureFormatLoaders)).then(function() {
      runParsedScript(astRoot, doc)
    }, function(err) {
      console.error("[script] could not load a file writer the script needs:", err);
      showToast("Could not run this script: a file format it writes failed to load.", 1e4)
    });
    return
  }
  runParsedScript(astRoot, doc)
};
ScriptEngine.eval = function(astNode, doc, env) {
  const nodeType = astNode.type;
  if (false) {} else if (nodeType == "Program" || nodeType == "BlockStatement") {
    return evalProgramOrBlock(astNode, doc, env);
  } else if (nodeType == "ReturnStatement") {
    env.__return = true;
    return astNode.argument ? ScriptEngine.evaluateExpression(astNode.argument, doc, env) : null;
  } else if (nodeType == "BreakStatement") {
    env.__break = true
  } else if (nodeType == "VariableDeclaration") {
    const declarations = astNode.declarations;
    for (let declIdx = 0; declIdx < declarations.length; declIdx++) ScriptEngine.eval(declarations[declIdx], doc, env)
  } else if (nodeType == "VariableDeclarator") {
    env[astNode.id.name] = astNode.init ? ScriptEngine.evaluateExpression(astNode.init, doc, env) : null
  } else if (nodeType == "FunctionDeclaration") {
    env[astNode.id.name] = astNode
  } else if (nodeType == "MemberExpression") {
    const objectValue = ScriptEngine.evaluateExpression(astNode.object, doc, env);
    const propertyKey = astNode.computed ? ScriptEngine.evaluateExpression(astNode.property, doc, env) : ScriptEngine.eval(astNode.property, doc, env);
    let memberResult;
    if (objectValue.o != null) memberResult = ScriptEngine.ScriptEval.getScriptObjectProperty(objectValue, propertyKey, doc, env);
    else memberResult = objectValue[propertyKey];
    return memberResult
  } else if (nodeType == "ArrayExpression") {
    const arrayResult = [];
    const elements = astNode.elements;
    for (let elemIdx = 0; elemIdx < elements.length; elemIdx++) arrayResult.push(ScriptEngine.evaluateExpression(elements[elemIdx], doc, env));
    return arrayResult
  } else if (nodeType == "ObjectExpression") {
    const objectResult = {};
    const properties = astNode.properties;
    for (let propIdx = 0; propIdx < properties.length; propIdx++) {
      const propertyNode = properties[propIdx];
      const objectKey = properties[propIdx].key.name ? properties[propIdx].key.name : properties[propIdx].key.value;
      objectResult[objectKey] = ScriptEngine.evaluateExpression(properties[propIdx].value, doc, env)
    }
    return objectResult
  } else if (nodeType == "ExpressionStatement") {
    return ScriptEngine.eval(astNode.expression, doc, env);
  } else if (nodeType == "NewExpression") {
    const newCallArgs = astNode.arguments;
    const newCallee = astNode.callee;
    const newCalleeType = newCallee.type;
    const evaluatedNewArgs = [];
    let constructedInstance = null;
    for (let argIdx = 0; argIdx < newCallArgs.length; argIdx++) evaluatedNewArgs.push(ScriptEngine.evaluateExpression(newCallArgs[argIdx], doc, env));
    if (newCalleeType == "Identifier") constructedInstance = ScriptEngine.ScriptEval.constructScriptObject(newCallee.name, evaluatedNewArgs, doc, env);
    else throw new Error("Unsupported new-expression callee type: " + newCalleeType);
    if (constructedInstance == null) throw "new " + newCallee.name;
    return constructedInstance
  } else if (nodeType == "CallExpression") {
    const callArgs = astNode.arguments;
    const callee = astNode.callee;
    const calleeType = callee.type;
    const callEnv = {};
    for (let envKey in env) callEnv[envKey] = env[envKey];
    const evaluatedArgs = [];
    for (let argIdx = 0; argIdx < callArgs.length; argIdx++) evaluatedArgs.push(ScriptEngine.evaluateExpression(callArgs[argIdx], doc, env));
    if (calleeType == "Identifier") {
      const funcName = callee.name;
      const funcDef = env[funcName];
      if (funcDef) {
        if (funcDef.params) {
          const paramNodes = funcDef.params;
          for (let paramIdx = 0; paramIdx < paramNodes.length; paramIdx++) callEnv[paramNodes[paramIdx].name] = evaluatedArgs[paramIdx];
          return ScriptEngine.eval(funcDef.body, doc, callEnv);
        } else {
          return funcDef.apply(null, evaluatedArgs)
        }
      } else if (ScriptEngine.ScriptEval.actionManagerMethodNames.indexOf(funcName) != -1) return ScriptEngine.ScriptEval.invokeScriptObjectMethod({
        o: "Application"
      }, funcName, evaluatedArgs, doc, env);
      else if (!hasScriptHostBinding(funcName)) reportUnavailableFunction(funcName);
      else {
        const hostFunction = getScriptHostBinding(funcName);
        if (typeof hostFunction != "function") reportUnavailableFunction(funcName);
        else return hostFunction.apply(null, evaluatedArgs)
      }
    } else if (calleeType == "MemberExpression") {
      const callObject = ScriptEngine.evaluateExpression(callee.object, doc, env);
      const callPropertyKey = callee.computed ? ScriptEngine.evaluateExpression(callee.property, doc, env) : ScriptEngine.eval(callee.property, doc, env);
      if (callObject.o != null) return ScriptEngine.ScriptEval.invokeScriptObjectMethod(callObject, callPropertyKey, evaluatedArgs, doc, env);
      else return callObject[callPropertyKey].apply(callObject, evaluatedArgs)
    } else if (calleeType == "FunctionExpression") {
      return ScriptEngine.eval(callee.body, doc, env);
    } else console.log(astNode)
  } else if (nodeType == "AssignmentExpression") {
    const assignOp = astNode.operator;
    const assignLeft = astNode.left;
    const leftNodeType = assignLeft.type;
    const leftValue = ScriptEngine.evaluateExpression(assignLeft, doc, env);
    const rightValue = ScriptEngine.evaluateExpression(astNode.right, doc, env);
    let assignResult = null;
    if (false) {} else if (assignOp == "=") assignResult = rightValue;
    else if (assignOp == "+=") assignResult = leftValue + rightValue;
    else if (assignOp == "-=") assignResult = leftValue - rightValue;
    else if (assignOp == "*=") assignResult = leftValue * rightValue;
    else if (assignOp == "/=") assignResult = leftValue / rightValue;
    else if (assignOp == "%=") assignResult = leftValue % rightValue;
    else if (assignOp == "&=") assignResult = leftValue & rightValue;
    else if (assignOp == "|=") assignResult = leftValue | rightValue;
    else if (assignOp == "&&=") assignResult = leftValue && rightValue;
    else if (assignOp == "||=") assignResult = leftValue || rightValue;
    else console.log(astNode);
    if (leftNodeType == "Identifier") {
      const varName = assignLeft.name;
      if (env.hasOwnProperty(varName)) env[varName] = assignResult;
      else env.__scriptGlobals[varName] = assignResult
    } else if (leftNodeType == "MemberExpression") {
      const memberKey = ScriptEngine.eval(assignLeft.property, doc, env);
      const memberObject = ScriptEngine.evaluateExpression(assignLeft.object, doc, env);
      if (memberObject.o != null) ScriptEngine.ScriptEval.setScriptObjectProperty(memberObject, memberKey, assignResult, doc, env);
      else memberObject[memberKey] = assignResult
    } else console.log(astNode)
  } else if (nodeType == "Identifier") return astNode.name;
  else if (nodeType == "Literal") return astNode.value;
  else if (nodeType == "UpdateExpression") {
    const updateOp = astNode.operator;
    const updateVarName = astNode.argument.name;
    const updateOperand = ScriptEngine.evaluateExpression(astNode.argument, doc, env);
    if (false) {} else if (updateOp == "++") {
      env[updateVarName]++;
      return astNode.prefix ? env[updateVarName] : env[updateVarName] - 1
    } else if (updateOp == "--") {
      env[updateVarName]--;
      return astNode.prefix ? env[updateVarName] : env[updateVarName] + 1
    } else console.log(astNode)
  } else if (nodeType == "UnaryExpression") {
    const unaryOp = astNode.operator;
    const unaryOperand = ScriptEngine.evaluateExpression(astNode.argument, doc, env);
    if (unaryOperand.o == "UnitValue") {
      if (unaryOp == "-") return -unaryOperand.value;
      else return ScriptEngine.applyUnaryOperator(unaryOperand.value, unaryOp);
    } else return ScriptEngine.applyUnaryOperator(unaryOperand, unaryOp);
  } else if (nodeType == "BinaryExpression" || nodeType == "LogicalExpression") {
    const binaryOp = astNode.operator;
    const leftOperand = ScriptEngine.evaluateExpression(astNode.left, doc, env);
    const rightOperand = ScriptEngine.evaluateExpression(astNode.right, doc, env);
    if (leftOperand == null || rightOperand == null) return ScriptEngine.applyBinaryOperator(leftOperand, rightOperand, binaryOp);
    else if (leftOperand.o == "UnitValue" && rightOperand.o == "UnitValue") return ScriptEngine.applyBinaryOperator(leftOperand.value, rightOperand.value, binaryOp);
    else if (leftOperand.o == "UnitValue") return ScriptEngine.applyBinaryOperator(leftOperand.value, rightOperand, binaryOp);
    else if (rightOperand.o == "UnitValue") {
      if (binaryOp == "-") return -(leftOperand - rightOperand.value);
      else return ScriptEngine.applyBinaryOperator(leftOperand, rightOperand.value, binaryOp);
    } else return ScriptEngine.applyBinaryOperator(leftOperand, rightOperand, binaryOp);
  } else if (nodeType == "IfStatement" || nodeType == "ConditionalExpression") {
    const testResult = ScriptEngine.evaluateExpression(astNode.test, doc, env);
    if (testResult) return ScriptEngine.eval(astNode.consequent, doc, env);
    else if (astNode.alternate) return ScriptEngine.eval(astNode.alternate, doc, env);
  } else if (nodeType == "ForInStatement") {
    ScriptEngine.eval(astNode.left, doc, env);
    const forInVarName = astNode.left.declarations[0].id.name;
    const forInIterable = ScriptEngine.evaluateExpression(astNode.right, doc, env);
    for (let iterableKey in forInIterable) {
      env[forInVarName] = iterableKey;
      var loopResult = ScriptEngine.eval(astNode.body, doc, env);
      if (env.__break) break;
      if (env.__return) return loopResult
    }
    env.__break = false
  } else if (nodeType == "ForStatement") {
    ScriptEngine.eval(astNode.init, doc, env);
    while (ScriptEngine.eval(astNode.test, doc, env)) {
      var loopResult = ScriptEngine.eval(astNode.body, doc, env);
      if (env.__break) break;
      if (env.__return) return loopResult;
      ScriptEngine.eval(astNode.update, doc, env)
    }
    env.__break = false
  } else if (nodeType == "DoWhileStatement") {
    do {
      var loopResult = ScriptEngine.eval(astNode.body, doc, env);
      if (env.__break) break;
      if (env.__return) return loopResult
    } while (ScriptEngine.eval(astNode.test, doc, env));
    env.__break = false
  } else if (nodeType == "TryStatement") {
    ScriptEngine.eval(astNode.block, doc, env);
    if (env.__throw) {
      const catchClause = astNode.handler;
      env[catchClause.param.name] = env.__throw;
      env.__throw = false;
      ScriptEngine.eval(catchClause.body, doc, env);
      delete env[catchClause.param.name]
    }
  } else if (nodeType == "EmptyStatement") {} else console.log(astNode)
};
ScriptEngine.applyBinaryOperator = function(left, right, operator) {
  if (operator == "+") return left + right;
  else if (operator == "-") return left - right;
  else if (operator == "*") return left * right;
  else if (operator == "/") return left / right;
  else if (operator == "%") return left % right;
  else if (operator == "^") return left ^ right;
  else if (operator == "&") return left & right;
  else if (operator == "&&") return left && right;
  else if (operator == "|") return left | right;
  else if (operator == "||") return left || right;
  else if (operator == "<") return left < right;
  else if (operator == ">") return left > right;
  else if (operator == "==") return left == right;
  else if (operator == "<=") return left <= right;
  else if (operator == ">=") return left >= right;
  else if (operator == "!=") return left != right;
  else if (operator == "!==") return left !== right;
  else if (operator == "<<") return left << right;
  else if (operator == ">>") return left >> right;
  else console.log(operator)
};
ScriptEngine.applyUnaryOperator = function(operand, operator) {
  if (operator == "-") return -operand;
  else if (operator == "!") return !operand;
  else if (operator == "~") return ~operand;
  else if (operator == "+") return operand;
  else console.log(operator)
};
ScriptEngine.evaluateExpression = function(astNode, doc, env) {
  const nodeType = astNode.type;
  if (nodeType == "Identifier") return ScriptEngine.resolveIdentifier(astNode.name, doc, env);
  else return ScriptEngine.eval(astNode, doc, env);
};
ScriptEngine.resolveIdentifier = function(name, doc, env) {
  if (name == "undefined") return undefined;
  else if (env.hasOwnProperty(name)) return env[name];
  else if (name == "app") return {
    o: "Application"
  };
  else if (name == "$") return {
    o: "$"
  };
  else if (ScriptEngine.ScriptEval.applicationPropertyNames.indexOf(name) != -1) return ScriptEngine.ScriptEval.getScriptObjectProperty({
    o: "Application"
  }, name, doc, env);
  else if (name == "window" || name == "globalThis") return env.__scriptGlobals;
  else if (hasScriptHostBinding(name)) return getScriptHostBinding(name);
  else {
    env[name] = null;
    return null
  }
};
ScriptEngine.ScriptEval = {};
ScriptEngine.ScriptEval.constructScriptObject = function(className, args, doc, env) {
  let scriptWrapper;
  if (className == "SolidColor") scriptWrapper = {
    o: className,
    value: [1, 0, 0, 0]
  };
  if (className == "RGBColor") scriptWrapper = {
    o: className,
    value: [1, 0, 0, 0]
  };
  if (className == "Window") scriptWrapper = {
    o: className,
    value: new DocumentWindowDialog(args[0], args[1], args[2])
  };
  if (className == "ExportOptionsSaveForWeb") scriptWrapper = {
    o: className,
    value: {
      fileFormatExtension: "png",
      cc: 100
    }
  };
  if (className == "JPEGSaveOptions") scriptWrapper = {
    o: className,
    value: {
      fileFormatExtension: "jpg",
      cc: 100
    }
  };
  if (className == "File") scriptWrapper = {
    o: className,
    value: args[0]
  };
  if (className == "ActionReference") scriptWrapper = {
    o: className,
    value: []
  };
  if (className == "ActionDescriptor") scriptWrapper = {
    o: className,
    value: {}
  };
  if (className == "ActionList") scriptWrapper = {
    o: className,
    value: []
  };
  if (className == "UnitValue") scriptWrapper = {
    o: className,
    value: args.length == 0 ? 0 : parseFloat(args[0])
  };
  return scriptWrapper
};
ScriptEngine.ScriptEval.applicationPropertyNames = "activeDocument documents fonts preferences displayDialogs foregroundColor backgroundColor".split(" ");
ScriptEngine.ScriptEval.actionManagerMethodNames = ["charIDToTypeID", "stringIDToTypeID", "executeAction", "executeActionGet", "doAction"];
ScriptEngine.ScriptEval.getScriptObjectProperty = function(scriptObj, propertyName, doc, env) {
  const appData = doc.appData;
  const currentDoc = doc.getCurrentDoc();
  if (false) {} else if (propertyName == "typename") {
    if (scriptObj.o == "Layer") return scriptObj.value.isGroup() ? "LayerSet" : "ArtLayer";
    else return scriptObj.o
  } else if (["Document", "Layer"].indexOf(scriptObj.o) != -1 && ["layers", "artLayers", "layerSets"].indexOf(propertyName) != -1) {
    let layerSectionNode = currentDoc.root;

    const layersCollection = {
      o: "Layers",
      cb: propertyName,
      value: []
    };

    if (scriptObj.o == "Layer") layerSectionNode = currentDoc.root.getSectionByIndex(currentDoc.layers.indexOf(scriptObj.value));
    if (layerSectionNode.children == null) return null;
    for (let childIdx = 0; childIdx < layerSectionNode.children.length; childIdx++) {
      const childLayer = layerSectionNode.children[childIdx].layer;
      const isLayerGroup = childLayer.isGroup();
      if (isLayerGroup && propertyName == "artLayers" || !isLayerGroup && propertyName == "layerSets") continue;
      layersCollection.value.push({
        o: "Layer",
        value: childLayer
      })
    }
    layersCollection.value.reverse();
    return layersCollection
  } else if (scriptObj.o == "Documents" || scriptObj.o == "Layers" || scriptObj.o == "HistoryStates") {
    if (false) {} else if (propertyName == "length") return scriptObj.value.length;
    else if (Number.isInteger(propertyName)) return scriptObj.value[propertyName];
    else console.log(scriptObj.o + ": unknown property ", propertyName)
  } else if (scriptObj.o == "Application") {
    if (false) {} else if (propertyName == "activeDocument") return {
      o: "Document",
      value: doc.getCurrentDoc()
    };
    else if (propertyName == "documents") {
      const documentsCollection = {
        o: "Documents",
        value: []
      };
      for (let docIdx = 0; docIdx < doc.openDocs.length; docIdx++) documentsCollection.value.push({
        o: "Document",
        value: doc.openDocs[docIdx]
      });
      return documentsCollection
    } else if (propertyName == "fonts") return {
      o: "TextFonts"
    };
    else if (propertyName == "preferences") return {
      o: "Preferences"
    };
    else if (propertyName == "displayDialogs") return {
      o: "DialogModes"
    };
    else if (propertyName == "foregroundColor" || propertyName == "backgroundColor") {
      const colorInt = propertyName[0] == "f" ? appData.colorInt : appData.bgColor;
      return {
        o: "SolidColor",
        value: [1, (colorInt >>> 16 & 255) / 255, (colorInt >>> 8 & 255) / 255, (colorInt >>> 0 & 255) / 255]
      };
    } else if (propertyName == "UI") return {
      o: "UI"
    };
    else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "Document") {
    const targetDocument = scriptObj.value;
    if (false) {} else if (propertyName == "activeLayer") {
      const activeLayer = targetDocument.layers[targetDocument.selectedLayerIndices[0]];
      return {
        o: "Layer",
        value: activeLayer
      };
    } else if (propertyName == "resolution") return targetDocument.dpi;
    else if (propertyName == "width") return targetDocument.width;
    else if (propertyName == "height") return targetDocument.height;
    else if (propertyName == "name") return targetDocument.name;
    else if (propertyName == "saved") return !targetDocument.isModified();
    else if (propertyName == "selection") return {
      o: "Selection"
    };
    else if (propertyName == "activeHistoryState") return {
      o: "HistoryState",
      idx: targetDocument.historyIndex
    };
    else if (propertyName == "source") return targetDocument.sourceUrl;
    else if (propertyName == "historyStates") {
      const historyStateEntries = [];
      for (let historyIdx = 0; historyIdx < targetDocument.history.length; historyIdx++) historyStateEntries.push({
        o: "HistoryState",
        idx: historyIdx
      });
      return {
        o: "HistoryStates",
        value: historyStateEntries
      };
    } else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "Layer") {
    const lockBitMap = {
        transparentPixelsLocked: 0,
        pixelsLocked: 1,
        positionLocked: 2,
        allLocked: 31
      };

    const layer = scriptObj.value;
    if (false) {} else if (propertyName == "visible") return layer.isVisible();
    else if (propertyName == "selected") return currentDoc.selectedLayerIndices.indexOf(currentDoc.layers.indexOf(layer)) != -1;
    else if (propertyName == "grouped") return layer.isClippingMask;
    else if (lockBitMap[propertyName] != null) return layer.isLockBitSet(lockBitMap[propertyName]);
    else if (propertyName == "opacity") return layer.Opct * 100 / 255;
    else if (propertyName == "blendMode") return layer.blendMode;
    else if (propertyName == "name") return layer.getName();
    else if (propertyName == "textItem") return {
      o: "TextItem",
      value: layer
    };
    else if (propertyName == "bounds") {
      const selectionRect = TransformToolBase.getSelectionRect(currentDoc, [currentDoc.layers.indexOf(layer)]);
      return ScriptEngine.ScriptEval.rectToBoundsArray(selectionRect, currentDoc);
    } else if (propertyName == "parent") {
      const openDocsList = doc.openDocs;
      for (let docIdx = 0; docIdx < openDocsList.length; docIdx++)
        if (openDocsList[docIdx].layers.indexOf(layer) != -1) return {
          o: "Document",
          value: openDocsList[docIdx]
        };
    } else if (propertyName == "kind") {
      const fillResourceKeys = ScriptEngine.ScriptEval.layerFillResourceKeys;
      for (let childIdx = 0; childIdx < fillResourceKeys.length; childIdx++)
        if (layer.add[fillResourceKeys[childIdx]] != null) return childIdx;
      return 0
    } else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "Selection") {
    if (false) {} else if (propertyName == "bounds") return ScriptEngine.ScriptEval.rectToBoundsArray(doc.getCurrentDoc().selectionMask.rect, currentDoc);
    else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "TextItem") {
    const tyShDescriptor = scriptObj.value.add.TySh;
    const engineData = tyShDescriptor.engineData;
    const layerText = TextEngineData.getLayerText(engineData);
    const textScale = tyShDescriptor.transform.getScale();
    const textStyle = TextEngineData.getTextStyle(engineData, 0, Math.max(0, layerText.length - 2));
    if (propertyName == "contents") return layerText.slice(0, layerText.length - 1).replace(/\n/g, "\r");
    else if (propertyName == "font") return textStyle.textStyle.Font != null ? textStyle.fontSet[textStyle.textStyle.Font].Name : null;
    else if (propertyName == "size") return ScriptEngine.ScriptEval.makeUnitValue(textStyle.textStyle.FontSize * textScale, currentDoc);
    else if (propertyName == "leading") return ScriptEngine.ScriptEval.makeUnitValue(textStyle.textStyle.Leading * textScale, currentDoc);
    else if (propertyName == "tracking") return ScriptEngine.ScriptEval.makeUnitValue(textStyle.textStyle.Tracking);
    else if (propertyName == "baselineShift") return ScriptEngine.ScriptEval.makeUnitValue(textStyle.textStyle.BaselineShift);
    else if (propertyName == "fauxBold") return textStyle.textStyle.FauxBold;
    else if (propertyName == "fauxItalic") return textStyle.textStyle.FauxItalic;
    else if (propertyName == "kind") return 1 - TextEngineData.getTextType(engineData);
    else if (propertyName == "useAutoLeading") return textStyle.paraStyle.AutoLeading;
    else if (propertyName == "hyphenation") return textStyle.paraStyle.AutoHyphenate;
    else if (propertyName == "justification") return ScriptEngine.ScriptEval.makeUnitValue(textStyle.paraStyle.Justification);
    else if (propertyName == "color") return {
      o: "SolidColor",
      value: textStyle.textStyle.FillColor.Values.slice(0)
    };
    else if (propertyName == "width" || propertyName == "height") {
      const boxBounds = TextEngineData.getBoxBounds(engineData);
      const boxWidth = (boxBounds[2] - boxBounds[0]) * textScale;
      const boxHeight = (boxBounds[3] - boxBounds[1]) * textScale;
      return ScriptEngine.ScriptEval.makeUnitValue(propertyName == "width" ? boxWidth : boxHeight, currentDoc);
    } else if (propertyName == "position") {
      const textTransform = tyShDescriptor.transform;
      return ScriptEngine.ScriptEval.coordsToUnitValues([textTransform.tx, textTransform.ty], currentDoc);
    } else if (propertyName == "horizontalScale" || propertyName == "verticalScale") {
      const scalePropName = propertyName[0].toUpperCase() + propertyName.slice(1);
      return Math.round(textStyle.textStyle[scalePropName] * 100);
    } else if (propertyName == "antiAliasMethod") TextEngineData.getAntiAliasMode(tyShDescriptor);
    else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "Preferences") {
    if (propertyName == "rulerUnits") return appData.prefs.AppWindow;
    else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "SolidColor") {
    if (propertyName == "rgb") return {
      o: "RGBColor",
      value: scriptObj.value
    };
    else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "RGBColor") {
    const redByte = Math.round(255 * scriptObj.value[1]);
    const greenByte = Math.round(255 * scriptObj.value[2]);
    const blueByte = Math.round(255 * scriptObj.value[3]);
    if (false) {} else if (propertyName == "red") return redByte;
    else if (propertyName == "green") return greenByte;
    else if (propertyName == "blue") return blueByte;
    else if (propertyName == "hexValue") return "#" + rgbToHex(redByte << 16 | greenByte << 8 | blueByte).toUpperCase();
    else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "UnitValue") {
    if (propertyName == "value") return scriptObj.value;
    else throw new Error("Unsupported UnitValue property: " + propertyName)
  } else if (scriptObj.o == "ExportOptionsSaveForWeb") {
    if (propertyName == "format") return scriptObj.value.fileFormatExtension;
    else if (propertyName == "PNG8") return false;
    else if (propertyName == "quality") return scriptObj.value.cc;
    else throw new Error("Unsupported ExportOptionsSaveForWeb property: " + propertyName)
  } else if (scriptObj.o == "JPEGSaveOptions") {
    return 0
  } else console.log(scriptObj, propertyName)
};
ScriptEngine.ScriptEval.rectToBoundsArray = function(rect, doc) {
  return ScriptEngine.ScriptEval.coordsToUnitValues([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height], doc);
};
ScriptEngine.ScriptEval.coordsToUnitValues = function(coords, doc) {
  const unitValues = [];
  for (let coordIdx = 0; coordIdx < coords.length; coordIdx++) unitValues.push(ScriptEngine.ScriptEval.makeUnitValue(coords[coordIdx], doc));
  return unitValues
};
ScriptEngine.ScriptEval.unwrapScriptObjectValues = function(scriptObjects) {
  const values = [];
  for (let scriptObjIdx = 0; scriptObjIdx < scriptObjects.length; scriptObjIdx++) values.push(scriptObjects[scriptObjIdx].o ? scriptObjects[scriptObjIdx].value : scriptObjects[scriptObjIdx]);
  return values
};
ScriptEngine.ScriptEval.makeUnitValue = function(value, doc) {
  return {
    o: "UnitValue",
    value: value
  };
};
ScriptEngine.ScriptEval.unwrapUnitValue = function(value, doc) {
  if (value.o == "UnitValue") return value.value;
  return value
};
ScriptEngine.ScriptEval.setScriptObjectProperty = function(scriptObj, propertyName, value, doc, env) {
  const documentActionEvent = new AppEvent(EventType.documentAction, true);
  const uiDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  const currentDoc = doc.getCurrentDoc();
  const appData = doc.appData;
  if (false) {} else if (scriptObj.o == "Application") {
    if (false) {} else if (propertyName == "activeDocument") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.focusDocumentTab,
        openedDocument: value.value
      };
      doc.dispatch(uiDispatchEvent)
    } else if (propertyName == "displayDialogs") {} else console.log(scriptObj, propertyName, value)
  } else if (scriptObj.o == "Document") {
    const targetDocument = scriptObj.value;
    if (false) {} else if (propertyName == "name") {
      documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
      documentActionEvent.data = {
        actionKind: Layer.renameDocument,
        documentBaseName: value,
        skipHistoryPush: true,
        targetDocument: targetDocument
      };
      currentDoc.panelsDirty = true
    } else if (propertyName == "source") targetDocument.sourceUrl = value;
    else if (propertyName == "activeLayer") {
      targetDocument.selectedLayerIndices = [targetDocument.layers.indexOf(value.value)]
    } else if (propertyName == "activeHistoryState") {
      documentActionEvent.routingChannel = EventChannel.EVENT_HISTORY;
      documentActionEvent.data = {
        actionKind: "h_itemchange",
        index: value.idx
      }
    } else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "Layer") {
    documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;

    const lockBitMap = {
        transparentPixelsLocked: 0,
        pixelsLocked: 1,
        positionLocked: 2,
        allLocked: 31
      };

    const layer = scriptObj.value;
    const layerIndex = currentDoc.layers.indexOf(layer);
    if (false) {} else if (propertyName == "visible") {
      if (layer.isVisible() != value) documentActionEvent.data = {
        actionKind: Layer.toggleVisibility,
        layerIndex: layerIndex
      }
    } else if (propertyName == "opacity") {
      documentActionEvent.data = {
        actionKind: Layer.setLayerOpacity,
        layerIndex: layerIndex,
        layerPropertyValue: Math.round(255 * value / 100)
      }
    } else if (propertyName == "blendMode") {
      documentActionEvent.data = {
        actionKind: Layer.setBlendMode,
        layerIndex: layerIndex,
        layerPropertyValue: BlendModes.psdCodes.indexOf(value)
      }
    } else if (propertyName == "name") {
      documentActionEvent.data = {
        actionKind: Layer.renameLayer,
        layerIndex: layerIndex,
        name: value
      }
    } else if (lockBitMap[propertyName] != null) {
      documentActionEvent.data = {
        actionKind: Layer.toggleLayerLocks,
        layerIndex: layerIndex,
        layerPropertyValue: [
          [value],
          [lockBitMap[propertyName]]
        ]
      }
    } else if (propertyName == "kind") {
      documentActionEvent.data = {
        actionKind: Layer.setLayerType,
        layerIndex: layerIndex,
        newLayerTypeKey: ScriptEngine.ScriptEval.layerFillResourceKeys[value]
      }
    } else if (propertyName == "grouped") {
      documentActionEvent.data = {
        actionKind: Layer.toggleClippingMask,
        layerIndex: layerIndex,
        layerPropertyValue: value
      }
    } else console.log(scriptObj, propertyName, value)
  } else if (scriptObj.o == "TextItem") {
    documentActionEvent.routingChannel = ToolId.TOOL_TYPE;
    const textLayer = scriptObj.value;
    const tyShDescriptor = textLayer.add.TySh;
    const engineDataCopy = JSON.parse(JSON.stringify(tyShDescriptor.engineData));
    const transformClone = tyShDescriptor.transform.clone();
    const textScale = tyShDescriptor.transform.getScale();
    const layerText = TextEngineData.getLayerText(engineDataCopy);
    const textStyle = TextEngineData.getTextStyle(engineDataCopy, 0, layerText.length - 2);
    let styleDirty = false;
    if (false) {} else if (propertyName == "contents") {
      TextEngineData.deleteText(engineDataCopy, 0, layerText.length - 1);
      TextEngineData.insertText(engineDataCopy, 0, value.replace(/\r/g, "\n"))
    } else if (propertyName == "size") {
      textStyle.textStyle.FontSize = (value.value != null ? value.value : value) / textScale;
      styleDirty = true
    } else if (propertyName == "leading") {
      textStyle.textStyle.Leading = (value.value != null ? value.value : value) / textScale;
      styleDirty = true
    } else if (propertyName == "tracking") {
      textStyle.textStyle.Tracking = value.value != null ? value.value : value;
      styleDirty = true
    } else if (propertyName == "baselineShift") {
      textStyle.textStyle.BaselineShift = value.value != null ? value.value : value;
      styleDirty = true
    } else if (propertyName == "fauxBold") {
      textStyle.textStyle.FauxBold = value;
      styleDirty = true
    } else if (propertyName == "fauxItalic") {
      textStyle.textStyle.FauxItalic = value;
      styleDirty = true
    } else if (propertyName == "kind") {
      const textType = TextEngineData.getTextType(engineDataCopy);
      if (textType == 1 && value == 1) {
        const paragraphStyle = new TextLayout(engineDataCopy, doc.appData.fontRegistry).paraStyle[0];
        const runEnd = paragraphStyle.nodes[0].end;
        const wordRunEnd = paragraphStyle.wordRuns[runEnd - 1].end;
        TextEngineData.deleteText(engineDataCopy, 0, layerText.length - 1);
        TextEngineData.insertText(engineDataCopy, 0, layerText.slice(0, wordRunEnd - 1))
      }
      if (textType == value) TextEngineData.setTextType(engineDataCopy, 1 - value)
    } else if (propertyName == "useAutoLeading") {
      textStyle.paraStyle.AutoLeading = value;
      styleDirty = true
    } else if (propertyName == "hyphenation") {
      textStyle.paraStyle.AutoHyphenate = value;
      styleDirty = true
    } else if (propertyName == "justification") {
      textStyle.paraStyle.Justification = value;
      styleDirty = true
    } else if (propertyName == "font") {
      TextEngineData.setTextFont(textStyle, value);
      styleDirty = true
    } else if (propertyName == "color") {
      textStyle.textStyle.FillColor.Values = value.value.slice(0);
      styleDirty = true
    } else if (propertyName == "width" || propertyName == "height") {
      const boxBounds = TextEngineData.getBoxBounds(engineDataCopy).slice(0);
      const unwrappedValue = ScriptEngine.ScriptEval.unwrapUnitValue(value);
      if (propertyName == "width") boxBounds[2] = Math.round(boxBounds[0] + unwrappedValue / textScale);
      else boxBounds[3] = Math.round(boxBounds[1] + unwrappedValue / textScale);
      TextEngineData.setBoxBounds(engineDataCopy, boxBounds)
    } else if (propertyName == "position") {
      transformClone.tx = value[0];
      transformClone.ty = value[1]
    } else if (propertyName == "horizontalScale" || propertyName == "verticalScale") {
      const scalePropName = propertyName[0].toUpperCase() + propertyName.slice(1);
      textStyle.textStyle[scalePropName] = value / 100;
      styleDirty = true
    } else if (propertyName == "antiAliasMethod") TextEngineData.setAntiAliasMode(tyShDescriptor, value);
    else console.log(scriptObj, propertyName, value);
    if (styleDirty) TextEngineData.applyStyle(engineDataCopy, 0, layerText.length - 1, textStyle);
    documentActionEvent.data = {
      actionKind: "newED",
      targetLayerIndex: currentDoc.layers.indexOf(textLayer),
      engineData: engineDataCopy,
      transformMatrix: transformClone
    }
  } else if (scriptObj.o == "Preferences") {
    if (false) {} else if (propertyName == "rulerUnits") {
      const prefsCopy = JSON.parse(JSON.stringify(appData.prefs));
      prefsCopy.AppWindow = value;
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.openResourcePresetPopup,
        popupType: PopupTypes.PREFERENCES,
        prefsSnapshot: prefsCopy
      };
      doc.dispatch(uiDispatchEvent)
    } else console.log(scriptObj, propertyName, value)
  } else if (scriptObj.o == "SolidColor") {
    if (propertyName == "rgb") scriptObj.value = value.value;
    else throw new Error("Unsupported SolidColor property: " + propertyName)
  } else if (scriptObj.o == "RGBColor") {
    if (false) {} else if (propertyName == "red") scriptObj.value[1] = value / 255;
    else if (propertyName == "green") scriptObj.value[2] = value / 255;
    else if (propertyName == "blue") scriptObj.value[3] = value / 255;
    else if (propertyName == "hexValue") {
      const parsedHexRgb = hexToRgb(value.slice(1));
      scriptObj.value[1] = (parsedHexRgb >>> 16 & 255) / 255;
      scriptObj.value[2] = (parsedHexRgb >>> 8 & 255) / 255;
      scriptObj.value[3] = (parsedHexRgb >>> 0 & 255) / 255
    } else console.log(scriptObj, propertyName)
  } else if (scriptObj.o == "ExportOptionsSaveForWeb") {
    if (propertyName == "format") scriptObj.value.fileFormatExtension = value;
    else if (propertyName == "PNG8") {} else if (propertyName == "quality") scriptObj.value.cc = value;
    else throw new Error("Unsupported ExportOptionsSaveForWeb property: " + propertyName)
  } else if (scriptObj.o == "JPEGSaveOptions") {
    if (propertyName == "quality") scriptObj.value.cc = Math.round(100 * value / 12)
  } else console.log(scriptObj, propertyName, value);
  if (documentActionEvent.data != null) doc.dispatch(documentActionEvent)
};
ScriptEngine.ScriptEval.invokeScriptObjectMethod = function(scriptObj, methodName, args, doc, env) {
  const scriptClassName = scriptObj.o;
  let methodReturnValue = null;
  const documentActionEvent = new AppEvent(EventType.documentAction, true);
  const historyGroupedEvent = new AppEvent(EventType.historyGrouped, true);
  const uiDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  const currentDoc = doc.getCurrentDoc();
  const openDocsList = doc.openDocs;
  if (false) {} else if (scriptClassName == "Application") {
    if (false) {} else if (methodName == "charIDToTypeID") {
      return mapCharIdToActionVerb(args[0]);
    } else if (methodName == "stringIDToTypeID") {
      return mapStringIdToTypeId(args[0]);
    } else if (methodName == "executeAction") {
      console.log(args);
      let descriptorPayload;
      if (args[1]) {
        descriptorPayload = args[1].value;
        descriptorPayload.classID = args[0]
      }

      const actionAliasMap = {
          setd: "set"
        };

      let resolvedActionId = actionAliasMap[args[0]];
      if (resolvedActionId == null) resolvedActionId = args[0];
      const adjustmentWireKey = AdjustmentEngine.descriptorKeyMap[args[0]];
      if (adjustmentWireKey && AdjustmentEngine.eventNames[adjustmentWireKey]) resolvedActionId = AdjustmentEngine.eventNames[adjustmentWireKey];
      historyGroupedEvent.data = {
        uf: resolvedActionId,
        actionDescriptor: descriptorPayload
      }
    } else if (methodName == "executeActionGet") {
      return {
        o: "ActionDescriptor",
        value: {
          classID: "null",
          null: {
            t: "obj ",
            v: args[0].value
          }
        }
      };
    } else if (methodName == "doAction") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.replayRecordedActionPair,
        recordedActionPair: [args[0], args[1]]
      }
    } else if (methodName == "open") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.importFromUrl,
        importSpec: {
          url: args[0]
        }
      };
      if (args[2] && openDocsList.length != 0) uiDispatchEvent.data.importSpec.placeIntoDocIndex = openDocsList.indexOf(currentDoc)
    } else if (methodName == "echoToOE") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.postClipboardEmbedMessage,
        embedMessage: args[0]
      }
    } else console.log(methodName)
  } else if (scriptClassName == "Document") {
    const targetDocument = scriptObj.value;
    if (false) {} else if (methodName == "crop") {
      historyGroupedEvent.data = CropToolBase.buildCropAction(args[0])
    } else if (methodName == "trim") {
      const trimSides = [];
      for (let sideIdx = 0; sideIdx < 4; sideIdx++) trimSides.push(args[sideIdx + 1] != null ? args[sideIdx + 1] : true);
      historyGroupedEvent.data = CropToolBase.buildTrimAction(args[0] != null ? args[0] : 0, trimSides)
    } else if (methodName == "suspendHistory") {
      const suspendHistoryAst = acorn.parse(args[1]);
      ScriptEngine.eval(suspendHistoryAst, doc, env)
    } else if (methodName == "save") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.saveOrCommitDocument
      }
    } else if (methodName == "saveToOE") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.saveOrCommitDocument,
        activeChannelEncodeArgs: args
      }
    } else if (methodName == "rotateCanvas") {
      historyGroupedEvent.data = TransformToolBase.buildRotateOrFlipAction(true, args[0])
    } else if (methodName == "resizeImage" || methodName == "resizeCanvas") {
      let resizeWidth = args[0];
      let resizeHeight = args[1];
      if (typeof resizeWidth != "number") {
        resizeWidth = targetDocument.width * parseFloat(resizeWidth.slice(0, resizeWidth.length - 1)) / 100;
        resizeHeight = targetDocument.height * parseFloat(resizeHeight.slice(0, resizeHeight.length - 1)) / 100
      }
      if (methodName == "resizeCanvas") historyGroupedEvent.data = CropToolBase.buildCanvasSizeAction(Math.round(resizeWidth), Math.round(resizeHeight), args[2]);
      else historyGroupedEvent.data = CropToolBase.buildImageSizeAction(Math.round(resizeWidth), Math.round(resizeHeight), null, 1)
    } else if (methodName == "paste") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.clipboardPasteLayers,
        pasteIntoSelection: args.length != 0 && args[0]
      }
    } else if (methodName == "close") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.focusDocumentTabByIndex,
        targetDocument: targetDocument
      }
    } else if (methodName == "exportDocument" || methodName == "saveAs") {
      const virtualFs = env.__fs;
      const exportPath = args[0].value.replace(":", "").replace("~/", "");
      const exportOptions = methodName == "exportDocument" ? args[2].value : args[1].value;
      const encodedBytes = FileFormatRegistry.encodeDocument(targetDocument, exportOptions.fileFormatExtension, null, null, [exportOptions.cc], doc.appData);
      virtualFs[exportPath] = new Uint8Array(encodedBytes)
    } else console.log(scriptObj, methodName, args)
  } else if (scriptClassName == "Layer") {
    const layer = scriptObj.value;
    const layerIndex = currentDoc.layers.indexOf(layer);
    if (false) {} else if (methodName == "copy") {
      ScriptEngine.ScriptEval.stashSelectionForLayerOp(currentDoc, doc, 0);
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.clipboardCopyLayers,
        copyMerged: args[0],
        layerIndex: layerIndex
      };
      doc.dispatch(uiDispatchEvent);
      delete uiDispatchEvent.data;
      ScriptEngine.ScriptEval.stashSelectionForLayerOp(currentDoc, doc, 1)
    } else if (methodName == "clear") {
      ScriptEngine.ScriptEval.stashSelectionForLayerOp(currentDoc, doc, 0);
      historyGroupedEvent.data = {
        uf: "delete"
      };
      doc.dispatch(historyGroupedEvent);
      delete historyGroupedEvent.data;
      ScriptEngine.ScriptEval.stashSelectionForLayerOp(currentDoc, doc, 1)
    } else if (methodName == "duplicate") {
      if (args.length == 0) {
        documentActionEvent.data = {
          actionKind: Layer.duplicateLayer,
          layerIndex: layerIndex
        };
        documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
        doc.dispatch(documentActionEvent);
        documentActionEvent.data = null;
        methodReturnValue = {
          o: "Layer",
          value: currentDoc.layers[currentDoc.selectedLayerIndices[0]]
        }
      } else if (args[0].o == "Document") {
        documentActionEvent.data = {
          actionKind: Layer.pasteLayers,
          layersToInsert: currentDoc.duplicateLayers(layerIndex),
          sourceDocument: currentDoc,
          targetDocument: args[0].value
        };
        documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT
      }
    } else if (methodName == "merge" || methodName == "remove") {
      documentActionEvent.data = {
        actionKind: methodName == "merge" ? Layer.mergeDown : Layer.deleteLayer,
        layerIndex: layerIndex
      };
      documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
      if (methodName != "remove") methodReturnValue = {
        o: "Layer",
        value: currentDoc.layers[currentDoc.selectedLayerIndices[0]]
      }
    } else if (methodName == "move") {
      documentActionEvent.data = {
        actionKind: Layer.moveLayer,
        source: layerIndex,
        target: currentDoc.layers.indexOf(args[0].value),
        dropPositionRatio: args[1] != 3 ? .6 : .3
      };
      documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT
    } else if (methodName == "rasterize") {
      historyGroupedEvent.data = {
        uf: "rasterizeLayer",
        actionDescriptor: {
          classID: "rasterizeLayer",
          null: ActionDescUtil.buildTargetRef("Lyr", true)
        }
      }
    } else if (methodName == "rotate") {
      documentActionEvent.data = {
        actionKind: "rot",
        historyLabelKey: "edit.rotate",
        gestureValue: -args[0] * Math.PI / 180,
        transformAnchorIndex: args[1],
        targetLayerIndex: layerIndex
      };
      documentActionEvent.routingChannel = ToolId.TOOL_FREE_TRANSFORM
    } else if (methodName == "resize") {
      documentActionEvent.data = {
        actionKind: "scl",
        historyLabelKey: "edit.transform",
        gestureValue: new Point(args[0] / 100, args[1] / 100),
        transformAnchorIndex: args[2],
        targetLayerIndex: layerIndex
      };
      documentActionEvent.routingChannel = ToolId.TOOL_FREE_TRANSFORM
    } else if (methodName == "translate") {
      const unwrappedTranslateArgs = ScriptEngine.ScriptEval.unwrapScriptObjectValues(args);
      documentActionEvent.data = {
        actionKind: "trsl",
        layerIndex: layerIndex,
        translateDeltaX: unwrappedTranslateArgs[0],
        translateDeltaY: unwrappedTranslateArgs[1]
      };
      documentActionEvent.routingChannel = ToolId.TOOL_MOVE
    } else if (methodName == "link") {
      documentActionEvent.data = {
        actionKind: Layer.linkLayers,
        linkLayerIndices: [layerIndex, currentDoc.layers.indexOf(args[0].value)]
      };
      documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT
    } else if (methodName == "invert") {
      documentActionEvent.routingChannel = EventChannel.EVENT_ADJUSTMENT;
      documentActionEvent.data = {
        actionKind: "start",
        adjustmentKey: "nvrt"
      }
    } else if (methodName.startsWith("apply") && FilterDefs.scriptNameToFourCc[methodName.slice(5)]) {
      const unwrappedFilterArgs = ScriptEngine.ScriptEval.unwrapScriptObjectValues(args);
      const filterFourCc = FilterDefs.scriptNameToFourCc[methodName.slice(5)];
      historyGroupedEvent.data = {
        uf: FilterDefs.filterScriptKeys[filterFourCc]
      };
      const filterDescriptor = FilterDefs.create(filterFourCc);
      if (filterDescriptor) {
        FilterDefs.filterPresetDeserialize[filterFourCc](filterDescriptor, unwrappedFilterArgs);
        historyGroupedEvent.data.actionDescriptor = filterDescriptor
      }
    } else console.log(scriptObj, methodName, args)
  } else if (scriptClassName == "Documents") {
    if (methodName == "getByName") {
      for (let docIdx = 0; docIdx < openDocsList.length; docIdx++)
        if (openDocsList[docIdx].name == args[0]) return {
          o: "Document",
          value: openDocsList[docIdx]
        };
      return null
    } else if (methodName == "add") {
      let backgroundFillIndex = args[5];
      if (backgroundFillIndex == null) backgroundFillIndex = 1;
      historyGroupedEvent.data = Document.buildMakeDocumentEvent(args[0], args[1], args[2], args[3], ["Wht", "Trns", "BckC"][backgroundFillIndex])
    } else throw new Error("Unsupported document creation arguments")
  } else if (scriptClassName == "Layers") {
    if (methodName == "getByName") {
      for (let layerListIdx = 0; layerListIdx < scriptObj.value.length; layerListIdx++)
        if (scriptObj.value[layerListIdx].value.getName() == args[0]) {
          methodReturnValue = scriptObj.value[layerListIdx];
          break
        } if (methodReturnValue == null) env.__throw = {
        message: "No layer with a name " + args[0]
      }
    } else if (methodName == "add") {
      documentActionEvent.data = {
        actionKind: scriptObj.cb == "layerSets" ? Layer.newFolder : Layer.newLayer
      };
      documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
      doc.dispatch(documentActionEvent);
      documentActionEvent.data = null;
      methodReturnValue = {
        o: "Layer",
        value: currentDoc.layers[currentDoc.selectedLayerIndices[0]]
      }
    } else console.log(scriptObj, methodName, args)
  } else if (scriptObj.o == "Selection") {
    if (methodName == "select") {
      const polygonPointPairs = args[0];
      const flatPolygonCoords = [];
      for (let polygonPairIdx = 0; polygonPairIdx < polygonPointPairs.length; polygonPairIdx++) flatPolygonCoords.push(polygonPointPairs[polygonPairIdx][0], polygonPointPairs[polygonPairIdx][1]);
      historyGroupedEvent.data = SelectTool.buildPolygonSelectionAction(flatPolygonCoords)
    } else if (methodName == "selectAll") {
      historyGroupedEvent.data = SelectTool.buildSelectAllAction(true)
    } else if (methodName == "invert") {
      historyGroupedEvent.data = {
        uf: "inverse"
      }
    } else if (methodName == "copy") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.clipboardCopyLayers
      }
    } else if (methodName == "deselect") {
      historyGroupedEvent.data = SelectTool.buildSelectAllAction()
    } else if (methodName == "fill") {
      let fillRgbDescriptor = args[0].value;
      fillRgbDescriptor = toRGBDesc({
        h: fillRgbDescriptor[1] * 255,
        l: fillRgbDescriptor[2] * 255,
        O: fillRgbDescriptor[3] * 255
      });
      historyGroupedEvent.data = PaintTool.buildFillAction("Clr", args[1], args[2] == null ? 1 : args[2] / 100, fillRgbDescriptor)
    } else console.log(scriptObj, methodName, args)
  } else if (scriptObj.o == "Window") {
    if (methodName == "show") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: scriptObj.value
      }
    } else throw new Error("Unsupported dialog invocation")
  } else if (scriptObj.o == "ActionReference") {
    if (methodName == "putProperty") {
      scriptObj.value.push({
        t: "prop",
        v: {
          classID: args[0],
          keyID: args[1]
        }
      })
    } else if (methodName == "putClass") {
      scriptObj.value.push({
        t: "Clss",
        v: {
          classID: args[0]
        }
      })
    } else if (methodName == "putEnumerated") {
      scriptObj.value.push({
        t: "Enmr",
        v: {
          classID: args[0],
          typeID: args[1],
          enum: args[2]
        }
      })
    } else console.log(methodName, args)
  } else if (scriptObj.o == "ActionDescriptor" || scriptObj.o == "ActionList") {
    if (methodName == "putReference") {
      scriptObj.value[args[0]] = {
        t: "obj ",
        v: args[1].value
      }
    } else if (methodName == "putDouble") {
      scriptObj.value[args[0]] = {
        t: "doub",
        v: args[1]
      }
    } else if (methodName == "putUnitDouble") {
      scriptObj.value[args[0]] = {
        t: "UntF",
        v: {
          type: args[1],
          val: args[2]
        }
      }
    } else if (methodName == "putObject") {
      if (scriptObj.o == "ActionList") {
        var nestedDescriptorObject = args[1].value;
        nestedDescriptorObject.classID = args[0];
        scriptObj.value.push({
          t: "Objc",
          v: nestedDescriptorObject
        })
      } else {
        var nestedDescriptorObject = args[2].value;
        nestedDescriptorObject.classID = args[1];
        scriptObj.value[args[0]] = {
          t: "Objc",
          v: nestedDescriptorObject
        }
      }
    } else if (methodName == "putList") {
      scriptObj.value[args[0]] = {
        t: "VlLs",
        v: args[1].value
      }
    } else if (methodName == "putBoolean") {
      scriptObj.value[args[0]] = {
        t: "bool",
        v: args[1]
      }
    } else if (methodName == "putInteger") {
      scriptObj.value[args[0]] = {
        t: "long",
        v: args[1]
      }
    } else if (methodName == "putString") {
      scriptObj.value[args[0]] = {
        t: "TEXT",
        v: args[1]
      }
    } else if (methodName == "putEnumerated") {
      const enumValueMap = {};
      enumValueMap[args[1]] = args[2];
      scriptObj.value[args[0]] = {
        t: "enum",
        v: enumValueMap
      }
    } else if (methodName == "hasKey") {
      const propertyRefList = scriptObj.value.null.v;
      for (let propertyRefIdx = 0; propertyRefIdx < propertyRefList.length; propertyRefIdx++) {
        if (propertyRefList[propertyRefIdx].v.keyID == args[0]) {
          if (args[0] == "UsrM") {
            return currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() != null;
          } else throw args
        }
      }
    } else console.log(methodName, args)
  } else if (scriptObj.o == "$") {
    if (methodName == "writeln") {
      console.log(args[0])
    } else throw methodName
  } else if (scriptObj.o == "UI") {
    let zoomUiPayload;
    if (methodName == "zoomIn" || methodName == "zoomOut") {
      zoomUiPayload = {
        actionKind: "zoom",
        zoomInOnGesture: methodName == "zoomIn"
      }
    } else if (methodName == "fitTheArea") {
      zoomUiPayload = {
        actionKind: "adapt",
        adaptTarget: "fitscr"
      }
    } else if (methodName == "pixelToPixel") {
      zoomUiPayload = {
        actionKind: "adapt",
        adaptTarget: "pixel"
      }
    }
    documentActionEvent.routingChannel = ToolId.TOOL_ZOOM;
    documentActionEvent.data = zoomUiPayload
  } else console.log(scriptObj, methodName, args);
  if (documentActionEvent.data) doc.dispatch(documentActionEvent);
  if (historyGroupedEvent.data) doc.dispatch(historyGroupedEvent);
  if (uiDispatchEvent.data) doc.dispatch(uiDispatchEvent);
  return methodReturnValue
};
ScriptEngine.ScriptEval.stashSelectionForLayerOp = function(doc, appContext, mode) {
  const selectDocumentEvent = new AppEvent(EventType.documentAction, true);
  selectDocumentEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
  const historyGroupedEvent = new AppEvent(EventType.historyGrouped, true);
  if (mode == 0) {
    ScriptEngine.ScriptEval.savedSelectionSnapshot = doc.selectionMask;
    historyGroupedEvent.data = SelectTool.buildSelectAllAction(true)
  } else {
    const savedSelection = ScriptEngine.ScriptEval.savedSelectionSnapshot;
    if (savedSelection) selectDocumentEvent.data = {
      actionKind: "setsel",
      historyLabelKey: "Restore Selection",
      selectionMask: {
        rect: savedSelection.rect.clone(),
        channel: savedSelection.channel.slice(0)
      }
    };
    else historyGroupedEvent.data = SelectTool.buildSelectAllAction()
  }
  appContext.dispatch(selectDocumentEvent.data ? selectDocumentEvent : historyGroupedEvent)
};
ScriptEngine.ScriptEval.savedSelectionSnapshot = null;
ScriptEngine.ScriptEval.scriptBuiltinEnums = {
  AnchorPosition: {
    TOPLEFT: 0,
    TOPCENTER: 1,
    TOPRIGHT: 2,
    MIDDLELEFT: 3,
    MIDDLECENTER: 4,
    MIDDLERIGHT: 5,
    BOTTOMLEFT: 6,
    BOTTOMCENTER: 7,
    BOTTOMRIGHT: 8
  },
  Units: {
    PIXELS: 0,
    INCHES: 1,
    CM: 2,
    MM: 3,
    PERCENT: 4,
    PICAS: 5,
    POINTS: 6
  },
  ElementPlacement: {
    INSIDE: 0,
    PLACEATBEGINNING: 1,
    PLACEATEND: 2,
    PLACEBEFORE: 3,
    PLACEAFTER: 4
  },
  LayerKind: {
    NORMAL: 0,
    SMARTOBJECT: 1,
    TEXT: 2,
    SOLIDFILL: 3,
    GRADIENTFILL: 4,
    PATTERNFILL: 5
  },
  RippleSize: {
    SMALL: 0,
    MEDIUM: 1,
    LARGE: 2
  },
  PolarConversionType: {
    POLARTORECTANGULAR: 1,
    RECTANGULARTOPOLAR: 0
  },
  OffsetUndefinedAreas: {
    REPEATEDGEPIXELS: 0,
    SETTOBACKGROUND: 1,
    WRAPAROUND: 2
  },
  NoiseDistribution: {
    GAUSSIAN: 0,
    UNIFORM: 1
  },
  TextType: {
    PARAGRAPHTEXT: 0,
    POINTTEXT: 1
  },
  DialogModes: {
    ALL: 0,
    ERROR: 1,
    NO: 2
  },
  SaveOptions: {
    DONOTSAVECHANGES: 0,
    PROMPTTOSAVECHANGES: 1,
    SAVECHANGES: 2
  },
  SaveDocumentType: {
    PNG: "png",
    JPEG: "jpg",
    COMPUSERVEGIF: "gif"
  },
  ExportType: {
    SAVEFORWEB: 0
  },
  MatteType: {
    BACKGROUND: 0,
    BLACK: 1,
    FOREGROUND: 2,
    NETSCAPE: 3,
    NONE: 4,
    SEMIGRAY: 5,
    WHITE: 6
  },
  FormatOptions: {
    OPTIMIZEDBASELINE: 0,
    PROGRESSIVE: 1,
    STANDARDBASELINE: 3
  },
  DocumentMode: {
    RGB: 0
  },
  NewDocumentMode: {
    RGB: 0
  },
  DocumentFill: {
    WHITE: 0,
    TRANSPARENT: 1,
    BACKGROUNDCOLOR: 2
  },
  TrimType: {
    TOPLEFT: 0,
    BOTTOMRIGHT: 1,
    TRANSPARENT: 2
  },
  BlendMode: {
    NORMAL: "norm",
    DISSOLVE: "diss",
    DARKEN: "dark",
    MULTIPLY: "mul ",
    COLORBURN: "idiv",
    LINEARBURN: "lbrn",
    DARKERCOLOR: "dkCl",
    LIGHTEN: "lite",
    SCREEN: "scrn",
    COLORDODGE: "div ",
    LINEARDODGE: "lddg",
    LIGHTERCOLOR: "lgCl",
    OVERLAY: "over",
    SOFTLIGHT: "sLit",
    HARDLIGHT: "hLit",
    VIVIDLIGHT: "vLit",
    LINEARLIGHT: "lLit",
    PINLIGHT: "pLit",
    HARDMIX: "hMix",
    DIFFERENCE: "diff",
    EXCLUSION: "smud",
    SUBTRACT: "fsub",
    DIVIDE: "fdiv",
    HUE: "hue ",
    SATURATION: "sat ",
    COLOR: "colr",
    LUMINOSITY: "lum "
  },
  Justification: {
    LEFT: 0,
    RIGHT: 1,
    CENTER: 2,
    LEFTJUSTIFIED: 3,
    RIGHTJUSTIFIED: 4,
    CENTERJUSTIFIED: 5,
    FULLYJUSTIFIED: 6
  },
  AntiAlias: {
    NONE: 0,
    SHARP: 1,
    CRISP: 2,
    STRONG: 3,
    SMOOTH: 4
  }
};
ScriptEngine.ScriptEval.scriptBuiltinEnums.ColorBlendMode = ScriptEngine.ScriptEval.scriptBuiltinEnums.BlendMode;
ScriptEngine.ScriptEval.layerFillResourceKeys = "---- SoLd TySh SoCo GdFl PtFl".split(" ");

export { ScriptEngine, deferredWritersNamedBy };
