var PDFJSDev={test:function(){return false}};
(() => {
  // ../../pdfjs/src/shared/util.js
  var VerbosityLevel = {
    ERRORS: 0,
    WARNINGS: 1,
    INFOS: 5
  };
  var verbosity = VerbosityLevel.WARNINGS;
  function info(msg) {
    if (verbosity >= VerbosityLevel.INFOS) {
      console.log(`Info: ${msg}`);
    }
  }
  function warn(msg) {
    if (verbosity >= VerbosityLevel.WARNINGS) {
      console.log(`Warning: ${msg}`);
    }
  }
  function unreachable(msg) {
    throw new Error(msg);
  }
  function assert(cond, msg) {
    if (!cond) {
      unreachable(msg);
    }
  }
  function shadow(obj, prop, value) {
    if (typeof PDFJSDev === "undefined" || PDFJSDev.test("!PRODUCTION || TESTING")) {
      assert(
        prop in obj,
        `shadow: Property "${prop && prop.toString()}" not found in object.`
      );
    }
    Object.defineProperty(obj, prop, {
      value,
      enumerable: true,
      configurable: true,
      writable: false
    });
    return value;
  }
  var BaseException = (function BaseExceptionClosure() {
    function BaseException2(message, name) {
      if (this.constructor === BaseException2) {
        unreachable("Cannot initialize BaseException.");
      }
      this.message = message;
      this.name = name;
    }
    BaseException2.prototype = new Error();
    BaseException2.constructor = BaseException2;
    return BaseException2;
  })();
  var FormatError = class extends BaseException {
    constructor(msg) {
      super(msg, "FormatError");
    }
  };
  var hexNumbers = [...Array(256).keys()].map(
    (n) => n.toString(16).padStart(2, "0")
  );

  // ../../pdfjs/src/core/core_utils.js
  function log2(x) {
    if (x <= 0) {
      return 0;
    }
    return Math.ceil(Math.log2(x));
  }
  function readInt8(data, offset) {
    return data[offset] << 24 >> 24;
  }
  function readUint16(data, offset) {
    return data[offset] << 8 | data[offset + 1];
  }
  function readUint32(data, offset) {
    return (data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0;
  }

  // ../../pdfjs/src/core/jpg.js
  var JpegError = class extends BaseException {
    constructor(msg) {
      super(`JPEG error: ${msg}`, "JpegError");
    }
  };
  var DNLMarkerError = class extends BaseException {
    constructor(message, scanLines) {
      super(message, "DNLMarkerError");
      this.scanLines = scanLines;
    }
  };
  var EOIMarkerError = class extends BaseException {
    constructor(msg) {
      super(msg, "EOIMarkerError");
    }
  };
  var dctZigZag = new Uint8Array([
    0,
    1,
    8,
    16,
    9,
    2,
    3,
    10,
    17,
    24,
    32,
    25,
    18,
    11,
    4,
    5,
    12,
    19,
    26,
    33,
    40,
    48,
    41,
    34,
    27,
    20,
    13,
    6,
    7,
    14,
    21,
    28,
    35,
    42,
    49,
    56,
    57,
    50,
    43,
    36,
    29,
    22,
    15,
    23,
    30,
    37,
    44,
    51,
    58,
    59,
    52,
    45,
    38,
    31,
    39,
    46,
    53,
    60,
    61,
    54,
    47,
    55,
    62,
    63
  ]);
  var dctCos1 = 4017;
  var dctSin1 = 799;
  var dctCos3 = 3406;
  var dctSin3 = 2276;
  var dctCos6 = 1567;
  var dctSin6 = 3784;
  var dctSqrt2 = 5793;
  var dctSqrt1d2 = 2896;
  function buildHuffmanTable(codeLengths, values) {
    let k = 0, i, j, length = 16;
    while (length > 0 && !codeLengths[length - 1]) {
      length--;
    }
    const code = [{ children: [], index: 0 }];
    let p = code[0], q;
    for (i = 0; i < length; i++) {
      for (j = 0; j < codeLengths[i]; j++) {
        p = code.pop();
        p.children[p.index] = values[k];
        while (p.index > 0) {
          p = code.pop();
        }
        p.index++;
        code.push(p);
        while (code.length <= i) {
          code.push(q = { children: [], index: 0 });
          p.children[p.index] = q.children;
          p = q;
        }
        k++;
      }
      if (i + 1 < length) {
        code.push(q = { children: [], index: 0 });
        p.children[p.index] = q.children;
        p = q;
      }
    }
    return code[0].children;
  }
  function getBlockBufferOffset(component, row, col) {
    return 64 * ((component.blocksPerLine + 1) * row + col);
  }
  function decodeScan(data, offset, frame, components, resetInterval, spectralStart, spectralEnd, successivePrev, successive, parseDNLMarker = false) {
    const mcusPerLine = frame.mcusPerLine;
    const progressive = frame.progressive;
    const startOffset = offset;
    let bitsData = 0, bitsCount = 0;
    function readBit() {
      if (bitsCount > 0) {
        bitsCount--;
        return bitsData >> bitsCount & 1;
      }
      bitsData = data[offset++];
      if (bitsData === 255) {
        const nextByte = data[offset++];
        if (nextByte) {
          if (nextByte === /* DNL = */
          220 && parseDNLMarker) {
            offset += 2;
            const scanLines = readUint16(data, offset);
            offset += 2;
            if (scanLines > 0 && scanLines !== frame.scanLines) {
              throw new DNLMarkerError(
                "Found DNL marker (0xFFDC) while parsing scan data",
                scanLines
              );
            }
          } else if (nextByte === /* EOI = */
          217) {
            if (parseDNLMarker) {
              const maybeScanLines = blockRow * (frame.precision === 8 ? 8 : 0);
              if (maybeScanLines > 0 && Math.round(frame.scanLines / maybeScanLines) >= 10) {
                throw new DNLMarkerError(
                  "Found EOI marker (0xFFD9) while parsing scan data, possibly caused by incorrect `scanLines` parameter",
                  maybeScanLines
                );
              }
            }
            throw new EOIMarkerError(
              "Found EOI marker (0xFFD9) while parsing scan data"
            );
          }
          throw new JpegError(
            `unexpected marker ${(bitsData << 8 | nextByte).toString(16)}`
          );
        }
      }
      bitsCount = 7;
      return bitsData >>> 7;
    }
    function decodeHuffman(tree) {
      let node = tree;
      while (true) {
        node = node[readBit()];
        switch (typeof node) {
          case "number":
            return node;
          case "object":
            continue;
        }
        throw new JpegError("invalid huffman sequence");
      }
    }
    function receive(length) {
      let n2 = 0;
      while (length > 0) {
        n2 = n2 << 1 | readBit();
        length--;
      }
      return n2;
    }
    function receiveAndExtend(length) {
      if (length === 1) {
        return readBit() === 1 ? 1 : -1;
      }
      const n2 = receive(length);
      if (n2 >= 1 << length - 1) {
        return n2;
      }
      return n2 + (-1 << length) + 1;
    }
    function decodeBaseline(component2, blockOffset) {
      const t = decodeHuffman(component2.huffmanTableDC);
      const diff = t === 0 ? 0 : receiveAndExtend(t);
      component2.blockData[blockOffset] = component2.pred += diff;
      let k2 = 1;
      while (k2 < 64) {
        const rs = decodeHuffman(component2.huffmanTableAC);
        const s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            break;
          }
          k2 += 16;
          continue;
        }
        k2 += r;
        const z = dctZigZag[k2];
        component2.blockData[blockOffset + z] = receiveAndExtend(s);
        k2++;
      }
    }
    function decodeDCFirst(component2, blockOffset) {
      const t = decodeHuffman(component2.huffmanTableDC);
      const diff = t === 0 ? 0 : receiveAndExtend(t) << successive;
      component2.blockData[blockOffset] = component2.pred += diff;
    }
    function decodeDCSuccessive(component2, blockOffset) {
      component2.blockData[blockOffset] |= readBit() << successive;
    }
    let eobrun = 0;
    function decodeACFirst(component2, blockOffset) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      let k2 = spectralStart;
      const e = spectralEnd;
      while (k2 <= e) {
        const rs = decodeHuffman(component2.huffmanTableAC);
        const s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = receive(r) + (1 << r) - 1;
            break;
          }
          k2 += 16;
          continue;
        }
        k2 += r;
        const z = dctZigZag[k2];
        component2.blockData[blockOffset + z] = receiveAndExtend(s) * (1 << successive);
        k2++;
      }
    }
    let successiveACState = 0, successiveACNextValue;
    function decodeACSuccessive(component2, blockOffset) {
      let k2 = spectralStart;
      const e = spectralEnd;
      let r = 0;
      let s;
      let rs;
      while (k2 <= e) {
        const offsetZ = blockOffset + dctZigZag[k2];
        const sign = component2.blockData[offsetZ] < 0 ? -1 : 1;
        switch (successiveACState) {
          case 0:
            rs = decodeHuffman(component2.huffmanTableAC);
            s = rs & 15;
            r = rs >> 4;
            if (s === 0) {
              if (r < 15) {
                eobrun = receive(r) + (1 << r);
                successiveACState = 4;
              } else {
                r = 16;
                successiveACState = 1;
              }
            } else {
              if (s !== 1) {
                throw new JpegError("invalid ACn encoding");
              }
              successiveACNextValue = receiveAndExtend(s);
              successiveACState = r ? 2 : 3;
            }
            continue;
          case 1:
          // skipping r zero items
          case 2:
            if (component2.blockData[offsetZ]) {
              component2.blockData[offsetZ] += sign * (readBit() << successive);
            } else {
              r--;
              if (r === 0) {
                successiveACState = successiveACState === 2 ? 3 : 0;
              }
            }
            break;
          case 3:
            if (component2.blockData[offsetZ]) {
              component2.blockData[offsetZ] += sign * (readBit() << successive);
            } else {
              component2.blockData[offsetZ] = successiveACNextValue << successive;
              successiveACState = 0;
            }
            break;
          case 4:
            if (component2.blockData[offsetZ]) {
              component2.blockData[offsetZ] += sign * (readBit() << successive);
            }
            break;
        }
        k2++;
      }
      if (successiveACState === 4) {
        eobrun--;
        if (eobrun === 0) {
          successiveACState = 0;
        }
      }
    }
    let blockRow = 0;
    function decodeMcu(component2, decode, mcu2, row, col) {
      const mcuRow = mcu2 / mcusPerLine | 0;
      const mcuCol = mcu2 % mcusPerLine;
      blockRow = mcuRow * component2.v + row;
      const blockCol = mcuCol * component2.h + col;
      const blockOffset = getBlockBufferOffset(component2, blockRow, blockCol);
      decode(component2, blockOffset);
    }
    function decodeBlock(component2, decode, mcu2) {
      blockRow = mcu2 / component2.blocksPerLine | 0;
      const blockCol = mcu2 % component2.blocksPerLine;
      const blockOffset = getBlockBufferOffset(component2, blockRow, blockCol);
      decode(component2, blockOffset);
    }
    const componentsLength = components.length;
    let component, i, j, k, n;
    let decodeFn;
    if (progressive) {
      if (spectralStart === 0) {
        decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
      } else {
        decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
      }
    } else {
      decodeFn = decodeBaseline;
    }
    let mcu = 0, fileMarker;
    let mcuExpected;
    if (componentsLength === 1) {
      mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
    } else {
      mcuExpected = mcusPerLine * frame.mcusPerColumn;
    }
    let h, v;
    while (mcu <= mcuExpected) {
      const mcuToRead = resetInterval ? Math.min(mcuExpected - mcu, resetInterval) : mcuExpected;
      if (mcuToRead > 0) {
        for (i = 0; i < componentsLength; i++) {
          components[i].pred = 0;
        }
        eobrun = 0;
        if (componentsLength === 1) {
          component = components[0];
          for (n = 0; n < mcuToRead; n++) {
            decodeBlock(component, decodeFn, mcu);
            mcu++;
          }
        } else {
          for (n = 0; n < mcuToRead; n++) {
            for (i = 0; i < componentsLength; i++) {
              component = components[i];
              h = component.h;
              v = component.v;
              for (j = 0; j < v; j++) {
                for (k = 0; k < h; k++) {
                  decodeMcu(component, decodeFn, mcu, j, k);
                }
              }
            }
            mcu++;
          }
        }
      }
      bitsCount = 0;
      fileMarker = findNextFileMarker(data, offset);
      if (!fileMarker) {
        break;
      }
      if (fileMarker.invalid) {
        const partialMsg = mcuToRead > 0 ? "unexpected" : "excessive";
        warn(
          `decodeScan - ${partialMsg} MCU data, current marker is: ${fileMarker.invalid}`
        );
        offset = fileMarker.offset;
      }
      if (fileMarker.marker >= 65488 && fileMarker.marker <= 65495) {
        offset += 2;
      } else {
        break;
      }
    }
    return offset - startOffset;
  }
  function quantizeAndInverse(component, blockBufferOffset, p) {
    const qt = component.quantizationTable, blockData = component.blockData;
    let v0, v1, v2, v3, v4, v5, v6, v7;
    let p0, p1, p2, p3, p4, p5, p6, p7;
    let t;
    if (!qt) {
      throw new JpegError("missing required Quantization Table.");
    }
    for (let row = 0; row < 64; row += 8) {
      p0 = blockData[blockBufferOffset + row];
      p1 = blockData[blockBufferOffset + row + 1];
      p2 = blockData[blockBufferOffset + row + 2];
      p3 = blockData[blockBufferOffset + row + 3];
      p4 = blockData[blockBufferOffset + row + 4];
      p5 = blockData[blockBufferOffset + row + 5];
      p6 = blockData[blockBufferOffset + row + 6];
      p7 = blockData[blockBufferOffset + row + 7];
      p0 *= qt[row];
      if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
        t = dctSqrt2 * p0 + 512 >> 10;
        p[row] = t;
        p[row + 1] = t;
        p[row + 2] = t;
        p[row + 3] = t;
        p[row + 4] = t;
        p[row + 5] = t;
        p[row + 6] = t;
        p[row + 7] = t;
        continue;
      }
      p1 *= qt[row + 1];
      p2 *= qt[row + 2];
      p3 *= qt[row + 3];
      p4 *= qt[row + 4];
      p5 *= qt[row + 5];
      p6 *= qt[row + 6];
      p7 *= qt[row + 7];
      v0 = dctSqrt2 * p0 + 128 >> 8;
      v1 = dctSqrt2 * p4 + 128 >> 8;
      v2 = p2;
      v3 = p6;
      v4 = dctSqrt1d2 * (p1 - p7) + 128 >> 8;
      v7 = dctSqrt1d2 * (p1 + p7) + 128 >> 8;
      v5 = p3 << 4;
      v6 = p5 << 4;
      v0 = v0 + v1 + 1 >> 1;
      v1 = v0 - v1;
      t = v2 * dctSin6 + v3 * dctCos6 + 128 >> 8;
      v2 = v2 * dctCos6 - v3 * dctSin6 + 128 >> 8;
      v3 = t;
      v4 = v4 + v6 + 1 >> 1;
      v6 = v4 - v6;
      v7 = v7 + v5 + 1 >> 1;
      v5 = v7 - v5;
      v0 = v0 + v3 + 1 >> 1;
      v3 = v0 - v3;
      v1 = v1 + v2 + 1 >> 1;
      v2 = v1 - v2;
      t = v4 * dctSin3 + v7 * dctCos3 + 2048 >> 12;
      v4 = v4 * dctCos3 - v7 * dctSin3 + 2048 >> 12;
      v7 = t;
      t = v5 * dctSin1 + v6 * dctCos1 + 2048 >> 12;
      v5 = v5 * dctCos1 - v6 * dctSin1 + 2048 >> 12;
      v6 = t;
      p[row] = v0 + v7;
      p[row + 7] = v0 - v7;
      p[row + 1] = v1 + v6;
      p[row + 6] = v1 - v6;
      p[row + 2] = v2 + v5;
      p[row + 5] = v2 - v5;
      p[row + 3] = v3 + v4;
      p[row + 4] = v3 - v4;
    }
    for (let col = 0; col < 8; ++col) {
      p0 = p[col];
      p1 = p[col + 8];
      p2 = p[col + 16];
      p3 = p[col + 24];
      p4 = p[col + 32];
      p5 = p[col + 40];
      p6 = p[col + 48];
      p7 = p[col + 56];
      if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
        t = dctSqrt2 * p0 + 8192 >> 14;
        if (t < -2040) {
          t = 0;
        } else if (t >= 2024) {
          t = 255;
        } else {
          t = t + 2056 >> 4;
        }
        blockData[blockBufferOffset + col] = t;
        blockData[blockBufferOffset + col + 8] = t;
        blockData[blockBufferOffset + col + 16] = t;
        blockData[blockBufferOffset + col + 24] = t;
        blockData[blockBufferOffset + col + 32] = t;
        blockData[blockBufferOffset + col + 40] = t;
        blockData[blockBufferOffset + col + 48] = t;
        blockData[blockBufferOffset + col + 56] = t;
        continue;
      }
      v0 = dctSqrt2 * p0 + 2048 >> 12;
      v1 = dctSqrt2 * p4 + 2048 >> 12;
      v2 = p2;
      v3 = p6;
      v4 = dctSqrt1d2 * (p1 - p7) + 2048 >> 12;
      v7 = dctSqrt1d2 * (p1 + p7) + 2048 >> 12;
      v5 = p3;
      v6 = p5;
      v0 = (v0 + v1 + 1 >> 1) + 4112;
      v1 = v0 - v1;
      t = v2 * dctSin6 + v3 * dctCos6 + 2048 >> 12;
      v2 = v2 * dctCos6 - v3 * dctSin6 + 2048 >> 12;
      v3 = t;
      v4 = v4 + v6 + 1 >> 1;
      v6 = v4 - v6;
      v7 = v7 + v5 + 1 >> 1;
      v5 = v7 - v5;
      v0 = v0 + v3 + 1 >> 1;
      v3 = v0 - v3;
      v1 = v1 + v2 + 1 >> 1;
      v2 = v1 - v2;
      t = v4 * dctSin3 + v7 * dctCos3 + 2048 >> 12;
      v4 = v4 * dctCos3 - v7 * dctSin3 + 2048 >> 12;
      v7 = t;
      t = v5 * dctSin1 + v6 * dctCos1 + 2048 >> 12;
      v5 = v5 * dctCos1 - v6 * dctSin1 + 2048 >> 12;
      v6 = t;
      p0 = v0 + v7;
      p7 = v0 - v7;
      p1 = v1 + v6;
      p6 = v1 - v6;
      p2 = v2 + v5;
      p5 = v2 - v5;
      p3 = v3 + v4;
      p4 = v3 - v4;
      if (p0 < 16) {
        p0 = 0;
      } else if (p0 >= 4080) {
        p0 = 255;
      } else {
        p0 >>= 4;
      }
      if (p1 < 16) {
        p1 = 0;
      } else if (p1 >= 4080) {
        p1 = 255;
      } else {
        p1 >>= 4;
      }
      if (p2 < 16) {
        p2 = 0;
      } else if (p2 >= 4080) {
        p2 = 255;
      } else {
        p2 >>= 4;
      }
      if (p3 < 16) {
        p3 = 0;
      } else if (p3 >= 4080) {
        p3 = 255;
      } else {
        p3 >>= 4;
      }
      if (p4 < 16) {
        p4 = 0;
      } else if (p4 >= 4080) {
        p4 = 255;
      } else {
        p4 >>= 4;
      }
      if (p5 < 16) {
        p5 = 0;
      } else if (p5 >= 4080) {
        p5 = 255;
      } else {
        p5 >>= 4;
      }
      if (p6 < 16) {
        p6 = 0;
      } else if (p6 >= 4080) {
        p6 = 255;
      } else {
        p6 >>= 4;
      }
      if (p7 < 16) {
        p7 = 0;
      } else if (p7 >= 4080) {
        p7 = 255;
      } else {
        p7 >>= 4;
      }
      blockData[blockBufferOffset + col] = p0;
      blockData[blockBufferOffset + col + 8] = p1;
      blockData[blockBufferOffset + col + 16] = p2;
      blockData[blockBufferOffset + col + 24] = p3;
      blockData[blockBufferOffset + col + 32] = p4;
      blockData[blockBufferOffset + col + 40] = p5;
      blockData[blockBufferOffset + col + 48] = p6;
      blockData[blockBufferOffset + col + 56] = p7;
    }
  }
  function buildComponentData(frame, component) {
    const blocksPerLine = component.blocksPerLine;
    const blocksPerColumn = component.blocksPerColumn;
    const computationBuffer = new Int16Array(64);
    for (let blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
      for (let blockCol = 0; blockCol < blocksPerLine; blockCol++) {
        const offset = getBlockBufferOffset(component, blockRow, blockCol);
        quantizeAndInverse(component, offset, computationBuffer);
      }
    }
    return component.blockData;
  }
  function findNextFileMarker(data, currentPos, startPos = currentPos) {
    const maxPos = data.length - 1;
    let newPos = startPos < currentPos ? startPos : currentPos;
    if (currentPos >= maxPos) {
      return null;
    }
    const currentMarker = readUint16(data, currentPos);
    if (currentMarker >= 65472 && currentMarker <= 65534) {
      return {
        invalid: null,
        marker: currentMarker,
        offset: currentPos
      };
    }
    let newMarker = readUint16(data, newPos);
    while (!(newMarker >= 65472 && newMarker <= 65534)) {
      if (++newPos >= maxPos) {
        return null;
      }
      newMarker = readUint16(data, newPos);
    }
    return {
      invalid: currentMarker.toString(16),
      marker: newMarker,
      offset: newPos
    };
  }
  var JpegImage = class {
    constructor({ decodeTransform = null, colorTransform = -1 } = {}) {
      this._decodeTransform = decodeTransform;
      this._colorTransform = colorTransform;
    }
    parse(data, { dnlScanLines = null } = {}) {
      function readDataBlock() {
        const length = readUint16(data, offset);
        offset += 2;
        let endOffset = offset + length - 2;
        const fileMarker2 = findNextFileMarker(data, endOffset, offset);
        if (fileMarker2 && fileMarker2.invalid) {
          warn(
            "readDataBlock - incorrect length, current marker is: " + fileMarker2.invalid
          );
          endOffset = fileMarker2.offset;
        }
        const array = data.subarray(offset, endOffset);
        offset += array.length;
        return array;
      }
      function prepareComponents(frame2) {
        const mcusPerLine = Math.ceil(frame2.samplesPerLine / 8 / frame2.maxH);
        const mcusPerColumn = Math.ceil(frame2.scanLines / 8 / frame2.maxV);
        for (let i = 0, ii = frame2.components.length; i < ii; i++) {
          const component = frame2.components[i];
          const blocksPerLine = Math.ceil(
            Math.ceil(frame2.samplesPerLine / 8) * component.h / frame2.maxH
          );
          const blocksPerColumn = Math.ceil(
            Math.ceil(frame2.scanLines / 8) * component.v / frame2.maxV
          );
          const blocksPerLineForMcu = mcusPerLine * component.h;
          const blocksPerColumnForMcu = mcusPerColumn * component.v;
          const blocksBufferSize = 64 * blocksPerColumnForMcu * (blocksPerLineForMcu + 1);
          component.blockData = new Int16Array(blocksBufferSize);
          component.blocksPerLine = blocksPerLine;
          component.blocksPerColumn = blocksPerColumn;
        }
        frame2.mcusPerLine = mcusPerLine;
        frame2.mcusPerColumn = mcusPerColumn;
      }
      let offset = 0;
      let jfif = null;
      let adobe = null;
      let frame, resetInterval;
      let numSOSMarkers = 0;
      const quantizationTables = [];
      const huffmanTablesAC = [], huffmanTablesDC = [];
      let fileMarker = readUint16(data, offset);
      offset += 2;
      if (fileMarker !== /* SOI (Start of Image) = */
      65496) {
        throw new JpegError("SOI not found");
      }
      fileMarker = readUint16(data, offset);
      offset += 2;
      markerLoop: while (fileMarker !== /* EOI (End of Image) = */
      65497) {
        let i, j, l;
        switch (fileMarker) {
          case 65504:
          // APP0 (Application Specific)
          case 65505:
          // APP1
          case 65506:
          // APP2
          case 65507:
          // APP3
          case 65508:
          // APP4
          case 65509:
          // APP5
          case 65510:
          // APP6
          case 65511:
          // APP7
          case 65512:
          // APP8
          case 65513:
          // APP9
          case 65514:
          // APP10
          case 65515:
          // APP11
          case 65516:
          // APP12
          case 65517:
          // APP13
          case 65518:
          // APP14
          case 65519:
          // APP15
          case 65534:
            const appData = readDataBlock();
            if (fileMarker === 65504) {
              if (appData[0] === 74 && appData[1] === 70 && appData[2] === 73 && appData[3] === 70 && appData[4] === 0) {
                jfif = {
                  version: { major: appData[5], minor: appData[6] },
                  densityUnits: appData[7],
                  xDensity: appData[8] << 8 | appData[9],
                  yDensity: appData[10] << 8 | appData[11],
                  thumbWidth: appData[12],
                  thumbHeight: appData[13],
                  thumbData: appData.subarray(
                    14,
                    14 + 3 * appData[12] * appData[13]
                  )
                };
              }
            }
            if (fileMarker === 65518) {
              if (appData[0] === 65 && appData[1] === 100 && appData[2] === 111 && appData[3] === 98 && appData[4] === 101) {
                adobe = {
                  version: appData[5] << 8 | appData[6],
                  flags0: appData[7] << 8 | appData[8],
                  flags1: appData[9] << 8 | appData[10],
                  transformCode: appData[11]
                };
              }
            }
            break;
          case 65499:
            const quantizationTablesLength = readUint16(data, offset);
            offset += 2;
            const quantizationTablesEnd = quantizationTablesLength + offset - 2;
            let z;
            while (offset < quantizationTablesEnd) {
              const quantizationTableSpec = data[offset++];
              const tableData = new Uint16Array(64);
              if (quantizationTableSpec >> 4 === 0) {
                for (j = 0; j < 64; j++) {
                  z = dctZigZag[j];
                  tableData[z] = data[offset++];
                }
              } else if (quantizationTableSpec >> 4 === 1) {
                for (j = 0; j < 64; j++) {
                  z = dctZigZag[j];
                  tableData[z] = readUint16(data, offset);
                  offset += 2;
                }
              } else {
                throw new JpegError("DQT - invalid table spec");
              }
              quantizationTables[quantizationTableSpec & 15] = tableData;
            }
            break;
          case 65472:
          // SOF0 (Start of Frame, Baseline DCT)
          case 65473:
          // SOF1 (Start of Frame, Extended DCT)
          case 65474:
            if (frame) {
              throw new JpegError("Only single frame JPEGs supported");
            }
            offset += 2;
            frame = {};
            frame.extended = fileMarker === 65473;
            frame.progressive = fileMarker === 65474;
            frame.precision = data[offset++];
            const sofScanLines = readUint16(data, offset);
            offset += 2;
            frame.scanLines = dnlScanLines || sofScanLines;
            frame.samplesPerLine = readUint16(data, offset);
            offset += 2;
            frame.components = [];
            frame.componentIds = {};
            const componentsCount = data[offset++];
            let maxH = 0, maxV = 0;
            for (i = 0; i < componentsCount; i++) {
              const componentId = data[offset];
              const h = data[offset + 1] >> 4;
              const v = data[offset + 1] & 15;
              if (maxH < h) {
                maxH = h;
              }
              if (maxV < v) {
                maxV = v;
              }
              const qId = data[offset + 2];
              l = frame.components.push({
                h,
                v,
                quantizationId: qId,
                quantizationTable: null
                // See comment below.
              });
              frame.componentIds[componentId] = l - 1;
              offset += 3;
            }
            frame.maxH = maxH;
            frame.maxV = maxV;
            prepareComponents(frame);
            break;
          case 65476:
            const huffmanLength = readUint16(data, offset);
            offset += 2;
            for (i = 2; i < huffmanLength; ) {
              const huffmanTableSpec = data[offset++];
              const codeLengths = new Uint8Array(16);
              let codeLengthSum = 0;
              for (j = 0; j < 16; j++, offset++) {
                codeLengthSum += codeLengths[j] = data[offset];
              }
              const huffmanValues = new Uint8Array(codeLengthSum);
              for (j = 0; j < codeLengthSum; j++, offset++) {
                huffmanValues[j] = data[offset];
              }
              i += 17 + codeLengthSum;
              (huffmanTableSpec >> 4 === 0 ? huffmanTablesDC : huffmanTablesAC)[huffmanTableSpec & 15] = buildHuffmanTable(codeLengths, huffmanValues);
            }
            break;
          case 65501:
            offset += 2;
            resetInterval = readUint16(data, offset);
            offset += 2;
            break;
          case 65498:
            const parseDNLMarker = ++numSOSMarkers === 1 && !dnlScanLines;
            offset += 2;
            const selectorsCount = data[offset++], components = [];
            for (i = 0; i < selectorsCount; i++) {
              const index = data[offset++];
              const componentIndex = frame.componentIds[index];
              const component = frame.components[componentIndex];
              component.index = index;
              const tableSpec = data[offset++];
              component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
              component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
              components.push(component);
            }
            const spectralStart = data[offset++], spectralEnd = data[offset++], successiveApproximation = data[offset++];
            try {
              const processed = decodeScan(
                data,
                offset,
                frame,
                components,
                resetInterval,
                spectralStart,
                spectralEnd,
                successiveApproximation >> 4,
                successiveApproximation & 15,
                parseDNLMarker
              );
              offset += processed;
            } catch (ex) {
              if (ex instanceof DNLMarkerError) {
                warn(`${ex.message} -- attempting to re-parse the JPEG image.`);
                return this.parse(data, { dnlScanLines: ex.scanLines });
              } else if (ex instanceof EOIMarkerError) {
                warn(`${ex.message} -- ignoring the rest of the image data.`);
                break markerLoop;
              }
              throw ex;
            }
            break;
          case 65500:
            offset += 4;
            break;
          case 65535:
            if (data[offset] !== 255) {
              offset--;
            }
            break;
          default:
            const nextFileMarker = findNextFileMarker(
              data,
              /* currentPos = */
              offset - 2,
              /* startPos = */
              offset - 3
            );
            if (nextFileMarker && nextFileMarker.invalid) {
              warn(
                "JpegImage.parse - unexpected data, current marker is: " + nextFileMarker.invalid
              );
              offset = nextFileMarker.offset;
              break;
            }
            if (!nextFileMarker || offset >= data.length - 1) {
              warn(
                "JpegImage.parse - reached the end of the image data without finding an EOI marker (0xFFD9)."
              );
              break markerLoop;
            }
            throw new JpegError(
              "JpegImage.parse - unknown marker: " + fileMarker.toString(16)
            );
        }
        fileMarker = readUint16(data, offset);
        offset += 2;
      }
      this.width = frame.samplesPerLine;
      this.height = frame.scanLines;
      this.jfif = jfif;
      this.adobe = adobe;
      this.components = [];
      for (let i = 0, ii = frame.components.length; i < ii; i++) {
        const component = frame.components[i];
        const quantizationTable = quantizationTables[component.quantizationId];
        if (quantizationTable) {
          component.quantizationTable = quantizationTable;
        }
        this.components.push({
          index: component.index,
          output: buildComponentData(frame, component),
          scaleX: component.h / frame.maxH,
          scaleY: component.v / frame.maxV,
          blocksPerLine: component.blocksPerLine,
          blocksPerColumn: component.blocksPerColumn
        });
      }
      this.numComponents = this.components.length;
      return void 0;
    }
    _getLinearizedBlockData(width, height, isSourcePDF = false) {
      const scaleX = this.width / width, scaleY = this.height / height;
      let component, componentScaleX, componentScaleY, blocksPerScanline;
      let x, y, i, j, k;
      let index;
      let offset = 0;
      let output;
      const numComponents = this.components.length;
      const dataLength = width * height * numComponents;
      const data = new Uint8ClampedArray(dataLength);
      const xScaleBlockOffset = new Uint32Array(width);
      const mask3LSB = 4294967288;
      let lastComponentScaleX;
      for (i = 0; i < numComponents; i++) {
        component = this.components[i];
        componentScaleX = component.scaleX * scaleX;
        componentScaleY = component.scaleY * scaleY;
        offset = i;
        output = component.output;
        blocksPerScanline = component.blocksPerLine + 1 << 3;
        if (componentScaleX !== lastComponentScaleX) {
          for (x = 0; x < width; x++) {
            j = 0 | x * componentScaleX;
            xScaleBlockOffset[x] = (j & mask3LSB) << 3 | j & 7;
          }
          lastComponentScaleX = componentScaleX;
        }
        for (y = 0; y < height; y++) {
          j = 0 | y * componentScaleY;
          index = blocksPerScanline * (j & mask3LSB) | (j & 7) << 3;
          for (x = 0; x < width; x++) {
            data[offset] = output[index + xScaleBlockOffset[x]];
            offset += numComponents;
          }
        }
      }
      let transform = this._decodeTransform;
      if (!isSourcePDF && numComponents === 4 && !transform) {
        transform = new Int32Array([-256, 255, -256, 255, -256, 255, -256, 255]);
      }
      if (transform) {
        for (i = 0; i < dataLength; ) {
          for (j = 0, k = 0; j < numComponents; j++, i++, k += 2) {
            data[i] = (data[i] * transform[k] >> 8) + transform[k + 1];
          }
        }
      }
      return data;
    }
    get _isColorConversionNeeded() {
      if (this.adobe) {
        return !!this.adobe.transformCode;
      }
      if (this.numComponents === 3) {
        if (this._colorTransform === 0) {
          return false;
        } else if (this.components[0].index === /* "R" = */
        82 && this.components[1].index === /* "G" = */
        71 && this.components[2].index === /* "B" = */
        66) {
          return false;
        }
        return true;
      }
      if (this._colorTransform === 1) {
        return true;
      }
      return false;
    }
    _convertYccToRgb(data) {
      let Y, Cb, Cr;
      for (let i = 0, length = data.length; i < length; i += 3) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        data[i] = Y - 179.456 + 1.402 * Cr;
        data[i + 1] = Y + 135.459 - 0.344 * Cb - 0.714 * Cr;
        data[i + 2] = Y - 226.816 + 1.772 * Cb;
      }
      return data;
    }
    _convertYcckToRgb(data) {
      let Y, Cb, Cr, k;
      let offset = 0;
      for (let i = 0, length = data.length; i < length; i += 4) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        k = data[i + 3];
        data[offset++] = -122.67195406894 + Cb * (-660635669420364e-19 * Cb + 437130475926232e-18 * Cr - 54080610064599e-18 * Y + 48449797120281e-17 * k - 0.154362151871126) + Cr * (-957964378445773e-18 * Cr + 817076911346625e-18 * Y - 0.00477271405408747 * k + 1.53380253221734) + Y * (961250184130688e-18 * Y - 0.00266257332283933 * k + 0.48357088451265) + k * (-336197177618394e-18 * k + 0.484791561490776);
        data[offset++] = 107.268039397724 + Cb * (219927104525741e-19 * Cb - 640992018297945e-18 * Cr + 659397001245577e-18 * Y + 426105652938837e-18 * k - 0.176491792462875) + Cr * (-778269941513683e-18 * Cr + 0.00130872261408275 * Y + 770482631801132e-18 * k - 0.151051492775562) + Y * (0.00126935368114843 * Y - 0.00265090189010898 * k + 0.25802910206845) + k * (-318913117588328e-18 * k - 0.213742400323665);
        data[offset++] = -20.810012546947 + Cb * (-570115196973677e-18 * Cb - 263409051004589e-19 * Cr + 0.0020741088115012 * Y - 0.00288260236853442 * k + 0.814272968359295) + Cr * (-153496057440975e-19 * Cr - 132689043961446e-18 * Y + 560833691242812e-18 * k - 0.195152027534049) + Y * (0.00174418132927582 * Y - 0.00255243321439347 * k + 0.116935020465145) + k * (-343531996510555e-18 * k + 0.24165260232407);
      }
      return data.subarray(0, offset);
    }
    _convertYcckToCmyk(data) {
      let Y, Cb, Cr;
      for (let i = 0, length = data.length; i < length; i += 4) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        data[i] = 434.456 - Y - 1.402 * Cr;
        data[i + 1] = 119.541 - Y + 0.344 * Cb + 0.714 * Cr;
        data[i + 2] = 481.816 - Y - 1.772 * Cb;
      }
      return data;
    }
    _convertCmykToRgb(data) {
      let c, m, y, k;
      let offset = 0;
      for (let i = 0, length = data.length; i < length; i += 4) {
        c = data[i];
        m = data[i + 1];
        y = data[i + 2];
        k = data[i + 3];
        data[offset++] = 255 + c * (-6747147073602441e-20 * c + 8379262121013727e-19 * m + 2894718188643294e-19 * y + 0.003264231057537806 * k - 1.1185611867203937) + m * (26374107616089405e-21 * m - 8626949158638572e-20 * y - 2748769067499491e-19 * k - 0.02155688794978967) + y * (-3878099212869363e-20 * y - 3267808279485286e-19 * k + 0.0686742238595345) - k * (3361971776183937e-19 * k + 0.7430659151342254);
        data[offset++] = 255 + c * (13596372813588848e-20 * c + 924537132573585e-18 * m + 10567359618683593e-20 * y + 4791864687436512e-19 * k - 0.3109689587515875) + m * (-23545346108370344e-20 * m + 2702845253534714e-19 * y + 0.0020200308977307156 * k - 0.7488052167015494) + y * (6834815998235662e-20 * y + 15168452363460973e-20 * k - 0.09751927774728933) - k * (3189131175883281e-19 * k + 0.7364883807733168);
        data[offset++] = 255 + c * (13598650411385307e-21 * c + 12423956175490851e-20 * m + 4751985097583589e-19 * y - 36729317476630422e-22 * k - 0.05562186980264034) + m * (16141380598724676e-20 * m + 9692239130725186e-19 * y + 7782692450036253e-19 * k - 0.44015232367526463) + y * (5068882914068769e-22 * y + 0.0017778369011375071 * k - 0.7591454649749609) - k * (3435319965105553e-19 * k + 0.7063770186160144);
      }
      return data.subarray(0, offset);
    }
    getData({ width, height, forceRGB = false, isSourcePDF = false }) {
      if (typeof PDFJSDev === "undefined" || PDFJSDev.test("!PRODUCTION || TESTING")) {
        assert(
          isSourcePDF === true,
          'JpegImage.getData: Unexpected "isSourcePDF" value for PDF files.'
        );
      }
      if (this.numComponents > 4) {
        throw new JpegError("Unsupported color mode");
      }
      const data = this._getLinearizedBlockData(width, height, isSourcePDF);
      if (this.numComponents === 1 && forceRGB) {
        const dataLength = data.length;
        const rgbData = new Uint8ClampedArray(dataLength * 3);
        let offset = 0;
        for (let i = 0; i < dataLength; i++) {
          const grayColor = data[i];
          rgbData[offset++] = grayColor;
          rgbData[offset++] = grayColor;
          rgbData[offset++] = grayColor;
        }
        return rgbData;
      } else if (this.numComponents === 3 && this._isColorConversionNeeded) {
        return this._convertYccToRgb(data);
      } else if (this.numComponents === 4) {
        if (this._isColorConversionNeeded) {
          if (forceRGB) {
            return this._convertYcckToRgb(data);
          }
          return this._convertYcckToCmyk(data);
        } else if (forceRGB) {
          return this._convertCmykToRgb(data);
        }
      }
      return data;
    }
  };

  // ../../pdfjs/src/core/arithmetic_decoder.js
  var QeTable = [
    { qe: 22017, nmps: 1, nlps: 1, switchFlag: 1 },
    { qe: 13313, nmps: 2, nlps: 6, switchFlag: 0 },
    { qe: 6145, nmps: 3, nlps: 9, switchFlag: 0 },
    { qe: 2753, nmps: 4, nlps: 12, switchFlag: 0 },
    { qe: 1313, nmps: 5, nlps: 29, switchFlag: 0 },
    { qe: 545, nmps: 38, nlps: 33, switchFlag: 0 },
    { qe: 22017, nmps: 7, nlps: 6, switchFlag: 1 },
    { qe: 21505, nmps: 8, nlps: 14, switchFlag: 0 },
    { qe: 18433, nmps: 9, nlps: 14, switchFlag: 0 },
    { qe: 14337, nmps: 10, nlps: 14, switchFlag: 0 },
    { qe: 12289, nmps: 11, nlps: 17, switchFlag: 0 },
    { qe: 9217, nmps: 12, nlps: 18, switchFlag: 0 },
    { qe: 7169, nmps: 13, nlps: 20, switchFlag: 0 },
    { qe: 5633, nmps: 29, nlps: 21, switchFlag: 0 },
    { qe: 22017, nmps: 15, nlps: 14, switchFlag: 1 },
    { qe: 21505, nmps: 16, nlps: 14, switchFlag: 0 },
    { qe: 20737, nmps: 17, nlps: 15, switchFlag: 0 },
    { qe: 18433, nmps: 18, nlps: 16, switchFlag: 0 },
    { qe: 14337, nmps: 19, nlps: 17, switchFlag: 0 },
    { qe: 13313, nmps: 20, nlps: 18, switchFlag: 0 },
    { qe: 12289, nmps: 21, nlps: 19, switchFlag: 0 },
    { qe: 10241, nmps: 22, nlps: 19, switchFlag: 0 },
    { qe: 9217, nmps: 23, nlps: 20, switchFlag: 0 },
    { qe: 8705, nmps: 24, nlps: 21, switchFlag: 0 },
    { qe: 7169, nmps: 25, nlps: 22, switchFlag: 0 },
    { qe: 6145, nmps: 26, nlps: 23, switchFlag: 0 },
    { qe: 5633, nmps: 27, nlps: 24, switchFlag: 0 },
    { qe: 5121, nmps: 28, nlps: 25, switchFlag: 0 },
    { qe: 4609, nmps: 29, nlps: 26, switchFlag: 0 },
    { qe: 4353, nmps: 30, nlps: 27, switchFlag: 0 },
    { qe: 2753, nmps: 31, nlps: 28, switchFlag: 0 },
    { qe: 2497, nmps: 32, nlps: 29, switchFlag: 0 },
    { qe: 2209, nmps: 33, nlps: 30, switchFlag: 0 },
    { qe: 1313, nmps: 34, nlps: 31, switchFlag: 0 },
    { qe: 1089, nmps: 35, nlps: 32, switchFlag: 0 },
    { qe: 673, nmps: 36, nlps: 33, switchFlag: 0 },
    { qe: 545, nmps: 37, nlps: 34, switchFlag: 0 },
    { qe: 321, nmps: 38, nlps: 35, switchFlag: 0 },
    { qe: 273, nmps: 39, nlps: 36, switchFlag: 0 },
    { qe: 133, nmps: 40, nlps: 37, switchFlag: 0 },
    { qe: 73, nmps: 41, nlps: 38, switchFlag: 0 },
    { qe: 37, nmps: 42, nlps: 39, switchFlag: 0 },
    { qe: 21, nmps: 43, nlps: 40, switchFlag: 0 },
    { qe: 9, nmps: 44, nlps: 41, switchFlag: 0 },
    { qe: 5, nmps: 45, nlps: 42, switchFlag: 0 },
    { qe: 1, nmps: 45, nlps: 43, switchFlag: 0 },
    { qe: 22017, nmps: 46, nlps: 46, switchFlag: 0 }
  ];
  var ArithmeticDecoder = class {
    // C.3.5 Initialisation of the decoder (INITDEC)
    constructor(data, start, end) {
      this.data = data;
      this.bp = start;
      this.dataEnd = end;
      this.chigh = data[start];
      this.clow = 0;
      this.byteIn();
      this.chigh = this.chigh << 7 & 65535 | this.clow >> 9 & 127;
      this.clow = this.clow << 7 & 65535;
      this.ct -= 7;
      this.a = 32768;
    }
    // C.3.4 Compressed data input (BYTEIN)
    byteIn() {
      const data = this.data;
      let bp = this.bp;
      if (data[bp] === 255) {
        if (data[bp + 1] > 143) {
          this.clow += 65280;
          this.ct = 8;
        } else {
          bp++;
          this.clow += data[bp] << 9;
          this.ct = 7;
          this.bp = bp;
        }
      } else {
        bp++;
        this.clow += bp < this.dataEnd ? data[bp] << 8 : 65280;
        this.ct = 8;
        this.bp = bp;
      }
      if (this.clow > 65535) {
        this.chigh += this.clow >> 16;
        this.clow &= 65535;
      }
    }
    // C.3.2 Decoding a decision (DECODE)
    readBit(contexts, pos) {
      let cx_index = contexts[pos] >> 1, cx_mps = contexts[pos] & 1;
      const qeTableIcx = QeTable[cx_index];
      const qeIcx = qeTableIcx.qe;
      let d;
      let a = this.a - qeIcx;
      if (this.chigh < qeIcx) {
        if (a < qeIcx) {
          a = qeIcx;
          d = cx_mps;
          cx_index = qeTableIcx.nmps;
        } else {
          a = qeIcx;
          d = 1 ^ cx_mps;
          if (qeTableIcx.switchFlag === 1) {
            cx_mps = d;
          }
          cx_index = qeTableIcx.nlps;
        }
      } else {
        this.chigh -= qeIcx;
        if ((a & 32768) !== 0) {
          this.a = a;
          return cx_mps;
        }
        if (a < qeIcx) {
          d = 1 ^ cx_mps;
          if (qeTableIcx.switchFlag === 1) {
            cx_mps = d;
          }
          cx_index = qeTableIcx.nlps;
        } else {
          d = cx_mps;
          cx_index = qeTableIcx.nmps;
        }
      }
      do {
        if (this.ct === 0) {
          this.byteIn();
        }
        a <<= 1;
        this.chigh = this.chigh << 1 & 65535 | this.clow >> 15 & 1;
        this.clow = this.clow << 1 & 65535;
        this.ct--;
      } while ((a & 32768) === 0);
      this.a = a;
      contexts[pos] = cx_index << 1 | cx_mps;
      return d;
    }
  };

  // ../../pdfjs/src/core/jpx.js
  var JpxError = class extends BaseException {
    constructor(msg) {
      super(`JPX error: ${msg}`, "JpxError");
    }
  };
  var SubbandsGainLog2 = {
    LL: 0,
    LH: 1,
    HL: 1,
    HH: 2
  };
  var JpxImage = class {
    constructor() {
      this.failOnCorruptedImage = false;
    }
    parse(data) {
      const head = readUint16(data, 0);
      if (head === 65359) {
        this.parseCodestream(data, 0, data.length);
        return;
      }
      const length = data.length;
      let position = 0;
      while (position < length) {
        let headerSize = 8;
        let lbox = readUint32(data, position);
        const tbox = readUint32(data, position + 4);
        position += headerSize;
        if (lbox === 1) {
          lbox = readUint32(data, position) * 4294967296 + readUint32(data, position + 4);
          position += 8;
          headerSize += 8;
        }
        if (lbox === 0) {
          lbox = length - position + headerSize;
        }
        if (lbox < headerSize) {
          throw new JpxError("Invalid box field size");
        }
        const dataLength = lbox - headerSize;
        let jumpDataLength = true;
        switch (tbox) {
          case 1785737832:
            jumpDataLength = false;
            break;
          case 1668246642:
            const method = data[position];
            if (method === 1) {
              const colorspace = readUint32(data, position + 3);
              switch (colorspace) {
                case 16:
                // this indicates a sRGB colorspace
                case 17:
                // this indicates a grayscale colorspace
                case 18:
                  break;
                default:
                  warn("Unknown colorspace " + colorspace);
                  break;
              }
            } else if (method === 2) {
              info("ICC profile not supported");
            }
            break;
          case 1785737827:
            this.parseCodestream(data, position, position + dataLength);
            break;
          case 1783636e3:
            if (readUint32(data, position) !== 218793738) {
              warn("Invalid JP2 signature");
            }
            break;
          // The following header types are valid but currently not used:
          case 1783634458:
          // 'jP\032\032'
          case 1718909296:
          // 'ftyp'
          case 1920099697:
          // 'rreq'
          case 1919251232:
          // 'res '
          case 1768449138:
            break;
          default:
            const headerType = String.fromCharCode(
              tbox >> 24 & 255,
              tbox >> 16 & 255,
              tbox >> 8 & 255,
              tbox & 255
            );
            warn(`Unsupported header type ${tbox} (${headerType}).`);
            break;
        }
        if (jumpDataLength) {
          position += dataLength;
        }
      }
    }
    parseImageProperties(stream) {
      let newByte = stream.getByte();
      while (newByte >= 0) {
        const oldByte = newByte;
        newByte = stream.getByte();
        const code = oldByte << 8 | newByte;
        if (code === 65361) {
          stream.skip(4);
          const Xsiz = stream.getInt32() >>> 0;
          const Ysiz = stream.getInt32() >>> 0;
          const XOsiz = stream.getInt32() >>> 0;
          const YOsiz = stream.getInt32() >>> 0;
          stream.skip(16);
          const Csiz = stream.getUint16();
          this.width = Xsiz - XOsiz;
          this.height = Ysiz - YOsiz;
          this.componentsCount = Csiz;
          this.bitsPerComponent = 8;
          return;
        }
      }
      throw new JpxError("No size marker found in JPX stream");
    }
    parseCodestream(data, start, end) {
      const context = {};
      let doNotRecover = false;
      try {
        let position = start;
        while (position + 1 < end) {
          const code = readUint16(data, position);
          position += 2;
          let length = 0, j, sqcd, spqcds, spqcdSize, scalarExpounded, tile;
          switch (code) {
            case 65359:
              context.mainHeader = true;
              break;
            case 65497:
              break;
            case 65361:
              length = readUint16(data, position);
              const siz = {};
              siz.Xsiz = readUint32(data, position + 4);
              siz.Ysiz = readUint32(data, position + 8);
              siz.XOsiz = readUint32(data, position + 12);
              siz.YOsiz = readUint32(data, position + 16);
              siz.XTsiz = readUint32(data, position + 20);
              siz.YTsiz = readUint32(data, position + 24);
              siz.XTOsiz = readUint32(data, position + 28);
              siz.YTOsiz = readUint32(data, position + 32);
              const componentsCount = readUint16(data, position + 36);
              siz.Csiz = componentsCount;
              const components = [];
              j = position + 38;
              for (let i = 0; i < componentsCount; i++) {
                const component = {
                  precision: (data[j] & 127) + 1,
                  isSigned: !!(data[j] & 128),
                  XRsiz: data[j + 1],
                  YRsiz: data[j + 2]
                };
                j += 3;
                calculateComponentDimensions(component, siz);
                components.push(component);
              }
              context.SIZ = siz;
              context.components = components;
              calculateTileGrids(context, components);
              context.QCC = [];
              context.COC = [];
              break;
            case 65372:
              length = readUint16(data, position);
              const qcd = {};
              j = position + 2;
              sqcd = data[j++];
              switch (sqcd & 31) {
                case 0:
                  spqcdSize = 8;
                  scalarExpounded = true;
                  break;
                case 1:
                  spqcdSize = 16;
                  scalarExpounded = false;
                  break;
                case 2:
                  spqcdSize = 16;
                  scalarExpounded = true;
                  break;
                default:
                  throw new Error("Invalid SQcd value " + sqcd);
              }
              qcd.noQuantization = spqcdSize === 8;
              qcd.scalarExpounded = scalarExpounded;
              qcd.guardBits = sqcd >> 5;
              spqcds = [];
              while (j < length + position) {
                const spqcd = {};
                if (spqcdSize === 8) {
                  spqcd.epsilon = data[j++] >> 3;
                  spqcd.mu = 0;
                } else {
                  spqcd.epsilon = data[j] >> 3;
                  spqcd.mu = (data[j] & 7) << 8 | data[j + 1];
                  j += 2;
                }
                spqcds.push(spqcd);
              }
              qcd.SPqcds = spqcds;
              if (context.mainHeader) {
                context.QCD = qcd;
              } else {
                context.currentTile.QCD = qcd;
                context.currentTile.QCC = [];
              }
              break;
            case 65373:
              length = readUint16(data, position);
              const qcc = {};
              j = position + 2;
              let cqcc;
              if (context.SIZ.Csiz < 257) {
                cqcc = data[j++];
              } else {
                cqcc = readUint16(data, j);
                j += 2;
              }
              sqcd = data[j++];
              switch (sqcd & 31) {
                case 0:
                  spqcdSize = 8;
                  scalarExpounded = true;
                  break;
                case 1:
                  spqcdSize = 16;
                  scalarExpounded = false;
                  break;
                case 2:
                  spqcdSize = 16;
                  scalarExpounded = true;
                  break;
                default:
                  throw new Error("Invalid SQcd value " + sqcd);
              }
              qcc.noQuantization = spqcdSize === 8;
              qcc.scalarExpounded = scalarExpounded;
              qcc.guardBits = sqcd >> 5;
              spqcds = [];
              while (j < length + position) {
                const spqcd = {};
                if (spqcdSize === 8) {
                  spqcd.epsilon = data[j++] >> 3;
                  spqcd.mu = 0;
                } else {
                  spqcd.epsilon = data[j] >> 3;
                  spqcd.mu = (data[j] & 7) << 8 | data[j + 1];
                  j += 2;
                }
                spqcds.push(spqcd);
              }
              qcc.SPqcds = spqcds;
              if (context.mainHeader) {
                context.QCC[cqcc] = qcc;
              } else {
                context.currentTile.QCC[cqcc] = qcc;
              }
              break;
            case 65362:
              length = readUint16(data, position);
              const cod = {};
              j = position + 2;
              const scod = data[j++];
              cod.entropyCoderWithCustomPrecincts = !!(scod & 1);
              cod.sopMarkerUsed = !!(scod & 2);
              cod.ephMarkerUsed = !!(scod & 4);
              cod.progressionOrder = data[j++];
              cod.layersCount = readUint16(data, j);
              j += 2;
              cod.multipleComponentTransform = data[j++];
              cod.decompositionLevelsCount = data[j++];
              cod.xcb = (data[j++] & 15) + 2;
              cod.ycb = (data[j++] & 15) + 2;
              const blockStyle = data[j++];
              cod.selectiveArithmeticCodingBypass = !!(blockStyle & 1);
              cod.resetContextProbabilities = !!(blockStyle & 2);
              cod.terminationOnEachCodingPass = !!(blockStyle & 4);
              cod.verticallyStripe = !!(blockStyle & 8);
              cod.predictableTermination = !!(blockStyle & 16);
              cod.segmentationSymbolUsed = !!(blockStyle & 32);
              cod.reversibleTransformation = data[j++];
              if (cod.entropyCoderWithCustomPrecincts) {
                const precinctsSizes = [];
                while (j < length + position) {
                  const precinctsSize = data[j++];
                  precinctsSizes.push({
                    PPx: precinctsSize & 15,
                    PPy: precinctsSize >> 4
                  });
                }
                cod.precinctsSizes = precinctsSizes;
              }
              const unsupported = [];
              if (cod.selectiveArithmeticCodingBypass) {
                unsupported.push("selectiveArithmeticCodingBypass");
              }
              if (cod.terminationOnEachCodingPass) {
                unsupported.push("terminationOnEachCodingPass");
              }
              if (cod.verticallyStripe) {
                unsupported.push("verticallyStripe");
              }
              if (cod.predictableTermination) {
                unsupported.push("predictableTermination");
              }
              if (unsupported.length > 0) {
                doNotRecover = true;
                warn(`JPX: Unsupported COD options (${unsupported.join(", ")}).`);
              }
              if (context.mainHeader) {
                context.COD = cod;
              } else {
                context.currentTile.COD = cod;
                context.currentTile.COC = [];
              }
              break;
            case 65424:
              length = readUint16(data, position);
              tile = {};
              tile.index = readUint16(data, position + 2);
              tile.length = readUint32(data, position + 4);
              tile.dataEnd = tile.length + position - 2;
              tile.partIndex = data[position + 8];
              tile.partsCount = data[position + 9];
              context.mainHeader = false;
              if (tile.partIndex === 0) {
                tile.COD = context.COD;
                tile.COC = context.COC.slice(0);
                tile.QCD = context.QCD;
                tile.QCC = context.QCC.slice(0);
              }
              context.currentTile = tile;
              break;
            case 65427:
              tile = context.currentTile;
              if (tile.partIndex === 0) {
                initializeTile(context, tile.index);
                buildPackets(context);
              }
              length = tile.dataEnd - position;
              parseTilePackets(context, data, position, length);
              break;
            case 65363:
              warn("JPX: Codestream code 0xFF53 (COC) is not implemented.");
            /* falls through */
            case 65365:
            // Tile-part lengths, main header (TLM)
            case 65367:
            // Packet length, main header (PLM)
            case 65368:
            // Packet length, tile-part header (PLT)
            case 65380:
              length = readUint16(data, position);
              break;
            default:
              throw new Error("Unknown codestream code: " + code.toString(16));
          }
          position += length;
        }
      } catch (e) {
        if (doNotRecover || this.failOnCorruptedImage) {
          throw new JpxError(e.message);
        } else {
          warn(`JPX: Trying to recover from: "${e.message}".`);
        }
      }
      this.tiles = transformComponents(context);
      this.width = context.SIZ.Xsiz - context.SIZ.XOsiz;
      this.height = context.SIZ.Ysiz - context.SIZ.YOsiz;
      this.componentsCount = context.SIZ.Csiz;
    }
  };
  function calculateComponentDimensions(component, siz) {
    component.x0 = Math.ceil(siz.XOsiz / component.XRsiz);
    component.x1 = Math.ceil(siz.Xsiz / component.XRsiz);
    component.y0 = Math.ceil(siz.YOsiz / component.YRsiz);
    component.y1 = Math.ceil(siz.Ysiz / component.YRsiz);
    component.width = component.x1 - component.x0;
    component.height = component.y1 - component.y0;
  }
  function calculateTileGrids(context, components) {
    const siz = context.SIZ;
    const tiles = [];
    let tile;
    const numXtiles = Math.ceil((siz.Xsiz - siz.XTOsiz) / siz.XTsiz);
    const numYtiles = Math.ceil((siz.Ysiz - siz.YTOsiz) / siz.YTsiz);
    for (let q = 0; q < numYtiles; q++) {
      for (let p = 0; p < numXtiles; p++) {
        tile = {};
        tile.tx0 = Math.max(siz.XTOsiz + p * siz.XTsiz, siz.XOsiz);
        tile.ty0 = Math.max(siz.YTOsiz + q * siz.YTsiz, siz.YOsiz);
        tile.tx1 = Math.min(siz.XTOsiz + (p + 1) * siz.XTsiz, siz.Xsiz);
        tile.ty1 = Math.min(siz.YTOsiz + (q + 1) * siz.YTsiz, siz.Ysiz);
        tile.width = tile.tx1 - tile.tx0;
        tile.height = tile.ty1 - tile.ty0;
        tile.components = [];
        tiles.push(tile);
      }
    }
    context.tiles = tiles;
    const componentsCount = siz.Csiz;
    for (let i = 0, ii = componentsCount; i < ii; i++) {
      const component = components[i];
      for (let j = 0, jj = tiles.length; j < jj; j++) {
        const tileComponent = {};
        tile = tiles[j];
        tileComponent.tcx0 = Math.ceil(tile.tx0 / component.XRsiz);
        tileComponent.tcy0 = Math.ceil(tile.ty0 / component.YRsiz);
        tileComponent.tcx1 = Math.ceil(tile.tx1 / component.XRsiz);
        tileComponent.tcy1 = Math.ceil(tile.ty1 / component.YRsiz);
        tileComponent.width = tileComponent.tcx1 - tileComponent.tcx0;
        tileComponent.height = tileComponent.tcy1 - tileComponent.tcy0;
        tile.components[i] = tileComponent;
      }
    }
  }
  function getBlocksDimensions(context, component, r) {
    const codOrCoc = component.codingStyleParameters;
    const result = {};
    if (!codOrCoc.entropyCoderWithCustomPrecincts) {
      result.PPx = 15;
      result.PPy = 15;
    } else {
      result.PPx = codOrCoc.precinctsSizes[r].PPx;
      result.PPy = codOrCoc.precinctsSizes[r].PPy;
    }
    result.xcb_ = r > 0 ? Math.min(codOrCoc.xcb, result.PPx - 1) : Math.min(codOrCoc.xcb, result.PPx);
    result.ycb_ = r > 0 ? Math.min(codOrCoc.ycb, result.PPy - 1) : Math.min(codOrCoc.ycb, result.PPy);
    return result;
  }
  function buildPrecincts(context, resolution, dimensions) {
    const precinctWidth = 1 << dimensions.PPx;
    const precinctHeight = 1 << dimensions.PPy;
    const isZeroRes = resolution.resLevel === 0;
    const precinctWidthInSubband = 1 << dimensions.PPx + (isZeroRes ? 0 : -1);
    const precinctHeightInSubband = 1 << dimensions.PPy + (isZeroRes ? 0 : -1);
    const numprecinctswide = resolution.trx1 > resolution.trx0 ? Math.ceil(resolution.trx1 / precinctWidth) - Math.floor(resolution.trx0 / precinctWidth) : 0;
    const numprecinctshigh = resolution.try1 > resolution.try0 ? Math.ceil(resolution.try1 / precinctHeight) - Math.floor(resolution.try0 / precinctHeight) : 0;
    const numprecincts = numprecinctswide * numprecinctshigh;
    resolution.precinctParameters = {
      precinctWidth,
      precinctHeight,
      numprecinctswide,
      numprecinctshigh,
      numprecincts,
      precinctWidthInSubband,
      precinctHeightInSubband
    };
  }
  function buildCodeblocks(context, subband, dimensions) {
    const xcb_ = dimensions.xcb_;
    const ycb_ = dimensions.ycb_;
    const codeblockWidth = 1 << xcb_;
    const codeblockHeight = 1 << ycb_;
    const cbx0 = subband.tbx0 >> xcb_;
    const cby0 = subband.tby0 >> ycb_;
    const cbx1 = subband.tbx1 + codeblockWidth - 1 >> xcb_;
    const cby1 = subband.tby1 + codeblockHeight - 1 >> ycb_;
    const precinctParameters = subband.resolution.precinctParameters;
    const codeblocks = [];
    const precincts = [];
    let i, j, codeblock, precinctNumber;
    for (j = cby0; j < cby1; j++) {
      for (i = cbx0; i < cbx1; i++) {
        codeblock = {
          cbx: i,
          cby: j,
          tbx0: codeblockWidth * i,
          tby0: codeblockHeight * j,
          tbx1: codeblockWidth * (i + 1),
          tby1: codeblockHeight * (j + 1)
        };
        codeblock.tbx0_ = Math.max(subband.tbx0, codeblock.tbx0);
        codeblock.tby0_ = Math.max(subband.tby0, codeblock.tby0);
        codeblock.tbx1_ = Math.min(subband.tbx1, codeblock.tbx1);
        codeblock.tby1_ = Math.min(subband.tby1, codeblock.tby1);
        const pi = Math.floor(
          (codeblock.tbx0_ - subband.tbx0) / precinctParameters.precinctWidthInSubband
        );
        const pj = Math.floor(
          (codeblock.tby0_ - subband.tby0) / precinctParameters.precinctHeightInSubband
        );
        precinctNumber = pi + pj * precinctParameters.numprecinctswide;
        codeblock.precinctNumber = precinctNumber;
        codeblock.subbandType = subband.type;
        codeblock.Lblock = 3;
        if (codeblock.tbx1_ <= codeblock.tbx0_ || codeblock.tby1_ <= codeblock.tby0_) {
          continue;
        }
        codeblocks.push(codeblock);
        let precinct = precincts[precinctNumber];
        if (precinct !== void 0) {
          if (i < precinct.cbxMin) {
            precinct.cbxMin = i;
          } else if (i > precinct.cbxMax) {
            precinct.cbxMax = i;
          }
          if (j < precinct.cbyMin) {
            precinct.cbxMin = j;
          } else if (j > precinct.cbyMax) {
            precinct.cbyMax = j;
          }
        } else {
          precincts[precinctNumber] = precinct = {
            cbxMin: i,
            cbyMin: j,
            cbxMax: i,
            cbyMax: j
          };
        }
        codeblock.precinct = precinct;
      }
    }
    subband.codeblockParameters = {
      codeblockWidth: xcb_,
      codeblockHeight: ycb_,
      numcodeblockwide: cbx1 - cbx0 + 1,
      numcodeblockhigh: cby1 - cby0 + 1
    };
    subband.codeblocks = codeblocks;
    subband.precincts = precincts;
  }
  function createPacket(resolution, precinctNumber, layerNumber) {
    const precinctCodeblocks = [];
    const subbands = resolution.subbands;
    for (let i = 0, ii = subbands.length; i < ii; i++) {
      const subband = subbands[i];
      const codeblocks = subband.codeblocks;
      for (let j = 0, jj = codeblocks.length; j < jj; j++) {
        const codeblock = codeblocks[j];
        if (codeblock.precinctNumber !== precinctNumber) {
          continue;
        }
        precinctCodeblocks.push(codeblock);
      }
    }
    return {
      layerNumber,
      codeblocks: precinctCodeblocks
    };
  }
  function LayerResolutionComponentPositionIterator(context) {
    const siz = context.SIZ;
    const tileIndex = context.currentTile.index;
    const tile = context.tiles[tileIndex];
    const layersCount = tile.codingStyleDefaultParameters.layersCount;
    const componentsCount = siz.Csiz;
    let maxDecompositionLevelsCount = 0;
    for (let q = 0; q < componentsCount; q++) {
      maxDecompositionLevelsCount = Math.max(
        maxDecompositionLevelsCount,
        tile.components[q].codingStyleParameters.decompositionLevelsCount
      );
    }
    let l = 0, r = 0, i = 0, k = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; l < layersCount; l++) {
        for (; r <= maxDecompositionLevelsCount; r++) {
          for (; i < componentsCount; i++) {
            const component = tile.components[i];
            if (r > component.codingStyleParameters.decompositionLevelsCount) {
              continue;
            }
            const resolution = component.resolutions[r];
            const numprecincts = resolution.precinctParameters.numprecincts;
            for (; k < numprecincts; ) {
              const packet = createPacket(resolution, k, l);
              k++;
              return packet;
            }
            k = 0;
          }
          i = 0;
        }
        r = 0;
      }
      throw new JpxError("Out of packets");
    };
  }
  function ResolutionLayerComponentPositionIterator(context) {
    const siz = context.SIZ;
    const tileIndex = context.currentTile.index;
    const tile = context.tiles[tileIndex];
    const layersCount = tile.codingStyleDefaultParameters.layersCount;
    const componentsCount = siz.Csiz;
    let maxDecompositionLevelsCount = 0;
    for (let q = 0; q < componentsCount; q++) {
      maxDecompositionLevelsCount = Math.max(
        maxDecompositionLevelsCount,
        tile.components[q].codingStyleParameters.decompositionLevelsCount
      );
    }
    let r = 0, l = 0, i = 0, k = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; r <= maxDecompositionLevelsCount; r++) {
        for (; l < layersCount; l++) {
          for (; i < componentsCount; i++) {
            const component = tile.components[i];
            if (r > component.codingStyleParameters.decompositionLevelsCount) {
              continue;
            }
            const resolution = component.resolutions[r];
            const numprecincts = resolution.precinctParameters.numprecincts;
            for (; k < numprecincts; ) {
              const packet = createPacket(resolution, k, l);
              k++;
              return packet;
            }
            k = 0;
          }
          i = 0;
        }
        l = 0;
      }
      throw new JpxError("Out of packets");
    };
  }
  function ResolutionPositionComponentLayerIterator(context) {
    const siz = context.SIZ;
    const tileIndex = context.currentTile.index;
    const tile = context.tiles[tileIndex];
    const layersCount = tile.codingStyleDefaultParameters.layersCount;
    const componentsCount = siz.Csiz;
    let l, r, c, p;
    let maxDecompositionLevelsCount = 0;
    for (c = 0; c < componentsCount; c++) {
      const component = tile.components[c];
      maxDecompositionLevelsCount = Math.max(
        maxDecompositionLevelsCount,
        component.codingStyleParameters.decompositionLevelsCount
      );
    }
    const maxNumPrecinctsInLevel = new Int32Array(
      maxDecompositionLevelsCount + 1
    );
    for (r = 0; r <= maxDecompositionLevelsCount; ++r) {
      let maxNumPrecincts = 0;
      for (c = 0; c < componentsCount; ++c) {
        const resolutions = tile.components[c].resolutions;
        if (r < resolutions.length) {
          maxNumPrecincts = Math.max(
            maxNumPrecincts,
            resolutions[r].precinctParameters.numprecincts
          );
        }
      }
      maxNumPrecinctsInLevel[r] = maxNumPrecincts;
    }
    l = 0;
    r = 0;
    c = 0;
    p = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; r <= maxDecompositionLevelsCount; r++) {
        for (; p < maxNumPrecinctsInLevel[r]; p++) {
          for (; c < componentsCount; c++) {
            const component = tile.components[c];
            if (r > component.codingStyleParameters.decompositionLevelsCount) {
              continue;
            }
            const resolution = component.resolutions[r];
            const numprecincts = resolution.precinctParameters.numprecincts;
            if (p >= numprecincts) {
              continue;
            }
            for (; l < layersCount; ) {
              const packet = createPacket(resolution, p, l);
              l++;
              return packet;
            }
            l = 0;
          }
          c = 0;
        }
        p = 0;
      }
      throw new JpxError("Out of packets");
    };
  }
  function PositionComponentResolutionLayerIterator(context) {
    const siz = context.SIZ;
    const tileIndex = context.currentTile.index;
    const tile = context.tiles[tileIndex];
    const layersCount = tile.codingStyleDefaultParameters.layersCount;
    const componentsCount = siz.Csiz;
    const precinctsSizes = getPrecinctSizesInImageScale(tile);
    const precinctsIterationSizes = precinctsSizes;
    let l = 0, r = 0, c = 0, px = 0, py = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; py < precinctsIterationSizes.maxNumHigh; py++) {
        for (; px < precinctsIterationSizes.maxNumWide; px++) {
          for (; c < componentsCount; c++) {
            const component = tile.components[c];
            const decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
            for (; r <= decompositionLevelsCount; r++) {
              const resolution = component.resolutions[r];
              const sizeInImageScale = precinctsSizes.components[c].resolutions[r];
              const k = getPrecinctIndexIfExist(
                px,
                py,
                sizeInImageScale,
                precinctsIterationSizes,
                resolution
              );
              if (k === null) {
                continue;
              }
              for (; l < layersCount; ) {
                const packet = createPacket(resolution, k, l);
                l++;
                return packet;
              }
              l = 0;
            }
            r = 0;
          }
          c = 0;
        }
        px = 0;
      }
      throw new JpxError("Out of packets");
    };
  }
  function ComponentPositionResolutionLayerIterator(context) {
    const siz = context.SIZ;
    const tileIndex = context.currentTile.index;
    const tile = context.tiles[tileIndex];
    const layersCount = tile.codingStyleDefaultParameters.layersCount;
    const componentsCount = siz.Csiz;
    const precinctsSizes = getPrecinctSizesInImageScale(tile);
    let l = 0, r = 0, c = 0, px = 0, py = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; c < componentsCount; ++c) {
        const component = tile.components[c];
        const precinctsIterationSizes = precinctsSizes.components[c];
        const decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
        for (; py < precinctsIterationSizes.maxNumHigh; py++) {
          for (; px < precinctsIterationSizes.maxNumWide; px++) {
            for (; r <= decompositionLevelsCount; r++) {
              const resolution = component.resolutions[r];
              const sizeInImageScale = precinctsIterationSizes.resolutions[r];
              const k = getPrecinctIndexIfExist(
                px,
                py,
                sizeInImageScale,
                precinctsIterationSizes,
                resolution
              );
              if (k === null) {
                continue;
              }
              for (; l < layersCount; ) {
                const packet = createPacket(resolution, k, l);
                l++;
                return packet;
              }
              l = 0;
            }
            r = 0;
          }
          px = 0;
        }
        py = 0;
      }
      throw new JpxError("Out of packets");
    };
  }
  function getPrecinctIndexIfExist(pxIndex, pyIndex, sizeInImageScale, precinctIterationSizes, resolution) {
    const posX = pxIndex * precinctIterationSizes.minWidth;
    const posY = pyIndex * precinctIterationSizes.minHeight;
    if (posX % sizeInImageScale.width !== 0 || posY % sizeInImageScale.height !== 0) {
      return null;
    }
    const startPrecinctRowIndex = posY / sizeInImageScale.width * resolution.precinctParameters.numprecinctswide;
    return posX / sizeInImageScale.height + startPrecinctRowIndex;
  }
  function getPrecinctSizesInImageScale(tile) {
    const componentsCount = tile.components.length;
    let minWidth = Number.MAX_VALUE;
    let minHeight = Number.MAX_VALUE;
    let maxNumWide = 0;
    let maxNumHigh = 0;
    const sizePerComponent = new Array(componentsCount);
    for (let c = 0; c < componentsCount; c++) {
      const component = tile.components[c];
      const decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
      const sizePerResolution = new Array(decompositionLevelsCount + 1);
      let minWidthCurrentComponent = Number.MAX_VALUE;
      let minHeightCurrentComponent = Number.MAX_VALUE;
      let maxNumWideCurrentComponent = 0;
      let maxNumHighCurrentComponent = 0;
      let scale = 1;
      for (let r = decompositionLevelsCount; r >= 0; --r) {
        const resolution = component.resolutions[r];
        const widthCurrentResolution = scale * resolution.precinctParameters.precinctWidth;
        const heightCurrentResolution = scale * resolution.precinctParameters.precinctHeight;
        minWidthCurrentComponent = Math.min(
          minWidthCurrentComponent,
          widthCurrentResolution
        );
        minHeightCurrentComponent = Math.min(
          minHeightCurrentComponent,
          heightCurrentResolution
        );
        maxNumWideCurrentComponent = Math.max(
          maxNumWideCurrentComponent,
          resolution.precinctParameters.numprecinctswide
        );
        maxNumHighCurrentComponent = Math.max(
          maxNumHighCurrentComponent,
          resolution.precinctParameters.numprecinctshigh
        );
        sizePerResolution[r] = {
          width: widthCurrentResolution,
          height: heightCurrentResolution
        };
        scale <<= 1;
      }
      minWidth = Math.min(minWidth, minWidthCurrentComponent);
      minHeight = Math.min(minHeight, minHeightCurrentComponent);
      maxNumWide = Math.max(maxNumWide, maxNumWideCurrentComponent);
      maxNumHigh = Math.max(maxNumHigh, maxNumHighCurrentComponent);
      sizePerComponent[c] = {
        resolutions: sizePerResolution,
        minWidth: minWidthCurrentComponent,
        minHeight: minHeightCurrentComponent,
        maxNumWide: maxNumWideCurrentComponent,
        maxNumHigh: maxNumHighCurrentComponent
      };
    }
    return {
      components: sizePerComponent,
      minWidth,
      minHeight,
      maxNumWide,
      maxNumHigh
    };
  }
  function buildPackets(context) {
    const siz = context.SIZ;
    const tileIndex = context.currentTile.index;
    const tile = context.tiles[tileIndex];
    const componentsCount = siz.Csiz;
    for (let c = 0; c < componentsCount; c++) {
      const component = tile.components[c];
      const decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
      const resolutions = [];
      const subbands = [];
      for (let r = 0; r <= decompositionLevelsCount; r++) {
        const blocksDimensions = getBlocksDimensions(context, component, r);
        const resolution = {};
        const scale = 1 << decompositionLevelsCount - r;
        resolution.trx0 = Math.ceil(component.tcx0 / scale);
        resolution.try0 = Math.ceil(component.tcy0 / scale);
        resolution.trx1 = Math.ceil(component.tcx1 / scale);
        resolution.try1 = Math.ceil(component.tcy1 / scale);
        resolution.resLevel = r;
        buildPrecincts(context, resolution, blocksDimensions);
        resolutions.push(resolution);
        let subband;
        if (r === 0) {
          subband = {};
          subband.type = "LL";
          subband.tbx0 = Math.ceil(component.tcx0 / scale);
          subband.tby0 = Math.ceil(component.tcy0 / scale);
          subband.tbx1 = Math.ceil(component.tcx1 / scale);
          subband.tby1 = Math.ceil(component.tcy1 / scale);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolution.subbands = [subband];
        } else {
          const bscale = 1 << decompositionLevelsCount - r + 1;
          const resolutionSubbands = [];
          subband = {};
          subband.type = "HL";
          subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
          subband.tby0 = Math.ceil(component.tcy0 / bscale);
          subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
          subband.tby1 = Math.ceil(component.tcy1 / bscale);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolutionSubbands.push(subband);
          subband = {};
          subband.type = "LH";
          subband.tbx0 = Math.ceil(component.tcx0 / bscale);
          subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
          subband.tbx1 = Math.ceil(component.tcx1 / bscale);
          subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolutionSubbands.push(subband);
          subband = {};
          subband.type = "HH";
          subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
          subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
          subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
          subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolutionSubbands.push(subband);
          resolution.subbands = resolutionSubbands;
        }
      }
      component.resolutions = resolutions;
      component.subbands = subbands;
    }
    const progressionOrder = tile.codingStyleDefaultParameters.progressionOrder;
    switch (progressionOrder) {
      case 0:
        tile.packetsIterator = new LayerResolutionComponentPositionIterator(
          context
        );
        break;
      case 1:
        tile.packetsIterator = new ResolutionLayerComponentPositionIterator(
          context
        );
        break;
      case 2:
        tile.packetsIterator = new ResolutionPositionComponentLayerIterator(
          context
        );
        break;
      case 3:
        tile.packetsIterator = new PositionComponentResolutionLayerIterator(
          context
        );
        break;
      case 4:
        tile.packetsIterator = new ComponentPositionResolutionLayerIterator(
          context
        );
        break;
      default:
        throw new JpxError(`Unsupported progression order ${progressionOrder}`);
    }
  }
  function parseTilePackets(context, data, offset, dataLength) {
    let position = 0;
    let buffer, bufferSize = 0, skipNextBit = false;
    function readBits(count) {
      while (bufferSize < count) {
        const b = data[offset + position];
        position++;
        if (skipNextBit) {
          buffer = buffer << 7 | b;
          bufferSize += 7;
          skipNextBit = false;
        } else {
          buffer = buffer << 8 | b;
          bufferSize += 8;
        }
        if (b === 255) {
          skipNextBit = true;
        }
      }
      bufferSize -= count;
      return buffer >>> bufferSize & (1 << count) - 1;
    }
    function skipMarkerIfEqual(value) {
      if (data[offset + position - 1] === 255 && data[offset + position] === value) {
        skipBytes(1);
        return true;
      } else if (data[offset + position] === 255 && data[offset + position + 1] === value) {
        skipBytes(2);
        return true;
      }
      return false;
    }
    function skipBytes(count) {
      position += count;
    }
    function alignToByte() {
      bufferSize = 0;
      if (skipNextBit) {
        position++;
        skipNextBit = false;
      }
    }
    function readCodingpasses() {
      if (readBits(1) === 0) {
        return 1;
      }
      if (readBits(1) === 0) {
        return 2;
      }
      let value = readBits(2);
      if (value < 3) {
        return value + 3;
      }
      value = readBits(5);
      if (value < 31) {
        return value + 6;
      }
      value = readBits(7);
      return value + 37;
    }
    const tileIndex = context.currentTile.index;
    const tile = context.tiles[tileIndex];
    const sopMarkerUsed = context.COD.sopMarkerUsed;
    const ephMarkerUsed = context.COD.ephMarkerUsed;
    const packetsIterator = tile.packetsIterator;
    while (position < dataLength) {
      alignToByte();
      if (sopMarkerUsed && skipMarkerIfEqual(145)) {
        skipBytes(4);
      }
      const packet = packetsIterator.nextPacket();
      if (!readBits(1)) {
        continue;
      }
      const layerNumber = packet.layerNumber, queue = [];
      let codeblock;
      for (let i = 0, ii = packet.codeblocks.length; i < ii; i++) {
        codeblock = packet.codeblocks[i];
        let precinct = codeblock.precinct;
        const codeblockColumn = codeblock.cbx - precinct.cbxMin;
        const codeblockRow = codeblock.cby - precinct.cbyMin;
        let codeblockIncluded = false;
        let firstTimeInclusion = false;
        let valueReady, zeroBitPlanesTree;
        if (codeblock.included !== void 0) {
          codeblockIncluded = !!readBits(1);
        } else {
          precinct = codeblock.precinct;
          let inclusionTree;
          if (precinct.inclusionTree !== void 0) {
            inclusionTree = precinct.inclusionTree;
          } else {
            const width = precinct.cbxMax - precinct.cbxMin + 1;
            const height = precinct.cbyMax - precinct.cbyMin + 1;
            inclusionTree = new InclusionTree(width, height, layerNumber);
            zeroBitPlanesTree = new TagTree(width, height);
            precinct.inclusionTree = inclusionTree;
            precinct.zeroBitPlanesTree = zeroBitPlanesTree;
            for (let l = 0; l < layerNumber; l++) {
              if (readBits(1) !== 0) {
                throw new JpxError("Invalid tag tree");
              }
            }
          }
          if (inclusionTree.reset(codeblockColumn, codeblockRow, layerNumber)) {
            while (true) {
              if (readBits(1)) {
                valueReady = !inclusionTree.nextLevel();
                if (valueReady) {
                  codeblock.included = true;
                  codeblockIncluded = firstTimeInclusion = true;
                  break;
                }
              } else {
                inclusionTree.incrementValue(layerNumber);
                break;
              }
            }
          }
        }
        if (!codeblockIncluded) {
          continue;
        }
        if (firstTimeInclusion) {
          zeroBitPlanesTree = precinct.zeroBitPlanesTree;
          zeroBitPlanesTree.reset(codeblockColumn, codeblockRow);
          while (true) {
            if (readBits(1)) {
              valueReady = !zeroBitPlanesTree.nextLevel();
              if (valueReady) {
                break;
              }
            } else {
              zeroBitPlanesTree.incrementValue();
            }
          }
          codeblock.zeroBitPlanes = zeroBitPlanesTree.value;
        }
        const codingpasses = readCodingpasses();
        while (readBits(1)) {
          codeblock.Lblock++;
        }
        const codingpassesLog2 = log2(codingpasses);
        const bits = (codingpasses < 1 << codingpassesLog2 ? codingpassesLog2 - 1 : codingpassesLog2) + codeblock.Lblock;
        const codedDataLength = readBits(bits);
        queue.push({
          codeblock,
          codingpasses,
          dataLength: codedDataLength
        });
      }
      alignToByte();
      if (ephMarkerUsed) {
        skipMarkerIfEqual(146);
      }
      while (queue.length > 0) {
        const packetItem = queue.shift();
        codeblock = packetItem.codeblock;
        if (codeblock.data === void 0) {
          codeblock.data = [];
        }
        codeblock.data.push({
          data,
          start: offset + position,
          end: offset + position + packetItem.dataLength,
          codingpasses: packetItem.codingpasses
        });
        position += packetItem.dataLength;
      }
    }
    return position;
  }
  function copyCoefficients(coefficients, levelWidth, levelHeight, subband, delta, mb, reversible, segmentationSymbolUsed, resetContextProbabilities) {
    const x0 = subband.tbx0;
    const y0 = subband.tby0;
    const width = subband.tbx1 - subband.tbx0;
    const codeblocks = subband.codeblocks;
    const right = subband.type.charAt(0) === "H" ? 1 : 0;
    const bottom = subband.type.charAt(1) === "H" ? levelWidth : 0;
    for (let i = 0, ii = codeblocks.length; i < ii; ++i) {
      const codeblock = codeblocks[i];
      const blockWidth = codeblock.tbx1_ - codeblock.tbx0_;
      const blockHeight = codeblock.tby1_ - codeblock.tby0_;
      if (blockWidth === 0 || blockHeight === 0) {
        continue;
      }
      if (codeblock.data === void 0) {
        continue;
      }
      const bitModel = new BitModel(
        blockWidth,
        blockHeight,
        codeblock.subbandType,
        codeblock.zeroBitPlanes,
        mb
      );
      let currentCodingpassType = 2;
      const data = codeblock.data;
      let totalLength = 0, codingpasses = 0;
      let j, jj, dataItem;
      for (j = 0, jj = data.length; j < jj; j++) {
        dataItem = data[j];
        totalLength += dataItem.end - dataItem.start;
        codingpasses += dataItem.codingpasses;
      }
      const encodedData = new Uint8Array(totalLength);
      let position = 0;
      for (j = 0, jj = data.length; j < jj; j++) {
        dataItem = data[j];
        const chunk = dataItem.data.subarray(dataItem.start, dataItem.end);
        encodedData.set(chunk, position);
        position += chunk.length;
      }
      const decoder = new ArithmeticDecoder(encodedData, 0, totalLength);
      bitModel.setDecoder(decoder);
      for (j = 0; j < codingpasses; j++) {
        switch (currentCodingpassType) {
          case 0:
            bitModel.runSignificancePropagationPass();
            break;
          case 1:
            bitModel.runMagnitudeRefinementPass();
            break;
          case 2:
            bitModel.runCleanupPass();
            if (segmentationSymbolUsed) {
              bitModel.checkSegmentationSymbol();
            }
            break;
        }
        if (resetContextProbabilities) {
          bitModel.reset();
        }
        currentCodingpassType = (currentCodingpassType + 1) % 3;
      }
      let offset = codeblock.tbx0_ - x0 + (codeblock.tby0_ - y0) * width;
      const sign = bitModel.coefficentsSign;
      const magnitude = bitModel.coefficentsMagnitude;
      const bitsDecoded = bitModel.bitsDecoded;
      const magnitudeCorrection = reversible ? 0 : 0.5;
      let k, n, nb;
      position = 0;
      const interleave = subband.type !== "LL";
      for (j = 0; j < blockHeight; j++) {
        const row = offset / width | 0;
        const levelOffset = 2 * row * (levelWidth - width) + right + bottom;
        for (k = 0; k < blockWidth; k++) {
          n = magnitude[position];
          if (n !== 0) {
            n = (n + magnitudeCorrection) * delta;
            if (sign[position] !== 0) {
              n = -n;
            }
            nb = bitsDecoded[position];
            const pos = interleave ? levelOffset + (offset << 1) : offset;
            if (reversible && nb >= mb) {
              coefficients[pos] = n;
            } else {
              coefficients[pos] = n * (1 << mb - nb);
            }
          }
          offset++;
          position++;
        }
        offset += width - blockWidth;
      }
    }
  }
  function transformTile(context, tile, c) {
    const component = tile.components[c];
    const codingStyleParameters = component.codingStyleParameters;
    const quantizationParameters = component.quantizationParameters;
    const decompositionLevelsCount = codingStyleParameters.decompositionLevelsCount;
    const spqcds = quantizationParameters.SPqcds;
    const scalarExpounded = quantizationParameters.scalarExpounded;
    const guardBits = quantizationParameters.guardBits;
    const segmentationSymbolUsed = codingStyleParameters.segmentationSymbolUsed;
    const resetContextProbabilities = codingStyleParameters.resetContextProbabilities;
    const precision = context.components[c].precision;
    const reversible = codingStyleParameters.reversibleTransformation;
    const transform = reversible ? new ReversibleTransform() : new IrreversibleTransform();
    const subbandCoefficients = [];
    let b = 0;
    for (let i = 0; i <= decompositionLevelsCount; i++) {
      const resolution = component.resolutions[i];
      const width = resolution.trx1 - resolution.trx0;
      const height = resolution.try1 - resolution.try0;
      const coefficients = new Float32Array(width * height);
      for (let j = 0, jj = resolution.subbands.length; j < jj; j++) {
        let mu, epsilon;
        if (!scalarExpounded) {
          mu = spqcds[0].mu;
          epsilon = spqcds[0].epsilon + (i > 0 ? 1 - i : 0);
        } else {
          mu = spqcds[b].mu;
          epsilon = spqcds[b].epsilon;
          b++;
        }
        const subband = resolution.subbands[j];
        const gainLog2 = SubbandsGainLog2[subband.type];
        const delta = reversible ? 1 : 2 ** (precision + gainLog2 - epsilon) * (1 + mu / 2048);
        const mb = guardBits + epsilon - 1;
        copyCoefficients(
          coefficients,
          width,
          height,
          subband,
          delta,
          mb,
          reversible,
          segmentationSymbolUsed,
          resetContextProbabilities
        );
      }
      subbandCoefficients.push({
        width,
        height,
        items: coefficients
      });
    }
    const result = transform.calculate(
      subbandCoefficients,
      component.tcx0,
      component.tcy0
    );
    return {
      left: component.tcx0,
      top: component.tcy0,
      width: result.width,
      height: result.height,
      items: result.items
    };
  }
  function transformComponents(context) {
    const siz = context.SIZ;
    const components = context.components;
    const componentsCount = siz.Csiz;
    const resultImages = [];
    for (let i = 0, ii = context.tiles.length; i < ii; i++) {
      const tile = context.tiles[i];
      const transformedTiles = [];
      for (let c = 0; c < componentsCount; c++) {
        transformedTiles[c] = transformTile(context, tile, c);
      }
      const tile0 = transformedTiles[0];
      const out = new Uint8ClampedArray(tile0.items.length * componentsCount);
      const result = {
        left: tile0.left,
        top: tile0.top,
        width: tile0.width,
        height: tile0.height,
        items: out
      };
      let shift, offset;
      let pos = 0, j, jj, y0, y1, y2;
      if (tile.codingStyleDefaultParameters.multipleComponentTransform) {
        const fourComponents = componentsCount === 4;
        const y0items = transformedTiles[0].items;
        const y1items = transformedTiles[1].items;
        const y2items = transformedTiles[2].items;
        const y3items = fourComponents ? transformedTiles[3].items : null;
        shift = components[0].precision - 8;
        offset = (128 << shift) + 0.5;
        const component0 = tile.components[0];
        const alpha01 = componentsCount - 3;
        jj = y0items.length;
        if (!component0.codingStyleParameters.reversibleTransformation) {
          for (j = 0; j < jj; j++, pos += alpha01) {
            y0 = y0items[j] + offset;
            y1 = y1items[j];
            y2 = y2items[j];
            out[pos++] = y0 + 1.402 * y2 >> shift;
            out[pos++] = y0 - 0.34413 * y1 - 0.71414 * y2 >> shift;
            out[pos++] = y0 + 1.772 * y1 >> shift;
          }
        } else {
          for (j = 0; j < jj; j++, pos += alpha01) {
            y0 = y0items[j] + offset;
            y1 = y1items[j];
            y2 = y2items[j];
            const g = y0 - (y2 + y1 >> 2);
            out[pos++] = g + y2 >> shift;
            out[pos++] = g >> shift;
            out[pos++] = g + y1 >> shift;
          }
        }
        if (fourComponents) {
          for (j = 0, pos = 3; j < jj; j++, pos += 4) {
            out[pos] = y3items[j] + offset >> shift;
          }
        }
      } else {
        for (let c = 0; c < componentsCount; c++) {
          const items = transformedTiles[c].items;
          shift = components[c].precision - 8;
          offset = (128 << shift) + 0.5;
          for (pos = c, j = 0, jj = items.length; j < jj; j++) {
            out[pos] = items[j] + offset >> shift;
            pos += componentsCount;
          }
        }
      }
      resultImages.push(result);
    }
    return resultImages;
  }
  function initializeTile(context, tileIndex) {
    const siz = context.SIZ;
    const componentsCount = siz.Csiz;
    const tile = context.tiles[tileIndex];
    for (let c = 0; c < componentsCount; c++) {
      const component = tile.components[c];
      const qcdOrQcc = context.currentTile.QCC[c] !== void 0 ? context.currentTile.QCC[c] : context.currentTile.QCD;
      component.quantizationParameters = qcdOrQcc;
      const codOrCoc = context.currentTile.COC[c] !== void 0 ? context.currentTile.COC[c] : context.currentTile.COD;
      component.codingStyleParameters = codOrCoc;
    }
    tile.codingStyleDefaultParameters = context.currentTile.COD;
  }
  var TagTree = class {
    constructor(width, height) {
      const levelsLength = log2(Math.max(width, height)) + 1;
      this.levels = [];
      for (let i = 0; i < levelsLength; i++) {
        const level = {
          width,
          height,
          items: []
        };
        this.levels.push(level);
        width = Math.ceil(width / 2);
        height = Math.ceil(height / 2);
      }
    }
    reset(i, j) {
      let currentLevel = 0, value = 0, level;
      while (currentLevel < this.levels.length) {
        level = this.levels[currentLevel];
        const index = i + j * level.width;
        if (level.items[index] !== void 0) {
          value = level.items[index];
          break;
        }
        level.index = index;
        i >>= 1;
        j >>= 1;
        currentLevel++;
      }
      currentLevel--;
      level = this.levels[currentLevel];
      level.items[level.index] = value;
      this.currentLevel = currentLevel;
      delete this.value;
    }
    incrementValue() {
      const level = this.levels[this.currentLevel];
      level.items[level.index]++;
    }
    nextLevel() {
      let currentLevel = this.currentLevel;
      let level = this.levels[currentLevel];
      const value = level.items[level.index];
      currentLevel--;
      if (currentLevel < 0) {
        this.value = value;
        return false;
      }
      this.currentLevel = currentLevel;
      level = this.levels[currentLevel];
      level.items[level.index] = value;
      return true;
    }
  };
  var InclusionTree = class {
    constructor(width, height, defaultValue) {
      const levelsLength = log2(Math.max(width, height)) + 1;
      this.levels = [];
      for (let i = 0; i < levelsLength; i++) {
        const items = new Uint8Array(width * height);
        for (let j = 0, jj = items.length; j < jj; j++) {
          items[j] = defaultValue;
        }
        const level = {
          width,
          height,
          items
        };
        this.levels.push(level);
        width = Math.ceil(width / 2);
        height = Math.ceil(height / 2);
      }
    }
    reset(i, j, stopValue) {
      let currentLevel = 0;
      while (currentLevel < this.levels.length) {
        const level = this.levels[currentLevel];
        const index = i + j * level.width;
        level.index = index;
        const value = level.items[index];
        if (value === 255) {
          break;
        }
        if (value > stopValue) {
          this.currentLevel = currentLevel;
          this.propagateValues();
          return false;
        }
        i >>= 1;
        j >>= 1;
        currentLevel++;
      }
      this.currentLevel = currentLevel - 1;
      return true;
    }
    incrementValue(stopValue) {
      const level = this.levels[this.currentLevel];
      level.items[level.index] = stopValue + 1;
      this.propagateValues();
    }
    propagateValues() {
      let levelIndex = this.currentLevel;
      let level = this.levels[levelIndex];
      const currentValue = level.items[level.index];
      while (--levelIndex >= 0) {
        level = this.levels[levelIndex];
        level.items[level.index] = currentValue;
      }
    }
    nextLevel() {
      let currentLevel = this.currentLevel;
      let level = this.levels[currentLevel];
      const value = level.items[level.index];
      level.items[level.index] = 255;
      currentLevel--;
      if (currentLevel < 0) {
        return false;
      }
      this.currentLevel = currentLevel;
      level = this.levels[currentLevel];
      level.items[level.index] = value;
      return true;
    }
  };
  var BitModel = (function BitModelClosure() {
    const UNIFORM_CONTEXT = 17;
    const RUNLENGTH_CONTEXT = 18;
    const LLAndLHContextsLabel = new Uint8Array([
      0,
      5,
      8,
      0,
      3,
      7,
      8,
      0,
      4,
      7,
      8,
      0,
      0,
      0,
      0,
      0,
      1,
      6,
      8,
      0,
      3,
      7,
      8,
      0,
      4,
      7,
      8,
      0,
      0,
      0,
      0,
      0,
      2,
      6,
      8,
      0,
      3,
      7,
      8,
      0,
      4,
      7,
      8,
      0,
      0,
      0,
      0,
      0,
      2,
      6,
      8,
      0,
      3,
      7,
      8,
      0,
      4,
      7,
      8,
      0,
      0,
      0,
      0,
      0,
      2,
      6,
      8,
      0,
      3,
      7,
      8,
      0,
      4,
      7,
      8
    ]);
    const HLContextLabel = new Uint8Array([
      0,
      3,
      4,
      0,
      5,
      7,
      7,
      0,
      8,
      8,
      8,
      0,
      0,
      0,
      0,
      0,
      1,
      3,
      4,
      0,
      6,
      7,
      7,
      0,
      8,
      8,
      8,
      0,
      0,
      0,
      0,
      0,
      2,
      3,
      4,
      0,
      6,
      7,
      7,
      0,
      8,
      8,
      8,
      0,
      0,
      0,
      0,
      0,
      2,
      3,
      4,
      0,
      6,
      7,
      7,
      0,
      8,
      8,
      8,
      0,
      0,
      0,
      0,
      0,
      2,
      3,
      4,
      0,
      6,
      7,
      7,
      0,
      8,
      8,
      8
    ]);
    const HHContextLabel = new Uint8Array([
      0,
      1,
      2,
      0,
      1,
      2,
      2,
      0,
      2,
      2,
      2,
      0,
      0,
      0,
      0,
      0,
      3,
      4,
      5,
      0,
      4,
      5,
      5,
      0,
      5,
      5,
      5,
      0,
      0,
      0,
      0,
      0,
      6,
      7,
      7,
      0,
      7,
      7,
      7,
      0,
      7,
      7,
      7,
      0,
      0,
      0,
      0,
      0,
      8,
      8,
      8,
      0,
      8,
      8,
      8,
      0,
      8,
      8,
      8,
      0,
      0,
      0,
      0,
      0,
      8,
      8,
      8,
      0,
      8,
      8,
      8,
      0,
      8,
      8,
      8
    ]);
    class BitModel2 {
      constructor(width, height, subband, zeroBitPlanes, mb) {
        this.width = width;
        this.height = height;
        let contextLabelTable;
        if (subband === "HH") {
          contextLabelTable = HHContextLabel;
        } else if (subband === "HL") {
          contextLabelTable = HLContextLabel;
        } else {
          contextLabelTable = LLAndLHContextsLabel;
        }
        this.contextLabelTable = contextLabelTable;
        const coefficientCount = width * height;
        this.neighborsSignificance = new Uint8Array(coefficientCount);
        this.coefficentsSign = new Uint8Array(coefficientCount);
        let coefficentsMagnitude;
        if (mb > 14) {
          coefficentsMagnitude = new Uint32Array(coefficientCount);
        } else if (mb > 6) {
          coefficentsMagnitude = new Uint16Array(coefficientCount);
        } else {
          coefficentsMagnitude = new Uint8Array(coefficientCount);
        }
        this.coefficentsMagnitude = coefficentsMagnitude;
        this.processingFlags = new Uint8Array(coefficientCount);
        const bitsDecoded = new Uint8Array(coefficientCount);
        if (zeroBitPlanes !== 0) {
          for (let i = 0; i < coefficientCount; i++) {
            bitsDecoded[i] = zeroBitPlanes;
          }
        }
        this.bitsDecoded = bitsDecoded;
        this.reset();
      }
      setDecoder(decoder) {
        this.decoder = decoder;
      }
      reset() {
        this.contexts = new Int8Array(19);
        this.contexts[0] = 4 << 1 | 0;
        this.contexts[UNIFORM_CONTEXT] = 46 << 1 | 0;
        this.contexts[RUNLENGTH_CONTEXT] = 3 << 1 | 0;
      }
      setNeighborsSignificance(row, column, index) {
        const neighborsSignificance = this.neighborsSignificance;
        const width = this.width, height = this.height;
        const left = column > 0;
        const right = column + 1 < width;
        let i;
        if (row > 0) {
          i = index - width;
          if (left) {
            neighborsSignificance[i - 1] += 16;
          }
          if (right) {
            neighborsSignificance[i + 1] += 16;
          }
          neighborsSignificance[i] += 4;
        }
        if (row + 1 < height) {
          i = index + width;
          if (left) {
            neighborsSignificance[i - 1] += 16;
          }
          if (right) {
            neighborsSignificance[i + 1] += 16;
          }
          neighborsSignificance[i] += 4;
        }
        if (left) {
          neighborsSignificance[index - 1] += 1;
        }
        if (right) {
          neighborsSignificance[index + 1] += 1;
        }
        neighborsSignificance[index] |= 128;
      }
      runSignificancePropagationPass() {
        const decoder = this.decoder;
        const width = this.width, height = this.height;
        const coefficentsMagnitude = this.coefficentsMagnitude;
        const coefficentsSign = this.coefficentsSign;
        const neighborsSignificance = this.neighborsSignificance;
        const processingFlags = this.processingFlags;
        const contexts = this.contexts;
        const labels = this.contextLabelTable;
        const bitsDecoded = this.bitsDecoded;
        const processedInverseMask = ~1;
        const processedMask = 1;
        const firstMagnitudeBitMask = 2;
        for (let i0 = 0; i0 < height; i0 += 4) {
          for (let j = 0; j < width; j++) {
            let index = i0 * width + j;
            for (let i1 = 0; i1 < 4; i1++, index += width) {
              const i = i0 + i1;
              if (i >= height) {
                break;
              }
              processingFlags[index] &= processedInverseMask;
              if (coefficentsMagnitude[index] || !neighborsSignificance[index]) {
                continue;
              }
              const contextLabel = labels[neighborsSignificance[index]];
              const decision = decoder.readBit(contexts, contextLabel);
              if (decision) {
                const sign = this.decodeSignBit(i, j, index);
                coefficentsSign[index] = sign;
                coefficentsMagnitude[index] = 1;
                this.setNeighborsSignificance(i, j, index);
                processingFlags[index] |= firstMagnitudeBitMask;
              }
              bitsDecoded[index]++;
              processingFlags[index] |= processedMask;
            }
          }
        }
      }
      decodeSignBit(row, column, index) {
        const width = this.width, height = this.height;
        const coefficentsMagnitude = this.coefficentsMagnitude;
        const coefficentsSign = this.coefficentsSign;
        let contribution, sign0, sign1, significance1;
        let contextLabel, decoded;
        significance1 = column > 0 && coefficentsMagnitude[index - 1] !== 0;
        if (column + 1 < width && coefficentsMagnitude[index + 1] !== 0) {
          sign1 = coefficentsSign[index + 1];
          if (significance1) {
            sign0 = coefficentsSign[index - 1];
            contribution = 1 - sign1 - sign0;
          } else {
            contribution = 1 - sign1 - sign1;
          }
        } else if (significance1) {
          sign0 = coefficentsSign[index - 1];
          contribution = 1 - sign0 - sign0;
        } else {
          contribution = 0;
        }
        const horizontalContribution = 3 * contribution;
        significance1 = row > 0 && coefficentsMagnitude[index - width] !== 0;
        if (row + 1 < height && coefficentsMagnitude[index + width] !== 0) {
          sign1 = coefficentsSign[index + width];
          if (significance1) {
            sign0 = coefficentsSign[index - width];
            contribution = 1 - sign1 - sign0 + horizontalContribution;
          } else {
            contribution = 1 - sign1 - sign1 + horizontalContribution;
          }
        } else if (significance1) {
          sign0 = coefficentsSign[index - width];
          contribution = 1 - sign0 - sign0 + horizontalContribution;
        } else {
          contribution = horizontalContribution;
        }
        if (contribution >= 0) {
          contextLabel = 9 + contribution;
          decoded = this.decoder.readBit(this.contexts, contextLabel);
        } else {
          contextLabel = 9 - contribution;
          decoded = this.decoder.readBit(this.contexts, contextLabel) ^ 1;
        }
        return decoded;
      }
      runMagnitudeRefinementPass() {
        const decoder = this.decoder;
        const width = this.width, height = this.height;
        const coefficentsMagnitude = this.coefficentsMagnitude;
        const neighborsSignificance = this.neighborsSignificance;
        const contexts = this.contexts;
        const bitsDecoded = this.bitsDecoded;
        const processingFlags = this.processingFlags;
        const processedMask = 1;
        const firstMagnitudeBitMask = 2;
        const length = width * height;
        const width4 = width * 4;
        for (let index0 = 0, indexNext; index0 < length; index0 = indexNext) {
          indexNext = Math.min(length, index0 + width4);
          for (let j = 0; j < width; j++) {
            for (let index = index0 + j; index < indexNext; index += width) {
              if (!coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) {
                continue;
              }
              let contextLabel = 16;
              if ((processingFlags[index] & firstMagnitudeBitMask) !== 0) {
                processingFlags[index] ^= firstMagnitudeBitMask;
                const significance = neighborsSignificance[index] & 127;
                contextLabel = significance === 0 ? 15 : 14;
              }
              const bit = decoder.readBit(contexts, contextLabel);
              coefficentsMagnitude[index] = coefficentsMagnitude[index] << 1 | bit;
              bitsDecoded[index]++;
              processingFlags[index] |= processedMask;
            }
          }
        }
      }
      runCleanupPass() {
        const decoder = this.decoder;
        const width = this.width, height = this.height;
        const neighborsSignificance = this.neighborsSignificance;
        const coefficentsMagnitude = this.coefficentsMagnitude;
        const coefficentsSign = this.coefficentsSign;
        const contexts = this.contexts;
        const labels = this.contextLabelTable;
        const bitsDecoded = this.bitsDecoded;
        const processingFlags = this.processingFlags;
        const processedMask = 1;
        const firstMagnitudeBitMask = 2;
        const oneRowDown = width;
        const twoRowsDown = width * 2;
        const threeRowsDown = width * 3;
        let iNext;
        for (let i0 = 0; i0 < height; i0 = iNext) {
          iNext = Math.min(i0 + 4, height);
          const indexBase = i0 * width;
          const checkAllEmpty = i0 + 3 < height;
          for (let j = 0; j < width; j++) {
            const index0 = indexBase + j;
            const allEmpty = checkAllEmpty && processingFlags[index0] === 0 && processingFlags[index0 + oneRowDown] === 0 && processingFlags[index0 + twoRowsDown] === 0 && processingFlags[index0 + threeRowsDown] === 0 && neighborsSignificance[index0] === 0 && neighborsSignificance[index0 + oneRowDown] === 0 && neighborsSignificance[index0 + twoRowsDown] === 0 && neighborsSignificance[index0 + threeRowsDown] === 0;
            let i1 = 0, index = index0;
            let i = i0, sign;
            if (allEmpty) {
              const hasSignificantCoefficent = decoder.readBit(
                contexts,
                RUNLENGTH_CONTEXT
              );
              if (!hasSignificantCoefficent) {
                bitsDecoded[index0]++;
                bitsDecoded[index0 + oneRowDown]++;
                bitsDecoded[index0 + twoRowsDown]++;
                bitsDecoded[index0 + threeRowsDown]++;
                continue;
              }
              i1 = decoder.readBit(contexts, UNIFORM_CONTEXT) << 1 | decoder.readBit(contexts, UNIFORM_CONTEXT);
              if (i1 !== 0) {
                i = i0 + i1;
                index += i1 * width;
              }
              sign = this.decodeSignBit(i, j, index);
              coefficentsSign[index] = sign;
              coefficentsMagnitude[index] = 1;
              this.setNeighborsSignificance(i, j, index);
              processingFlags[index] |= firstMagnitudeBitMask;
              index = index0;
              for (let i2 = i0; i2 <= i; i2++, index += width) {
                bitsDecoded[index]++;
              }
              i1++;
            }
            for (i = i0 + i1; i < iNext; i++, index += width) {
              if (coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) {
                continue;
              }
              const contextLabel = labels[neighborsSignificance[index]];
              const decision = decoder.readBit(contexts, contextLabel);
              if (decision === 1) {
                sign = this.decodeSignBit(i, j, index);
                coefficentsSign[index] = sign;
                coefficentsMagnitude[index] = 1;
                this.setNeighborsSignificance(i, j, index);
                processingFlags[index] |= firstMagnitudeBitMask;
              }
              bitsDecoded[index]++;
            }
          }
        }
      }
      checkSegmentationSymbol() {
        const decoder = this.decoder;
        const contexts = this.contexts;
        const symbol = decoder.readBit(contexts, UNIFORM_CONTEXT) << 3 | decoder.readBit(contexts, UNIFORM_CONTEXT) << 2 | decoder.readBit(contexts, UNIFORM_CONTEXT) << 1 | decoder.readBit(contexts, UNIFORM_CONTEXT);
        if (symbol !== 10) {
          throw new JpxError("Invalid segmentation symbol");
        }
      }
    }
    return BitModel2;
  })();
  var Transform = class _Transform {
    constructor() {
      if (this.constructor === _Transform) {
        unreachable("Cannot initialize Transform.");
      }
    }
    calculate(subbands, u0, v0) {
      let ll = subbands[0];
      for (let i = 1, ii = subbands.length; i < ii; i++) {
        ll = this.iterate(ll, subbands[i], u0, v0);
      }
      return ll;
    }
    extend(buffer, offset, size) {
      let i1 = offset - 1, j1 = offset + 1;
      let i2 = offset + size - 2, j2 = offset + size;
      buffer[i1--] = buffer[j1++];
      buffer[j2++] = buffer[i2--];
      buffer[i1--] = buffer[j1++];
      buffer[j2++] = buffer[i2--];
      buffer[i1--] = buffer[j1++];
      buffer[j2++] = buffer[i2--];
      buffer[i1] = buffer[j1];
      buffer[j2] = buffer[i2];
    }
    filter(x, offset, length) {
      unreachable("Abstract method `filter` called");
    }
    iterate(ll, hl_lh_hh, u0, v0) {
      const llWidth = ll.width, llHeight = ll.height;
      let llItems = ll.items;
      const width = hl_lh_hh.width;
      const height = hl_lh_hh.height;
      const items = hl_lh_hh.items;
      let i, j, k, l, u, v;
      for (k = 0, i = 0; i < llHeight; i++) {
        l = i * 2 * width;
        for (j = 0; j < llWidth; j++, k++, l += 2) {
          items[l] = llItems[k];
        }
      }
      llItems = ll.items = null;
      const bufferPadding = 4;
      const rowBuffer = new Float32Array(width + 2 * bufferPadding);
      if (width === 1) {
        if ((u0 & 1) !== 0) {
          for (v = 0, k = 0; v < height; v++, k += width) {
            items[k] *= 0.5;
          }
        }
      } else {
        for (v = 0, k = 0; v < height; v++, k += width) {
          rowBuffer.set(items.subarray(k, k + width), bufferPadding);
          this.extend(rowBuffer, bufferPadding, width);
          this.filter(rowBuffer, bufferPadding, width);
          items.set(rowBuffer.subarray(bufferPadding, bufferPadding + width), k);
        }
      }
      let numBuffers = 16;
      const colBuffers = [];
      for (i = 0; i < numBuffers; i++) {
        colBuffers.push(new Float32Array(height + 2 * bufferPadding));
      }
      let b, currentBuffer = 0;
      ll = bufferPadding + height;
      if (height === 1) {
        if ((v0 & 1) !== 0) {
          for (u = 0; u < width; u++) {
            items[u] *= 0.5;
          }
        }
      } else {
        for (u = 0; u < width; u++) {
          if (currentBuffer === 0) {
            numBuffers = Math.min(width - u, numBuffers);
            for (k = u, l = bufferPadding; l < ll; k += width, l++) {
              for (b = 0; b < numBuffers; b++) {
                colBuffers[b][l] = items[k + b];
              }
            }
            currentBuffer = numBuffers;
          }
          currentBuffer--;
          const buffer = colBuffers[currentBuffer];
          this.extend(buffer, bufferPadding, height);
          this.filter(buffer, bufferPadding, height);
          if (currentBuffer === 0) {
            k = u - numBuffers + 1;
            for (l = bufferPadding; l < ll; k += width, l++) {
              for (b = 0; b < numBuffers; b++) {
                items[k + b] = colBuffers[b][l];
              }
            }
          }
        }
      }
      return { width, height, items };
    }
  };
  var IrreversibleTransform = class extends Transform {
    filter(x, offset, length) {
      const len = length >> 1;
      offset |= 0;
      let j, n, current, next;
      const alpha = -1.586134342059924;
      const beta = -0.052980118572961;
      const gamma = 0.882911075530934;
      const delta = 0.443506852043971;
      const K = 1.230174104914001;
      const K_ = 1 / K;
      j = offset - 3;
      for (n = len + 4; n--; j += 2) {
        x[j] *= K_;
      }
      j = offset - 2;
      current = delta * x[j - 1];
      for (n = len + 3; n--; j += 2) {
        next = delta * x[j + 1];
        x[j] = K * x[j] - current - next;
        if (n--) {
          j += 2;
          current = delta * x[j + 1];
          x[j] = K * x[j] - current - next;
        } else {
          break;
        }
      }
      j = offset - 1;
      current = gamma * x[j - 1];
      for (n = len + 2; n--; j += 2) {
        next = gamma * x[j + 1];
        x[j] -= current + next;
        if (n--) {
          j += 2;
          current = gamma * x[j + 1];
          x[j] -= current + next;
        } else {
          break;
        }
      }
      j = offset;
      current = beta * x[j - 1];
      for (n = len + 1; n--; j += 2) {
        next = beta * x[j + 1];
        x[j] -= current + next;
        if (n--) {
          j += 2;
          current = beta * x[j + 1];
          x[j] -= current + next;
        } else {
          break;
        }
      }
      if (len !== 0) {
        j = offset + 1;
        current = alpha * x[j - 1];
        for (n = len; n--; j += 2) {
          next = alpha * x[j + 1];
          x[j] -= current + next;
          if (n--) {
            j += 2;
            current = alpha * x[j + 1];
            x[j] -= current + next;
          } else {
            break;
          }
        }
      }
    }
  };
  var ReversibleTransform = class extends Transform {
    filter(x, offset, length) {
      const len = length >> 1;
      offset |= 0;
      let j, n;
      for (j = offset, n = len + 1; n--; j += 2) {
        x[j] -= x[j - 1] + x[j + 1] + 2 >> 2;
      }
      for (j = offset + 1, n = len; n--; j += 2) {
        x[j] += x[j - 1] + x[j + 1] >> 1;
      }
    }
  };

  // ../../pdfjs/src/core/ccitt.js
  var ccittEOL = -2;
  var ccittEOF = -1;
  var twoDimPass = 0;
  var twoDimHoriz = 1;
  var twoDimVert0 = 2;
  var twoDimVertR1 = 3;
  var twoDimVertL1 = 4;
  var twoDimVertR2 = 5;
  var twoDimVertL2 = 6;
  var twoDimVertR3 = 7;
  var twoDimVertL3 = 8;
  var twoDimTable = [
    [-1, -1],
    [-1, -1],
    // 000000x
    [7, twoDimVertL3],
    // 0000010
    [7, twoDimVertR3],
    // 0000011
    [6, twoDimVertL2],
    [6, twoDimVertL2],
    // 000010x
    [6, twoDimVertR2],
    [6, twoDimVertR2],
    // 000011x
    [4, twoDimPass],
    [4, twoDimPass],
    // 0001xxx
    [4, twoDimPass],
    [4, twoDimPass],
    [4, twoDimPass],
    [4, twoDimPass],
    [4, twoDimPass],
    [4, twoDimPass],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    // 001xxxx
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimHoriz],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    // 010xxxx
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertL1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    // 011xxxx
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [3, twoDimVertR1],
    [1, twoDimVert0],
    [1, twoDimVert0],
    // 1xxxxxx
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0],
    [1, twoDimVert0]
  ];
  var whiteTable1 = [
    [-1, -1],
    // 00000
    [12, ccittEOL],
    // 00001
    [-1, -1],
    [-1, -1],
    // 0001x
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 001xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 010xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 011xx
    [11, 1792],
    [11, 1792],
    // 1000x
    [12, 1984],
    // 10010
    [12, 2048],
    // 10011
    [12, 2112],
    // 10100
    [12, 2176],
    // 10101
    [12, 2240],
    // 10110
    [12, 2304],
    // 10111
    [11, 1856],
    [11, 1856],
    // 1100x
    [11, 1920],
    [11, 1920],
    // 1101x
    [12, 2368],
    // 11100
    [12, 2432],
    // 11101
    [12, 2496],
    // 11110
    [12, 2560]
    // 11111
  ];
  var whiteTable2 = [
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 0000000xx
    [8, 29],
    [8, 29],
    // 00000010x
    [8, 30],
    [8, 30],
    // 00000011x
    [8, 45],
    [8, 45],
    // 00000100x
    [8, 46],
    [8, 46],
    // 00000101x
    [7, 22],
    [7, 22],
    [7, 22],
    [7, 22],
    // 0000011xx
    [7, 23],
    [7, 23],
    [7, 23],
    [7, 23],
    // 0000100xx
    [8, 47],
    [8, 47],
    // 00001010x
    [8, 48],
    [8, 48],
    // 00001011x
    [6, 13],
    [6, 13],
    [6, 13],
    [6, 13],
    // 000011xxx
    [6, 13],
    [6, 13],
    [6, 13],
    [6, 13],
    [7, 20],
    [7, 20],
    [7, 20],
    [7, 20],
    // 0001000xx
    [8, 33],
    [8, 33],
    // 00010010x
    [8, 34],
    [8, 34],
    // 00010011x
    [8, 35],
    [8, 35],
    // 00010100x
    [8, 36],
    [8, 36],
    // 00010101x
    [8, 37],
    [8, 37],
    // 00010110x
    [8, 38],
    [8, 38],
    // 00010111x
    [7, 19],
    [7, 19],
    [7, 19],
    [7, 19],
    // 0001100xx
    [8, 31],
    [8, 31],
    // 00011010x
    [8, 32],
    [8, 32],
    // 00011011x
    [6, 1],
    [6, 1],
    [6, 1],
    [6, 1],
    // 000111xxx
    [6, 1],
    [6, 1],
    [6, 1],
    [6, 1],
    [6, 12],
    [6, 12],
    [6, 12],
    [6, 12],
    // 001000xxx
    [6, 12],
    [6, 12],
    [6, 12],
    [6, 12],
    [8, 53],
    [8, 53],
    // 00100100x
    [8, 54],
    [8, 54],
    // 00100101x
    [7, 26],
    [7, 26],
    [7, 26],
    [7, 26],
    // 0010011xx
    [8, 39],
    [8, 39],
    // 00101000x
    [8, 40],
    [8, 40],
    // 00101001x
    [8, 41],
    [8, 41],
    // 00101010x
    [8, 42],
    [8, 42],
    // 00101011x
    [8, 43],
    [8, 43],
    // 00101100x
    [8, 44],
    [8, 44],
    // 00101101x
    [7, 21],
    [7, 21],
    [7, 21],
    [7, 21],
    // 0010111xx
    [7, 28],
    [7, 28],
    [7, 28],
    [7, 28],
    // 0011000xx
    [8, 61],
    [8, 61],
    // 00110010x
    [8, 62],
    [8, 62],
    // 00110011x
    [8, 63],
    [8, 63],
    // 00110100x
    [8, 0],
    [8, 0],
    // 00110101x
    [8, 320],
    [8, 320],
    // 00110110x
    [8, 384],
    [8, 384],
    // 00110111x
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    // 00111xxxx
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 10],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    // 01000xxxx
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [5, 11],
    [7, 27],
    [7, 27],
    [7, 27],
    [7, 27],
    // 0100100xx
    [8, 59],
    [8, 59],
    // 01001010x
    [8, 60],
    [8, 60],
    // 01001011x
    [9, 1472],
    // 010011000
    [9, 1536],
    // 010011001
    [9, 1600],
    // 010011010
    [9, 1728],
    // 010011011
    [7, 18],
    [7, 18],
    [7, 18],
    [7, 18],
    // 0100111xx
    [7, 24],
    [7, 24],
    [7, 24],
    [7, 24],
    // 0101000xx
    [8, 49],
    [8, 49],
    // 01010010x
    [8, 50],
    [8, 50],
    // 01010011x
    [8, 51],
    [8, 51],
    // 01010100x
    [8, 52],
    [8, 52],
    // 01010101x
    [7, 25],
    [7, 25],
    [7, 25],
    [7, 25],
    // 0101011xx
    [8, 55],
    [8, 55],
    // 01011000x
    [8, 56],
    [8, 56],
    // 01011001x
    [8, 57],
    [8, 57],
    // 01011010x
    [8, 58],
    [8, 58],
    // 01011011x
    [6, 192],
    [6, 192],
    [6, 192],
    [6, 192],
    // 010111xxx
    [6, 192],
    [6, 192],
    [6, 192],
    [6, 192],
    [6, 1664],
    [6, 1664],
    [6, 1664],
    [6, 1664],
    // 011000xxx
    [6, 1664],
    [6, 1664],
    [6, 1664],
    [6, 1664],
    [8, 448],
    [8, 448],
    // 01100100x
    [8, 512],
    [8, 512],
    // 01100101x
    [9, 704],
    // 011001100
    [9, 768],
    // 011001101
    [8, 640],
    [8, 640],
    // 01100111x
    [8, 576],
    [8, 576],
    // 01101000x
    [9, 832],
    // 011010010
    [9, 896],
    // 011010011
    [9, 960],
    // 011010100
    [9, 1024],
    // 011010101
    [9, 1088],
    // 011010110
    [9, 1152],
    // 011010111
    [9, 1216],
    // 011011000
    [9, 1280],
    // 011011001
    [9, 1344],
    // 011011010
    [9, 1408],
    // 011011011
    [7, 256],
    [7, 256],
    [7, 256],
    [7, 256],
    // 0110111xx
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    // 0111xxxxx
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 2],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    // 1000xxxxx
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [4, 3],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    // 10010xxxx
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 128],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    // 10011xxxx
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 8],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    // 10100xxxx
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [5, 9],
    [6, 16],
    [6, 16],
    [6, 16],
    [6, 16],
    // 101010xxx
    [6, 16],
    [6, 16],
    [6, 16],
    [6, 16],
    [6, 17],
    [6, 17],
    [6, 17],
    [6, 17],
    // 101011xxx
    [6, 17],
    [6, 17],
    [6, 17],
    [6, 17],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    // 1011xxxxx
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 4],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    // 1100xxxxx
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    [6, 14],
    [6, 14],
    [6, 14],
    [6, 14],
    // 110100xxx
    [6, 14],
    [6, 14],
    [6, 14],
    [6, 14],
    [6, 15],
    [6, 15],
    [6, 15],
    [6, 15],
    // 110101xxx
    [6, 15],
    [6, 15],
    [6, 15],
    [6, 15],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    // 11011xxxx
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [5, 64],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    // 1110xxxxx
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    // 1111xxxxx
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7],
    [4, 7]
  ];
  var blackTable1 = [
    [-1, -1],
    [-1, -1],
    // 000000000000x
    [12, ccittEOL],
    [12, ccittEOL],
    // 000000000001x
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 00000000001xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 00000000010xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 00000000011xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 00000000100xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 00000000101xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 00000000110xx
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 00000000111xx
    [11, 1792],
    [11, 1792],
    [11, 1792],
    [11, 1792],
    // 00000001000xx
    [12, 1984],
    [12, 1984],
    // 000000010010x
    [12, 2048],
    [12, 2048],
    // 000000010011x
    [12, 2112],
    [12, 2112],
    // 000000010100x
    [12, 2176],
    [12, 2176],
    // 000000010101x
    [12, 2240],
    [12, 2240],
    // 000000010110x
    [12, 2304],
    [12, 2304],
    // 000000010111x
    [11, 1856],
    [11, 1856],
    [11, 1856],
    [11, 1856],
    // 00000001100xx
    [11, 1920],
    [11, 1920],
    [11, 1920],
    [11, 1920],
    // 00000001101xx
    [12, 2368],
    [12, 2368],
    // 000000011100x
    [12, 2432],
    [12, 2432],
    // 000000011101x
    [12, 2496],
    [12, 2496],
    // 000000011110x
    [12, 2560],
    [12, 2560],
    // 000000011111x
    [10, 18],
    [10, 18],
    [10, 18],
    [10, 18],
    // 0000001000xxx
    [10, 18],
    [10, 18],
    [10, 18],
    [10, 18],
    [12, 52],
    [12, 52],
    // 000000100100x
    [13, 640],
    // 0000001001010
    [13, 704],
    // 0000001001011
    [13, 768],
    // 0000001001100
    [13, 832],
    // 0000001001101
    [12, 55],
    [12, 55],
    // 000000100111x
    [12, 56],
    [12, 56],
    // 000000101000x
    [13, 1280],
    // 0000001010010
    [13, 1344],
    // 0000001010011
    [13, 1408],
    // 0000001010100
    [13, 1472],
    // 0000001010101
    [12, 59],
    [12, 59],
    // 000000101011x
    [12, 60],
    [12, 60],
    // 000000101100x
    [13, 1536],
    // 0000001011010
    [13, 1600],
    // 0000001011011
    [11, 24],
    [11, 24],
    [11, 24],
    [11, 24],
    // 00000010111xx
    [11, 25],
    [11, 25],
    [11, 25],
    [11, 25],
    // 00000011000xx
    [13, 1664],
    // 0000001100100
    [13, 1728],
    // 0000001100101
    [12, 320],
    [12, 320],
    // 000000110011x
    [12, 384],
    [12, 384],
    // 000000110100x
    [12, 448],
    [12, 448],
    // 000000110101x
    [13, 512],
    // 0000001101100
    [13, 576],
    // 0000001101101
    [12, 53],
    [12, 53],
    // 000000110111x
    [12, 54],
    [12, 54],
    // 000000111000x
    [13, 896],
    // 0000001110010
    [13, 960],
    // 0000001110011
    [13, 1024],
    // 0000001110100
    [13, 1088],
    // 0000001110101
    [13, 1152],
    // 0000001110110
    [13, 1216],
    // 0000001110111
    [10, 64],
    [10, 64],
    [10, 64],
    [10, 64],
    // 0000001111xxx
    [10, 64],
    [10, 64],
    [10, 64],
    [10, 64]
  ];
  var blackTable2 = [
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    // 00000100xxxx
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [8, 13],
    [11, 23],
    [11, 23],
    // 00000101000x
    [12, 50],
    // 000001010010
    [12, 51],
    // 000001010011
    [12, 44],
    // 000001010100
    [12, 45],
    // 000001010101
    [12, 46],
    // 000001010110
    [12, 47],
    // 000001010111
    [12, 57],
    // 000001011000
    [12, 58],
    // 000001011001
    [12, 61],
    // 000001011010
    [12, 256],
    // 000001011011
    [10, 16],
    [10, 16],
    [10, 16],
    [10, 16],
    // 0000010111xx
    [10, 17],
    [10, 17],
    [10, 17],
    [10, 17],
    // 0000011000xx
    [12, 48],
    // 000001100100
    [12, 49],
    // 000001100101
    [12, 62],
    // 000001100110
    [12, 63],
    // 000001100111
    [12, 30],
    // 000001101000
    [12, 31],
    // 000001101001
    [12, 32],
    // 000001101010
    [12, 33],
    // 000001101011
    [12, 40],
    // 000001101100
    [12, 41],
    // 000001101101
    [11, 22],
    [11, 22],
    // 00000110111x
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    // 00000111xxxx
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [8, 14],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    // 0000100xxxxx
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 10],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    // 0000101xxxxx
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [7, 11],
    [9, 15],
    [9, 15],
    [9, 15],
    [9, 15],
    // 000011000xxx
    [9, 15],
    [9, 15],
    [9, 15],
    [9, 15],
    [12, 128],
    // 000011001000
    [12, 192],
    // 000011001001
    [12, 26],
    // 000011001010
    [12, 27],
    // 000011001011
    [12, 28],
    // 000011001100
    [12, 29],
    // 000011001101
    [11, 19],
    [11, 19],
    // 00001100111x
    [11, 20],
    [11, 20],
    // 00001101000x
    [12, 34],
    // 000011010010
    [12, 35],
    // 000011010011
    [12, 36],
    // 000011010100
    [12, 37],
    // 000011010101
    [12, 38],
    // 000011010110
    [12, 39],
    // 000011010111
    [11, 21],
    [11, 21],
    // 00001101100x
    [12, 42],
    // 000011011010
    [12, 43],
    // 000011011011
    [10, 0],
    [10, 0],
    [10, 0],
    [10, 0],
    // 0000110111xx
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    // 0000111xxxxx
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12],
    [7, 12]
  ];
  var blackTable3 = [
    [-1, -1],
    [-1, -1],
    [-1, -1],
    [-1, -1],
    // 0000xx
    [6, 9],
    // 000100
    [6, 8],
    // 000101
    [5, 7],
    [5, 7],
    // 00011x
    [4, 6],
    [4, 6],
    [4, 6],
    [4, 6],
    // 0010xx
    [4, 5],
    [4, 5],
    [4, 5],
    [4, 5],
    // 0011xx
    [3, 1],
    [3, 1],
    [3, 1],
    [3, 1],
    // 010xxx
    [3, 1],
    [3, 1],
    [3, 1],
    [3, 1],
    [3, 4],
    [3, 4],
    [3, 4],
    [3, 4],
    // 011xxx
    [3, 4],
    [3, 4],
    [3, 4],
    [3, 4],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    // 10xxxx
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 3],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    // 11xxxx
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2]
  ];
  var CCITTFaxDecoder = class {
    constructor(source, options = {}) {
      if (!source || typeof source.next !== "function") {
        throw new Error('CCITTFaxDecoder - invalid "source" parameter.');
      }
      this.source = source;
      this.eof = false;
      this.encoding = options.K || 0;
      this.eoline = options.EndOfLine || false;
      this.byteAlign = options.EncodedByteAlign || false;
      this.columns = options.Columns || 1728;
      this.rows = options.Rows || 0;
      let eoblock = options.EndOfBlock;
      if (eoblock === null || eoblock === void 0) {
        eoblock = true;
      }
      this.eoblock = eoblock;
      this.black = options.BlackIs1 || false;
      this.codingLine = new Uint32Array(this.columns + 1);
      this.refLine = new Uint32Array(this.columns + 2);
      this.codingLine[0] = this.columns;
      this.codingPos = 0;
      this.row = 0;
      this.nextLine2D = this.encoding < 0;
      this.inputBits = 0;
      this.inputBuf = 0;
      this.outputBits = 0;
      this.rowsDone = false;
      let code1;
      while ((code1 = this._lookBits(12)) === 0) {
        this._eatBits(1);
      }
      if (code1 === 1) {
        this._eatBits(12);
      }
      if (this.encoding > 0) {
        this.nextLine2D = !this._lookBits(1);
        this._eatBits(1);
      }
    }
    readNextChar() {
      if (this.eof) {
        return -1;
      }
      const refLine = this.refLine;
      const codingLine = this.codingLine;
      const columns = this.columns;
      let refPos, blackPixels, bits, i;
      if (this.outputBits === 0) {
        if (this.rowsDone) {
          this.eof = true;
        }
        if (this.eof) {
          return -1;
        }
        this.err = false;
        let code1, code2, code3;
        if (this.nextLine2D) {
          for (i = 0; codingLine[i] < columns; ++i) {
            refLine[i] = codingLine[i];
          }
          refLine[i++] = columns;
          refLine[i] = columns;
          codingLine[0] = 0;
          this.codingPos = 0;
          refPos = 0;
          blackPixels = 0;
          while (codingLine[this.codingPos] < columns) {
            code1 = this._getTwoDimCode();
            switch (code1) {
              case twoDimPass:
                this._addPixels(refLine[refPos + 1], blackPixels);
                if (refLine[refPos + 1] < columns) {
                  refPos += 2;
                }
                break;
              case twoDimHoriz:
                code1 = code2 = 0;
                if (blackPixels) {
                  do {
                    code1 += code3 = this._getBlackCode();
                  } while (code3 >= 64);
                  do {
                    code2 += code3 = this._getWhiteCode();
                  } while (code3 >= 64);
                } else {
                  do {
                    code1 += code3 = this._getWhiteCode();
                  } while (code3 >= 64);
                  do {
                    code2 += code3 = this._getBlackCode();
                  } while (code3 >= 64);
                }
                this._addPixels(codingLine[this.codingPos] + code1, blackPixels);
                if (codingLine[this.codingPos] < columns) {
                  this._addPixels(
                    codingLine[this.codingPos] + code2,
                    blackPixels ^ 1
                  );
                }
                while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                  refPos += 2;
                }
                break;
              case twoDimVertR3:
                this._addPixels(refLine[refPos] + 3, blackPixels);
                blackPixels ^= 1;
                if (codingLine[this.codingPos] < columns) {
                  ++refPos;
                  while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                    refPos += 2;
                  }
                }
                break;
              case twoDimVertR2:
                this._addPixels(refLine[refPos] + 2, blackPixels);
                blackPixels ^= 1;
                if (codingLine[this.codingPos] < columns) {
                  ++refPos;
                  while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                    refPos += 2;
                  }
                }
                break;
              case twoDimVertR1:
                this._addPixels(refLine[refPos] + 1, blackPixels);
                blackPixels ^= 1;
                if (codingLine[this.codingPos] < columns) {
                  ++refPos;
                  while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                    refPos += 2;
                  }
                }
                break;
              case twoDimVert0:
                this._addPixels(refLine[refPos], blackPixels);
                blackPixels ^= 1;
                if (codingLine[this.codingPos] < columns) {
                  ++refPos;
                  while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                    refPos += 2;
                  }
                }
                break;
              case twoDimVertL3:
                this._addPixelsNeg(refLine[refPos] - 3, blackPixels);
                blackPixels ^= 1;
                if (codingLine[this.codingPos] < columns) {
                  if (refPos > 0) {
                    --refPos;
                  } else {
                    ++refPos;
                  }
                  while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                    refPos += 2;
                  }
                }
                break;
              case twoDimVertL2:
                this._addPixelsNeg(refLine[refPos] - 2, blackPixels);
                blackPixels ^= 1;
                if (codingLine[this.codingPos] < columns) {
                  if (refPos > 0) {
                    --refPos;
                  } else {
                    ++refPos;
                  }
                  while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                    refPos += 2;
                  }
                }
                break;
              case twoDimVertL1:
                this._addPixelsNeg(refLine[refPos] - 1, blackPixels);
                blackPixels ^= 1;
                if (codingLine[this.codingPos] < columns) {
                  if (refPos > 0) {
                    --refPos;
                  } else {
                    ++refPos;
                  }
                  while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) {
                    refPos += 2;
                  }
                }
                break;
              case ccittEOF:
                this._addPixels(columns, 0);
                this.eof = true;
                break;
              default:
                info("bad 2d code");
                this._addPixels(columns, 0);
                this.err = true;
            }
          }
        } else {
          codingLine[0] = 0;
          this.codingPos = 0;
          blackPixels = 0;
          while (codingLine[this.codingPos] < columns) {
            code1 = 0;
            if (blackPixels) {
              do {
                code1 += code3 = this._getBlackCode();
              } while (code3 >= 64);
            } else {
              do {
                code1 += code3 = this._getWhiteCode();
              } while (code3 >= 64);
            }
            this._addPixels(codingLine[this.codingPos] + code1, blackPixels);
            blackPixels ^= 1;
          }
        }
        let gotEOL = false;
        if (this.byteAlign) {
          this.inputBits &= ~7;
        }
        if (!this.eoblock && this.row === this.rows - 1) {
          this.rowsDone = true;
        } else {
          code1 = this._lookBits(12);
          if (this.eoline) {
            while (code1 !== ccittEOF && code1 !== 1) {
              this._eatBits(1);
              code1 = this._lookBits(12);
            }
          } else {
            while (code1 === 0) {
              this._eatBits(1);
              code1 = this._lookBits(12);
            }
          }
          if (code1 === 1) {
            this._eatBits(12);
            gotEOL = true;
          } else if (code1 === ccittEOF) {
            this.eof = true;
          }
        }
        if (!this.eof && this.encoding > 0 && !this.rowsDone) {
          this.nextLine2D = !this._lookBits(1);
          this._eatBits(1);
        }
        if (this.eoblock && gotEOL && this.byteAlign) {
          code1 = this._lookBits(12);
          if (code1 === 1) {
            this._eatBits(12);
            if (this.encoding > 0) {
              this._lookBits(1);
              this._eatBits(1);
            }
            if (this.encoding >= 0) {
              for (i = 0; i < 4; ++i) {
                code1 = this._lookBits(12);
                if (code1 !== 1) {
                  info("bad rtc code: " + code1);
                }
                this._eatBits(12);
                if (this.encoding > 0) {
                  this._lookBits(1);
                  this._eatBits(1);
                }
              }
            }
            this.eof = true;
          }
        } else if (this.err && this.eoline) {
          while (true) {
            code1 = this._lookBits(13);
            if (code1 === ccittEOF) {
              this.eof = true;
              return -1;
            }
            if (code1 >> 1 === 1) {
              break;
            }
            this._eatBits(1);
          }
          this._eatBits(12);
          if (this.encoding > 0) {
            this._eatBits(1);
            this.nextLine2D = !(code1 & 1);
          }
        }
        if (codingLine[0] > 0) {
          this.outputBits = codingLine[this.codingPos = 0];
        } else {
          this.outputBits = codingLine[this.codingPos = 1];
        }
        this.row++;
      }
      let c;
      if (this.outputBits >= 8) {
        c = this.codingPos & 1 ? 0 : 255;
        this.outputBits -= 8;
        if (this.outputBits === 0 && codingLine[this.codingPos] < columns) {
          this.codingPos++;
          this.outputBits = codingLine[this.codingPos] - codingLine[this.codingPos - 1];
        }
      } else {
        bits = 8;
        c = 0;
        do {
          if (typeof this.outputBits !== "number") {
            throw new FormatError(
              'Invalid /CCITTFaxDecode data, "outputBits" must be a number.'
            );
          }
          if (this.outputBits > bits) {
            c <<= bits;
            if (!(this.codingPos & 1)) {
              c |= 255 >> 8 - bits;
            }
            this.outputBits -= bits;
            bits = 0;
          } else {
            c <<= this.outputBits;
            if (!(this.codingPos & 1)) {
              c |= 255 >> 8 - this.outputBits;
            }
            bits -= this.outputBits;
            this.outputBits = 0;
            if (codingLine[this.codingPos] < columns) {
              this.codingPos++;
              this.outputBits = codingLine[this.codingPos] - codingLine[this.codingPos - 1];
            } else if (bits > 0) {
              c <<= bits;
              bits = 0;
            }
          }
        } while (bits);
      }
      if (this.black) {
        c ^= 255;
      }
      return c;
    }
    /**
     * @private
     */
    _addPixels(a1, blackPixels) {
      const codingLine = this.codingLine;
      let codingPos = this.codingPos;
      if (a1 > codingLine[codingPos]) {
        if (a1 > this.columns) {
          info("row is wrong length");
          this.err = true;
          a1 = this.columns;
        }
        if (codingPos & 1 ^ blackPixels) {
          ++codingPos;
        }
        codingLine[codingPos] = a1;
      }
      this.codingPos = codingPos;
    }
    /**
     * @private
     */
    _addPixelsNeg(a1, blackPixels) {
      const codingLine = this.codingLine;
      let codingPos = this.codingPos;
      if (a1 > codingLine[codingPos]) {
        if (a1 > this.columns) {
          info("row is wrong length");
          this.err = true;
          a1 = this.columns;
        }
        if (codingPos & 1 ^ blackPixels) {
          ++codingPos;
        }
        codingLine[codingPos] = a1;
      } else if (a1 < codingLine[codingPos]) {
        if (a1 < 0) {
          info("invalid code");
          this.err = true;
          a1 = 0;
        }
        while (codingPos > 0 && a1 < codingLine[codingPos - 1]) {
          --codingPos;
        }
        codingLine[codingPos] = a1;
      }
      this.codingPos = codingPos;
    }
    /**
     * This function returns the code found from the table.
     * The start and end parameters set the boundaries for searching the table.
     * The limit parameter is optional. Function returns an array with three
     * values. The first array element indicates whether a valid code is being
     * returned. The second array element is the actual code. The third array
     * element indicates whether EOF was reached.
     * @private
     */
    _findTableCode(start, end, table, limit) {
      const limitValue = limit || 0;
      for (let i = start; i <= end; ++i) {
        let code = this._lookBits(i);
        if (code === ccittEOF) {
          return [true, 1, false];
        }
        if (i < end) {
          code <<= end - i;
        }
        if (!limitValue || code >= limitValue) {
          const p = table[code - limitValue];
          if (p[0] === i) {
            this._eatBits(i);
            return [true, p[1], true];
          }
        }
      }
      return [false, 0, false];
    }
    /**
     * @private
     */
    _getTwoDimCode() {
      let code = 0;
      let p;
      if (this.eoblock) {
        code = this._lookBits(7);
        p = twoDimTable[code];
        if (p && p[0] > 0) {
          this._eatBits(p[0]);
          return p[1];
        }
      } else {
        const result = this._findTableCode(1, 7, twoDimTable);
        if (result[0] && result[2]) {
          return result[1];
        }
      }
      info("Bad two dim code");
      return ccittEOF;
    }
    /**
     * @private
     */
    _getWhiteCode() {
      let code = 0;
      let p;
      if (this.eoblock) {
        code = this._lookBits(12);
        if (code === ccittEOF) {
          return 1;
        }
        if (code >> 5 === 0) {
          p = whiteTable1[code];
        } else {
          p = whiteTable2[code >> 3];
        }
        if (p[0] > 0) {
          this._eatBits(p[0]);
          return p[1];
        }
      } else {
        let result = this._findTableCode(1, 9, whiteTable2);
        if (result[0]) {
          return result[1];
        }
        result = this._findTableCode(11, 12, whiteTable1);
        if (result[0]) {
          return result[1];
        }
      }
      info("bad white code");
      this._eatBits(1);
      return 1;
    }
    /**
     * @private
     */
    _getBlackCode() {
      let code, p;
      if (this.eoblock) {
        code = this._lookBits(13);
        if (code === ccittEOF) {
          return 1;
        }
        if (code >> 7 === 0) {
          p = blackTable1[code];
        } else if (code >> 9 === 0 && code >> 7 !== 0) {
          p = blackTable2[(code >> 1) - 64];
        } else {
          p = blackTable3[code >> 7];
        }
        if (p[0] > 0) {
          this._eatBits(p[0]);
          return p[1];
        }
      } else {
        let result = this._findTableCode(2, 6, blackTable3);
        if (result[0]) {
          return result[1];
        }
        result = this._findTableCode(7, 12, blackTable2, 64);
        if (result[0]) {
          return result[1];
        }
        result = this._findTableCode(10, 13, blackTable1);
        if (result[0]) {
          return result[1];
        }
      }
      info("bad black code");
      this._eatBits(1);
      return 1;
    }
    /**
     * @private
     */
    _lookBits(n) {
      let c;
      while (this.inputBits < n) {
        if ((c = this.source.next()) === -1) {
          if (this.inputBits === 0) {
            return ccittEOF;
          }
          return this.inputBuf << n - this.inputBits & 65535 >> 16 - n;
        }
        this.inputBuf = this.inputBuf << 8 | c;
        this.inputBits += 8;
      }
      return this.inputBuf >> this.inputBits - n & 65535 >> 16 - n;
    }
    /**
     * @private
     */
    _eatBits(n) {
      if ((this.inputBits -= n) < 0) {
        this.inputBits = 0;
      }
    }
  };

  // ../../pdfjs/src/core/jbig2.js
  var Jbig2Error = class extends BaseException {
    constructor(msg) {
      super(`JBIG2 error: ${msg}`, "Jbig2Error");
    }
  };
  var ContextCache = class {
    getContexts(id) {
      if (id in this) {
        return this[id];
      }
      return this[id] = new Int8Array(1 << 16);
    }
  };
  var DecodingContext = class {
    constructor(data, start, end) {
      this.data = data;
      this.start = start;
      this.end = end;
    }
    get decoder() {
      const decoder = new ArithmeticDecoder(this.data, this.start, this.end);
      return shadow(this, "decoder", decoder);
    }
    get contextCache() {
      const cache = new ContextCache();
      return shadow(this, "contextCache", cache);
    }
  };
  function decodeInteger(contextCache, procedure, decoder) {
    const contexts = contextCache.getContexts(procedure);
    let prev = 1;
    function readBits(length) {
      let v = 0;
      for (let i = 0; i < length; i++) {
        const bit = decoder.readBit(contexts, prev);
        prev = prev < 256 ? prev << 1 | bit : (prev << 1 | bit) & 511 | 256;
        v = v << 1 | bit;
      }
      return v >>> 0;
    }
    const sign = readBits(1);
    const value = readBits(1) ? readBits(1) ? readBits(1) ? readBits(1) ? readBits(1) ? readBits(32) + 4436 : readBits(12) + 340 : readBits(8) + 84 : readBits(6) + 20 : readBits(4) + 4 : readBits(2);
    if (sign === 0) {
      return value;
    } else if (value > 0) {
      return -value;
    }
    return null;
  }
  function decodeIAID(contextCache, decoder, codeLength) {
    const contexts = contextCache.getContexts("IAID");
    let prev = 1;
    for (let i = 0; i < codeLength; i++) {
      const bit = decoder.readBit(contexts, prev);
      prev = prev << 1 | bit;
    }
    if (codeLength < 31) {
      return prev & (1 << codeLength) - 1;
    }
    return prev & 2147483647;
  }
  var SegmentTypes = [
    "SymbolDictionary",
    null,
    null,
    null,
    "IntermediateTextRegion",
    null,
    "ImmediateTextRegion",
    "ImmediateLosslessTextRegion",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "PatternDictionary",
    null,
    null,
    null,
    "IntermediateHalftoneRegion",
    null,
    "ImmediateHalftoneRegion",
    "ImmediateLosslessHalftoneRegion",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "IntermediateGenericRegion",
    null,
    "ImmediateGenericRegion",
    "ImmediateLosslessGenericRegion",
    "IntermediateGenericRefinementRegion",
    null,
    "ImmediateGenericRefinementRegion",
    "ImmediateLosslessGenericRefinementRegion",
    null,
    null,
    null,
    null,
    "PageInformation",
    "EndOfPage",
    "EndOfStripe",
    "EndOfFile",
    "Profiles",
    "Tables",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "Extension"
  ];
  var CodingTemplates = [
    [
      { x: -1, y: -2 },
      { x: 0, y: -2 },
      { x: 1, y: -2 },
      { x: -2, y: -1 },
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: 2, y: -1 },
      { x: -4, y: 0 },
      { x: -3, y: 0 },
      { x: -2, y: 0 },
      { x: -1, y: 0 }
    ],
    [
      { x: -1, y: -2 },
      { x: 0, y: -2 },
      { x: 1, y: -2 },
      { x: 2, y: -2 },
      { x: -2, y: -1 },
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: 2, y: -1 },
      { x: -3, y: 0 },
      { x: -2, y: 0 },
      { x: -1, y: 0 }
    ],
    [
      { x: -1, y: -2 },
      { x: 0, y: -2 },
      { x: 1, y: -2 },
      { x: -2, y: -1 },
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: -2, y: 0 },
      { x: -1, y: 0 }
    ],
    [
      { x: -3, y: -1 },
      { x: -2, y: -1 },
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: -4, y: 0 },
      { x: -3, y: 0 },
      { x: -2, y: 0 },
      { x: -1, y: 0 }
    ]
  ];
  var RefinementTemplates = [
    {
      coding: [
        { x: 0, y: -1 },
        { x: 1, y: -1 },
        { x: -1, y: 0 }
      ],
      reference: [
        { x: 0, y: -1 },
        { x: 1, y: -1 },
        { x: -1, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: -1, y: 1 },
        { x: 0, y: 1 },
        { x: 1, y: 1 }
      ]
    },
    {
      coding: [
        { x: -1, y: -1 },
        { x: 0, y: -1 },
        { x: 1, y: -1 },
        { x: -1, y: 0 }
      ],
      reference: [
        { x: 0, y: -1 },
        { x: -1, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 }
      ]
    }
  ];
  var ReusedContexts = [
    39717,
    // 10011 0110010 0101
    1941,
    // 0011 110010 101
    229,
    // 001 11001 01
    405
    // 011001 0101
  ];
  var RefinementReusedContexts = [
    32,
    // '000' + '0' (coding) + '00010000' + '0' (reference)
    8
    // '0000' + '001000'
  ];
  function decodeBitmapTemplate0(width, height, decodingContext) {
    const decoder = decodingContext.decoder;
    const contexts = decodingContext.contextCache.getContexts("GB");
    const bitmap = [];
    let contextLabel, i, j, pixel, row, row1, row2;
    const OLD_PIXEL_MASK = 31735;
    for (i = 0; i < height; i++) {
      row = bitmap[i] = new Uint8Array(width);
      row1 = i < 1 ? row : bitmap[i - 1];
      row2 = i < 2 ? row : bitmap[i - 2];
      contextLabel = row2[0] << 13 | row2[1] << 12 | row2[2] << 11 | row1[0] << 7 | row1[1] << 6 | row1[2] << 5 | row1[3] << 4;
      for (j = 0; j < width; j++) {
        row[j] = pixel = decoder.readBit(contexts, contextLabel);
        contextLabel = (contextLabel & OLD_PIXEL_MASK) << 1 | (j + 3 < width ? row2[j + 3] << 11 : 0) | (j + 4 < width ? row1[j + 4] << 4 : 0) | pixel;
      }
    }
    return bitmap;
  }
  function decodeBitmap(mmr, width, height, templateIndex, prediction, skip, at, decodingContext) {
    if (mmr) {
      const input = new Reader(
        decodingContext.data,
        decodingContext.start,
        decodingContext.end
      );
      return decodeMMRBitmap(input, width, height, false);
    }
    if (templateIndex === 0 && !skip && !prediction && at.length === 4 && at[0].x === 3 && at[0].y === -1 && at[1].x === -3 && at[1].y === -1 && at[2].x === 2 && at[2].y === -2 && at[3].x === -2 && at[3].y === -2) {
      return decodeBitmapTemplate0(width, height, decodingContext);
    }
    const useskip = !!skip;
    const template = CodingTemplates[templateIndex].concat(at);
    template.sort(function(a, b) {
      return a.y - b.y || a.x - b.x;
    });
    const templateLength = template.length;
    const templateX = new Int8Array(templateLength);
    const templateY = new Int8Array(templateLength);
    const changingTemplateEntries = [];
    let reuseMask = 0, minX = 0, maxX = 0, minY = 0;
    let c, k;
    for (k = 0; k < templateLength; k++) {
      templateX[k] = template[k].x;
      templateY[k] = template[k].y;
      minX = Math.min(minX, template[k].x);
      maxX = Math.max(maxX, template[k].x);
      minY = Math.min(minY, template[k].y);
      if (k < templateLength - 1 && template[k].y === template[k + 1].y && template[k].x === template[k + 1].x - 1) {
        reuseMask |= 1 << templateLength - 1 - k;
      } else {
        changingTemplateEntries.push(k);
      }
    }
    const changingEntriesLength = changingTemplateEntries.length;
    const changingTemplateX = new Int8Array(changingEntriesLength);
    const changingTemplateY = new Int8Array(changingEntriesLength);
    const changingTemplateBit = new Uint16Array(changingEntriesLength);
    for (c = 0; c < changingEntriesLength; c++) {
      k = changingTemplateEntries[c];
      changingTemplateX[c] = template[k].x;
      changingTemplateY[c] = template[k].y;
      changingTemplateBit[c] = 1 << templateLength - 1 - k;
    }
    const sbb_left = -minX;
    const sbb_top = -minY;
    const sbb_right = width - maxX;
    const pseudoPixelContext = ReusedContexts[templateIndex];
    let row = new Uint8Array(width);
    const bitmap = [];
    const decoder = decodingContext.decoder;
    const contexts = decodingContext.contextCache.getContexts("GB");
    let ltp = 0, j, i0, j0, contextLabel = 0, bit, shift;
    for (let i = 0; i < height; i++) {
      if (prediction) {
        const sltp = decoder.readBit(contexts, pseudoPixelContext);
        ltp ^= sltp;
        if (ltp) {
          bitmap.push(row);
          continue;
        }
      }
      row = new Uint8Array(row);
      bitmap.push(row);
      for (j = 0; j < width; j++) {
        if (useskip && skip[i][j]) {
          row[j] = 0;
          continue;
        }
        if (j >= sbb_left && j < sbb_right && i >= sbb_top) {
          contextLabel = contextLabel << 1 & reuseMask;
          for (k = 0; k < changingEntriesLength; k++) {
            i0 = i + changingTemplateY[k];
            j0 = j + changingTemplateX[k];
            bit = bitmap[i0][j0];
            if (bit) {
              bit = changingTemplateBit[k];
              contextLabel |= bit;
            }
          }
        } else {
          contextLabel = 0;
          shift = templateLength - 1;
          for (k = 0; k < templateLength; k++, shift--) {
            j0 = j + templateX[k];
            if (j0 >= 0 && j0 < width) {
              i0 = i + templateY[k];
              if (i0 >= 0) {
                bit = bitmap[i0][j0];
                if (bit) {
                  contextLabel |= bit << shift;
                }
              }
            }
          }
        }
        const pixel = decoder.readBit(contexts, contextLabel);
        row[j] = pixel;
      }
    }
    return bitmap;
  }
  function decodeRefinement(width, height, templateIndex, referenceBitmap, offsetX, offsetY, prediction, at, decodingContext) {
    let codingTemplate = RefinementTemplates[templateIndex].coding;
    if (templateIndex === 0) {
      codingTemplate = codingTemplate.concat([at[0]]);
    }
    const codingTemplateLength = codingTemplate.length;
    const codingTemplateX = new Int32Array(codingTemplateLength);
    const codingTemplateY = new Int32Array(codingTemplateLength);
    let k;
    for (k = 0; k < codingTemplateLength; k++) {
      codingTemplateX[k] = codingTemplate[k].x;
      codingTemplateY[k] = codingTemplate[k].y;
    }
    let referenceTemplate = RefinementTemplates[templateIndex].reference;
    if (templateIndex === 0) {
      referenceTemplate = referenceTemplate.concat([at[1]]);
    }
    const referenceTemplateLength = referenceTemplate.length;
    const referenceTemplateX = new Int32Array(referenceTemplateLength);
    const referenceTemplateY = new Int32Array(referenceTemplateLength);
    for (k = 0; k < referenceTemplateLength; k++) {
      referenceTemplateX[k] = referenceTemplate[k].x;
      referenceTemplateY[k] = referenceTemplate[k].y;
    }
    const referenceWidth = referenceBitmap[0].length;
    const referenceHeight = referenceBitmap.length;
    const pseudoPixelContext = RefinementReusedContexts[templateIndex];
    const bitmap = [];
    const decoder = decodingContext.decoder;
    const contexts = decodingContext.contextCache.getContexts("GR");
    let ltp = 0;
    for (let i = 0; i < height; i++) {
      if (prediction) {
        const sltp = decoder.readBit(contexts, pseudoPixelContext);
        ltp ^= sltp;
        if (ltp) {
          throw new Jbig2Error("prediction is not supported");
        }
      }
      const row = new Uint8Array(width);
      bitmap.push(row);
      for (let j = 0; j < width; j++) {
        let i0, j0;
        let contextLabel = 0;
        for (k = 0; k < codingTemplateLength; k++) {
          i0 = i + codingTemplateY[k];
          j0 = j + codingTemplateX[k];
          if (i0 < 0 || j0 < 0 || j0 >= width) {
            contextLabel <<= 1;
          } else {
            contextLabel = contextLabel << 1 | bitmap[i0][j0];
          }
        }
        for (k = 0; k < referenceTemplateLength; k++) {
          i0 = i + referenceTemplateY[k] - offsetY;
          j0 = j + referenceTemplateX[k] - offsetX;
          if (i0 < 0 || i0 >= referenceHeight || j0 < 0 || j0 >= referenceWidth) {
            contextLabel <<= 1;
          } else {
            contextLabel = contextLabel << 1 | referenceBitmap[i0][j0];
          }
        }
        const pixel = decoder.readBit(contexts, contextLabel);
        row[j] = pixel;
      }
    }
    return bitmap;
  }
  function decodeSymbolDictionary(huffman, refinement, symbols, numberOfNewSymbols, numberOfExportedSymbols, huffmanTables, templateIndex, at, refinementTemplateIndex, refinementAt, decodingContext, huffmanInput) {
    if (huffman && refinement) {
      throw new Jbig2Error("symbol refinement with Huffman is not supported");
    }
    const newSymbols = [];
    let currentHeight = 0;
    let symbolCodeLength = log2(symbols.length + numberOfNewSymbols);
    const decoder = decodingContext.decoder;
    const contextCache = decodingContext.contextCache;
    let tableB1, symbolWidths;
    if (huffman) {
      tableB1 = getStandardTable(1);
      symbolWidths = [];
      symbolCodeLength = Math.max(symbolCodeLength, 1);
    }
    while (newSymbols.length < numberOfNewSymbols) {
      const deltaHeight = huffman ? huffmanTables.tableDeltaHeight.decode(huffmanInput) : decodeInteger(contextCache, "IADH", decoder);
      currentHeight += deltaHeight;
      let currentWidth = 0, totalWidth = 0;
      const firstSymbol = huffman ? symbolWidths.length : 0;
      while (true) {
        const deltaWidth = huffman ? huffmanTables.tableDeltaWidth.decode(huffmanInput) : decodeInteger(contextCache, "IADW", decoder);
        if (deltaWidth === null) {
          break;
        }
        currentWidth += deltaWidth;
        totalWidth += currentWidth;
        let bitmap;
        if (refinement) {
          const numberOfInstances = decodeInteger(contextCache, "IAAI", decoder);
          if (numberOfInstances > 1) {
            bitmap = decodeTextRegion(
              huffman,
              refinement,
              currentWidth,
              currentHeight,
              0,
              numberOfInstances,
              1,
              // strip size
              symbols.concat(newSymbols),
              symbolCodeLength,
              0,
              // transposed
              0,
              // ds offset
              1,
              // top left 7.4.3.1.1
              0,
              // OR operator
              huffmanTables,
              refinementTemplateIndex,
              refinementAt,
              decodingContext,
              0,
              huffmanInput
            );
          } else {
            const symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
            const rdx = decodeInteger(contextCache, "IARDX", decoder);
            const rdy = decodeInteger(contextCache, "IARDY", decoder);
            const symbol = symbolId < symbols.length ? symbols[symbolId] : newSymbols[symbolId - symbols.length];
            bitmap = decodeRefinement(
              currentWidth,
              currentHeight,
              refinementTemplateIndex,
              symbol,
              rdx,
              rdy,
              false,
              refinementAt,
              decodingContext
            );
          }
          newSymbols.push(bitmap);
        } else if (huffman) {
          symbolWidths.push(currentWidth);
        } else {
          bitmap = decodeBitmap(
            false,
            currentWidth,
            currentHeight,
            templateIndex,
            false,
            null,
            at,
            decodingContext
          );
          newSymbols.push(bitmap);
        }
      }
      if (huffman && !refinement) {
        const bitmapSize = huffmanTables.tableBitmapSize.decode(huffmanInput);
        huffmanInput.byteAlign();
        let collectiveBitmap;
        if (bitmapSize === 0) {
          collectiveBitmap = readUncompressedBitmap(
            huffmanInput,
            totalWidth,
            currentHeight
          );
        } else {
          const originalEnd = huffmanInput.end;
          const bitmapEnd = huffmanInput.position + bitmapSize;
          huffmanInput.end = bitmapEnd;
          collectiveBitmap = decodeMMRBitmap(
            huffmanInput,
            totalWidth,
            currentHeight,
            false
          );
          huffmanInput.end = originalEnd;
          huffmanInput.position = bitmapEnd;
        }
        const numberOfSymbolsDecoded = symbolWidths.length;
        if (firstSymbol === numberOfSymbolsDecoded - 1) {
          newSymbols.push(collectiveBitmap);
        } else {
          let i2, y, xMin = 0, xMax, bitmapWidth, symbolBitmap;
          for (i2 = firstSymbol; i2 < numberOfSymbolsDecoded; i2++) {
            bitmapWidth = symbolWidths[i2];
            xMax = xMin + bitmapWidth;
            symbolBitmap = [];
            for (y = 0; y < currentHeight; y++) {
              symbolBitmap.push(collectiveBitmap[y].subarray(xMin, xMax));
            }
            newSymbols.push(symbolBitmap);
            xMin = xMax;
          }
        }
      }
    }
    const exportedSymbols = [], flags = [];
    let currentFlag = false, i, ii;
    const totalSymbolsLength = symbols.length + numberOfNewSymbols;
    while (flags.length < totalSymbolsLength) {
      let runLength = huffman ? tableB1.decode(huffmanInput) : decodeInteger(contextCache, "IAEX", decoder);
      while (runLength--) {
        flags.push(currentFlag);
      }
      currentFlag = !currentFlag;
    }
    for (i = 0, ii = symbols.length; i < ii; i++) {
      if (flags[i]) {
        exportedSymbols.push(symbols[i]);
      }
    }
    for (let j = 0; j < numberOfNewSymbols; i++, j++) {
      if (flags[i]) {
        exportedSymbols.push(newSymbols[j]);
      }
    }
    return exportedSymbols;
  }
  function decodeTextRegion(huffman, refinement, width, height, defaultPixelValue, numberOfSymbolInstances, stripSize, inputSymbols, symbolCodeLength, transposed, dsOffset, referenceCorner, combinationOperator, huffmanTables, refinementTemplateIndex, refinementAt, decodingContext, logStripSize, huffmanInput) {
    if (huffman && refinement) {
      throw new Jbig2Error("refinement with Huffman is not supported");
    }
    const bitmap = [];
    let i, row;
    for (i = 0; i < height; i++) {
      row = new Uint8Array(width);
      if (defaultPixelValue) {
        for (let j = 0; j < width; j++) {
          row[j] = defaultPixelValue;
        }
      }
      bitmap.push(row);
    }
    const decoder = decodingContext.decoder;
    const contextCache = decodingContext.contextCache;
    let stripT = huffman ? -huffmanTables.tableDeltaT.decode(huffmanInput) : -decodeInteger(contextCache, "IADT", decoder);
    let firstS = 0;
    i = 0;
    while (i < numberOfSymbolInstances) {
      const deltaT = huffman ? huffmanTables.tableDeltaT.decode(huffmanInput) : decodeInteger(contextCache, "IADT", decoder);
      stripT += deltaT;
      const deltaFirstS = huffman ? huffmanTables.tableFirstS.decode(huffmanInput) : decodeInteger(contextCache, "IAFS", decoder);
      firstS += deltaFirstS;
      let currentS = firstS;
      do {
        let currentT = 0;
        if (stripSize > 1) {
          currentT = huffman ? huffmanInput.readBits(logStripSize) : decodeInteger(contextCache, "IAIT", decoder);
        }
        const t = stripSize * stripT + currentT;
        const symbolId = huffman ? huffmanTables.symbolIDTable.decode(huffmanInput) : decodeIAID(contextCache, decoder, symbolCodeLength);
        const applyRefinement = refinement && (huffman ? huffmanInput.readBit() : decodeInteger(contextCache, "IARI", decoder));
        let symbolBitmap = inputSymbols[symbolId];
        let symbolWidth = symbolBitmap[0].length;
        let symbolHeight = symbolBitmap.length;
        if (applyRefinement) {
          const rdw = decodeInteger(contextCache, "IARDW", decoder);
          const rdh = decodeInteger(contextCache, "IARDH", decoder);
          const rdx = decodeInteger(contextCache, "IARDX", decoder);
          const rdy = decodeInteger(contextCache, "IARDY", decoder);
          symbolWidth += rdw;
          symbolHeight += rdh;
          symbolBitmap = decodeRefinement(
            symbolWidth,
            symbolHeight,
            refinementTemplateIndex,
            symbolBitmap,
            (rdw >> 1) + rdx,
            (rdh >> 1) + rdy,
            false,
            refinementAt,
            decodingContext
          );
        }
        const offsetT = t - (referenceCorner & 1 ? 0 : symbolHeight - 1);
        const offsetS = currentS - (referenceCorner & 2 ? symbolWidth - 1 : 0);
        let s2, t2, symbolRow;
        if (transposed) {
          for (s2 = 0; s2 < symbolHeight; s2++) {
            row = bitmap[offsetS + s2];
            if (!row) {
              continue;
            }
            symbolRow = symbolBitmap[s2];
            const maxWidth = Math.min(width - offsetT, symbolWidth);
            switch (combinationOperator) {
              case 0:
                for (t2 = 0; t2 < maxWidth; t2++) {
                  row[offsetT + t2] |= symbolRow[t2];
                }
                break;
              case 2:
                for (t2 = 0; t2 < maxWidth; t2++) {
                  row[offsetT + t2] ^= symbolRow[t2];
                }
                break;
              default:
                throw new Jbig2Error(
                  `operator ${combinationOperator} is not supported`
                );
            }
          }
          currentS += symbolHeight - 1;
        } else {
          for (t2 = 0; t2 < symbolHeight; t2++) {
            row = bitmap[offsetT + t2];
            if (!row) {
              continue;
            }
            symbolRow = symbolBitmap[t2];
            switch (combinationOperator) {
              case 0:
                for (s2 = 0; s2 < symbolWidth; s2++) {
                  row[offsetS + s2] |= symbolRow[s2];
                }
                break;
              case 2:
                for (s2 = 0; s2 < symbolWidth; s2++) {
                  row[offsetS + s2] ^= symbolRow[s2];
                }
                break;
              default:
                throw new Jbig2Error(
                  `operator ${combinationOperator} is not supported`
                );
            }
          }
          currentS += symbolWidth - 1;
        }
        i++;
        const deltaS = huffman ? huffmanTables.tableDeltaS.decode(huffmanInput) : decodeInteger(contextCache, "IADS", decoder);
        if (deltaS === null) {
          break;
        }
        currentS += deltaS + dsOffset;
      } while (true);
    }
    return bitmap;
  }
  function decodePatternDictionary(mmr, patternWidth, patternHeight, maxPatternIndex, template, decodingContext) {
    const at = [];
    if (!mmr) {
      at.push({
        x: -patternWidth,
        y: 0
      });
      if (template === 0) {
        at.push(
          {
            x: -3,
            y: -1
          },
          {
            x: 2,
            y: -2
          },
          {
            x: -2,
            y: -2
          }
        );
      }
    }
    const collectiveWidth = (maxPatternIndex + 1) * patternWidth;
    const collectiveBitmap = decodeBitmap(
      mmr,
      collectiveWidth,
      patternHeight,
      template,
      false,
      null,
      at,
      decodingContext
    );
    const patterns = [];
    for (let i = 0; i <= maxPatternIndex; i++) {
      const patternBitmap = [];
      const xMin = patternWidth * i;
      const xMax = xMin + patternWidth;
      for (let y = 0; y < patternHeight; y++) {
        patternBitmap.push(collectiveBitmap[y].subarray(xMin, xMax));
      }
      patterns.push(patternBitmap);
    }
    return patterns;
  }
  function decodeHalftoneRegion(mmr, patterns, template, regionWidth, regionHeight, defaultPixelValue, enableSkip, combinationOperator, gridWidth, gridHeight, gridOffsetX, gridOffsetY, gridVectorX, gridVectorY, decodingContext) {
    const skip = null;
    if (enableSkip) {
      throw new Jbig2Error("skip is not supported");
    }
    if (combinationOperator !== 0) {
      throw new Jbig2Error(
        `operator "${combinationOperator}" is not supported in halftone region`
      );
    }
    const regionBitmap = [];
    let i, j, row;
    for (i = 0; i < regionHeight; i++) {
      row = new Uint8Array(regionWidth);
      if (defaultPixelValue) {
        for (j = 0; j < regionWidth; j++) {
          row[j] = defaultPixelValue;
        }
      }
      regionBitmap.push(row);
    }
    const numberOfPatterns = patterns.length;
    const pattern0 = patterns[0];
    const patternWidth = pattern0[0].length, patternHeight = pattern0.length;
    const bitsPerValue = log2(numberOfPatterns);
    const at = [];
    if (!mmr) {
      at.push({
        x: template <= 1 ? 3 : 2,
        y: -1
      });
      if (template === 0) {
        at.push(
          {
            x: -3,
            y: -1
          },
          {
            x: 2,
            y: -2
          },
          {
            x: -2,
            y: -2
          }
        );
      }
    }
    const grayScaleBitPlanes = [];
    let mmrInput, bitmap;
    if (mmr) {
      mmrInput = new Reader(
        decodingContext.data,
        decodingContext.start,
        decodingContext.end
      );
    }
    for (i = bitsPerValue - 1; i >= 0; i--) {
      if (mmr) {
        bitmap = decodeMMRBitmap(mmrInput, gridWidth, gridHeight, true);
      } else {
        bitmap = decodeBitmap(
          false,
          gridWidth,
          gridHeight,
          template,
          false,
          skip,
          at,
          decodingContext
        );
      }
      grayScaleBitPlanes[i] = bitmap;
    }
    let mg, ng, bit, patternIndex, patternBitmap, x, y, patternRow, regionRow;
    for (mg = 0; mg < gridHeight; mg++) {
      for (ng = 0; ng < gridWidth; ng++) {
        bit = 0;
        patternIndex = 0;
        for (j = bitsPerValue - 1; j >= 0; j--) {
          bit ^= grayScaleBitPlanes[j][mg][ng];
          patternIndex |= bit << j;
        }
        patternBitmap = patterns[patternIndex];
        x = gridOffsetX + mg * gridVectorY + ng * gridVectorX >> 8;
        y = gridOffsetY + mg * gridVectorX - ng * gridVectorY >> 8;
        if (x >= 0 && x + patternWidth <= regionWidth && y >= 0 && y + patternHeight <= regionHeight) {
          for (i = 0; i < patternHeight; i++) {
            regionRow = regionBitmap[y + i];
            patternRow = patternBitmap[i];
            for (j = 0; j < patternWidth; j++) {
              regionRow[x + j] |= patternRow[j];
            }
          }
        } else {
          let regionX, regionY;
          for (i = 0; i < patternHeight; i++) {
            regionY = y + i;
            if (regionY < 0 || regionY >= regionHeight) {
              continue;
            }
            regionRow = regionBitmap[regionY];
            patternRow = patternBitmap[i];
            for (j = 0; j < patternWidth; j++) {
              regionX = x + j;
              if (regionX >= 0 && regionX < regionWidth) {
                regionRow[regionX] |= patternRow[j];
              }
            }
          }
        }
      }
    }
    return regionBitmap;
  }
  function readSegmentHeader(data, start) {
    const segmentHeader = {};
    segmentHeader.number = readUint32(data, start);
    const flags = data[start + 4];
    const segmentType = flags & 63;
    if (!SegmentTypes[segmentType]) {
      throw new Jbig2Error("invalid segment type: " + segmentType);
    }
    segmentHeader.type = segmentType;
    segmentHeader.typeName = SegmentTypes[segmentType];
    segmentHeader.deferredNonRetain = !!(flags & 128);
    const pageAssociationFieldSize = !!(flags & 64);
    const referredFlags = data[start + 5];
    let referredToCount = referredFlags >> 5 & 7;
    const retainBits = [referredFlags & 31];
    let position = start + 6;
    if (referredFlags === 7) {
      referredToCount = readUint32(data, position - 1) & 536870911;
      position += 3;
      let bytes = referredToCount + 7 >> 3;
      retainBits[0] = data[position++];
      while (--bytes > 0) {
        retainBits.push(data[position++]);
      }
    } else if (referredFlags === 5 || referredFlags === 6) {
      throw new Jbig2Error("invalid referred-to flags");
    }
    segmentHeader.retainBits = retainBits;
    let referredToSegmentNumberSize = 4;
    if (segmentHeader.number <= 256) {
      referredToSegmentNumberSize = 1;
    } else if (segmentHeader.number <= 65536) {
      referredToSegmentNumberSize = 2;
    }
    const referredTo = [];
    let i, ii;
    for (i = 0; i < referredToCount; i++) {
      let number;
      if (referredToSegmentNumberSize === 1) {
        number = data[position];
      } else if (referredToSegmentNumberSize === 2) {
        number = readUint16(data, position);
      } else {
        number = readUint32(data, position);
      }
      referredTo.push(number);
      position += referredToSegmentNumberSize;
    }
    segmentHeader.referredTo = referredTo;
    if (!pageAssociationFieldSize) {
      segmentHeader.pageAssociation = data[position++];
    } else {
      segmentHeader.pageAssociation = readUint32(data, position);
      position += 4;
    }
    segmentHeader.length = readUint32(data, position);
    position += 4;
    if (segmentHeader.length === 4294967295) {
      if (segmentType === 38) {
        const genericRegionInfo = readRegionSegmentInformation(data, position);
        const genericRegionSegmentFlags = data[position + RegionSegmentInformationFieldLength];
        const genericRegionMmr = !!(genericRegionSegmentFlags & 1);
        const searchPatternLength = 6;
        const searchPattern = new Uint8Array(searchPatternLength);
        if (!genericRegionMmr) {
          searchPattern[0] = 255;
          searchPattern[1] = 172;
        }
        searchPattern[2] = genericRegionInfo.height >>> 24 & 255;
        searchPattern[3] = genericRegionInfo.height >> 16 & 255;
        searchPattern[4] = genericRegionInfo.height >> 8 & 255;
        searchPattern[5] = genericRegionInfo.height & 255;
        for (i = position, ii = data.length; i < ii; i++) {
          let j = 0;
          while (j < searchPatternLength && searchPattern[j] === data[i + j]) {
            j++;
          }
          if (j === searchPatternLength) {
            segmentHeader.length = i + searchPatternLength;
            break;
          }
        }
        if (segmentHeader.length === 4294967295) {
          throw new Jbig2Error("segment end was not found");
        }
      } else {
        throw new Jbig2Error("invalid unknown segment length");
      }
    }
    segmentHeader.headerEnd = position;
    return segmentHeader;
  }
  function readSegments(header, data, start, end) {
    const segments = [];
    let position = start;
    while (position < end) {
      const segmentHeader = readSegmentHeader(data, position);
      position = segmentHeader.headerEnd;
      const segment = {
        header: segmentHeader,
        data
      };
      if (!header.randomAccess) {
        segment.start = position;
        position += segmentHeader.length;
        segment.end = position;
      }
      segments.push(segment);
      if (segmentHeader.type === 51) {
        break;
      }
    }
    if (header.randomAccess) {
      for (let i = 0, ii = segments.length; i < ii; i++) {
        segments[i].start = position;
        position += segments[i].header.length;
        segments[i].end = position;
      }
    }
    return segments;
  }
  function readRegionSegmentInformation(data, start) {
    return {
      width: readUint32(data, start),
      height: readUint32(data, start + 4),
      x: readUint32(data, start + 8),
      y: readUint32(data, start + 12),
      combinationOperator: data[start + 16] & 7
    };
  }
  var RegionSegmentInformationFieldLength = 17;
  function processSegment(segment, visitor) {
    const header = segment.header;
    const data = segment.data, end = segment.end;
    let position = segment.start;
    let args, at, i, atLength;
    switch (header.type) {
      case 0:
        const dictionary = {};
        const dictionaryFlags = readUint16(data, position);
        dictionary.huffman = !!(dictionaryFlags & 1);
        dictionary.refinement = !!(dictionaryFlags & 2);
        dictionary.huffmanDHSelector = dictionaryFlags >> 2 & 3;
        dictionary.huffmanDWSelector = dictionaryFlags >> 4 & 3;
        dictionary.bitmapSizeSelector = dictionaryFlags >> 6 & 1;
        dictionary.aggregationInstancesSelector = dictionaryFlags >> 7 & 1;
        dictionary.bitmapCodingContextUsed = !!(dictionaryFlags & 256);
        dictionary.bitmapCodingContextRetained = !!(dictionaryFlags & 512);
        dictionary.template = dictionaryFlags >> 10 & 3;
        dictionary.refinementTemplate = dictionaryFlags >> 12 & 1;
        position += 2;
        if (!dictionary.huffman) {
          atLength = dictionary.template === 0 ? 4 : 1;
          at = [];
          for (i = 0; i < atLength; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          dictionary.at = at;
        }
        if (dictionary.refinement && !dictionary.refinementTemplate) {
          at = [];
          for (i = 0; i < 2; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          dictionary.refinementAt = at;
        }
        dictionary.numberOfExportedSymbols = readUint32(data, position);
        position += 4;
        dictionary.numberOfNewSymbols = readUint32(data, position);
        position += 4;
        args = [
          dictionary,
          header.number,
          header.referredTo,
          data,
          position,
          end
        ];
        break;
      case 6:
      // ImmediateTextRegion
      case 7:
        const textRegion = {};
        textRegion.info = readRegionSegmentInformation(data, position);
        position += RegionSegmentInformationFieldLength;
        const textRegionSegmentFlags = readUint16(data, position);
        position += 2;
        textRegion.huffman = !!(textRegionSegmentFlags & 1);
        textRegion.refinement = !!(textRegionSegmentFlags & 2);
        textRegion.logStripSize = textRegionSegmentFlags >> 2 & 3;
        textRegion.stripSize = 1 << textRegion.logStripSize;
        textRegion.referenceCorner = textRegionSegmentFlags >> 4 & 3;
        textRegion.transposed = !!(textRegionSegmentFlags & 64);
        textRegion.combinationOperator = textRegionSegmentFlags >> 7 & 3;
        textRegion.defaultPixelValue = textRegionSegmentFlags >> 9 & 1;
        textRegion.dsOffset = textRegionSegmentFlags << 17 >> 27;
        textRegion.refinementTemplate = textRegionSegmentFlags >> 15 & 1;
        if (textRegion.huffman) {
          const textRegionHuffmanFlags = readUint16(data, position);
          position += 2;
          textRegion.huffmanFS = textRegionHuffmanFlags & 3;
          textRegion.huffmanDS = textRegionHuffmanFlags >> 2 & 3;
          textRegion.huffmanDT = textRegionHuffmanFlags >> 4 & 3;
          textRegion.huffmanRefinementDW = textRegionHuffmanFlags >> 6 & 3;
          textRegion.huffmanRefinementDH = textRegionHuffmanFlags >> 8 & 3;
          textRegion.huffmanRefinementDX = textRegionHuffmanFlags >> 10 & 3;
          textRegion.huffmanRefinementDY = textRegionHuffmanFlags >> 12 & 3;
          textRegion.huffmanRefinementSizeSelector = !!(textRegionHuffmanFlags & 16384);
        }
        if (textRegion.refinement && !textRegion.refinementTemplate) {
          at = [];
          for (i = 0; i < 2; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          textRegion.refinementAt = at;
        }
        textRegion.numberOfSymbolInstances = readUint32(data, position);
        position += 4;
        args = [textRegion, header.referredTo, data, position, end];
        break;
      case 16:
        const patternDictionary = {};
        const patternDictionaryFlags = data[position++];
        patternDictionary.mmr = !!(patternDictionaryFlags & 1);
        patternDictionary.template = patternDictionaryFlags >> 1 & 3;
        patternDictionary.patternWidth = data[position++];
        patternDictionary.patternHeight = data[position++];
        patternDictionary.maxPatternIndex = readUint32(data, position);
        position += 4;
        args = [patternDictionary, header.number, data, position, end];
        break;
      case 22:
      // ImmediateHalftoneRegion
      case 23:
        const halftoneRegion = {};
        halftoneRegion.info = readRegionSegmentInformation(data, position);
        position += RegionSegmentInformationFieldLength;
        const halftoneRegionFlags = data[position++];
        halftoneRegion.mmr = !!(halftoneRegionFlags & 1);
        halftoneRegion.template = halftoneRegionFlags >> 1 & 3;
        halftoneRegion.enableSkip = !!(halftoneRegionFlags & 8);
        halftoneRegion.combinationOperator = halftoneRegionFlags >> 4 & 7;
        halftoneRegion.defaultPixelValue = halftoneRegionFlags >> 7 & 1;
        halftoneRegion.gridWidth = readUint32(data, position);
        position += 4;
        halftoneRegion.gridHeight = readUint32(data, position);
        position += 4;
        halftoneRegion.gridOffsetX = readUint32(data, position) & 4294967295;
        position += 4;
        halftoneRegion.gridOffsetY = readUint32(data, position) & 4294967295;
        position += 4;
        halftoneRegion.gridVectorX = readUint16(data, position);
        position += 2;
        halftoneRegion.gridVectorY = readUint16(data, position);
        position += 2;
        args = [halftoneRegion, header.referredTo, data, position, end];
        break;
      case 38:
      // ImmediateGenericRegion
      case 39:
        const genericRegion = {};
        genericRegion.info = readRegionSegmentInformation(data, position);
        position += RegionSegmentInformationFieldLength;
        const genericRegionSegmentFlags = data[position++];
        genericRegion.mmr = !!(genericRegionSegmentFlags & 1);
        genericRegion.template = genericRegionSegmentFlags >> 1 & 3;
        genericRegion.prediction = !!(genericRegionSegmentFlags & 8);
        if (!genericRegion.mmr) {
          atLength = genericRegion.template === 0 ? 4 : 1;
          at = [];
          for (i = 0; i < atLength; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          genericRegion.at = at;
        }
        args = [genericRegion, data, position, end];
        break;
      case 48:
        const pageInfo = {
          width: readUint32(data, position),
          height: readUint32(data, position + 4),
          resolutionX: readUint32(data, position + 8),
          resolutionY: readUint32(data, position + 12)
        };
        if (pageInfo.height === 4294967295) {
          delete pageInfo.height;
        }
        const pageSegmentFlags = data[position + 16];
        readUint16(data, position + 17);
        pageInfo.lossless = !!(pageSegmentFlags & 1);
        pageInfo.refinement = !!(pageSegmentFlags & 2);
        pageInfo.defaultPixelValue = pageSegmentFlags >> 2 & 1;
        pageInfo.combinationOperator = pageSegmentFlags >> 3 & 3;
        pageInfo.requiresBuffer = !!(pageSegmentFlags & 32);
        pageInfo.combinationOperatorOverride = !!(pageSegmentFlags & 64);
        args = [pageInfo];
        break;
      case 49:
        break;
      case 50:
        break;
      case 51:
        break;
      case 53:
        args = [header.number, data, position, end];
        break;
      case 62:
        break;
      default:
        throw new Jbig2Error(
          `segment type ${header.typeName}(${header.type}) is not implemented`
        );
    }
    const callbackName = "on" + header.typeName;
    if (callbackName in visitor) {
      visitor[callbackName].apply(visitor, args);
    }
  }
  function processSegments(segments, visitor) {
    for (let i = 0, ii = segments.length; i < ii; i++) {
      processSegment(segments[i], visitor);
    }
  }
  function parseJbig2Chunks(chunks) {
    const visitor = new SimpleSegmentVisitor();
    for (let i = 0, ii = chunks.length; i < ii; i++) {
      const chunk = chunks[i];
      const segments = readSegments({}, chunk.data, chunk.start, chunk.end);
      processSegments(segments, visitor);
    }
    return visitor.buffer;
  }
  function parseJbig2(data) {
    if (typeof PDFJSDev === "undefined" || !PDFJSDev.test("IMAGE_DECODERS")) {
      throw new Error("Not implemented: parseJbig2");
    }
    const end = data.length;
    let position = 0;
    if (data[position] !== 151 || data[position + 1] !== 74 || data[position + 2] !== 66 || data[position + 3] !== 50 || data[position + 4] !== 13 || data[position + 5] !== 10 || data[position + 6] !== 26 || data[position + 7] !== 10) {
      throw new Jbig2Error("parseJbig2 - invalid header.");
    }
    const header = /* @__PURE__ */ Object.create(null);
    position += 8;
    const flags = data[position++];
    header.randomAccess = !(flags & 1);
    if (!(flags & 2)) {
      header.numberOfPages = readUint32(data, position);
      position += 4;
    }
    const segments = readSegments(header, data, position, end);
    const visitor = new SimpleSegmentVisitor();
    processSegments(segments, visitor);
    const { width, height } = visitor.currentPageInfo;
    const bitPacked = visitor.buffer;
    const imgData = new Uint8ClampedArray(width * height);
    let q = 0, k = 0;
    for (let i = 0; i < height; i++) {
      let mask = 0, buffer;
      for (let j = 0; j < width; j++) {
        if (!mask) {
          mask = 128;
          buffer = bitPacked[k++];
        }
        imgData[q++] = buffer & mask ? 0 : 255;
        mask >>= 1;
      }
    }
    return { imgData, width, height };
  }
  var SimpleSegmentVisitor = class {
    onPageInformation(info2) {
      this.currentPageInfo = info2;
      const rowSize = info2.width + 7 >> 3;
      const buffer = new Uint8ClampedArray(rowSize * info2.height);
      if (info2.defaultPixelValue) {
        buffer.fill(255);
      }
      this.buffer = buffer;
    }
    drawBitmap(regionInfo, bitmap) {
      const pageInfo = this.currentPageInfo;
      const width = regionInfo.width, height = regionInfo.height;
      const rowSize = pageInfo.width + 7 >> 3;
      const combinationOperator = pageInfo.combinationOperatorOverride ? regionInfo.combinationOperator : pageInfo.combinationOperator;
      const buffer = this.buffer;
      const mask0 = 128 >> (regionInfo.x & 7);
      let offset0 = regionInfo.y * rowSize + (regionInfo.x >> 3);
      let i, j, mask, offset;
      switch (combinationOperator) {
        case 0:
          for (i = 0; i < height; i++) {
            mask = mask0;
            offset = offset0;
            for (j = 0; j < width; j++) {
              if (bitmap[i][j]) {
                buffer[offset] |= mask;
              }
              mask >>= 1;
              if (!mask) {
                mask = 128;
                offset++;
              }
            }
            offset0 += rowSize;
          }
          break;
        case 2:
          for (i = 0; i < height; i++) {
            mask = mask0;
            offset = offset0;
            for (j = 0; j < width; j++) {
              if (bitmap[i][j]) {
                buffer[offset] ^= mask;
              }
              mask >>= 1;
              if (!mask) {
                mask = 128;
                offset++;
              }
            }
            offset0 += rowSize;
          }
          break;
        default:
          throw new Jbig2Error(
            `operator ${combinationOperator} is not supported`
          );
      }
    }
    onImmediateGenericRegion(region, data, start, end) {
      const regionInfo = region.info;
      const decodingContext = new DecodingContext(data, start, end);
      const bitmap = decodeBitmap(
        region.mmr,
        regionInfo.width,
        regionInfo.height,
        region.template,
        region.prediction,
        null,
        region.at,
        decodingContext
      );
      this.drawBitmap(regionInfo, bitmap);
    }
    onImmediateLosslessGenericRegion() {
      this.onImmediateGenericRegion(...arguments);
    }
    onSymbolDictionary(dictionary, currentSegment, referredSegments, data, start, end) {
      let huffmanTables, huffmanInput;
      if (dictionary.huffman) {
        huffmanTables = getSymbolDictionaryHuffmanTables(
          dictionary,
          referredSegments,
          this.customTables
        );
        huffmanInput = new Reader(data, start, end);
      }
      let symbols = this.symbols;
      if (!symbols) {
        this.symbols = symbols = {};
      }
      const inputSymbols = [];
      for (const referredSegment of referredSegments) {
        const referredSymbols = symbols[referredSegment];
        if (referredSymbols) {
          inputSymbols.push(...referredSymbols);
        }
      }
      const decodingContext = new DecodingContext(data, start, end);
      symbols[currentSegment] = decodeSymbolDictionary(
        dictionary.huffman,
        dictionary.refinement,
        inputSymbols,
        dictionary.numberOfNewSymbols,
        dictionary.numberOfExportedSymbols,
        huffmanTables,
        dictionary.template,
        dictionary.at,
        dictionary.refinementTemplate,
        dictionary.refinementAt,
        decodingContext,
        huffmanInput
      );
    }
    onImmediateTextRegion(region, referredSegments, data, start, end) {
      const regionInfo = region.info;
      let huffmanTables, huffmanInput;
      const symbols = this.symbols;
      const inputSymbols = [];
      for (const referredSegment of referredSegments) {
        const referredSymbols = symbols[referredSegment];
        if (referredSymbols) {
          inputSymbols.push(...referredSymbols);
        }
      }
      const symbolCodeLength = log2(inputSymbols.length);
      if (region.huffman) {
        huffmanInput = new Reader(data, start, end);
        huffmanTables = getTextRegionHuffmanTables(
          region,
          referredSegments,
          this.customTables,
          inputSymbols.length,
          huffmanInput
        );
      }
      const decodingContext = new DecodingContext(data, start, end);
      const bitmap = decodeTextRegion(
        region.huffman,
        region.refinement,
        regionInfo.width,
        regionInfo.height,
        region.defaultPixelValue,
        region.numberOfSymbolInstances,
        region.stripSize,
        inputSymbols,
        symbolCodeLength,
        region.transposed,
        region.dsOffset,
        region.referenceCorner,
        region.combinationOperator,
        huffmanTables,
        region.refinementTemplate,
        region.refinementAt,
        decodingContext,
        region.logStripSize,
        huffmanInput
      );
      this.drawBitmap(regionInfo, bitmap);
    }
    onImmediateLosslessTextRegion() {
      this.onImmediateTextRegion(...arguments);
    }
    onPatternDictionary(dictionary, currentSegment, data, start, end) {
      let patterns = this.patterns;
      if (!patterns) {
        this.patterns = patterns = {};
      }
      const decodingContext = new DecodingContext(data, start, end);
      patterns[currentSegment] = decodePatternDictionary(
        dictionary.mmr,
        dictionary.patternWidth,
        dictionary.patternHeight,
        dictionary.maxPatternIndex,
        dictionary.template,
        decodingContext
      );
    }
    onImmediateHalftoneRegion(region, referredSegments, data, start, end) {
      const patterns = this.patterns[referredSegments[0]];
      const regionInfo = region.info;
      const decodingContext = new DecodingContext(data, start, end);
      const bitmap = decodeHalftoneRegion(
        region.mmr,
        patterns,
        region.template,
        regionInfo.width,
        regionInfo.height,
        region.defaultPixelValue,
        region.enableSkip,
        region.combinationOperator,
        region.gridWidth,
        region.gridHeight,
        region.gridOffsetX,
        region.gridOffsetY,
        region.gridVectorX,
        region.gridVectorY,
        decodingContext
      );
      this.drawBitmap(regionInfo, bitmap);
    }
    onImmediateLosslessHalftoneRegion() {
      this.onImmediateHalftoneRegion(...arguments);
    }
    onTables(currentSegment, data, start, end) {
      let customTables = this.customTables;
      if (!customTables) {
        this.customTables = customTables = {};
      }
      customTables[currentSegment] = decodeTablesSegment(data, start, end);
    }
  };
  var HuffmanLine = class {
    constructor(lineData) {
      if (lineData.length === 2) {
        this.isOOB = true;
        this.rangeLow = 0;
        this.prefixLength = lineData[0];
        this.rangeLength = 0;
        this.prefixCode = lineData[1];
        this.isLowerRange = false;
      } else {
        this.isOOB = false;
        this.rangeLow = lineData[0];
        this.prefixLength = lineData[1];
        this.rangeLength = lineData[2];
        this.prefixCode = lineData[3];
        this.isLowerRange = lineData[4] === "lower";
      }
    }
  };
  var HuffmanTreeNode = class _HuffmanTreeNode {
    constructor(line) {
      this.children = [];
      if (line) {
        this.isLeaf = true;
        this.rangeLength = line.rangeLength;
        this.rangeLow = line.rangeLow;
        this.isLowerRange = line.isLowerRange;
        this.isOOB = line.isOOB;
      } else {
        this.isLeaf = false;
      }
    }
    buildTree(line, shift) {
      const bit = line.prefixCode >> shift & 1;
      if (shift <= 0) {
        this.children[bit] = new _HuffmanTreeNode(line);
      } else {
        let node = this.children[bit];
        if (!node) {
          this.children[bit] = node = new _HuffmanTreeNode(null);
        }
        node.buildTree(line, shift - 1);
      }
    }
    decodeNode(reader) {
      if (this.isLeaf) {
        if (this.isOOB) {
          return null;
        }
        const htOffset = reader.readBits(this.rangeLength);
        return this.rangeLow + (this.isLowerRange ? -htOffset : htOffset);
      }
      const node = this.children[reader.readBit()];
      if (!node) {
        throw new Jbig2Error("invalid Huffman data");
      }
      return node.decodeNode(reader);
    }
  };
  var HuffmanTable = class {
    constructor(lines, prefixCodesDone) {
      if (!prefixCodesDone) {
        this.assignPrefixCodes(lines);
      }
      this.rootNode = new HuffmanTreeNode(null);
      for (let i = 0, ii = lines.length; i < ii; i++) {
        const line = lines[i];
        if (line.prefixLength > 0) {
          this.rootNode.buildTree(line, line.prefixLength - 1);
        }
      }
    }
    decode(reader) {
      return this.rootNode.decodeNode(reader);
    }
    assignPrefixCodes(lines) {
      const linesLength = lines.length;
      let prefixLengthMax = 0;
      for (let i = 0; i < linesLength; i++) {
        prefixLengthMax = Math.max(prefixLengthMax, lines[i].prefixLength);
      }
      const histogram = new Uint32Array(prefixLengthMax + 1);
      for (let i = 0; i < linesLength; i++) {
        histogram[lines[i].prefixLength]++;
      }
      let currentLength = 1, firstCode = 0, currentCode, currentTemp, line;
      histogram[0] = 0;
      while (currentLength <= prefixLengthMax) {
        firstCode = firstCode + histogram[currentLength - 1] << 1;
        currentCode = firstCode;
        currentTemp = 0;
        while (currentTemp < linesLength) {
          line = lines[currentTemp];
          if (line.prefixLength === currentLength) {
            line.prefixCode = currentCode;
            currentCode++;
          }
          currentTemp++;
        }
        currentLength++;
      }
    }
  };
  function decodeTablesSegment(data, start, end) {
    const flags = data[start];
    const lowestValue = readUint32(data, start + 1) & 4294967295;
    const highestValue = readUint32(data, start + 5) & 4294967295;
    const reader = new Reader(data, start + 9, end);
    const prefixSizeBits = (flags >> 1 & 7) + 1;
    const rangeSizeBits = (flags >> 4 & 7) + 1;
    const lines = [];
    let prefixLength, rangeLength, currentRangeLow = lowestValue;
    do {
      prefixLength = reader.readBits(prefixSizeBits);
      rangeLength = reader.readBits(rangeSizeBits);
      lines.push(
        new HuffmanLine([currentRangeLow, prefixLength, rangeLength, 0])
      );
      currentRangeLow += 1 << rangeLength;
    } while (currentRangeLow < highestValue);
    prefixLength = reader.readBits(prefixSizeBits);
    lines.push(new HuffmanLine([lowestValue - 1, prefixLength, 32, 0, "lower"]));
    prefixLength = reader.readBits(prefixSizeBits);
    lines.push(new HuffmanLine([highestValue, prefixLength, 32, 0]));
    if (flags & 1) {
      prefixLength = reader.readBits(prefixSizeBits);
      lines.push(new HuffmanLine([prefixLength, 0]));
    }
    return new HuffmanTable(lines, false);
  }
  var standardTablesCache = {};
  function getStandardTable(number) {
    let table = standardTablesCache[number];
    if (table) {
      return table;
    }
    let lines;
    switch (number) {
      case 1:
        lines = [
          [0, 1, 4, 0],
          [16, 2, 8, 2],
          [272, 3, 16, 6],
          [65808, 3, 32, 7]
          // upper
        ];
        break;
      case 2:
        lines = [
          [0, 1, 0, 0],
          [1, 2, 0, 2],
          [2, 3, 0, 6],
          [3, 4, 3, 14],
          [11, 5, 6, 30],
          [75, 6, 32, 62],
          // upper
          [6, 63]
          // OOB
        ];
        break;
      case 3:
        lines = [
          [-256, 8, 8, 254],
          [0, 1, 0, 0],
          [1, 2, 0, 2],
          [2, 3, 0, 6],
          [3, 4, 3, 14],
          [11, 5, 6, 30],
          [-257, 8, 32, 255, "lower"],
          [75, 7, 32, 126],
          // upper
          [6, 62]
          // OOB
        ];
        break;
      case 4:
        lines = [
          [1, 1, 0, 0],
          [2, 2, 0, 2],
          [3, 3, 0, 6],
          [4, 4, 3, 14],
          [12, 5, 6, 30],
          [76, 5, 32, 31]
          // upper
        ];
        break;
      case 5:
        lines = [
          [-255, 7, 8, 126],
          [1, 1, 0, 0],
          [2, 2, 0, 2],
          [3, 3, 0, 6],
          [4, 4, 3, 14],
          [12, 5, 6, 30],
          [-256, 7, 32, 127, "lower"],
          [76, 6, 32, 62]
          // upper
        ];
        break;
      case 6:
        lines = [
          [-2048, 5, 10, 28],
          [-1024, 4, 9, 8],
          [-512, 4, 8, 9],
          [-256, 4, 7, 10],
          [-128, 5, 6, 29],
          [-64, 5, 5, 30],
          [-32, 4, 5, 11],
          [0, 2, 7, 0],
          [128, 3, 7, 2],
          [256, 3, 8, 3],
          [512, 4, 9, 12],
          [1024, 4, 10, 13],
          [-2049, 6, 32, 62, "lower"],
          [2048, 6, 32, 63]
          // upper
        ];
        break;
      case 7:
        lines = [
          [-1024, 4, 9, 8],
          [-512, 3, 8, 0],
          [-256, 4, 7, 9],
          [-128, 5, 6, 26],
          [-64, 5, 5, 27],
          [-32, 4, 5, 10],
          [0, 4, 5, 11],
          [32, 5, 5, 28],
          [64, 5, 6, 29],
          [128, 4, 7, 12],
          [256, 3, 8, 1],
          [512, 3, 9, 2],
          [1024, 3, 10, 3],
          [-1025, 5, 32, 30, "lower"],
          [2048, 5, 32, 31]
          // upper
        ];
        break;
      case 8:
        lines = [
          [-15, 8, 3, 252],
          [-7, 9, 1, 508],
          [-5, 8, 1, 253],
          [-3, 9, 0, 509],
          [-2, 7, 0, 124],
          [-1, 4, 0, 10],
          [0, 2, 1, 0],
          [2, 5, 0, 26],
          [3, 6, 0, 58],
          [4, 3, 4, 4],
          [20, 6, 1, 59],
          [22, 4, 4, 11],
          [38, 4, 5, 12],
          [70, 5, 6, 27],
          [134, 5, 7, 28],
          [262, 6, 7, 60],
          [390, 7, 8, 125],
          [646, 6, 10, 61],
          [-16, 9, 32, 510, "lower"],
          [1670, 9, 32, 511],
          // upper
          [2, 1]
          // OOB
        ];
        break;
      case 9:
        lines = [
          [-31, 8, 4, 252],
          [-15, 9, 2, 508],
          [-11, 8, 2, 253],
          [-7, 9, 1, 509],
          [-5, 7, 1, 124],
          [-3, 4, 1, 10],
          [-1, 3, 1, 2],
          [1, 3, 1, 3],
          [3, 5, 1, 26],
          [5, 6, 1, 58],
          [7, 3, 5, 4],
          [39, 6, 2, 59],
          [43, 4, 5, 11],
          [75, 4, 6, 12],
          [139, 5, 7, 27],
          [267, 5, 8, 28],
          [523, 6, 8, 60],
          [779, 7, 9, 125],
          [1291, 6, 11, 61],
          [-32, 9, 32, 510, "lower"],
          [3339, 9, 32, 511],
          // upper
          [2, 0]
          // OOB
        ];
        break;
      case 10:
        lines = [
          [-21, 7, 4, 122],
          [-5, 8, 0, 252],
          [-4, 7, 0, 123],
          [-3, 5, 0, 24],
          [-2, 2, 2, 0],
          [2, 5, 0, 25],
          [3, 6, 0, 54],
          [4, 7, 0, 124],
          [5, 8, 0, 253],
          [6, 2, 6, 1],
          [70, 5, 5, 26],
          [102, 6, 5, 55],
          [134, 6, 6, 56],
          [198, 6, 7, 57],
          [326, 6, 8, 58],
          [582, 6, 9, 59],
          [1094, 6, 10, 60],
          [2118, 7, 11, 125],
          [-22, 8, 32, 254, "lower"],
          [4166, 8, 32, 255],
          // upper
          [2, 2]
          // OOB
        ];
        break;
      case 11:
        lines = [
          [1, 1, 0, 0],
          [2, 2, 1, 2],
          [4, 4, 0, 12],
          [5, 4, 1, 13],
          [7, 5, 1, 28],
          [9, 5, 2, 29],
          [13, 6, 2, 60],
          [17, 7, 2, 122],
          [21, 7, 3, 123],
          [29, 7, 4, 124],
          [45, 7, 5, 125],
          [77, 7, 6, 126],
          [141, 7, 32, 127]
          // upper
        ];
        break;
      case 12:
        lines = [
          [1, 1, 0, 0],
          [2, 2, 0, 2],
          [3, 3, 1, 6],
          [5, 5, 0, 28],
          [6, 5, 1, 29],
          [8, 6, 1, 60],
          [10, 7, 0, 122],
          [11, 7, 1, 123],
          [13, 7, 2, 124],
          [17, 7, 3, 125],
          [25, 7, 4, 126],
          [41, 8, 5, 254],
          [73, 8, 32, 255]
          // upper
        ];
        break;
      case 13:
        lines = [
          [1, 1, 0, 0],
          [2, 3, 0, 4],
          [3, 4, 0, 12],
          [4, 5, 0, 28],
          [5, 4, 1, 13],
          [7, 3, 3, 5],
          [15, 6, 1, 58],
          [17, 6, 2, 59],
          [21, 6, 3, 60],
          [29, 6, 4, 61],
          [45, 6, 5, 62],
          [77, 7, 6, 126],
          [141, 7, 32, 127]
          // upper
        ];
        break;
      case 14:
        lines = [
          [-2, 3, 0, 4],
          [-1, 3, 0, 5],
          [0, 1, 0, 0],
          [1, 3, 0, 6],
          [2, 3, 0, 7]
        ];
        break;
      case 15:
        lines = [
          [-24, 7, 4, 124],
          [-8, 6, 2, 60],
          [-4, 5, 1, 28],
          [-2, 4, 0, 12],
          [-1, 3, 0, 4],
          [0, 1, 0, 0],
          [1, 3, 0, 5],
          [2, 4, 0, 13],
          [3, 5, 1, 29],
          [5, 6, 2, 61],
          [9, 7, 4, 125],
          [-25, 7, 32, 126, "lower"],
          [25, 7, 32, 127]
          // upper
        ];
        break;
      default:
        throw new Jbig2Error(`standard table B.${number} does not exist`);
    }
    for (let i = 0, ii = lines.length; i < ii; i++) {
      lines[i] = new HuffmanLine(lines[i]);
    }
    table = new HuffmanTable(lines, true);
    standardTablesCache[number] = table;
    return table;
  }
  var Reader = class {
    constructor(data, start, end) {
      this.data = data;
      this.start = start;
      this.end = end;
      this.position = start;
      this.shift = -1;
      this.currentByte = 0;
    }
    readBit() {
      if (this.shift < 0) {
        if (this.position >= this.end) {
          throw new Jbig2Error("end of data while reading bit");
        }
        this.currentByte = this.data[this.position++];
        this.shift = 7;
      }
      const bit = this.currentByte >> this.shift & 1;
      this.shift--;
      return bit;
    }
    readBits(numBits) {
      let result = 0, i;
      for (i = numBits - 1; i >= 0; i--) {
        result |= this.readBit() << i;
      }
      return result;
    }
    byteAlign() {
      this.shift = -1;
    }
    next() {
      if (this.position >= this.end) {
        return -1;
      }
      return this.data[this.position++];
    }
  };
  function getCustomHuffmanTable(index, referredTo, customTables) {
    let currentIndex = 0;
    for (let i = 0, ii = referredTo.length; i < ii; i++) {
      const table = customTables[referredTo[i]];
      if (table) {
        if (index === currentIndex) {
          return table;
        }
        currentIndex++;
      }
    }
    throw new Jbig2Error("can't find custom Huffman table");
  }
  function getTextRegionHuffmanTables(textRegion, referredTo, customTables, numberOfSymbols, reader) {
    const codes = [];
    for (let i = 0; i <= 34; i++) {
      const codeLength = reader.readBits(4);
      codes.push(new HuffmanLine([i, codeLength, 0, 0]));
    }
    const runCodesTable = new HuffmanTable(codes, false);
    codes.length = 0;
    for (let i = 0; i < numberOfSymbols; ) {
      const codeLength = runCodesTable.decode(reader);
      if (codeLength >= 32) {
        let repeatedLength, numberOfRepeats, j;
        switch (codeLength) {
          case 32:
            if (i === 0) {
              throw new Jbig2Error("no previous value in symbol ID table");
            }
            numberOfRepeats = reader.readBits(2) + 3;
            repeatedLength = codes[i - 1].prefixLength;
            break;
          case 33:
            numberOfRepeats = reader.readBits(3) + 3;
            repeatedLength = 0;
            break;
          case 34:
            numberOfRepeats = reader.readBits(7) + 11;
            repeatedLength = 0;
            break;
          default:
            throw new Jbig2Error("invalid code length in symbol ID table");
        }
        for (j = 0; j < numberOfRepeats; j++) {
          codes.push(new HuffmanLine([i, repeatedLength, 0, 0]));
          i++;
        }
      } else {
        codes.push(new HuffmanLine([i, codeLength, 0, 0]));
        i++;
      }
    }
    reader.byteAlign();
    const symbolIDTable = new HuffmanTable(codes, false);
    let customIndex = 0, tableFirstS, tableDeltaS, tableDeltaT;
    switch (textRegion.huffmanFS) {
      case 0:
      case 1:
        tableFirstS = getStandardTable(textRegion.huffmanFS + 6);
        break;
      case 3:
        tableFirstS = getCustomHuffmanTable(
          customIndex,
          referredTo,
          customTables
        );
        customIndex++;
        break;
      default:
        throw new Jbig2Error("invalid Huffman FS selector");
    }
    switch (textRegion.huffmanDS) {
      case 0:
      case 1:
      case 2:
        tableDeltaS = getStandardTable(textRegion.huffmanDS + 8);
        break;
      case 3:
        tableDeltaS = getCustomHuffmanTable(
          customIndex,
          referredTo,
          customTables
        );
        customIndex++;
        break;
      default:
        throw new Jbig2Error("invalid Huffman DS selector");
    }
    switch (textRegion.huffmanDT) {
      case 0:
      case 1:
      case 2:
        tableDeltaT = getStandardTable(textRegion.huffmanDT + 11);
        break;
      case 3:
        tableDeltaT = getCustomHuffmanTable(
          customIndex,
          referredTo,
          customTables
        );
        customIndex++;
        break;
      default:
        throw new Jbig2Error("invalid Huffman DT selector");
    }
    if (textRegion.refinement) {
      throw new Jbig2Error("refinement with Huffman is not supported");
    }
    return {
      symbolIDTable,
      tableFirstS,
      tableDeltaS,
      tableDeltaT
    };
  }
  function getSymbolDictionaryHuffmanTables(dictionary, referredTo, customTables) {
    let customIndex = 0, tableDeltaHeight, tableDeltaWidth;
    switch (dictionary.huffmanDHSelector) {
      case 0:
      case 1:
        tableDeltaHeight = getStandardTable(dictionary.huffmanDHSelector + 4);
        break;
      case 3:
        tableDeltaHeight = getCustomHuffmanTable(
          customIndex,
          referredTo,
          customTables
        );
        customIndex++;
        break;
      default:
        throw new Jbig2Error("invalid Huffman DH selector");
    }
    switch (dictionary.huffmanDWSelector) {
      case 0:
      case 1:
        tableDeltaWidth = getStandardTable(dictionary.huffmanDWSelector + 2);
        break;
      case 3:
        tableDeltaWidth = getCustomHuffmanTable(
          customIndex,
          referredTo,
          customTables
        );
        customIndex++;
        break;
      default:
        throw new Jbig2Error("invalid Huffman DW selector");
    }
    let tableBitmapSize, tableAggregateInstances;
    if (dictionary.bitmapSizeSelector) {
      tableBitmapSize = getCustomHuffmanTable(
        customIndex,
        referredTo,
        customTables
      );
      customIndex++;
    } else {
      tableBitmapSize = getStandardTable(1);
    }
    if (dictionary.aggregationInstancesSelector) {
      tableAggregateInstances = getCustomHuffmanTable(
        customIndex,
        referredTo,
        customTables
      );
    } else {
      tableAggregateInstances = getStandardTable(1);
    }
    return {
      tableDeltaHeight,
      tableDeltaWidth,
      tableBitmapSize,
      tableAggregateInstances
    };
  }
  function readUncompressedBitmap(reader, width, height) {
    const bitmap = [];
    for (let y = 0; y < height; y++) {
      const row = new Uint8Array(width);
      bitmap.push(row);
      for (let x = 0; x < width; x++) {
        row[x] = reader.readBit();
      }
      reader.byteAlign();
    }
    return bitmap;
  }
  function decodeMMRBitmap(input, width, height, endOfBlock) {
    const params = {
      K: -1,
      Columns: width,
      Rows: height,
      BlackIs1: true,
      EndOfBlock: endOfBlock
    };
    const decoder = new CCITTFaxDecoder(input, params);
    const bitmap = [];
    let currentByte, eof = false;
    for (let y = 0; y < height; y++) {
      const row = new Uint8Array(width);
      bitmap.push(row);
      let shift = -1;
      for (let x = 0; x < width; x++) {
        if (shift < 0) {
          currentByte = decoder.readNextChar();
          if (currentByte === -1) {
            currentByte = 0;
            eof = true;
          }
          shift = 7;
        }
        row[x] = currentByte >> shift & 1;
        shift--;
      }
    }
    if (endOfBlock && !eof) {
      const lookForEOFLimit = 5;
      for (let i = 0; i < lookForEOFLimit; i++) {
        if (decoder.readNextChar() === -1) {
          break;
        }
      }
    }
    return bitmap;
  }
  var Jbig2Image = class {
    parseChunks(chunks) {
      return parseJbig2Chunks(chunks);
    }
    parse(data) {
      if (typeof PDFJSDev === "undefined" || !PDFJSDev.test("IMAGE_DECODERS")) {
        throw new Error("Not implemented: Jbig2Image.parse");
      }
      const { imgData, width, height } = parseJbig2(data);
      this.width = width;
      this.height = height;
      return imgData;
    }
  };

  // entry.js
  globalThis.PDFJS = { JpegImage, JpxImage, Jbig2Image };
})();
