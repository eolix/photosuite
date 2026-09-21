/**
 * WebGL and Canvas2D composite drawing for PluginToolPanel, plus color helpers
 * used by the document canvas and overlay passes.
 */

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { LayerSystem } from "../../engine/layer-system.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { rectToPathOutline } from "../../engine/compositing/anti-alias.js";
import { psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";
import { buildChannelMatrix, transformInterleaved, transposeColorMatrix } from "../../engine/compositing/color-matrix.js";
import { resampleImageBufferWithMatrix } from "../../engine/compositing/pixel-ops.js";

/**
 * Attach composite draw methods, color statics, and the WebGL composite shader
 * onto PluginToolPanel.
 * @param {Function} PluginToolPanel
 */
export function installPluginToolComposite(PluginToolPanel) {
  PluginToolPanel.getCanvasBackgroundRgba = getCanvasBackgroundRgba;
  PluginToolPanel.psdColorToUnitRgba = psdColorToUnitRgba;
  PluginToolPanel.unitRgbaToCssString = unitRgbaToCssString;
  PluginToolPanel.patchZeroBlueForWebglImageData = patchZeroBlueForWebglImageData;
  PluginToolPanel.WebglCanvasCompositeShader = WebglCanvasCompositeShader;
  WebglCanvasCompositeShader.prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  WebglCanvasCompositeShader.prototype.composite = webglCompositeDraw;
  PluginToolPanel.prototype.drawWebglComposite = function() {
    drawWebglComposite(this, PluginToolPanel);
  };
  PluginToolPanel.prototype.drawCanvas2dComposite = function() {
    drawCanvas2dComposite(this, PluginToolPanel);
  };
}

/**
 * Canvas artboard background as unit-interval RGBA.
 * @param {object} pluginDocument
 * @returns {number[]}
 */
function getCanvasBackgroundRgba(pluginDocument) {
  const canvasColor = pluginDocument.add.artd.canvasColor;
  if (canvasColor == null) return [0, 0, 0, 0];
  return psdColorToUnitRgba(canvasColor);
}

/**
 * Convert a PSD color descriptor to unit-interval RGBA.
 * @param {{ v: object }} psdColorDesc
 * @returns {number[]}
 */
function psdColorToUnitRgba(psdColorDesc) {
  const rgb = psdColorToRgb(psdColorDesc.v),
    rgba = [rgb.h / 255, rgb.l / 255, rgb.O / 255, 1];
  for (let channelIdx = 0; channelIdx < 4; channelIdx++) rgba[channelIdx] = Math.min(1, rgba[channelIdx]);
  return rgba;
}

/**
 * Format unit RGBA as a CSS rgba() string. When WebGL is on, blue is nudged
 * away from zero unless forceMinBlue requests the opposite clamp.
 * @param {number[]} rgba
 * @param {boolean} [forceMinBlue]
 * @returns {string}
 */
function unitRgbaToCssString(rgba, forceMinBlue) {
  let blueChannel = rgba[2] * 255;
  if (LayerSystem.webglEnabled) blueChannel = forceMinBlue ? 0 : Math.max(1, blueChannel);
  return "rgba(" + rgba[0] * 255 + "," + rgba[1] * 255 + "," + blueChannel + "," + rgba[3] + ")";
}

/**
 * WebGL cannot distinguish blue=0 overlays; bump zero blues to 3 when enabled.
 * @param {Uint8Array|Uint8ClampedArray} pixelData
 */
function patchZeroBlueForWebglImageData(pixelData) {
  if (LayerSystem.webglEnabled)
    for (let byteIdx = 0; byteIdx < pixelData.length; byteIdx += 4) {
      if (pixelData[byteIdx + 2] == 0) pixelData[byteIdx + 2] = 3;
    }
}

function ensureWebglCompositeShaders(PluginToolPanel) {
  if (LayerSystem.webglEnabled && PluginToolPanel.defaultWebglCompositeShader == null)
    PluginToolPanel.defaultWebglCompositeShader = new PluginToolPanel.WebglCanvasCompositeShader(false);
  if (LayerSystem.webglEnabled && PluginToolPanel.artboardWebglCompositeShaders == null)
    PluginToolPanel.artboardWebglCompositeShaders = [
      new PluginToolPanel.WebglCanvasCompositeShader(true, 2),
      new PluginToolPanel.WebglCanvasCompositeShader(true, 8),
      new PluginToolPanel.WebglCanvasCompositeShader(true, 32),
      new PluginToolPanel.WebglCanvasCompositeShader(true, 128)
    ];
  if (PluginToolPanel.artboardRectUniformBuffer == null)
    PluginToolPanel.artboardRectUniformBuffer = new Float32Array(4 * 1024);
}

/**
 * Pack visible artboard rects into the shared uniform buffer; return write count.
 * @param {object} pluginDocument
 * @param {Float32Array} artboardRectBuffer
 * @returns {number}
 */
function fillArtboardRectUniforms(pluginDocument, artboardRectBuffer) {
  artboardRectBuffer.fill(0);
  const docWidth = pluginDocument.width,
    docHeight = pluginDocument.height;
  let writeIndex = 0;
  for (let layerIdx = 0; layerIdx < pluginDocument.layers.length; layerIdx++) {
    const layerNode = pluginDocument.layers[layerIdx],
      artboardMeta = layerNode.add.artb;
    if (artboardMeta == null || !layerNode.isVisible()) continue;
    const artboardRect = layerNode.getArtboardRect();
    artboardRectBuffer[writeIndex] = artboardRect.x / docWidth;
    artboardRectBuffer[writeIndex + 1] = artboardRect.y / docHeight;
    artboardRectBuffer[writeIndex + 2] = artboardRect.width / docWidth;
    artboardRectBuffer[writeIndex + 3] = artboardRect.height / docHeight;
    writeIndex += 4;
    if (writeIndex == artboardRectBuffer.length) break;
  }
  return writeIndex;
}

function artboardShaderTierForRectCount(artboardRectWriteIndex) {
  let shaderTier = 0;
  if (artboardRectWriteIndex > 2 * 4) shaderTier++;
  if (artboardRectWriteIndex > 8 * 4) shaderTier++;
  if (artboardRectWriteIndex > 32 * 4) shaderTier++;
  return shaderTier;
}

function buildCompositeViewMatrixArray(pluginDocument, docView, canvasWidth, canvasHeight) {
  const viewMatrix = new Matrix2D();
  viewMatrix.scale(canvasWidth, canvasHeight);
  viewMatrix.concat(docView.getViewMatrix(true));
  viewMatrix.scale(1 / pluginDocument.width, 1 / pluginDocument.height);
  return [viewMatrix.a, viewMatrix.b, 0, viewMatrix.c, viewMatrix.d, 0, viewMatrix.tx, viewMatrix.ty, 1];
}

/**
 * Composite the plugin document onto the panel's main canvas using WebGL. Draws
 * any active mask overlays into the view texture, selects a checkerboard shader
 * or one of the artboard shaders (sized to the number of visible artboards),
 * feeds the view matrix, background color, artboard rects, and channel-
 * visibility matrix as uniforms, and issues the composite draw.
 */
function drawWebglComposite(panel, PluginToolPanel) {
  ensureWebglCompositeShaders(PluginToolPanel);
  const pluginDocument = panel.pluginDocument;
  let compositeShader,
    artboardRectWriteIndex = 0;
  if (pluginDocument.glTexture == null) return;
  const docView = pluginDocument.pathViewport,
    canvasWidth = docView.viewportRect.width,
    canvasHeight = docView.viewportRect.height,
    glContext = LayerSystem.renderCtx;
  panel.mainCanvasCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  const maskOverlaysDrawn = panel.drawActiveMaskOverlays(pluginDocument);
  if (docView.viewCanvasTexture == null) docView.viewCanvasTexture = new LayerSystem.RgbaTexture(canvasWidth, canvasHeight);
  if (maskOverlaysDrawn) docView.viewCanvasTexture.set(panel.canvasEl);
  else {
    LayerSystem.bindRenderTarget(docView.viewCanvasTexture);
    LayerSystem.clearWithColor(1);
  }
  const panOffset = docView.docToScreenPoint(0, 0),
    matrixArray = buildCompositeViewMatrixArray(pluginDocument, docView, canvasWidth, canvasHeight);
  let bgColorRgba = [0, 0, 0, 0],
    artboardRectBuffer = PluginToolPanel.artboardRectUniformBuffer;
  if (pluginDocument.add.artd) {
    bgColorRgba = PluginToolPanel.getCanvasBackgroundRgba(pluginDocument);
    artboardRectWriteIndex = fillArtboardRectUniforms(pluginDocument, artboardRectBuffer);
    const shaderTier = artboardShaderTierForRectCount(artboardRectWriteIndex);
    compositeShader = PluginToolPanel.artboardWebglCompositeShaders[shaderTier];
    artboardRectBuffer = new Float32Array(artboardRectBuffer.buffer, 0, [2, 8, 32, 128][shaderTier] * 4);
  } else compositeShader = PluginToolPanel.defaultWebglCompositeShader;
  LayerSystem.bindMainCanvas(canvasWidth, canvasHeight);
  LayerSystem.clearWithColor(0);
  LayerSystem.bindMainCanvas(canvasWidth, canvasHeight);
  compositeShader.use();
  compositeShader.composite(
    docView.viewCanvasTexture.glTexture,
    pluginDocument.glTexture.glTexture,
    new Float32Array(matrixArray),
    new Float32Array([canvasWidth / 8, canvasHeight / 8, panOffset.x / canvasWidth, panOffset.y / canvasHeight]),
    pluginDocument.width,
    pluginDocument.height,
    1 / pluginDocument.pathViewport.zoomScale,
    canvasWidth,
    canvasHeight,
    new Float32Array(bgColorRgba),
    artboardRectBuffer,
    new Float32Array(transposeColorMatrix(buildChannelMatrix(docView.channelVisibility)))
  );
  glContext.drawArrays(glContext.TRIANGLES, 0, 6);
}

function fillCheckerboardDocumentBackground(panel, pluginDocument, invertedMatrix, docBounds) {
  panel.mainCanvasCtx.save();
  const checkerOrigin = invertedMatrix.transformPoint(new Point(0, 0));
  invertedMatrix.translate(-checkerOrigin.x, -checkerOrigin.y);
  panel.mainCanvasCtx.translate(Math.round(checkerOrigin.x), Math.round(checkerOrigin.y));
  panel.mainCanvasCtx.fillStyle = panel.checkerboardPattern;
  panel.appendPathToCanvasContext(rectToPathOutline(docBounds), invertedMatrix, panel.mainCanvasCtx);
  panel.mainCanvasCtx.fill();
  panel.mainCanvasCtx.restore();
}

function fillArtboardDocumentBackground(panel, PluginToolPanel, pluginDocument, invertedMatrix, canvasWidth, canvasHeight) {
  panel.mainCanvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString(PluginToolPanel.getCanvasBackgroundRgba(pluginDocument));
  panel.mainCanvasCtx.fillRect(0, 0, canvasWidth, canvasHeight);
  panel.mainCanvasCtx.save();
  panel.mainCanvasCtx.setTransform(invertedMatrix.a, invertedMatrix.b, invertedMatrix.c, invertedMatrix.d, invertedMatrix.tx, invertedMatrix.ty);
  const sectionNodes = pluginDocument.root.children;
  for (let nodeIdx = 0; nodeIdx < sectionNodes.length; nodeIdx++) {
    const layerNode = sectionNodes[nodeIdx].layer;
    if (layerNode.add.artb == null || !layerNode.isVisible()) continue;
    const artboardRect = layerNode.getArtboardRect(),
      artboardBg = layerNode.getArtboardBgColor();
    if (artboardBg != 0) continue;
    panel.mainCanvasCtx.fillStyle = "white";
    panel.mainCanvasCtx.fillRect(artboardRect.x, artboardRect.y, artboardRect.width, artboardRect.height);
  }
  panel.mainCanvasCtx.restore();
}

/**
 * Canvas2D fallback for the same composite: paints the document background
 * (checkerboard, or per-artboard fills), resamples the document buffer through
 * the view matrix into a scratch RGBA buffer, applies channel visibility, blits
 * the result, and draws mask overlays.
 */
function drawCanvas2dComposite(panel, PluginToolPanel) {
  const pluginDocument = panel.pluginDocument;
  if (pluginDocument.buffer == null) return;
  const docView = pluginDocument.pathViewport,
    childrenBuffer = docView.viewportRect,
    canvasWidth = childrenBuffer.width,
    canvasHeight = childrenBuffer.height,
    docBounds = new Rect(0, 0, pluginDocument.width, pluginDocument.height);
  panel.overlayCanvasCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  panel.mainCanvasCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  const viewMatrix = docView.getViewMatrix(true),
    invertedMatrix = viewMatrix.clone();
  invertedMatrix.invert();
  if (pluginDocument.add.artd == null) {
    fillCheckerboardDocumentBackground(panel, pluginDocument, invertedMatrix, docBounds);
  } else {
    fillArtboardDocumentBackground(panel, PluginToolPanel, pluginDocument, invertedMatrix, canvasWidth, canvasHeight);
  }
  if (docView.scratchUint8Buffer.length != childrenBuffer.area()) {
    docView.scratchUint8Buffer = allocBuffer(childrenBuffer.area());
    docView.scratchRgbaBuffer = allocBuffer(childrenBuffer.area() * 4);
  }
  docView.scratchRgbaBuffer.fill(0);
  resampleImageBufferWithMatrix(pluginDocument.buffer, docBounds, viewMatrix, docView.scratchRgbaBuffer, childrenBuffer);
  if (docView.channelVisibility[0] + docView.channelVisibility[1] + docView.channelVisibility[2] != 3)
    transformInterleaved(docView.scratchRgbaBuffer, docView.scratchRgbaBuffer, buildChannelMatrix(docView.channelVisibility));
  panel.overlayCanvasCtx.putImageData(new ImageData(new Uint8ClampedArray(docView.scratchRgbaBuffer.buffer), childrenBuffer.width, childrenBuffer.height), 0, 0);
  panel.mainCanvasCtx.drawImage(panel.overlayCanvas, 0, 0);
  panel.mainCanvasCtx.getImageData(0, 0, 1, 1);
  panel.drawActiveMaskOverlays(pluginDocument);
}

/**
 * GLSL shader program that blends the document texture over the canvas
 * background. When `artboardModeEnabled` it fills up to `maxArtboardCount`
 * artboard rectangles with the artboard/background color; otherwise it draws
 * the transparency checkerboard with a soft drop shadow around the document.
 */
function WebglCanvasCompositeShader(artboardModeEnabled, maxArtboardCount) {
  LayerSystem.ShaderProgram.call(this);
  this.artboardModeEnabled = artboardModeEnabled;
  const fragmentShaderSource = "\t\t\tprecision mediump float;\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform sampler2D target;\t\t\tuniform vec3 contSizeZoom;\t\t\tuniform vec2 cnvSize;\t\t\tuniform mat4 ctrn; \t\t\t" + (artboardModeEnabled ? "uniform vec4 bgClr;  uniform vec4 ars[" + maxArtboardCount + "]; " : "") + "\t\t\t\t\t\tvarying vec2 tCoord;\t\t\tvarying vec2 sCoord;\t\t\tvarying vec2 gCoord;\t\t\t\t\t\t/* This approximates the error function, needed for the gaussian integral */ \t\t\tvec4 erf(vec4 x) { \t\t\t  vec4 s = sign(x), a = abs(x);\t\t\t  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;\t\t\t  x *= x;  \t\t\t  return s - s / (x * x); \t\t\t} \t\t\t/* Return the mask for the shadow of a box from lower to upper */  \t\t\tfloat boxShadow(vec2 lower, vec2 upper, vec2 point, float sigma) { \t\t\t  vec4 query = vec4(point - lower, point-upper); \t\t\t  vec4 integral = 0.5 + 0.5 * erf(query * (sqrt(0.5) / sigma)); \t\t\t  return (integral.z - integral.x) * (integral.w - integral.y); \t\t\t} \t\t\t\t\t\tvec4 simpleBlend(vec4 src, vec4 tgt) {\t\t\t\tfloat na = src.w + tgt.w*(1.0-src.w);\t\t\t\t/* avoid division by zero */ \t\t\t\treturn na==0.0 ? vec4(0,0,0,0) : vec4( (src.xyz*src.w + tgt.w*tgt.xyz*(1.0-src.w))*(1.0/na), na);\t\t\t} \t\t\t\t\t\t" + LayerSystem.shaderLib.in01Fn + "\t\t\t\t\t\tvoid main(void) {\t\t\t\tvec4 src = texture2D(source, tCoord); \t\t\t\tvec4 tgt = ctrn*texture2D(target, sCoord); " + (artboardModeEnabled ? "\t\t\t\t\tbool inr = false; vec4 BG = bgClr; \t\t\t\t\tfor(int i=0; i<" + maxArtboardCount + "; i++) { \t\t\t\t\t\tvec4 ar = ars[i]; \t\t\t\t\t\tvec2 nsc = sCoord - ar.xy; \t\t\t\t\t\tif( ar.z!=0.0 && in01(nsc/ar.zw) ){\t\t\t\t\t\tinr=true; BG=vec4(1.0,1.0,1.0,1.0); }\t\t\t\t\t}\t\t\t\t" : "\t\t\t\t\tfloat shdw = 0.3*boxShadow(vec2(0,0),contSizeZoom.xy, sCoord*contSizeZoom.xy+vec2(0.0,-6.0*contSizeZoom.z) , 10.0*contSizeZoom.z);\t\t\t\t\tvec4 grid = mod(floor(gCoord.x) + floor(gCoord.y), 2.0)==1.0 ? vec4(0.784,0.784,0.784,1) : vec4(1,1,1,1);\t\t\t\t\tvec4 BG = in01(sCoord) ? grid : vec4(0.0,0.0,0.0,shdw); \t\t\t\t") + "\t\t\t\tvec4 outc = in01(sCoord) ?  simpleBlend(tgt,BG) :  BG ;  \t\t\t\tif(src.b == 0.0 && src.a >0.5) gl_FragColor = mix(outc, vec4(vec3(1,1,1)-outc.rgb,1.0), src.w); \t\t\t\telse             gl_FragColor = simpleBlend(src,outc); \t\t\t\t\t\t\t}",
    vertexShaderSource = "\t\t\tattribute vec2 verPos;\t\t\tvarying vec2 tCoord;\t\t\tvarying vec2 sCoord;\t\t\tvarying vec2 gCoord;\t\t\t\t\t\tuniform mat3 tmat;\t\t\tuniform vec4 gsize;\t\t\tvoid main(void) {\t\t\t\ttCoord = verPos;\t\t\t\tsCoord = (tmat*vec3(verPos,1.0)).xy;\t\t\t\tgCoord = (verPos-gsize.zw) * gsize.xy ; \t\t\t\tgl_Position = vec4(vec2(-1.0, 1.0) + 2.0*vec2(verPos.x,-verPos.y), 0.0, 1.0);\t\t\t}";
  this.compileAndLink(fragmentShaderSource, vertexShaderSource);
}

function webglCompositeDraw(overlayTexture, sourceTexture, viewMatrixArray, gsizeUniform, docWidth, docHeight, invZoom, canvasWidth, canvasHeight, bgColorRgba, artboardRects, channelMatrix) {
  this.cacheUniforms("tmat gsize source target contSizeZoom cnvSize bgClr ars ctrn".split(" "));
  const glContext = LayerSystem.renderCtx,
    uniformLocs = this.uniformLocations;
  glContext.uniformMatrix3fv(uniformLocs.tmat, false, viewMatrixArray);
  glContext.uniform4fv(uniformLocs.gsize, gsizeUniform);
  glContext.uniform3f(uniformLocs.contSizeZoom, docWidth, docHeight, invZoom);
  glContext.uniform2f(uniformLocs.cnvSize, canvasWidth, canvasHeight);
  glContext.uniformMatrix4fv(uniformLocs.ctrn, false, channelMatrix);
  if (this.artboardModeEnabled) {
    glContext.uniform4fv(uniformLocs.ars, artboardRects);
    glContext.uniform4fv(uniformLocs.bgClr, bgColorRgba);
  }
  glContext.uniform1i(uniformLocs.source, 0);
  glContext.uniform1i(uniformLocs.target, 1);
  glContext.activeTexture(glContext.TEXTURE0);
  glContext.bindTexture(glContext.TEXTURE_2D, overlayTexture);
  glContext.activeTexture(glContext.TEXTURE1);
  glContext.bindTexture(glContext.TEXTURE_2D, sourceTexture);
  glContext.activeTexture(glContext.TEXTURE0);
}
