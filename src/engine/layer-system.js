/**
 * WebGL layer compositing runtime: textures, adjustment/filter shaders, and
 * blend / clipping / passthrough renderers.
 */

import { Rect } from '../core/math/rect.js';
import { allocBuffer, planarToInterleaved } from "./compositing/buffer-utils.js";
import { copyPixels } from "./compositing/pixel-ops.js";
import { transposeColorMatrix } from "./compositing/color-matrix.js";


function minifyGlsl(source) {
    source = source.replace(/\s\s+/g, " ");
    source = source.replace(/; /g, ";");
    source = source.replace(/} /g, "}");
    source = source.replace(/ }/g, "}");
    source = source.replace(/{ /g, "{");
    source = source.replace(/ {/g, "{");
    source = source.replace(/= /g, "=");
    source = source.replace(/ =/g, "=");
    source = source.replace(/\| /g, "|");
    source = source.replace(/ \|/g, "|");
    return source
}

function rectToViewportCoords(rect, viewport) {
    return new Float32Array([(rect.x - viewport.x) / viewport.width, (rect.y - viewport.y) / viewport.height, rect.width / viewport.width, rect.height / viewport.height])
}

function tryInitWebGl(layerSystem) {
  const contextAttribs = {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false
    };

  let gl;
  if (!gl) gl = layerSystem.offscreenCanvas.getContext("webgl", contextAttribs);
  if (!gl) gl = layerSystem.offscreenCanvas.getContext("experimental-webgl", contextAttribs);
  if (gl) {
    layerSystem.webglEnabled = true;
    layerSystem.glContextAvailable = true;
    layerSystem.renderCtx = gl;
    layerSystem.glFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, layerSystem.glFramebuffer);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  }
}

function installGpuCore(LayerSystem) {
  LayerSystem.checkTextureSize = function(maxSide) {
    let gl = LayerSystem.renderCtx;
    if (maxSide > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      // Requested texture exceeds the GPU limit; fall back to CPU compositing.
      LayerSystem.webglEnabled = false;
    }
  };
  LayerSystem.getOffscreenCanvas = function() {
    return this.offscreenCanvas;
  };
  LayerSystem.bindRenderTarget = function(texture, scissorRect) {
    let gl = LayerSystem.renderCtx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, LayerSystem.glFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.glTexture, 0);
    gl.viewport(0, 0, texture.width, texture.height);
    if (scissorRect) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(scissorRect.x, scissorRect.y, scissorRect.width, scissorRect.height)
    } else gl.disable(gl.SCISSOR_TEST)
  };
  LayerSystem.bindMainCanvas = function(canvasWidth, canvasHeight, scissorRect) {
    if (scissorRect) throw new Error("bindMainCanvas does not support a scissor rectangle");
    let gl = LayerSystem.renderCtx;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    if (scissorRect) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(scissorRect.x, scissorRect.y, Math.round(scissorRect.width), Math.round(scissorRect.height))
    } else gl.disable(gl.SCISSOR_TEST)
  };
  LayerSystem.clear = function() {
    let gl = LayerSystem.renderCtx;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT)
  };
  LayerSystem.clearWithColor = function(rgbaPacked, channelMask) {
    if (channelMask == null) channelMask = 0;
    const maskRed = (channelMask >>> 0 & 255) == 0;
    const maskGreen = (channelMask >>> 8 & 255) == 0;
    const maskBlue = (channelMask >>> 16 & 255) == 0;
    const maskAlpha = (channelMask >>> 24 & 255) == 0;
    const clearR = (rgbaPacked >>> 0 & 255) * (1 / 255);
    const clearG = (rgbaPacked >>> 8 & 255) * (1 / 255);
    const clearB = (rgbaPacked >>> 16 & 255) * (1 / 255);
    const clearA = (rgbaPacked >>> 24 & 255) * (1 / 255);
    let gl = LayerSystem.renderCtx;
    gl.colorMask(maskRed, maskGreen, maskBlue, maskAlpha);
    gl.clearColor(clearR, clearG, clearB, clearA);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.colorMask(true, true, true, true)
  };
  LayerSystem.copyGpuTextureRegion = function(dstTex, dstRect, srcTex, srcRect, clipRect) {
    let copyRect = dstRect.intersect(srcRect);
    if (clipRect) copyRect = copyRect.intersect(clipRect);
    if (copyRect.isEmpty()) return;
    let gl = LayerSystem.renderCtx;
    LayerSystem.bindRenderTarget(dstTex);
    gl.bindTexture(gl.TEXTURE_2D, srcTex.glTexture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, copyRect.x - srcRect.x, copyRect.y - srcRect.y, copyRect.x - dstRect.x, copyRect.y - dstRect.y, copyRect.width, copyRect.height)
  };
  LayerSystem.getPooledTexture = function(poolIndex, width, height) {
    let pooled = LayerSystem.texturePool[poolIndex];
    if (pooled == null || pooled.width != width || pooled.height != height) {
      if (pooled) pooled.delete();
      pooled = new LayerSystem.RgbaTexture(width, height)
    }
    LayerSystem.texturePool[poolIndex] = pooled;
    return pooled
  };
  LayerSystem.texturePool = [];
}

function installShaderProgram(LayerSystem) {
  LayerSystem.ShaderProgram = function() {
    this.glProgram = null;
    this.uniformLocations = null
  };
  LayerSystem.ShaderProgram.lastBound = null;
  LayerSystem.ShaderProgram.prototype.cacheUniforms = function(uniformNames) {
    if (this.uniformLocations) return;
    this.uniformLocations = {};
    let gl = LayerSystem.renderCtx;
    const program = this.glProgram;
    const locations = this.uniformLocations;
    for (let idx = 0; idx < uniformNames.length; idx++) {
      const name = uniformNames[idx];
      locations[name] = gl.getUniformLocation(program, name)
    }
  };
  LayerSystem.ShaderProgram.prototype.composite = function() {};
  LayerSystem.ShaderProgram.prototype.bindTextures = function(texturePairs) {
    let gl = LayerSystem.renderCtx;
    for (let idx = 0; idx < texturePairs.length; idx += 2) {
      gl.uniform1i(texturePairs[idx], idx >>> 1);
      gl.activeTexture(gl["TEXTURE" + (idx >>> 1)]);
      gl.bindTexture(gl.TEXTURE_2D, texturePairs[idx + 1])
    }
    gl.activeTexture(gl.TEXTURE0)
  };
  LayerSystem.ShaderProgram.prototype.compileAndLink = function(fragmentSrc, vertexSrc) {
    let gl = LayerSystem.renderCtx;
    const fragShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragShader, fragmentSrc);
    gl.compileShader(fragShader);
    if (!gl.getShaderParameter(fragShader, gl.COMPILE_STATUS)) console.log(gl.getShaderInfoLog(fragShader));
    const vertShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertShader, vertexSrc);
    gl.compileShader(vertShader);
    if (!gl.getShaderParameter(vertShader, gl.COMPILE_STATUS)) console.log(gl.getShaderInfoLog(vertShader));
    const program = gl.createProgram();
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.log("Could not initialise shaders");
    this.glProgram = program
  };
  LayerSystem.ShaderProgram.prototype.use = function() {
    if (LayerSystem.ShaderProgram.lastBound != this) {
      LayerSystem.renderCtx.useProgram(this.glProgram);
      LayerSystem.ShaderProgram.lastBound = this
    }
  };
}

function installTextures(LayerSystem) {
  LayerSystem.AlphaTexture = function(width, height) {
    LayerSystem.textureInstanceCount++;
    LayerSystem.textureMemoryCount += width * height;
    if (LayerSystem.debugMode) console.log("GL.Channels instances: " + LayerSystem.textureInstanceCount + ", memory: " + LayerSystem.textureMemoryCount);
    let gl = LayerSystem.renderCtx;
    this.width = width;
    this.height = height;
    this.glTexture = gl.createTexture();
    this.backupTexture = null;
    this.initGlTexture(this.glTexture, width, height)
  };
  LayerSystem.AlphaTexture.prototype.initGlTexture = function(glTexture, width, height) {
    let gl = LayerSystem.renderCtx;
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, width, height, 0, gl.ALPHA, gl.UNSIGNED_BYTE, null)
  };
  LayerSystem.AlphaTexture.prototype.set = function(pixelData) {
    let gl = LayerSystem.renderCtx;
    gl.bindTexture(gl.TEXTURE_2D, this.glTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, this.width, this.height, 0, gl.ALPHA, gl.UNSIGNED_BYTE, pixelData);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  };
  LayerSystem.AlphaTexture.prototype.delete = function() {
    let gl = LayerSystem.renderCtx;
    if (this.glTexture) {
      gl.deleteTexture(this.glTexture);
      LayerSystem.textureInstanceCount--;
      LayerSystem.textureMemoryCount -= this.width * this.height
    }
    if (LayerSystem.debugMode) console.log("GL.Channels instances: " + LayerSystem.textureInstanceCount + ", memory: " + LayerSystem.textureMemoryCount * 4)
  };
  LayerSystem.textureInstanceCount = 0;
  LayerSystem.RgbaTexture = function(width, height, useLinearFilter) {
    if (useLinearFilter == null) useLinearFilter = false;
    LayerSystem.textureInstanceCount++;
    LayerSystem.textureMemoryCount += width * height * 4;
    if (LayerSystem.debugMode) console.log("GL.Channels instances: " + LayerSystem.textureInstanceCount + ", memory: " + LayerSystem.textureMemoryCount);
    let gl = LayerSystem.renderCtx;
    this.useLinearFilter = useLinearFilter;
    this.width = width;
    this.height = height;
    this.glTexture = gl.createTexture();
    this.backupTexture = null;
    this.initGlTexture(this.glTexture, width, height)
  };
  LayerSystem.RgbaTexture.prototype.set = function(pixelData, subRect) {
    let gl = LayerSystem.renderCtx;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindTexture(gl.TEXTURE_2D, this.glTexture);
    if (pixelData == null || ArrayBuffer.isView(pixelData)) {
      const pixelCount = this.width * this.height;
      if (subRect == null || subRect.area() * 10 > pixelCount) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixelData);
      else {
        const staging = allocBuffer(subRect.area() * 4);
        copyPixels(pixelData, new Rect(0, 0, this.width, this.height), staging, subRect);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, subRect.x, subRect.y, subRect.width, subRect.height, gl.RGBA, gl.UNSIGNED_BYTE, staging)
      }
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixelData)
  };
  LayerSystem.RgbaTexture.prototype.get = function(outBuffer) {
    let gl = LayerSystem.renderCtx;
    LayerSystem.bindRenderTarget(this);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, outBuffer)
  };
  LayerSystem.RgbaTexture.prototype.saveBackup = function(backupRect) {
    if (backupRect.isEmpty()) return;
    let gl = LayerSystem.renderCtx;
    if (this.backupTexture == null) {
      this.backupTexture = gl.createTexture();
      this.initGlTexture(this.backupTexture, this.width, this.height);
      LayerSystem.textureInstanceCount++;
      LayerSystem.textureMemoryCount += this.width * this.height * 4
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, LayerSystem.glFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.backupTexture);
    if (backupRect) {
      const copyX = Math.max(backupRect.x, 0);
      const copyY = Math.max(backupRect.y, 0);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, copyX, copyY, copyX, copyY, backupRect.width, backupRect.height)
    } else gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, this.width, this.height, 0)
  };
  LayerSystem.RgbaTexture.prototype.initGlTexture = function(glTexture, width, height) {
    let gl = LayerSystem.renderCtx;
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.useLinearFilter ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  };
  LayerSystem.RgbaTexture.prototype.delete = function() {
    let gl = LayerSystem.renderCtx;
    if (this.glTexture) {
      gl.deleteTexture(this.glTexture);
      LayerSystem.textureInstanceCount--;
      LayerSystem.textureMemoryCount -= this.width * this.height * 4
    }
    if (this.backupTexture) {
      gl.deleteTexture(this.backupTexture);
      LayerSystem.textureInstanceCount--;
      LayerSystem.textureMemoryCount -= this.width * this.height * 4
    }
    if (LayerSystem.debugMode) console.log("GL.Channels instances: " + LayerSystem.textureInstanceCount + ", memory: " + LayerSystem.textureMemoryCount)
  };
  LayerSystem.RgbaTexture.prototype.clone = function() {
    let gl = LayerSystem.renderCtx;
    const cloneTex = new LayerSystem.RgbaTexture(this.width, this.height);
    LayerSystem.bindRenderTarget(this);
    gl.bindTexture(gl.TEXTURE_2D, cloneTex.glTexture);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, this.width, this.height, 0);
    return cloneTex
  };
}

function installAdjPipeline(LayerSystem) {
  LayerSystem.shaderLib = {
    colorBurnBlend: "  vec3 ocbrn(vec3 a, vec3 b, float f) {  vec3 d = (a*vec3(f)+ONE3-vec3(f));  return mix(ONE3 - min(ONE3,(ONE3-b)/d), ZERO3, vec3(vec3(greaterThan(vec3(0.001),d))) );  }  ",
    colorDodgeBlend: "  vec3 ocddg(vec3 a, vec3 b, float f) {  return mix(        min(ONE3,       b/(ONE3 - a*f))    ,   ONE3   , vec3(equal(a*f,ONE3 )) );  }  ",
    vec3Constants: "const vec3 ZERO3 = vec3(0.0,0.0,0.0) ;\t\t\tconst vec3 QUAR3 = vec3(0.25,0.25,0.25) ;\t\t\tconst vec3 HALF3 = vec3(0.5,0.5,0.5) ;\t\t\tconst vec3 ONE3  = vec3(1.0,1.0,1.0) ;",
    hueDiffFn: " float hueDiff(float shue, float hue) { \t\t\t\tfloat df = hue-shue, adf=abs(df), df0 = df-1.0, df1 = df+1.0; \t\t\t\tif(abs(df0) < adf)  df = df0; \t\t\t\telse if(abs(df1) < adf)  df = df1; \t\t\t\treturn df; \t\t\t}",
    hueCFn: " float hueCF(float hueS, float hue0) { \t\t\t\tfloat df = hueDiff(hue0, hueS)*6.0; \t\t\t\treturn   max(0.0, min(1.0,  (df<0.0) ? 1.0+df : 1.0-df  ));  } ",
    satFn: "float sat(vec3 c) { return max(c.x,max(c.y,c.z)) - min(c.x,min(c.y,c.z)); }",
    lumFn: "float lum(vec3 c) { return dot(c, vec3(0.3,0.59,0.11)); } ",
    dTrfn: "vec3  D  (vec3 x) { return mix( sqrt(x), ((16.0*x-12.0)*x+4.0)*x  , vec3(lessThanEqual(x,QUAR3))  ); }",
    midSatFn: "float midSat (vec3 v, float s) { return ((v.y-v.z)*s)/(v.x-v.z); }",
    setSatFn: "vec3 setSat (vec3 c, float s) \t\t\t{\t\t\t\tvec3 o;\t\t\t\tif(c.r==c.g && c.g==c.b) o = ZERO3;\t\t\t\telse if(c.r>c.g)  {\t\t\t\t\tif(c.r>c.b) {\t\t\t\t\t\tif(c.g>c.b)\to = vec3(s, midSat(c.rgb,s), 0.0); \t\t\t\t\t\telse\to = vec3(s, 0.0, midSat(c.rbg,s)); \t\t\t\t\t}\t\t\t\t\telse\t\to = vec3(midSat(c.brg,s), 0.0, s); \t\t\t\t} else  {\t\t\t\t\tif(c.r<c.b) {\t\t\t\t\t\tif(c.g>c.b)\to = vec3(0.0, s, midSat(c.gbr,s)); \t\t\t\t\t\telse\t    o = vec3(0.0, midSat(c.bgr,s), s); \t\t\t\t\t}\t\t\t\t\telse\t\t    o = vec3(midSat(c.grb,s), s, 0.0);\t\t\t\t}\t\t\t\treturn o;\t\t\t}",
    clipColFn: "vec3 clipCol(vec3 c) \t\t\t{ \t\t\t\tvec3 o = c;  float l = lum(c); \t\t\t\tfloat n = min(c.r,min(c.g,c.b)); \t\t\t\tfloat x = max(c.r,max(c.g,c.b)); \t\t\t\tif(n<0.0) o = l + (o-l)*(l/(l-n));\t\t\t\tif(x>1.0) o = l + (o-l)*(1.0-l)/(x-l);\t\t\t\treturn o;\t\t\t}",
    setLumFn: "vec3 setLum (vec3 c, float l) { return clipCol(c+l-lum(c)); } ",
    in01Fn: "bool in01(vec2 c) { return (0.0<=c.x) && (c.x<=1.0) && (0.0<=c.y) && (c.y<=1.0); }",
    hashFn: "float hash(vec2 v) { return fract(sin(dot(v ,vec2(12.9898,78.233))) * 43758.5453); }",
    rgbToHslFn: "vec3 rgbToHsl (vec3 rgb) {\t\t\t\tfloat r = rgb.r, g = rgb.g, b = rgb.b; \t\t\t\tfloat mx = max(r, max(g, b)), mn = min(r, min(g, b)); \t\t\t\tfloat h, s, l = (mx + mn) * 0.5;\t\t\t\t\t\t\t\tif(mx == mn) h = s = 0.0; \t\t\t\telse{ \t\t\t\t\tfloat d = mx - mn; \t\t\t\t\ts = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);  \t\t\t\t\t\t\t\t\t\tif(mx==r) h = (g - b) / d + (g < b ? 6.0 : 0.0);  \t\t\t\t\telse if(mx==g) h = (b - r) / d + 2.0; \t\t\t\t\telse if(mx==b) h = (r - g) / d + 4.0; \t\t\t\t\t\t\t\t\t\th /= 6.0; \t\t\t\t}  \t\t\t\treturn vec3(h,s,l); }",
    hslToRgbFn: "vec3 hslToRgb (float h, float s, float l){\t\t\t\tfloat r, g, b;\t\t\t\t\t\t\t\tif(s == 0.0)  r = g = b = l; \t\t\t\telse{ \t\t\t\t\tfloat q = l < 0.5 ? l * (1.0 + s) : l + s - l * s; \t\t\t\t\tfloat p = 2.0 * l - q; \t\t\t\t\tr = hue2rgb(p, q, h + 1.0/3.0); \t\t\t\t\tg = hue2rgb(p, q, h); \t\t\t\t\tb = hue2rgb(p, q, h - 1.0/3.0); \t\t\t\t} \t\t\t\treturn vec3(r,g,b); } ",
    hue2rgbFn: "float hue2rgb(float p, float q, float t){ \t\t\t\tif(t < 0.0) t += 1.0;\t\t\t\tif(t > 1.0) t -= 1.0;\t\t\t\tif(t < 1.0/6.0) return p + (q - p) * 6.0 * t; \t\t\t\tif(t < 1.0/2.0) return q; \t\t\t\tif(t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0; \t\t\t\treturn p;\t}",
    rgbToHsvFn: "vec3 rgbToHsv(vec3 rgb){\t\t\t\t\tfloat r = rgb.r, g = rgb.g, b = rgb.b; \t\t\t\tfloat mx = max(r, max(g, b)), mn = min(r, min(g, b)); \t\t\t\tfloat h, s, v = mx; \t\t\t\t\t\t\t\tfloat d = mx - mn; \t\t\t\ts = mx == 0.0 ? 0.0 : d / mx; \t\t\t\t\t\t\t\tif(mx == mn) h = 0.0;  \t\t\t\telse if(mx==r) h = (g - b) / d + (g < b ? 6.0 : 0.0);  \t\t\t\telse if(mx==g) h = (b - r) / d + 2.0; \t\t\t\telse if(mx==b) h = (r - g) / d + 4.0; \t\t\t\t\t\t\t\th /= 6.0; \t\t\t\treturn vec3(h,s,v);  }",
    hsvToRgbFn: "vec3 hsvToRgb(float h, float s, float v)  { \t\t\t\tfloat r, g, b, f, p, q, t, i; \t\t\t\ti = floor(h * 6.0); \t\t\t\tf = h * 6.0 - i; \t\t\t\tp = v * (1.0 - s); \t\t\t\tq = v * (1.0 - f * s); \t\t\t\tt = v * (1.0 - (1.0 - f) * s); \t\t\t\t\t\t\t\tif     (i==0.0) { r = v, g = t, b = p; }\t\t\t\telse if(i==1.0) { r = q, g = v, b = p; }\t\t\t\telse if(i==2.0) { r = p, g = v, b = t; }\t\t\t\telse if(i==3.0) { r = p, g = q, b = v; }\t\t\t\telse if(i==4.0) { r = t, g = p, b = v; }\t\t\t\telse if(i==5.0) { r = v, g = p, b = q; }\t\t\t\t\t\t\t\treturn vec3(r,g,b); }",
    rgbToLabFn: "\t\tfloat srgbUngamma(float x) {\t\t\treturn (x<0.04045) ? (x / 12.92) : pow( ( x + 0.055 ) / 1.055,  2.4);\t\t}\t\tfloat xyzScale(float x) {\t\t\treturn (x>0.008856) ? pow(x,1.0/3.0) : (903.3*x+16.0)*(1.0/116.0); \t\t}\t\tvec3 rgbToLab(vec3 rgb) {\t\t\tbool ok = true;\t\t\trgb.r = srgbUngamma(rgb.r); \t\t\trgb.g = srgbUngamma(rgb.g); \t\t\trgb.b = srgbUngamma(rgb.b); \t\t\tok = ok && 0.0318<=rgb.r && rgb.r<=0.0319; \t\t\tok = ok && 0.127 <=rgb.g && rgb.g<=0.128 ; \t\t\tok = ok && 0.3047<=rgb.b && rgb.b<=0.305; \t\t\t\t\t\tmat3 srgb2xyz = mat3(0.4360747164307918, 0.222504478679176, 0.013932173981751634,    0.3850649153329662, 0.7168786002139355, 0.09710452396580642,    0.14308038098632878, 0.06061692340677909, 0.7141732835334675); \t\t\t\t\t\tvec3 xyz = srgb2xyz*rgb; \t\t\tok = ok && 0.106<=xyz[0] && xyz[0]<=0.107;  \t\t\t\t\t\txyz=xyz*vec3(100.0/96.72, 100.0/100.0, 100.0/81.427);  \t\t\txyz.x = xyzScale(xyz.x); \t\t\txyz.y = xyzScale(xyz.y); \t\t\txyz.z = xyzScale(xyz.z); \t\t\t\t\t\treturn vec3(116.0*xyz.y-16.0, 500.0*(xyz.x-xyz.y), 200.0*(xyz.y-xyz.z));  \t\t} \t\tfloat labSimilar(vec3 lab, vec3 mnm, vec3 mxm, float lim)  {\t\t\tfloat L=lab.x, a=lab.y, b=lab.z; \t\t\tfloat dl = ((L<mnm.x) ? (mnm.x-L) : ((mxm.x<L) ? (mxm.x-L) : 0.0))*(1.0/100.0); \t\t\tfloat da = ((a<mnm.y) ? (mnm.y-a) : ((mxm.y<a) ? (mxm.y-a) : 0.0))*(1.0/116.0); \t\t\tfloat db = ((b<mnm.z) ? (mnm.z-b) : ((mxm.z<b) ? (mxm.z-b) : 0.0))*(1.0/116.0); \t\t\t/*float dl  = (slab.x-lab.x)*(1.0/100.0), da=(slab.y-lab.y)*(1.0/116.0), db=(slab.z-lab.z)*(1.0/116.0);*/ \t\t\tfloat dst = sqrt(dl*dl+da*da+db*db)*1.35; \t\t\treturn (dst<=lim) ? min(1.0,1.17*(1.0 - (dst/lim))) : 0.0; \t\t}",
    blendIfFn: "\t\tfloat _blendIf(float c, vec4 br) {  return min((c-br.x)*br.y,  (c-br.w)*br.z);  }  \t\tfloat blendIf(vec4 sc, vec4 tc, vec4 br[10]) {  \t\t\tfloat sg = lum(sc.rgb); \t\t\tfloat tg = lum(tc.rgb); \t\t\tfloat ms = _blendIf(sg,br[0]); \t\t\tms = min(ms, _blendIf(sc.r,br[2])); \t\t\tms = min(ms, _blendIf(sc.g,br[4])); \t\t\tms = min(ms, _blendIf(sc.b,br[6])); \t\t\t\t\t\tfloat mt = _blendIf(tg,br[1]); \t\t\tmt = min(mt, _blendIf(tc.r,br[3])); \t\t\tmt = min(mt, _blendIf(tc.g,br[5])); \t\t\tmt = min(mt, _blendIf(tc.b,br[7])); \t\t\tmt=max(mt,1.0-tc.w);\t\t\t\t\t\tfloat mi=min(ms,mt);\t\t\treturn mi<0.0?0.0:(mi>1.0?1.0:mi);\t\t}"
  };
  LayerSystem.adjLayerRenderer = {
    shaderCache: {},
    vertexShader: "\t\t\tattribute vec2 verPos;\t\t\tvarying vec2 sCoord;\t\t\tvoid main(void) {\t\t\t\tsCoord = verPos;\t\t\t\tgl_Position = vec4(vec2(-1.0,-1.0) + 2.0*verPos, 0.0, 1.0);\t\t\t}"
  };
  LayerSystem.adjLayerRenderer.render = function(shaderOptions, srcTexture) {
    const shaderTypes = AdjustmentShaderType;
    const shaderIndex = [shaderTypes.LookupTable, shaderTypes.HueSat, shaderTypes.Vibrance, shaderTypes.ColorMatrix, shaderTypes.ReplaceColor, shaderTypes.SelectiveColor, shaderTypes.BlackWhite, shaderTypes.IccLut].indexOf(shaderOptions.type);
    let shader = LayerSystem.adjLayerRenderer.shaderCache[shaderOptions.type];
    if (shader == null) shader = LayerSystem.adjLayerRenderer.shaderCache[shaderOptions.type] = new LayerSystem.adjLayerShaders[shaderIndex];
    shader.use();
    shader.composite(srcTexture, shaderOptions);
    LayerSystem.renderCtx.drawArrays(LayerSystem.renderCtx.TRIANGLES, 0, 6)
  };
  LayerSystem.adjLayerShaders = [];
  LayerSystem.adjLayerShaders[0] = function() {
    LayerSystem.ShaderProgram.call(this);
    this.lutCacheByLength = {};
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t" + LayerSystem.shaderLib.lumFn + "\t\t\t" + LayerSystem.shaderLib.vec3Constants + "\t\t\tuniform sampler2D source;\t\t\tuniform sampler2D map;\t\t\tuniform float toGray;\t\t\tuniform float presLum;\t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\tvoid main(void) {\t\t\t\tvec4 src = texture2D(source, sCoord); \t\t\t\tfloat olum = lum(src.rgb); \t\t\t\tsrc.rgb = toGray * vec3(olum) + (1.0-toGray)*src.rgb; \t\t\t\tfloat r = texture2D(map, vec2(src.r, 0)).r;\t\t\t\tfloat g = texture2D(map, vec2(src.g, 0)).g;\t\t\t\tfloat b = texture2D(map, vec2(src.b, 0)).b;\t\t\t\tvec3 col = vec3(r,g,b); \t\t\t\tif(presLum==1.0) { \t\t\t\t\tfloat nlum = lum(col); \t\t\t\t\tif(olum>nlum) col += (olum-nlum)/(1.0-nlum)*(ONE3-col); \t\t\t\t\telse if(nlum==0.0) col = ZERO3; \t\t\t\t\telse col = (olum/nlum) * col; \t\t\t\t}\t\t\t\tgl_FragColor = vec4(col,src.w);\t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[0].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[0].prototype.composite = function(srcTexture, shaderOptions) {
    const planar = {
        h: shaderOptions.lutR,
        l: shaderOptions.lutG,
        O: shaderOptions.lutB,
        w: allocBuffer(shaderOptions.lutR.length)
      };

    const lutLength = planar.h.length;
    if (this.lutCacheByLength["m" + lutLength] == null) {
      this.lutCacheByLength["m" + lutLength] = {
        lutTexture: new LayerSystem.RgbaTexture(lutLength, 1),
        interleavedLutBuffer: allocBuffer(lutLength * 4)
      }
    }
    const cacheEntry = this.lutCacheByLength["m" + lutLength];
    planarToInterleaved(planar, cacheEntry.interleavedLutBuffer);
    const lutTex = cacheEntry.lutTexture;
    lutTex.set(cacheEntry.interleavedLutBuffer);
    this.cacheUniforms(["source", "map", "toGray", "presLum"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform1f(uniforms.toGray, shaderOptions.toGray ? 1 : 0);
    gl.uniform1f(uniforms.presLum, shaderOptions.preserveLuminosity ? 1 : 0);
    this.bindTextures([uniforms.source, srcTexture, uniforms.map, lutTex.glTexture])
  };
  LayerSystem.adjLayerShaders[1] = function() {
    LayerSystem.ShaderProgram.call(this);
    this.hueSatMapTexture = new LayerSystem.RgbaTexture(256, 1);
    this.hueSatInterleaved = allocBuffer(256 * 4);
    let fragSrc = "\t\t\t\tprecision mediump float;\t\t\t\t" + LayerSystem.shaderLib.hue2rgbFn + "\t\t\t\t" + LayerSystem.shaderLib.rgbToHslFn + "\t\t\t\t" + LayerSystem.shaderLib.hslToRgbFn + "\t\t\t\t\t\t\t\tuniform sampler2D source;\t\t\t\tuniform sampler2D map;\t\t\t\tuniform float cfa; \t\t\t\tuniform float cfb; \t\t\t\tuniform int colorize; \t\t\t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\t\t\tvoid main(void) { \t\t\t\t\tvec4 src = texture2D(source, sCoord);\t\t\t\t\tvec3 rgb = src.rgb;\t\t\t\t\tfloat mn=min(rgb.r,min(rgb.g,rgb.b)), mx = max(rgb.r,max(rgb.g,rgb.b));\t\t\t\t\t\t\t\t\t\tvec3 hsl = rgbToHsl(rgb); \t\t\t\t\tfloat h = hsl.r, s = hsl.g, l = hsl.b; \t\t\t\t\t\t\t\t\t\tvec4 mapv = texture2D(map, vec2(h, 0));\t\t\t\t\tfloat nh = mapv.r; \t\t\t\t\tfloat sc = mapv.g*2.0-1.0; \t\t\t\t\tfloat lc = mapv.b*2.0-1.0; \t\t\t\t\t\t\t\t\t\tfloat cf = -lc, tv=mn;\t\t\t\t\tif(0.0<lc) {  cf=lc;  tv=mx;  }\t\t\t\t\t\t\t\t\t\tfloat a0 = cfa + cfb*cf*tv, a1 = cfb*(1.0-cf);\t\t\t\t\trgb = a0 + a1 * rgb;\t\t\t\t\t\t\t\t\t\thsl = rgbToHsl(rgb);  s = hsl.g;  l = hsl.b; \t\t\t\t\tfloat ns = sc; \t\t\t\t\tif(colorize==0) {\t\t\t\t\t\tif(sc>0.0) sc = pow(tan((3.14159265359/2.0)*sc),1.3);\t\t\t\t\t\tns = min(s * (1.0 + sc), 1.0); \t\t\t\t\t} \t\t\t\t\t\t\t\t\t\tgl_FragColor = vec4(hslToRgb(nh,ns,l),src.w); \t\t\t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[1].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[1].prototype.composite = function(srcTexture, shaderOptions) {
    planarToInterleaved({
      h: shaderOptions.hueLut,
      l: shaderOptions.satLut,
      O: shaderOptions.lightLut,
      w: allocBuffer(256)
    }, this.hueSatInterleaved);
    this.hueSatMapTexture.set(this.hueSatInterleaved);
    this.cacheUniforms(["source", "map", "cfa", "cfb", "colorize"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform1f(uniforms.cfa, shaderOptions.colorizeA);
    gl.uniform1f(uniforms.cfb, shaderOptions.colorizeB);
    gl.uniform1i(uniforms.colorize, shaderOptions.colorizeMode);
    this.bindTextures([uniforms.source, srcTexture, uniforms.map, this.hueSatMapTexture.glTexture])
  };
  LayerSystem.adjLayerShaders[2] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t" + LayerSystem.shaderLib.hue2rgbFn + "\t\t\t" + LayerSystem.shaderLib.rgbToHsvFn + "\t\t\t" + LayerSystem.shaderLib.hsvToRgbFn + "\t\t\t" + LayerSystem.shaderLib.rgbToHslFn + "\t\t\t" + LayerSystem.shaderLib.hslToRgbFn + "\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform float vib; \t\t\tuniform float sat; \t\t\tconst float PI = 3.141592653; \t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\tvoid main(void) { \t\t\t\tvec4 src = texture2D(source, sCoord); \t\t\t\tvec3 hsl = rgbToHsv(src.rgb); \t\t\t\tfloat h=hsl.r, s=hsl.g, l=hsl.b; \t\t\t\t\t\t\t\tfloat sk0 = 0.0, sk1 = 45.0/360.0; \t\t\t\tfloat skin = (h<sk1) ? cos((PI/2.0)*(h-sk1/2.0)/(sk1/2.0)) : 0.0; \t\t\t\t\t\t\t\ts = s + 0.2 * (1.0-0.4*skin) * vib * max(0.0, sin(s*PI)); \t\t\t\t\t\t\t\ts = s * (1.0 + sat); \t\t\t\t\t\t\t\ts = max(0.0, min(1.0, s));\t\t\t\tsrc.rgb = hsvToRgb(h,s,l);\t\t\t\tgl_FragColor = vec4(src.rgb,src.w); \t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[2].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[2].prototype.composite = function(srcTexture, shaderOptions) {
    this.cacheUniforms(["source", "vib", "sat"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform1f(uniforms.vib, shaderOptions.vibranceSat[0] / 100);
    gl.uniform1f(uniforms.sat, shaderOptions.vibranceSat[1] / 100);
    this.bindTextures([uniforms.source, srcTexture])
  };
  LayerSystem.adjLayerShaders[3] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform mat4  trf; \t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\tvoid main(void) { \t\t\t\tvec4 src = texture2D(source, sCoord); \t\t\t\tvec4 nsr = vec4(src.rgb,1.0); \t\t\t\tgl_FragColor = vec4((trf*nsr).rgb,src.w); \t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[3].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[3].prototype.composite = function(srcTexture, shaderOptions) {
    this.cacheUniforms(["source", "trf"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniformMatrix4fv(uniforms.trf, false, new Float32Array(transposeColorMatrix(shaderOptions.matrix)));
    this.bindTextures([uniforms.source, srcTexture])
  };
  LayerSystem.adjLayerShaders[4] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = "\t\t\tprecision mediump float; \t\t\t" + LayerSystem.shaderLib.rgbToLabFn + "\t\t\t" + LayerSystem.shaderLib.hue2rgbFn + "\t\t\t" + LayerSystem.shaderLib.hslToRgbFn + "\t\t\t" + LayerSystem.shaderLib.rgbToHslFn + "\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform vec3 mnm;\t  \t\t\tuniform vec3 mxm;\t  \t\t\tuniform vec3 shift;   \t\t\tuniform float lim;    \t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\tvoid main(void) { \t\t\t\tvec4 src = texture2D(source, sCoord); \t\t\t\t\t\t\t\tvec3 lab = rgbToLab(src.rgb);\t\t\t\tfloat scl = labSimilar(lab, mnm,mxm, lim);\t\t\t\t\t\t\t\tvec3 hsv = rgbToHsl(src.rgb); \t\t\t\tfloat nh = 2.0 + hsv[0]+scl*shift[0]; \t\t\t\thsv[0] = fract(nh); \t\t\t\thsv[1] = max(0.0, min(1.0, hsv[1] + scl*shift[1])); \t\t\t\thsv[2] = max(0.0, min(1.0, hsv[2] + scl*shift[2])); \t\t\t\t\t\t\t\tvec3 rgb = hslToRgb(hsv[0], hsv[1], hsv[2]); \t\t\t\t\t\t\t\tgl_FragColor = vec4(rgb,src.w); \t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[4].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[4].prototype.composite = function(srcTexture, shaderOptions) {
    this.cacheUniforms(["source", "mnm", "mxm", "shift", "lim"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform3fv(uniforms.mnm, new Float32Array(shaderOptions.labMin));
    gl.uniform3fv(uniforms.mxm, new Float32Array(shaderOptions.labMax));
    gl.uniform3fv(uniforms.shift, new Float32Array(shaderOptions.shift));
    gl.uniform1f(uniforms.lim, shaderOptions.fuzziness);
    this.bindTextures([uniforms.source, srcTexture])
  };
  LayerSystem.adjLayerShaders[5] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t" + LayerSystem.shaderLib.vec3Constants + "\t\t\t" + LayerSystem.shaderLib.hueDiffFn + "\t\t\t" + LayerSystem.shaderLib.hueCFn + "\t\t\t" + LayerSystem.shaderLib.rgbToHslFn + "\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform vec3 cfs[18]; \t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\tvoid main(void) { \t\t\t\tvec4 src = texture2D(source, sCoord); \t\t\t\tvec3 rgb = src.rgb; \t\t\t\tvec3 hsl = rgbToHsl(rgb); \t\t\t\tfloat mx = max(rgb.r, max(rgb.g, rgb.b)); \t\t\t\tfloat mn = min(rgb.r, min(rgb.g, rgb.b)); \t\t\t\t\t\t\t\tvec3 CMY = ONE3 - rgb; \t\t\t\tvec3 d = ZERO3; \t\t\t\t\t\t\t\tfor(int j=0; j<9; j++) \t\t\t\t{ \t\t\t\t    vec3 NCMY = CMY * cfs[j+j] + cfs[j+j+1]; \t\t\t\t\t\t\t\t\t\tfloat cfK = 0.0;\t\t\t\t\tif     (j< 6) { \t\t\t\t\t\tcfK = hueCF(float(j)*(1.0/6.0), hsl.x); \t\t\t\t\t\tcfK = cfK * hsl.y * 2.0*min(hsl.z, 1.0-hsl.z); \t\t\t\t\t} \t\t\t\t\telse if(j==6) cfK = max(0.0,mn-0.5)*2.0;\t\t\t\t\telse if(j==7) cfK = 1.0-(abs(mx-0.5)+abs(mn-0.5));\t\t\t\t\telse          cfK = max(0.0,0.5-mx)*2.0;\t\t\t\t\t\t\t\t\t\td += (max(ZERO3, min(ONE3, NCMY))-CMY)*cfK; \t\t\t\t} \t\t\t\t\t\t\t\tCMY = max(ZERO3, min(ONE3, CMY+d)); \t\t\t\trgb = ONE3 - CMY; \t\t\t\t\t\t\t\tgl_FragColor = vec4(rgb,src.w); \t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[5].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[5].prototype.composite = function(srcTexture, shaderOptions) {
    this.cacheUniforms(["source", "cfs"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform3fv(uniforms.cfs, shaderOptions.selcMatrix);
    this.bindTextures([uniforms.source, srcTexture])
  };
  LayerSystem.adjLayerShaders[6] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t" + LayerSystem.shaderLib.hue2rgbFn + "\t\t\t" + LayerSystem.shaderLib.hueDiffFn + "\t\t\t" + LayerSystem.shaderLib.hueCFn + "\t\t\t" + LayerSystem.shaderLib.rgbToHslFn + "\t\t\t" + LayerSystem.shaderLib.hslToRgbFn + "\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform float wght[6]; \t\t\tuniform float prms[6]; \t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\tvoid main(void) { \t\t\t\tvec4 src = texture2D(source, sCoord); \t\t\t\tvec3 rgb = src.rgb; \t\t\t\t\t\t\t\tfloat tint=prms[0], hue=prms[1], lum=prms[2], mcf=prms[3], lutR=prms[4], x1=prms[5]; \t\t\t\tvec3 hsl = rgbToHsl(rgb); \t\t\t\t\t\t\t\tfloat cf = 0.0;\t\t\t\tfor(int j=0; j<6; j++) cf += min(1.0, 1.7*(1.0-hsl.z)) * hsl.y *  wght[j] * hueCF(hsl.x, float(j)*(1.0/6.0));\t\t\t\t\t\t\t\tfloat lig = max(0.0, min(1.0, hsl.z*(1.0+cf)));\t\t\t\tif(tint==1.0) {  \t\t\t\t\tfloat totl = 0.0;\t\t\t\t\tif     (lig<lutR) totl = lig*(0.5/lum); \t\t\t\t\telse if(lig<x1) totl = lig + (mcf)*(0.5 - lum); \t\t\t\t\telse            totl = 1.0 - (1.0-lig)*0.5/(1.0-lum); \t\t\t\t\t\t\t\t\t\thsl.x = hue;  \t\t\t\t\thsl.y = min(1.0, mcf + 3.0*mcf*abs(lig-0.5*(lutR+x1))); \t\t\t\t\thsl.z = totl; \t\t\t\t} \t\t\t\telse {  hsl.x=0.0;  hsl.y=0.0;  hsl.z=lig;  } \t\t\t\t\t\t\t\trgb = hslToRgb(hsl.x, hsl.y, hsl.z); \t\t\t\t\t\t\t\tgl_FragColor = vec4(rgb,src.w); \t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[6].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[6].prototype.composite = function(srcTexture, shaderOptions) {
    this.cacheUniforms(["source", "wght", "prms"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    const tintParams = [shaderOptions.useTint, shaderOptions.tintHue, shaderOptions.tintLum, shaderOptions.tintSat, shaderOptions.tintLower, shaderOptions.tintUpper];
    gl.uniform1fv(uniforms.wght, new Float32Array(shaderOptions.hueWeights));
    gl.uniform1fv(uniforms.prms, new Float32Array(tintParams));
    this.bindTextures([uniforms.source, srcTexture])
  };
  LayerSystem.adjLayerShaders[7] = function() {
    LayerSystem.ShaderProgram.call(this);
    this.iccLutCacheByResolution = {};
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform sampler2D lut;\t\t\tuniform float N;\t\t\t\t\t\tvarying vec2 sCoord;\t\t\t\t\t\tvoid main(void) { \t\t\t\tfloat iN = 1.0/N; \t\t\t\tvec4 src = texture2D(source, sCoord); \t\t\t\tfloat fb = 0.5*iN + src.b*(1.0-iN); \t\t\t\tfloat fg = 0.5*iN + src.g*(1.0-iN); \t\t\t\tfloat R  = src.r*(N-1.0)*0.999999; \t\t\t\tfloat ir = floor(R)*iN;  \t\t\t\t\t\t\t\tvec4 c0 = texture2D(lut, vec2(fb, ir   +( fg   )*iN)); \t\t\t\tvec4 c1 = texture2D(lut, vec2(fb, ir+iN+( fg   )*iN)); \t\t\t\tvec4 rs = mix(c0,c1,R-floor(R));  \t\t\t\tgl_FragColor = vec4(rs.rgb,src.w); \t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.adjLayerShaders[7].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.adjLayerShaders[7].prototype.composite = function(srcTexture, shaderOptions) {
    this.cacheUniforms(["source", "lut", "N"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    const lutResolution = shaderOptions.lutResolution;
    const pixBuf = shaderOptions.pixBuf;
    if (this.iccLutCacheByResolution["m" + lutResolution] == null) this.iccLutCacheByResolution["m" + lutResolution] = new LayerSystem.RgbaTexture(lutResolution, lutResolution * lutResolution);
    const lutTex = this.iccLutCacheByResolution["m" + lutResolution];
    lutTex.set(pixBuf);
    gl.uniform1f(uniforms.N, lutResolution);
    this.bindTextures([uniforms.source, srcTexture, uniforms.lut, lutTex.glTexture]);
    gl.activeTexture(gl.TEXTURE1);
    const linearFilter = gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linearFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linearFilter);
    gl.activeTexture(gl.TEXTURE0)
  };
}

function installFilterPipeline(LayerSystem) {
  LayerSystem.filter = {
    shaderCache: {},
    SPECULAR: 0,
    BRISTLE: 1,
    ANISOTROPIC: 2,
    DEPTH_BEVEL: 3
  };
  LayerSystem.filter.render = function(filterOptions, srcTexture) {
    const filterTypes = LayerSystem.filter;
    const shaderIndex = [filterTypes.SPECULAR, filterTypes.BRISTLE, filterTypes.ANISOTROPIC, filterTypes.DEPTH_BEVEL].indexOf(filterOptions.type);
    let shader = LayerSystem.filter.shaderCache[filterOptions.type];
    if (shader == null) shader = LayerSystem.filter.shaderCache[filterOptions.type] = new LayerSystem.filterShaders[shaderIndex];
    shader.use();
    shader.composite(srcTexture, filterOptions);
    LayerSystem.renderCtx.drawArrays(LayerSystem.renderCtx.TRIANGLES, 0, 6)
  };
  LayerSystem.filterShaders = [0, 0, 0, 0, 0, 0, 0];
  LayerSystem.filterShaders[3] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = ` precision mediump float;uniform sampler2D source;uniform vec2 iwh;uniform float tdep;uniform float rrad;uniform vec2 spec;uniform vec3 nois;uniform mat4 poly0;uniform mat4 poly1;varying vec2 sCoord;bool inPoly(vec4 v){vec4 p=max(v*poly0,v*poly1);return max(max(p.x,p.y),max(p.z,p.w))<=0.0;}vec3 rand3(vec3 px, vec3 py){vec3 rawVal=sin(px*11.697096+py*73.32456) * 12157.47691;return rawVal - floor(rawVal);}vec3 gaus3(vec3 px, vec3 py){return (rand3(px,py)+rand3(1.21*px,1.7*py)+rand3(3.1*py,4.7*px)+rand3(0.67*py,0.81*px) -2.0 )*1.5;}vec3 unif3(vec3 px, vec3 py){return rand3(px,py)*2.0-1.0;}const float PRC=70.0;void main(void){vec4 sclr=texture2D(source, sCoord);float depth=abs(tdep-sclr.w);float rad=depth*rrad;if(rad!=0.0){vec3 sum;float sw=0.0, inc=1.0;for(float y=-PRC;y<=PRC;y++){inc=1.0-inc;if(y<-rad||y>rad) continue;for(float x=-PRC;x<=PRC;x+=2.0){float cx=x+inc;if(x<-rad||x>rad) continue;if(!inPoly(vec4(cx,y,rad,0.0))) continue;vec4 clr=texture2D(source, sCoord+vec2(cx,y)*iwh);float cd=abs(tdep-clr.w);float avg=0.3*clr.r+0.59*clr.g+0.11*clr.b;float frc=spec.x*cd*cd;if(avg>spec.y) clr.rgb=(1.0-frc)*clr.rgb + frc*vec3(7.0);float prt=(cd<depth ? ((depth-cd)/depth) : (cd==0.0?0.0:(cd-depth)/cd));float cw=1.0-prt;sw+=cw;sum+=cw*clr.rgb;}}/*gl_FragColor=inPoly(vec4(-1.0+sCoord.x*2.0,-1.0+sCoord.y*2.0,1,0))?vec4(1,1,1,1):vec4(0,0,0,1);*/ sclr=vec4(sum/sw,1.0);}vec3 pa=vec3(sCoord.x,sCoord.y,2.1*sCoord.x);vec3 pb=vec3(sCoord.y,3.235*sCoord.x,2.3*sCoord.y);vec3 nose=nois.y==0.0 ? unif3(pa,pb) : gaus3(pa,pb);if(nois.z==1.0) nose.x=nose.y=nose.z;sclr.rgb +=(depth*nois.x)*nose;gl_FragColor=sclr;}`;
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.filterShaders[3].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.filterShaders[3].prototype.composite = function(srcTexture, filterOptions) {
    this.cacheUniforms("source iwh tdep rrad spec nois poly0 poly1".split(" "));
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform2fv(uniforms.iwh, filterOptions.invTexelSize);
    gl.uniform1f(uniforms.tdep, filterOptions.targetDepth);
    gl.uniform1f(uniforms.rrad, filterOptions.bevelRadius);
    gl.uniform2fv(uniforms.spec, filterOptions.specularThresholds);
    gl.uniform3fv(uniforms.nois, filterOptions.noiseSettings);
    gl.uniformMatrix4fv(uniforms.poly0, false, filterOptions.clipPolyMatrix0);
    gl.uniformMatrix4fv(uniforms.poly1, false, filterOptions.clipPolyMatrix1);
    this.bindTextures([uniforms.source, srcTexture]);
    const linearFilter = gl.LINEAR;
    gl.activeTexture(gl.TEXTURE0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linearFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linearFilter);
    gl.activeTexture(gl.TEXTURE0)
  };
  LayerSystem.filterShaders[0] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = ` precision mediump float; uniform sampler2D source; uniform vec2 iwh; uniform vec3 ld; uniform float shine; varying vec2 sCoord; float getShadow(vec2 p) { float x1 = texture2D(source, p+vec2(-1.0, 0.0)*iwh).w; float x2 = texture2D(source, p+vec2( 1.0, 0.0)*iwh).w; float y1 = texture2D(source, p+vec2( 0.0,-1.0)*iwh).w; float y2 = texture2D(source, p+vec2( 0.0, 1.0)*iwh).w; float dx0 = 0.7, dx2 = (x2-x1); float dy1 = 0.7, dy2 = (y2-y1); vec3 n = normalize(vec3(-dx2*dy1, -dx0*dy2, dx0*dy1)); return dot(ld,n); } void main(void) { float wh = 1.0 + getShadow(sCoord)*shine; gl_FragColor = texture2D(source, sCoord)*wh; }`;
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.filterShaders[0].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.filterShaders[0].prototype.composite = function(srcTexture, filterOptions) {
    this.cacheUniforms(["source", "iwh", "ld", "shine"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform2fv(uniforms.iwh, filterOptions.invTexelSize);
    gl.uniform3fv(uniforms.ld, filterOptions.lightDirection);
    gl.uniform1f(uniforms.shine, filterOptions.shine);
    this.bindTextures([uniforms.source, srcTexture, uniforms.tang, filterOptions.tangentMapTexture])
  };
  LayerSystem.filterShaders[1] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = ` precision mediump float; uniform sampler2D source; uniform vec2 iwh; uniform float isc; uniform float bristle; varying vec2 sCoord; float hash(float px, float py) { float rawVal = sin(px*11.697096+py*73.32456) * 12157.47691; return rawVal - floor(rawVal); } float getNoise(vec2 o) { vec2 p = (o+vec2(613.0,117.0))*isc; vec2 np = floor(p); vec2 nrP = p-np; float s11=sin(11.0); vec2 c0 = cos(np)*s11; vec2 c1 = cos(np+vec2(1.0,1.0))*s11; float n = hash(c0.x,c0.y); float nr = hash(c1.x,c1.y); float nd = hash(c0.x,c1.y); float nrd = hash(c1.x,c1.y); float h1 = mix(n , nr,nrP.x); float h2 = mix(nd,nrd,nrP.x); float v = mix(h1, h2,nrP.y); v = (v < 0.5) ? 0.0:1.0; float rslt = v + bristle * hash(cos(p.x)*s11,cos(p.y)*s11); return rslt*(1.0/3.0); } void main(void) { vec2 xy = sCoord/iwh; vec4 col = texture2D(source, sCoord); col.a = getNoise(xy); gl_FragColor = col; }`;
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.filterShaders[1].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.filterShaders[1].prototype.composite = function(srcTexture, filterOptions) {
    this.cacheUniforms(["source", "iwh", "isc", "bristle"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform2fv(uniforms.iwh, filterOptions.invTexelSize);
    gl.uniform1f(uniforms.isc, filterOptions.noiseScale);
    gl.uniform1f(uniforms.bristle, filterOptions.bristleStrength);
    this.bindTextures([uniforms.source, srcTexture])
  };
  LayerSystem.filterShaders[2] = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = ` precision mediump float; uniform sampler2D source; uniform sampler2D tang; uniform vec2 iwh; uniform float sigma; uniform float expo; varying vec2 sCoord; float weight (float x) { return exp( -pow(x,expo)/(2.0*sigma*sigma) ); } void main(void) { float hw=sigma+sigma; float sw = 1.0; vec4 sum = texture2D(source, sCoord); vec2 fp = 2.0*(texture2D(tang, sCoord).xy-vec2(0.5,0.5)); vec2 d = fp; for(int i=0; i<2; i++) { vec2 p = sCoord; for(float r=0.0; r<2000.0; r++) { vec2 md = 2.0*(texture2D(tang, p).xy-vec2(0.5,0.5)); if(dot(md,d)<0.0) { md=-md; } d = md; p += md*iwh; float w = weight(r); sum += w*texture2D(source, p); sw+=w; if(r>=hw) break; } d=-fp; } gl_FragColor = sum*(1.0/sw); }`;
    this.compileAndLink(fragSrc, LayerSystem.adjLayerRenderer.vertexShader)
  };
  LayerSystem.filterShaders[2].prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.filterShaders[2].prototype.composite = function(srcTexture, filterOptions) {
    this.cacheUniforms(["source", "tang", "iwh", "sigma", "expo"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform2fv(uniforms.iwh, filterOptions.invTexelSize);
    gl.uniform1f(uniforms.sigma, filterOptions.blurSigma);
    gl.uniform1f(uniforms.expo, filterOptions.blurExponent);
    this.bindTextures([uniforms.source, srcTexture, uniforms.tang, filterOptions.tangentMapTexture]);
    const linearFilter = gl.LINEAR;
    gl.activeTexture(gl.TEXTURE0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linearFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linearFilter);
    gl.activeTexture(gl.TEXTURE0)
  };
}

function installBlendRenderers(LayerSystem) {
  LayerSystem.renderers = {};
  LayerSystem.renderers.shaderCache = {};
  LayerSystem.renderers.clippingRenderer = null;
  LayerSystem.renderers.clippingNoAlphaRenderer = null;
  LayerSystem.renderers.noClipRenderer = null;
  LayerSystem.renderers.composite = function(blendMode, srcTex, srcRect, dstTex, dstRect, clipRect, opacity, shapeStyleParams) {
    if (shapeStyleParams == null) shapeStyleParams = defaultShapeStyleParams();
    if (typeof blendMode !== "string" || blendMode === "" || blendMode === "pass" || LayerSystem.renderers.blendShaderBodies[blendMode] == null) blendMode = "norm";
    if ("idiv,lbrn,div ,lddg,vLit,lLit,hMix,diff".split(",").indexOf(blendMode) == -1) {
      opacity = opacity * shapeStyleParams.fill;
      shapeStyleParams.fill = 1;
      shapeStyleParams.style = false
    }
    const cacheKey = blendMode + (shapeStyleParams.blendIfTable ? "1" : "");
    if (LayerSystem.renderers.shaderCache[cacheKey] == null) LayerSystem.renderers.shaderCache[cacheKey] = new LayerSystem.renderers.BlendShader(blendMode, shapeStyleParams.blendIfTable != null);
    const blendShader = LayerSystem.renderers.shaderCache[cacheKey];
    const drawRect = srcRect.intersect(dstRect).intersect(clipRect);
    drawRect.offset(-dstRect.x, -dstRect.y);
    if (drawRect.isEmpty()) return;
    let gl = LayerSystem.renderCtx;
    LayerSystem.bindRenderTarget(dstTex, drawRect);
    dstTex.saveBackup(drawRect);
    blendShader.use();
    blendShader.composite(srcTex.glTexture, dstTex.backupTexture, LayerSystem.rectToViewportCoords(srcRect, dstRect), opacity, shapeStyleParams.fill, shapeStyleParams.style ? 1 : 0, shapeStyleParams.preserveDestAlpha ? 1 : 0, shapeStyleParams.blendIfTable ? new Float32Array(shapeStyleParams.blendIfTable) : null);
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  };
  LayerSystem.renderers.compositeWithClipping = function(clipSourceTex, srcRect, dstTex, dstRect, weightTex, weightRect, maskChannelFill, clipRect, weightScale, dissolveMode, colorSwitch) {
    if (LayerSystem.renderers.clippingRenderer == null) LayerSystem.renderers.clippingRenderer = new LayerSystem.renderers.ClippingShader(true, true);
    if (LayerSystem.renderers.clippingNoAlphaRenderer == null) LayerSystem.renderers.clippingNoAlphaRenderer = new LayerSystem.renderers.ClippingShader(true, false);
    if (LayerSystem.renderers.noClipRenderer == null) LayerSystem.renderers.noClipRenderer = new LayerSystem.renderers.ClippingShader(false, true);
    const dissolveFactor = dissolveMode ? 1 : 0;
    const clipShader = clipSourceTex ? weightTex ? LayerSystem.renderers.clippingRenderer : LayerSystem.renderers.clippingNoAlphaRenderer : LayerSystem.renderers.noClipRenderer;
    const colorSwitchVec = new Float32Array(colorSwitch ? [colorSwitch[0], colorSwitch[1], colorSwitch[2], 1] : [1, 1, 1, 1]);
    const drawRect = srcRect ? srcRect.intersect(dstRect).intersect(clipRect) : dstRect.intersect(clipRect);
    if (drawRect.isEmpty()) return;
    drawRect.offset(-dstRect.x, -dstRect.y);
    let gl = LayerSystem.renderCtx;
    LayerSystem.bindRenderTarget(dstTex, drawRect);
    dstTex.saveBackup(drawRect);
    clipShader.use();
    if (clipSourceTex == null) clipShader.composite(null, dstTex.backupTexture, weightTex.glTexture, LayerSystem.rectToViewportCoords(dstRect, dstRect), LayerSystem.rectToViewportCoords(weightRect, dstRect), maskChannelFill / 255, weightScale, dissolveFactor, colorSwitchVec);
    else if (weightTex) clipShader.composite(clipSourceTex.glTexture, dstTex.backupTexture, weightTex.glTexture, LayerSystem.rectToViewportCoords(srcRect, dstRect), LayerSystem.rectToViewportCoords(weightRect, dstRect), maskChannelFill / 255, weightScale, dissolveFactor, colorSwitchVec);
    else clipShader.composite(clipSourceTex.glTexture, dstTex.backupTexture, null, LayerSystem.rectToViewportCoords(srcRect, dstRect), null, maskChannelFill / 255, weightScale, dissolveFactor, colorSwitchVec);
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  };
  LayerSystem.renderers.compositePassthrough = function(srcTex, dstTex, alphaTex) {
    if (LayerSystem.renderers.passthroughInstance == null) LayerSystem.renderers.passthroughInstance = new LayerSystem.renderers.PassthroughShader;
    const passthroughShader = LayerSystem.renderers.passthroughInstance;
    const fullRect = new Rect(0, 0, srcTex.width, srcTex.height);
    let gl = LayerSystem.renderCtx;
    LayerSystem.bindRenderTarget(dstTex);
    dstTex.saveBackup(fullRect);
    passthroughShader.use();
    passthroughShader.composite(fullRect, srcTex.glTexture, dstTex.backupTexture, alphaTex.glTexture);
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  };
  LayerSystem.renderers.blendShaderBodies = {
    norm: "return a;",
    diss: "return a;",
    dark: "return min(a,b);",
    "mul ": "return a*b;",
    idiv: "  vec3 d = (a*vec3(f)+ONE3-vec3(f));  return mix(mix(ONE3-((ONE3-b)/max(d,vec3(1e-6))), ZERO3, vec3(greaterThanEqual(ONE3-b,d)) ), ONE3   ,   vec3(equal(b,ONE3) ));   ",
    lbrn: "return max(ZERO3, a*f+b-f);",
    dkCl: "return ( lum(a)<lum(b) ? a : b );",
    lite: "return max(a,b);",
    scrn: "return b+a-b*a;",
    "div ": "a*=f;  return mix(    mix(  min(ONE3,b/(1.0-a)), ONE3,  step(1.0-a, b))     , ZERO3, vec3(equal(b,ZERO3)) );",
    lddg: "a*=f;  return min(ONE3,a+b);",
    lgCl: "return ( lum(a)>lum(b) ? a : b );",
    over: "return mix( a+(2.0*b -1.0)-a*(2.0*b-1.0) ,  2.0*b*a , step(-HALF3,-b) );",
    sLit: "return mix( b+(2.0*a -1.0)*(D(b)-b)  , b-(1.0-2.0*a)*b*(1.0-b) , step(-HALF3,-a) );",
    hLit: "return mix( b+(2.0*a -1.0)-b*(2.0*a-1.0) ,  2.0*a*b , step(-HALF3,-a) );",
    vLit: " return mix( ocddg(2.0*a-1.0,b,f)  ,  ocbrn(2.0*a,b,f)  ,  vec3(greaterThanEqual(HALF3,a))); ",
    lLit: "return mix( min(ONE3, (2.0*a-1.0)*f+b) , max(ZERO3, 2.0*a*f+b-f)  , step(-HALF3,-a));",
    pLit: "return mix( max(2.0*a-1.0,b) , min(2.0*a, b) , step(-HALF3,-a)  );",
    hMix: "if(f>0.99) return vec3(greaterThanEqual(a+b,ONE3));   return  min( ONE3, max(ZERO3,  (b+a*f-f)/(1.0-f+1e-6)  ))  ;  ",
    diff: "return abs(a*f-b);",
    smud: "return a+b-2.0*a*b;",
    fsub: "return max(b-a, ZERO3);",
    fdiv: "return min(b/a, ONE3);",
    "hue ": "return  setLum( setSat(a, sat(b)) , lum(b) ); ",
    "sat ": "return  setLum( setSat(b, sat(a)) , lum(b) ); ",
    colr: "return  setLum( a, lum(b) ); ",
    "lum ": "return  setLum( b, lum(a) ); "
  };
  LayerSystem.renderers.BlendShader = function(blendMode, hasBlendIf) {
    LayerSystem.ShaderProgram.call(this);
    let GuBlendBody = LayerSystem.renderers.blendShaderBodies[blendMode];
    if (GuBlendBody == null) GuBlendBody = LayerSystem.renderers.blendShaderBodies.norm;
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t" + LayerSystem.shaderLib.vec3Constants + "\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform sampler2D target;\t\t\tuniform float alpha;\t\t\tuniform float fill;\t\t\tuniform float style;\t\t\tuniform float keepBGA;\t\t\t" + (hasBlendIf ? "uniform vec4 blIf[10];" : "") + "\t\t\t\t\t\tvarying vec2 tCoord;\t\t\tvarying vec2 sCoord;\t\t\t\t\t\t\t\t\t" + LayerSystem.shaderLib.satFn + "\t\t\t" + LayerSystem.shaderLib.lumFn + "\t\t\t" + LayerSystem.shaderLib.dTrfn + "\t\t\t" + LayerSystem.shaderLib.colorBurnBlend + "\t\t\t" + LayerSystem.shaderLib.colorDodgeBlend + "\t\t\t" + LayerSystem.shaderLib.midSatFn + "\t\t\t" + LayerSystem.shaderLib.setSatFn + "\t\t\t" + LayerSystem.shaderLib.clipColFn + "\t\t\t" + LayerSystem.shaderLib.setLumFn + "\t\t\t" + LayerSystem.shaderLib.hashFn + "\t\t\t" + (hasBlendIf ? LayerSystem.shaderLib.blendIfFn : "") + "\t\t\t\t\t\tvec3  BB(vec3  a, vec3  b, float f) { " + GuBlendBody + " } \t\t\t\t\t\tvoid main(void) {\t\t\t\tvec4 tgt = texture2D(target, tCoord);\t\t\t\tvec4 src = texture2D(source, sCoord);";
    const vertSrc = "\t\t\tattribute vec2 verPos;\t\t\tuniform vec4 srct;\t\t\tvarying vec2 tCoord;\t\t\tvarying vec2 sCoord;\t\t\tvoid main(void) {\t\t\t\ttCoord = verPos;\t\t\t\tsCoord = (verPos-srct.xy)/srct.zw;\t\t\t\tgl_Position = vec4(vec2(-1.0,-1.0) + 2.0*verPos, 0.0, 1.0);\t\t\t}";
    if (blendMode == "diss") fragSrc += "\t\t\t\t\tgl_FragColor = (hash(tCoord) >= (keepBGA + (1.0-keepBGA)*src.w)*alpha ? tgt : vec4(src.xyz, keepBGA*tgt.w + (1.0-keepBGA)));  }";
    else fragSrc += "  \t\t\t\t\tfloat as = (keepBGA + (1.0-keepBGA)*src.w) * alpha, at = keepBGA + (1.0-keepBGA)*tgt.w; \t\t\t\t\t" + (hasBlendIf ? "  as*=blendIf(src,tgt,blIf);  " : "") + "\t\t\t\t\tfloat ats = at * (1.0-as), ao = as + ats, iao = (ao==0.0) ? 0.0 : (1.0/ao); \t\t\t\t\tfloat ccf = (style==1.0) ? 1.0 : as; \t\t\t\t\tvec3 ncl = ( (1.0-at)*as*src.xyz + (1.0-ccf)*at*tgt.xyz + ccf*at*BB(src.xyz, tgt.xyz, (1.0+as-ccf)*fill)  ) * iao;\t\t\t\t\tgl_FragColor = vec4(ncl, keepBGA*tgt.w + (1.0-keepBGA)*(as*fill + at*(1.0-as*fill)));\t\t\t\t\t\t\t}";
    this.compileAndLink(fragSrc, vertSrc)
  };
  LayerSystem.renderers.BlendShader.prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.renderers.BlendShader.prototype.composite = function(srcGlTexture, dstGlTexture, srcViewportCoords, opacity, fill, style, keepBGA, blendIfRanges) {
    this.cacheUniforms("srct alpha source target fill style keepBGA blIf".split(" "));
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform4fv(uniforms.srct, srcViewportCoords);
    gl.uniform1f(uniforms.alpha, opacity);
    gl.uniform1f(uniforms.fill, fill);
    gl.uniform1f(uniforms.style, style);
    gl.uniform1f(uniforms.keepBGA, keepBGA);
    if (blendIfRanges) gl.uniform4fv(uniforms.blIf, blendIfRanges);
    this.bindTextures([uniforms.source, srcGlTexture, uniforms.target, dstGlTexture])
  };
  LayerSystem.renderers.ClippingShader = function(clipsSource, usesWeightTexture) {
    LayerSystem.ShaderProgram.call(this);
    this.clipsSource = clipsSource;
    this.usesWeightTexture = usesWeightTexture;
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t\t\t\tuniform sampler2D source;\t\t\tuniform sampler2D target;\t\t\tuniform sampler2D weight;\t\t\tuniform vec4 cswitch;\t\t\tuniform float wcolor;\t\t\tuniform float awg; /* weight scale */\t\t\tuniform float dissv; /* dissolve factor */\t\t\t\t\t\tvarying vec2 tCoord;\t\t\tvarying vec2 sCoord;\t\t\tvarying vec2 wCoord;\t\t\t\t\t\t" + LayerSystem.shaderLib.in01Fn + "\t\t\t" + LayerSystem.shaderLib.hashFn + "\t\t\t\t\t\tvoid main(void) {\t\t\t\tvec4 tgt = texture2D(target, tCoord);\t\t\t\tvec4 src = " + (clipsSource ? "texture2D(source, sCoord)" : "vec4(0.0)") + "; \t\t\t\tfloat wg = awg " + (usesWeightTexture ? "* (in01(wCoord) ? texture2D(weight, wCoord).w : wcolor)" : "") + ";\t\t\t\t" + (clipsSource ? "" : "wg = 1.0-wg;") + "\t\t\t\tfloat hwg = hash(tCoord)>=wg ? 0.0 : 1.0;  wg = dissv*hwg + (1.0-dissv)*wg; \t\t\t\tfloat as = wg*src.w, at = (1.0-wg)*tgt.w, ao = as+at;\t\t\t\t\t\t\t\tvec4 nc = vec4( (as*src.xyz + at*tgt.xyz)/ao, ao );  \t\t\t\tgl_FragColor =  " + (usesWeightTexture ? "nc" : "cswitch*nc + (1.0- cswitch)*tgt") + ";    \t\t\t}";
    const vertSrc = "\t\t\tattribute vec2 verPos;\t\t\tvarying vec2 tCoord;\t\t\tvarying vec2 sCoord;\t\t\tvarying vec2 wCoord;\t\t\t\t\t\tuniform vec4 srct;\t\t\tuniform vec4 wrct;\t\t\tvoid main(void) {\t\t\t\ttCoord = verPos;\t\t\t\tsCoord = (verPos-srct.xy)/srct.zw;\t\t\t\twCoord = (verPos-wrct.xy)/wrct.zw;\t\t\t\tgl_Position = vec4(vec2(-1.0,-1.0) + 2.0*verPos, 0.0, 1.0);\t\t\t}";
    this.compileAndLink(fragSrc, vertSrc)
  };
  LayerSystem.renderers.ClippingShader.prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.renderers.ClippingShader.prototype.composite = function(clipSourceGlTexture, dstBackupGlTexture, weightGlTexture, srcViewportCoords, weightViewportCoords, fallbackWeightAlpha, weightScale, dissolveFactor, colorSwitch) {
    if (this.usesWeightTexture) this.cacheUniforms("srct wrct wcolor awg dissv source target weight cswitch".split(" "));
    else this.cacheUniforms("srct awg dissv source target cswitch".split(" "));
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform4fv(uniforms.srct, srcViewportCoords);
    if (this.usesWeightTexture) {
      gl.uniform4fv(uniforms.wrct, weightViewportCoords);
      gl.uniform1f(uniforms.wcolor, fallbackWeightAlpha)
    } else {
      gl.uniform4fv(uniforms.cswitch, colorSwitch)
    }
    gl.uniform1f(uniforms.awg, weightScale);
    gl.uniform1f(uniforms.dissv, dissolveFactor);
    const texturePairs = [uniforms.source, clipSourceGlTexture, uniforms.target, dstBackupGlTexture];
    if (this.usesWeightTexture) texturePairs.push(uniforms.weight, weightGlTexture);
    this.bindTextures(texturePairs)
  };
  LayerSystem.renderers.PassthroughShader = function() {
    LayerSystem.ShaderProgram.call(this);
    let fragSrc = "\t\t\tprecision mediump float;\t\t\t\t\t\tuniform sampler2D prev;\t\t\tuniform sampler2D next;\t\t\tuniform sampler2D alpha;\t\t\t\t\t\tvarying vec2 coord;\t\t\t\t\t\t\t\t\tvoid main(void) {\t\t\t\tvec3 or = texture2D(prev , coord).rgb;\t\t\t\tvec3 ir = texture2D(next , coord).rgb; \t\t\t\tfloat al = texture2D(alpha, coord).w; \t\t\t\tgl_FragColor =  vec4(  (ir-(1.0-al)*or)*(1.0/al)   ,1.0 );  \t\t\t}";
    const vertSrc = "\t\t\tattribute vec2 verPos;\t\t\tvarying vec2 coord;\t\t\t\t\t\tuniform vec4 rct;\t\t\tvoid main(void) {\t\t\t\tcoord = verPos;\t\t\t\tgl_Position = vec4(vec2(-1.0,-1.0) + 2.0*verPos, 0.0, 1.0);\t\t\t}";
    this.compileAndLink(fragSrc, vertSrc)
  };
  LayerSystem.renderers.PassthroughShader.prototype = Object.create(LayerSystem.ShaderProgram.prototype);
  LayerSystem.renderers.PassthroughShader.prototype.composite = function(viewportRect, prevGlTexture, nextGlTexture, alphaGlTexture) {
    this.cacheUniforms(["rct", "prev", "next", "alpha"]);
    let gl = LayerSystem.renderCtx;
    const uniforms = this.uniformLocations;
    gl.uniform4fv(uniforms.rct, [0, 0, 1, 1]);
    this.bindTextures([uniforms.prev, prevGlTexture, uniforms.next, nextGlTexture, uniforms.alpha, alphaGlTexture])
  };

}

/**
 * The adjustment shader programs, by index into `LayerSystem.adjLayerShaders`.
 * The adjustment engine names these when it builds shader options; the renderer
 * uses them to pick the program.
 */
export const AdjustmentShaderType = Object.freeze({
  LookupTable: 0,
  HueSat: 1,
  Vibrance: 2,
  SelectiveColor: 3,
  BlackWhite: 4,
  ColorMatrix: 5,
  ReplaceColor: 6,
  IccLut: 7,
});

/**
 * Per-layer parameters `LayerSystem.renderers.composite` reads when the caller
 * has no layer style to contribute: full fill, all channels, no knockout.
 */
export function defaultShapeStyleParams() {
  return {
    fill: 1,
    blendIfTable: null,
    channelRestrictions: [1, 1, 1],
    knockout: 0,
    style: false,
    preserveDestAlpha: false,
  };
}

/**
 * The layer compositing runtime. There is one: it owns the GL context and the
 * compiled shader programs, and a second would mean a second context.
 *
 * Building the object is pure — it is methods and shader-source tables — so it
 * happens here at module scope. The canvas and the GL context are not: they
 * need a document, so {@link initLayerSystemGl} makes them, once, from startup.
 * Until then `webglEnabled` is false and the CPU paths run.
 */
export const LayerSystem = {
  webglEnabled: false,
  glContextAvailable: false,
  debugMode: false,
  offscreenCanvas: null,
  renderCtx: null,
  glFramebuffer: null,
  textureMemoryCount: 0,
  minifyGlsl,
  rectToViewportCoords,
};

installGpuCore(LayerSystem);
installShaderProgram(LayerSystem);
installTextures(LayerSystem);
installAdjPipeline(LayerSystem);
installFilterPipeline(LayerSystem);
installBlendRenderers(LayerSystem);

/**
 * Give the layer system its canvas and GL context. Safe to call more than once;
 * the second call does nothing.
 */
export function initLayerSystemGl() {
  if (LayerSystem.offscreenCanvas !== null) return LayerSystem;
  LayerSystem.offscreenCanvas = document.createElement("canvas");
  tryInitWebGl(LayerSystem);
  return LayerSystem;
}
