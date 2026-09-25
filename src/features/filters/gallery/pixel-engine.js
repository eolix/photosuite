/**
 * Filter Gallery pixel buffer: width/height, band offsets for worker strips, and
 * per-filter scanline kernels (blur, emboss, median, texture, …). Consumed by
 * `GalleryFilterDefs` and `FilterPixelOps`.
 */

function clearMedianHistograms(valueHistogram, coarseHistogram) {
    for (let histClearIdx = 0; histClearIdx < 256; histClearIdx++) {
        valueHistogram[histClearIdx] = 0
    }
    for (let bucketClearIdx = 0; bucketClearIdx < 16; bucketClearIdx++) {
        coarseHistogram[bucketClearIdx] = 0
    }
}

function selectMedianRankValue(valueHistogram, coarseHistogram, medianRank) {
    let cumulativeCount = 0;
    let valueIdx = 0;
    while (cumulativeCount + coarseHistogram[valueIdx >>> 4] < medianRank) {
        cumulativeCount += coarseHistogram[valueIdx >>> 4];
        valueIdx += 16
    }
    for (; valueIdx < 256; valueIdx++) {
        cumulativeCount += valueHistogram[valueIdx];
        if (cumulativeCount >= medianRank) break
    }
    return valueIdx;
}


function beginAsyncWasmLoad(relativeWasmPath, wasmIntegrityHash, onExportsReady) {
    fetch(new URL(relativeWasmPath, import.meta.url), { integrity: wasmIntegrityHash })
        .then(function (response) { return response.arrayBuffer(); })
        .then(function (wasmBytes) { return WebAssembly.instantiate(wasmBytes); })
        .then(function (wasmModule) { onExportsReady(wasmModule.instance.exports); })
        .catch(function () { /* keep JS fallback */ });
}

function buildTextureBlendFunctions() {
    const mirrorWithinPeriod = function (value, period) {
            return period <= value ? value / period & 1 ? period - value % period : value % period : value
        };
    return [
        function (valueA, valueB) {
            return mirrorWithinPeriod(valueA, 255) / 255
        },
        function (valueA, valueB) {
            return (255 + mirrorWithinPeriod(valueA, 255) - mirrorWithinPeriod(valueB, 255)) / 510
        },
        function (valueA, valueB) {
            return (255 - mirrorWithinPeriod(valueB, 255)) / 255
        },
        function (valueA, valueB) {
            return (510 - mirrorWithinPeriod(valueA, 255) - mirrorWithinPeriod(valueB, 255)) / 510
        },
        function (valueA, valueB) {
            return (255 - mirrorWithinPeriod(valueA, 255)) / 255
        },
        function (valueA, valueB) {
            return (255 - mirrorWithinPeriod(valueA, 255) + mirrorWithinPeriod(valueB, 255)) / 510
        },
        function (valueA, valueB) {
            return mirrorWithinPeriod(valueB, 255) / 255
        },
        function (valueA, valueB) {
            return (mirrorWithinPeriod(valueA, 255) + mirrorWithinPeriod(valueB, 255)) / 510
        }
    ];
}

export const PixelEngine = {};

PixelEngine.textureLoader = null;
PixelEngine.bilinearSample = null;

PixelEngine.width = 0;
PixelEngine.height = 0;
PixelEngine.pixelCount = 0;
PixelEngine.int32BufferLen = 0;
PixelEngine.rgbaLen = 0;

// Band-processing context. When a worker runs a filter on a horizontal slice of a
// larger image, these tell origin-anchored ops where the slice sits in the whole:
// _bandOffY is the global row of local row 0, _bandFullH the global image height,
// _randSkip the number of RNG draws consumed by the rows above this band. All zero
// for whole-image runs, so the single-threaded path is unaffected.
PixelEngine._bandOffY = 0;
PixelEngine._bandFullH = 0;
PixelEngine._randSkip = 0;
// Optional pre-computed random plane (band-local, one byte per pixel). When set,
// randomFill copies from it instead of running the generator, so a band can reuse
// the main thread's single generation pass rather than fast-forwarding the RNG to
// its own offset. Null for whole-image runs.
PixelEngine._randField = null;
PixelEngine.init = function (width, height) {
    const pixelCount = width * height;
    const self = PixelEngine;
    self.width = width;
    self.height = height;
    self.pixelCount = pixelCount;
    self.int32BufferLen = pixelCount << 1;
    self.rgbaLen = pixelCount << 2
};
PixelEngine.seedRandom = function (seedState) {
    const skip = PixelEngine._randSkip | 0;
    for (let skipIndex = 0; skipIndex < skip; skipIndex++) seedState += 1831565813;
    PixelEngine.random = function () {
        let hashedState = seedState += 1831565813;
        hashedState = Math.imul(hashedState ^ hashedState >>> 15, hashedState | 1);
        hashedState ^= hashedState + Math.imul(hashedState ^ hashedState >>> 7, hashedState | 61);
        return ((hashedState ^ hashedState >>> 14) >>> 0) / 4294967296
    }
};
// Allocate a scratch Uint8Array sized for the current image at the given
// stride. `bytesPerPixel` is 1 (single channel), 2 (packed 16-bit pairs), or
// 4 (RGBA). Any other value yields a negative length and throws.
PixelEngine.allocArray = function (bytesPerPixel) {
    const byteLength =
        bytesPerPixel === 1 ? PixelEngine.pixelCount :
        bytesPerPixel === 2 ? PixelEngine.int32BufferLen :
        bytesPerPixel === 4 ? PixelEngine.rgbaLen : -1;
    return new Uint8Array(byteLength)
};
PixelEngine.allocInt32 = function () {
    return new Int32Array(PixelEngine.int32BufferLen)
};

// Histogram median blur is the dominant cost in the artistic filter gallery and
// runs much slower under WKWebView's JavaScriptCore than under V8. The kernel is
// offloaded to median.wasm (source + byte-equality harness in
// wasm/median/). Load is async and best-effort: until it resolves, the
// JS implementations below run unchanged, so this is a pure speedup with a safe
// fallback. Window size is bounded by the wasm-side colpos[256] scratch.
PixelEngine._medianWasm = null;
PixelEngine.loadMedianWasm = function () {
    if (PixelEngine._medianWasmLoading || typeof fetch !== "function") return;
    PixelEngine._medianWasmLoading = true;
    beginAsyncWasmLoad("../wasm/median.wasm", "sha384-Q0TxUMA+LRvCbE2q6WHEGGR/kEVJlhOe5mlmwHpQ29Sx8YWK5rE4AThLDlAxqbLS", function (exports) {
        PixelEngine._medianWasm = exports;
    });
};
PixelEngine._runMedianWasm = function (src, dst, call) {
    const wasm = PixelEngine._medianWasm;
    const pixelCount = PixelEngine.pixelCount;
    wasm.wasm_reset();
    const srcPtr = wasm.wasm_alloc(pixelCount);
    const dstPtr = wasm.wasm_alloc(pixelCount);
    const need = dstPtr + pixelCount;
    const have = wasm.memory.buffer.byteLength;
    if (have < need) wasm.memory.grow(((need - have) >>> 16) + 1);
    new Uint8Array(wasm.memory.buffer).set(src.subarray(0, pixelCount), srcPtr);
    call(wasm, srcPtr, dstPtr);
    dst.set(new Uint8Array(wasm.memory.buffer, dstPtr, pixelCount));
};

// Separable box blur, offloaded to blur.wasm (source in wasm/blur/). Same async,
// best-effort load + JS fallback as the median kernel. Needs an i32 scratch plane
// for the vertical-pass column sums, so it has its own runner.
PixelEngine._blurWasm = null;
PixelEngine.loadBlurWasm = function () {
    if (PixelEngine._blurWasmLoading || typeof fetch !== "function") return;
    PixelEngine._blurWasmLoading = true;
    beginAsyncWasmLoad("../wasm/blur.wasm", "sha384-oZWNUCVPMELLXPIsTcpC+dpiIcfBvRMmWfBP4ZaZbxpvdO1tY063zoNEIBFnHLAO", function (exports) {
        PixelEngine._blurWasm = exports;
    });
};
PixelEngine._runBlurWasm = function (src, dst, windowWidth, windowHeight) {
    const wasm = PixelEngine._blurWasm;
    const pixelCount = PixelEngine.pixelCount;
    wasm.wasm_reset();
    const srcPtr = wasm.wasm_alloc(pixelCount);
    const dstPtr = wasm.wasm_alloc(pixelCount);
    const tmpPtr = wasm.wasm_alloc(pixelCount * 4);
    const need = tmpPtr + pixelCount * 4;
    const have = wasm.memory.buffer.byteLength;
    if (have < need) wasm.memory.grow(((need - have) >>> 16) + 1);
    new Uint8Array(wasm.memory.buffer).set(src.subarray(0, pixelCount), srcPtr);
    wasm.box_blur(srcPtr, dstPtr, tmpPtr, PixelEngine.width, PixelEngine.height, windowWidth, windowHeight);
    dst.set(new Uint8Array(wasm.memory.buffer, dstPtr, pixelCount));
};
PixelEngine.boxBlur = function (src, dst, kernelWidth, kernelHeight) {
    if (kernelHeight == null) kernelHeight = kernelWidth;
    if (PixelEngine._blurWasm) {
        PixelEngine._runBlurWasm(src, dst, kernelWidth, kernelHeight);
        return;
    }
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const kernelHeightLoop = kernelHeight;
    const kernelHeightHalf = kernelHeight >> 1;
    const kernelWidthLoop = kernelWidth;
    const kernelWidthHalf = kernelWidth >> 1;
    const kernelArea = kernelWidth * kernelHeight;
    let outIndex = 0;
    for (let outRow = 0; outRow < height; outRow++) {
        let rowSum = 0;
        for (let kernelRow = 0; kernelRow < kernelHeightLoop; kernelRow++) {
            for (let kernelCol = 0; kernelCol < kernelWidthLoop; kernelCol++) {
                let sampleCol = 0 - kernelWidthHalf + kernelCol;
                let sampleRow = outRow - kernelHeightHalf + kernelRow;
                if (sampleCol < 0) sampleCol = 0;
                else if (sampleCol >= width) sampleCol = width - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                rowSum += src[sampleRow * width + sampleCol]
            }
        }
        dst[outIndex++] = ~~(rowSum / kernelArea);
        for (let outCol = 1; outCol < width; outCol++) {
            for (let kernelRow = 0; kernelRow < kernelHeightLoop; kernelRow++) {
                let removeCol = outCol - kernelWidthHalf - 1;
                let addCol = removeCol + kernelWidthLoop;
                let sampleRow = outRow - kernelHeightHalf + kernelRow;
                if (removeCol < 0) removeCol = 0;
                if (addCol >= width) addCol = width - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                rowSum += src[sampleRow * width + addCol] - src[sampleRow * width + removeCol]
            }
            dst[outIndex++] = ~~(rowSum / kernelArea)
        }
    }
};
PixelEngine.boxBlurRG = function (src, dst, kernelWidth, kernelHeight) {
    const self = PixelEngine;
    const channelBuffer = new Int32Array(self.pixelCount);
    let blurredBuffer = new Int32Array(self.pixelCount);
    for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
        self.readChannel(src, channelBuffer, channelIndex, 2);
        self.boxBlur(channelBuffer, blurredBuffer, kernelWidth, kernelHeight);
        self.writeChannel(blurredBuffer, dst, channelIndex, 2)
    }
};
PixelEngine.boxBlurRGBA = function (src, dst, kernelWidth, kernelHeight) {
    const self = PixelEngine;
    const channelBuffer = self.allocArray(1);
    let blurredBuffer = self.allocArray(1);
    for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
        self.readChannel(src, channelBuffer, channelIndex);
        if (channelIndex < 3) self.boxBlur(channelBuffer, blurredBuffer, kernelWidth, kernelHeight);
        else blurredBuffer = channelBuffer;
        self.writeChannel(blurredBuffer, dst, channelIndex)
    }
};
PixelEngine.diagonalBlur = function (src, dst, kernelWidth, kernelHeight, reverseDiagonal) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const kernelSpan = kernelWidth + kernelHeight - 1;
    const kernelWidthHalf = kernelWidth >> 1;
    const kernelSpanHalf = kernelSpan >> 1;
    let outIndex = 0;
    const kernelArea = kernelWidth * kernelHeight;
    const columnStartOffsets = new Int32Array(kernelWidth);
    for (let outRow = 0; outRow < height; outRow++) {
        let redSum = 0;
        let greenSum = 0;
        let blueSum = 0;
        for (let kernelCol = 0; kernelCol < kernelWidth; kernelCol++) {
            const spanOffset = reverseDiagonal ? kernelSpan - kernelCol - kernelHeight : kernelCol;
            for (let spanIdx = spanOffset, spanEnd = kernelHeight + spanOffset; spanIdx < spanEnd; spanIdx++) {
                let sampleCol = 0 - kernelSpanHalf + spanIdx;
                let sampleRow = outRow - kernelWidthHalf + kernelCol;
                if (spanIdx == spanOffset) {
                    columnStartOffsets[kernelCol] = sampleCol
                }
                if (sampleCol < 0) sampleCol = 0;
                else if (sampleCol >= width) sampleCol = width - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                const pixelOffset = width * sampleRow + sampleCol << 2;
                redSum += src[pixelOffset];
                greenSum += src[pixelOffset + 1];
                blueSum += src[pixelOffset + 2]
            }
        }
        dst[outIndex++] = ~~(redSum / kernelArea);
        dst[outIndex++] = ~~(greenSum / kernelArea);
        dst[outIndex++] = ~~(blueSum / kernelArea);
        dst[outIndex] = src[outIndex];
        outIndex++;
        for (let outCol = 1; outCol < width; outCol++) {
            for (let kernelCol = 0; kernelCol < kernelWidth; kernelCol++) {
                let sampleRow = outRow - kernelWidthHalf + kernelCol;
                const nextStartCol = columnStartOffsets[kernelCol] + 1;
                columnStartOffsets[kernelCol] = nextStartCol;
                let removeCol = nextStartCol - 1;
                let addCol = nextStartCol + kernelHeight - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                if (removeCol < 0) removeCol = 0;
                else if (removeCol >= width) removeCol = width - 1;
                if (addCol < 0) addCol = 0;
                else if (addCol >= width) addCol = width - 1;
                const removeOffset = sampleRow * width + removeCol << 2;
                const addOffset = sampleRow * width + addCol << 2;
                redSum = redSum + src[addOffset] - src[removeOffset];
                greenSum = greenSum + src[addOffset + 1] - src[removeOffset + 1];
                blueSum = blueSum + src[addOffset + 2] - src[removeOffset + 2]
            }
            dst[outIndex++] = ~~(redSum / kernelArea);
            dst[outIndex++] = ~~(greenSum / kernelArea);
            dst[outIndex++] = ~~(blueSum / kernelArea);
            dst[outIndex] = src[outIndex];
            outIndex++
        }
    }
};
PixelEngine.medianBlurChan = function (src, dst, kernelWidth, kernelHeight, reverseDiagonal, medianRank) {
    if (PixelEngine._medianWasm && kernelWidth <= 256) {
        PixelEngine._runMedianWasm(src, dst, function (wasmModule, srcBuffer, dstBuffer) {
            wasmModule.median_dir(srcBuffer, dstBuffer, PixelEngine.width, PixelEngine.height, kernelWidth, kernelHeight, reverseDiagonal ? 1 : 0, medianRank);
        });
        return;
    }
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const kernelSpan = kernelWidth + kernelHeight - 1;
    const kernelWidthHalf = kernelWidth >> 1;
    const kernelSpanHalf = kernelSpan >> 1;
    let outIndex = 0;
    const columnStartOffsets = new Int32Array(kernelWidth);
    const valueHistogram = new Int32Array(256);
    const coarseHistogram = new Int32Array(16);
    for (let outRow = 0; outRow < height; outRow++) {
        clearMedianHistograms(valueHistogram, coarseHistogram);
        for (let kernelCol = 0; kernelCol < kernelWidth; kernelCol++) {
            const spanOffset = reverseDiagonal ? kernelSpan - kernelCol - kernelHeight : kernelCol;
            for (let spanIdx = spanOffset, spanEnd = kernelHeight + spanOffset; spanIdx < spanEnd; spanIdx++) {
                let sampleCol = 0 - kernelSpanHalf + spanIdx;
                let sampleRow = outRow - kernelWidthHalf + kernelCol;
                if (spanIdx == spanOffset) {
                    columnStartOffsets[kernelCol] = sampleCol
                }
                if (sampleCol < 0) sampleCol = 0;
                else if (sampleCol >= width) sampleCol = width - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                valueHistogram[src[sampleRow * width + sampleCol]]++;
                coarseHistogram[src[sampleRow * width + sampleCol] >>> 4]++
            }
        }
        dst[outIndex++] = selectMedianRankValue(valueHistogram, coarseHistogram, medianRank);
        for (let outCol = 1; outCol < width; outCol++) {
            for (let kernelCol = 0; kernelCol < kernelWidth; kernelCol++) {
                let sampleRow = outRow - kernelWidthHalf + kernelCol;
                const nextStartCol = columnStartOffsets[kernelCol] + 1;
                columnStartOffsets[kernelCol] = nextStartCol;
                let removeCol = nextStartCol - 1;
                let addCol = nextStartCol + kernelHeight - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                if (removeCol < 0) removeCol = 0;
                else if (removeCol >= width) removeCol = width - 1;
                if (addCol < 0) addCol = 0;
                else if (addCol >= width) addCol = width - 1;
                valueHistogram[src[sampleRow * width + removeCol]]--;
                valueHistogram[src[sampleRow * width + addCol]]++;
                coarseHistogram[src[sampleRow * width + removeCol] >>> 4]--;
                coarseHistogram[src[sampleRow * width + addCol] >>> 4]++
            }
            dst[outIndex++] = selectMedianRankValue(valueHistogram, coarseHistogram, medianRank)
        }
    }
};
PixelEngine.medianBlurRGBA = function (src, dst, kernelWidth, kernelHeight, reverseDiagonal, medianRank) {
    const self = PixelEngine;
    const channelBuffer = self.allocArray(1);
    let blurredBuffer = self.allocArray(1);
    for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
        self.readChannel(src, channelBuffer, channelIndex);
        if (channelIndex < 3) self.medianBlurChan(channelBuffer, blurredBuffer, kernelWidth, kernelHeight, reverseDiagonal, medianRank);
        else blurredBuffer = channelBuffer;
        self.writeChannel(blurredBuffer, dst, channelIndex)
    }
};
PixelEngine.medianBlurH = function (src, dst, kernelWidth, kernelHeight, medianRank) {
    if (PixelEngine._medianWasm && kernelHeight <= 256) {
        PixelEngine._runMedianWasm(src, dst, function (wasmModule, srcBuffer, dstBuffer) {
            wasmModule.median_h(srcBuffer, dstBuffer, PixelEngine.width, PixelEngine.height, kernelWidth, kernelHeight, medianRank);
        });
        return;
    }
    medianRank = Math.min(kernelHeight * kernelWidth, medianRank);
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const kernelHeightHalf = kernelHeight >> 1;
    const kernelWidthHalf = kernelWidth >> 1;
    let outIndex = 0;
    const rowStartCols = new Int32Array(kernelHeight);
    const valueHistogram = new Int32Array(256);
    const coarseHistogram = new Int32Array(16);
    for (let outRow = 0; outRow < height; outRow++) {
        clearMedianHistograms(valueHistogram, coarseHistogram);
        for (let kernelRow = 0; kernelRow < kernelHeight; kernelRow++) {
            for (let kernelCol = 0, kernelWidthLimit = kernelWidth; kernelCol < kernelWidthLimit; kernelCol++) {
                let sampleCol = 0 - kernelWidthHalf + kernelCol;
                let sampleRow = outRow - kernelHeightHalf + kernelRow;
                if (kernelCol == 0) {
                    rowStartCols[kernelRow] = sampleCol
                }
                if (sampleCol < 0) sampleCol = 0;
                else if (sampleCol >= width) sampleCol = width - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                valueHistogram[src[sampleRow * width + sampleCol]]++;
                coarseHistogram[src[sampleRow * width + sampleCol] >>> 4]++
            }
        }
        dst[outIndex++] = selectMedianRankValue(valueHistogram, coarseHistogram, medianRank);
        for (let outCol = 1; outCol < width; outCol++) {
            for (let kernelRow = 0; kernelRow < kernelHeight; kernelRow++) {
                let sampleRow = outRow - kernelHeightHalf + kernelRow;
                const nextStartCol = rowStartCols[kernelRow] + 1;
                rowStartCols[kernelRow] = nextStartCol;
                let removeCol = nextStartCol - 1;
                let addCol = nextStartCol + kernelWidth - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                if (removeCol < 0) removeCol = 0;
                else if (removeCol >= width) removeCol = width - 1;
                if (addCol < 0) addCol = 0;
                else if (addCol >= width) addCol = width - 1;
                valueHistogram[src[sampleRow * width + removeCol]]--;
                valueHistogram[src[sampleRow * width + addCol]]++;
                coarseHistogram[src[sampleRow * width + removeCol] >>> 4]--;
                coarseHistogram[src[sampleRow * width + addCol] >>> 4]++
            }
            dst[outIndex++] = selectMedianRankValue(valueHistogram, coarseHistogram, medianRank)
        }
    }
};
PixelEngine.medianBlurHRGBA = function (src, dst, kernelWidth, kernelHeight, medianRank) {
    const self = PixelEngine;
    const channelBuffer = self.allocArray(1);
    let blurredBuffer = self.allocArray(1);
    for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
        self.readChannel(src, channelBuffer, channelIndex);
        if (channelIndex < 3) self.medianBlurH(channelBuffer, blurredBuffer, kernelWidth, kernelHeight, medianRank);
        else blurredBuffer = channelBuffer;
        self.writeChannel(blurredBuffer, dst, channelIndex)
    }
};
PixelEngine.sharpenChan = function (src, dst, amount) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    let outIndex = 0;
    for (let outRow = 0; outRow < height; outRow++) {
        const rowOffset = outRow * width;
        let prevRowOffset = (outRow - 1) * width;
        let nextRowOffset = (outRow + 1) * width;
        if (prevRowOffset < 0) prevRowOffset = rowOffset;
        if (nextRowOffset >= height) nextRowOffset = rowOffset;
        for (let outCol = 0; outCol < width; outCol++) {
            let leftCol = outCol - 1;
            let rightCol = outCol + 1;
            if (leftCol < 0) leftCol = outCol;
            if (rightCol >= width) rightCol = outCol;
            const leftIndex = rowOffset + leftCol;
            const rightIndex = rowOffset + rightCol;
            const topIndex = prevRowOffset + outCol;
            const bottomIndex = nextRowOffset + outCol;
            const centerIndex = rowOffset + outCol;
            const leftSample = src[leftIndex];
            const rightSample = src[rightIndex];
            const topSample = src[topIndex];
            const bottomSample = src[bottomIndex];
            const centerSample = src[centerIndex];
            let sharpened = centerSample + (centerSample * 4 * amount + .5);
            sharpened = sharpened - ((leftSample + rightSample + bottomSample + topSample) * amount + .5);
            dst[outIndex++] = self.clamp(sharpened)
        }
    }
};
PixelEngine.sharpenRGBA = function (src, dst, amount) {
    const self = PixelEngine;
    const channelBuffer = self.allocArray(1);
    let sharpenedBuffer = self.allocArray(1);
    for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
        self.readChannel(src, channelBuffer, channelIndex);
        if (channelIndex < 3) self.sharpenChan(channelBuffer, sharpenedBuffer, amount);
        else sharpenedBuffer = channelBuffer;
        self.writeChannel(sharpenedBuffer, dst, channelIndex)
    }
};
PixelEngine.smoothRGBA = function (src, dst, blendWeight) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    let outIndex = 0;
    const divisor = blendWeight + 4;
    for (let outRow = 0; outRow < height; outRow++) {
        const rowOffset = outRow * width;
        let prevRowOffset = (outRow - 1) * width;
        let nextRowOffset = (outRow + 1) * width;
        if (prevRowOffset < 0) prevRowOffset = rowOffset;
        if (nextRowOffset >= height) nextRowOffset = rowOffset;
        for (let outCol = 0; outCol < width; outCol++) {
            let leftCol = outCol - 1;
            let rightCol = outCol + 1;
            if (leftCol < 0) leftCol = outCol;
            if (rightCol >= width) rightCol = outCol;
            const leftOffset = rowOffset + leftCol << 2;
            const rightOffset = rowOffset + rightCol << 2;
            const topOffset = prevRowOffset + outCol << 2;
            const bottomOffset = nextRowOffset + outCol << 2;
            const centerOffset = rowOffset + outCol << 2;
            for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
                const leftSample = src[leftOffset + channelIdx];
                const rightSample = src[rightOffset + channelIdx];
                const topSample = src[topOffset + channelIdx];
                const bottomSample = src[bottomOffset + channelIdx];
                const centerSample = src[centerOffset + channelIdx];
                dst[outIndex++] = (centerSample * blendWeight + leftSample + rightSample + bottomSample + topSample) / divisor
            }
            dst[outIndex] = src[outIndex];
            outIndex++
        }
    }
};
PixelEngine.modeBlur = function (src, dst, kernelHeight, kernelWidth) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const kernelHeightHalf = kernelHeight >> 1;
    const kernelWidthHalf = kernelWidth >> 1;
    let outIndex = 0;
    const rowStartCols = new Int32Array(kernelHeight);
    const valueHistogram = new Int32Array(256);
    for (let outRow = 0; outRow < height; outRow++) {
        for (let histClearIdx = 0; histClearIdx < 256; histClearIdx++) {
            valueHistogram[histClearIdx] = 0
        }
        for (let kernelRow = 0; kernelRow < kernelHeight; kernelRow++) {
            for (let kernelCol = 0, kernelWidthLimit = kernelWidth; kernelCol < kernelWidthLimit; kernelCol++) {
                let sampleCol = 0 - kernelWidthHalf + kernelCol;
                let sampleRow = outRow - kernelHeightHalf + kernelRow;
                if (kernelCol == 0) {
                    rowStartCols[kernelRow] = sampleCol
                }
                if (sampleCol < 0) sampleCol = 0;
                else if (sampleCol >= width) sampleCol = width - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                valueHistogram[src[sampleRow * width + sampleCol]]++
            }
        }
        let maxCount = 0;
        let modeValue = 0;
        for (let valueIdx = 0; valueIdx < 256; valueIdx++) {
            if (maxCount < valueHistogram[valueIdx]) {
                modeValue = valueIdx;
                maxCount = valueHistogram[valueIdx]
            }
        }
        dst[outIndex++] = modeValue;
        for (let outCol = 1; outCol < width; outCol++) {
            for (let kernelRow = 0; kernelRow < kernelHeight; kernelRow++) {
                let sampleRow = outRow - kernelHeightHalf + kernelRow;
                const nextStartCol = rowStartCols[kernelRow] + 1;
                rowStartCols[kernelRow] = nextStartCol;
                let removeCol = nextStartCol - 1;
                let addCol = nextStartCol + kernelWidth - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow >= height) sampleRow = height - 1;
                if (removeCol < 0) removeCol = 0;
                else if (removeCol >= width) removeCol = width - 1;
                if (addCol < 0) addCol = 0;
                else if (addCol >= width) addCol = width - 1;
                valueHistogram[src[sampleRow * width + removeCol]]--;
                valueHistogram[src[sampleRow * width + addCol]]++
            }
            maxCount = 0;
            modeValue = 0;
            for (let valueIdx = 0; valueIdx < 256; valueIdx++) {
                if (maxCount < valueHistogram[valueIdx]) {
                    modeValue = valueIdx;
                    maxCount = valueHistogram[valueIdx]
                }
            }
            dst[outIndex++] = modeValue
        }
    }
};
PixelEngine.dirKernels = [function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (topLeft + topCenter + topRight) * weight - (bottomRight + bottomCenter + bottomLeft) * weight
}, function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (topCenter + topRight + centerRight) * weight - (bottomCenter + bottomLeft + centerLeft) * weight
}, function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (topRight + centerRight + bottomRight) * weight - (bottomLeft + centerLeft + topLeft) * weight
}, function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (centerRight + bottomRight + bottomCenter) * weight - (centerLeft + topLeft + topCenter) * weight
}, function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (bottomRight + bottomCenter + bottomLeft) * weight - (topLeft + topCenter + topRight) * weight
}, function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (bottomCenter + bottomLeft + centerLeft) * weight - (topCenter + topRight + centerRight) * weight
}, function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (bottomLeft + centerLeft + topLeft) * weight - (topRight + centerRight + bottomRight) * weight
}, function (topLeft, topCenter, topRight, centerLeft, center, centerRight, bottomLeft, bottomCenter, bottomRight, weight) {
    return center + (centerLeft + topLeft + topCenter) * weight - (centerRight + bottomRight + bottomCenter) * weight
}];
PixelEngine.applyDirKernel = function (src, centerRef, dst, kernelIndex, weight) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const stride = width;
    const kernelFn = self.dirKernels[kernelIndex - 1];
    for (let outRow = 0; outRow < height; outRow++) {
        let prevRowOffset = (outRow > 0 ? outRow - 1 : 0) * stride;
        const rowOffset = outRow * stride;
        let nextRowOffset = (outRow < height ? outRow + 1 : outRow) * stride;
        for (let outCol = 0; outCol < width; outCol++) {
            let leftCol = outCol > 0 ? outCol - 1 : 0;
            let rightCol = outCol < width ? outCol + 1 : outCol;
            let outIndex = rowOffset + outCol;
            const topLeft = src[prevRowOffset + leftCol];
            const topCenter = src[prevRowOffset + outCol];
            const topRight = src[prevRowOffset + rightCol];
            const centerLeft = src[rowOffset + leftCol];
            const centerSample = centerRef[outIndex];
            const centerRight = src[rowOffset + rightCol];
            const bottomLeft = src[nextRowOffset + leftCol];
            const bottomCenter = src[nextRowOffset + outCol];
            const bottomRight = src[nextRowOffset + rightCol];
            dst[outIndex] = self.clamp(kernelFn(topLeft, topCenter, topRight, centerLeft, centerSample, centerRight, bottomLeft, bottomCenter, bottomRight, weight))
        }
    }
};
PixelEngine.applyDirKernelRGB = function (src, centerRef, dst, kernelIndex, weight) {
    const self = PixelEngine;
    const channelBuffer = self.allocArray(1);
    const centerRefBuffer = self.allocArray(1);
    const outChannelBuffer = self.allocArray(1);
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        self.readChannel(src, channelBuffer, channelIndex);
        self.readChannel(centerRef, centerRefBuffer, channelIndex);
        self.applyDirKernel(channelBuffer, centerRefBuffer, outChannelBuffer, kernelIndex, weight);
        self.writeChannel(outChannelBuffer, dst, channelIndex)
    }
    self.readChannel(centerRef, channelBuffer, 3);
    self.writeChannel(channelBuffer, dst, 3)
};
PixelEngine.rgbaToGray = function (src, dst) {
    const rgbaLen = src.length;
    let dstIndex = 0;
    for (let rgbaIndex = 0; rgbaIndex < rgbaLen; rgbaIndex++) {
        dst[dstIndex++] = ~~((src[rgbaIndex++] + src[rgbaIndex++] + src[rgbaIndex++] + 2) / 3)
    }
};
PixelEngine.writeOutput = function (src, dst) {
    const dstLen = dst.length;
    let dstIndex = 0;
    for (let srcIndex = 0; srcIndex < dstLen; srcIndex++) {
        const grayValue = src[srcIndex];
        dst[dstIndex++] = grayValue;
        dst[dstIndex++] = grayValue;
        dst[dstIndex++] = grayValue;
        dst[dstIndex++] = 255
    }
    if (dst[0] == 255) dst[0]--;
    else dst[0]++
};
PixelEngine.rgbaMaxChan = function (src, dst) {
    const pixelCount = dst.length;
    let rgbaIndex = 0;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        let maxValue = src[rgbaIndex++];
        const green = src[rgbaIndex++];
        const blue = src[rgbaIndex++];
        rgbaIndex++;
        if (green > maxValue) maxValue = green;
        if (blue > maxValue) maxValue = blue;
        dst[pixelIndex] = maxValue
    }
};
PixelEngine.rgbToHSV = function (src, dst) {
    if (dst == null) dst = src;
    const rgbaLen = src.length;
    for (let rgbaIndex = 0; rgbaIndex < rgbaLen; rgbaIndex += 4) {
        let minChannel = src[rgbaIndex];
        const green = src[rgbaIndex + 1];
        const blue = src[rgbaIndex + 2];
        const savedRed = minChannel;
        let maxChannelIndex = 0;
        let maxChannel = minChannel;
        let hue;
        if (green <= minChannel) {
            minChannel = green
        } else {
            maxChannelIndex = 1;
            maxChannel = green
        }
        if (blue <= maxChannel) {
            if (minChannel > blue) {
                minChannel = blue
            }
        } else {
            maxChannelIndex = 2;
            maxChannel = blue
        }
        const delta = maxChannel - minChannel;
        if (delta != 0) {
            if (maxChannelIndex == 0) {
                hue = ~~(43 * (green - blue) / delta)
            } else if (maxChannelIndex == 1) {
                hue = ~~(43 * (blue + 2 * delta - savedRed) / delta)
            } else {
                hue = 43 * (savedRed + 4 * delta - green) / delta
            }
            if (hue < 0) {
                hue = 255 & hue - 1
            }
            dst[rgbaIndex] = hue;
            dst[rgbaIndex + 1] = ~~(255 * delta / maxChannel)
        } else {
            dst[rgbaIndex] = delta;
            dst[rgbaIndex + 1] = delta
        }
        dst[rgbaIndex + 2] = maxChannel;
        dst[rgbaIndex + 3] = src[rgbaIndex + 3]
    }
};
PixelEngine.hsvToRGB = function (src, dst) {
    if (dst == null) dst = src;
    const rgbaLen = src.length;
    for (let rgbaIndex = 0; rgbaIndex < rgbaLen; rgbaIndex += 4) {
        let hue = src[rgbaIndex];
        const saturation = src[rgbaIndex + 1];
        const value = src[rgbaIndex + 2];
        if (saturation) {
            if (hue == 255) hue = 0;
            const hueSector = ~~(6 * hue / 255);
            const hueRemainder = ~~(-255 * hueSector + 6 * hue);
            if (hueSector == 0) {
                dst[rgbaIndex] = value;
                dst[rgbaIndex + 1] = ~~(value * (255 - saturation * (255 - hueRemainder) / 255) / 255);
                dst[rgbaIndex + 2] = ~~(value * (255 - saturation) / 255)
            } else if (hueSector == 1) {
                dst[rgbaIndex] = ~~(value * (255 - saturation * hueRemainder / 255) / 255);
                dst[rgbaIndex + 1] = value;
                dst[rgbaIndex + 2] = ~~(value * (255 - saturation) / 255)
            } else if (hueSector == 2) {
                dst[rgbaIndex] = ~~(value * (255 - saturation) / 255);
                dst[rgbaIndex + 1] = value;
                dst[rgbaIndex + 2] = ~~(value * (255 - saturation * (255 - hueRemainder) / 255) / 255)
            } else if (hueSector == 3) {
                dst[rgbaIndex] = ~~(value * (255 - saturation) / 255);
                dst[rgbaIndex + 1] = ~~(value * (255 - saturation * hueRemainder / 255) / 255);
                dst[rgbaIndex + 2] = value
            } else if (hueSector == 4) {
                dst[rgbaIndex] = ~~(value * (255 - saturation * (255 - hueRemainder) / 255) / 255);
                dst[rgbaIndex + 1] = ~~(value * (255 - saturation) / 255);
                dst[rgbaIndex + 2] = value
            } else {
                dst[rgbaIndex] = value;
                dst[rgbaIndex + 1] = ~~(value * (255 - saturation) / 255);
                dst[rgbaIndex + 2] = ~~(value * (255 - saturation * hueRemainder / 255) / 255)
            }
        } else {
            dst[rgbaIndex] = value;
            dst[rgbaIndex + 1] = value;
            dst[rgbaIndex + 2] = value
        }
        dst[rgbaIndex + 3] = src[rgbaIndex + 3]
    }
};
PixelEngine.writeChannel = function (src, dst, channelIndex, channelStride) {
    if (channelIndex == null) channelIndex = 2;
    if (channelStride == null) channelStride = 4;
    const srcLen = src.length;
    for (let pixelIndex = 0; pixelIndex < srcLen; pixelIndex++) {
        dst[channelIndex] = src[pixelIndex];
        channelIndex += channelStride
    }
};
PixelEngine.readChannel = function (src, dst, channelIndex, channelStride) {
    if (channelIndex == null) channelIndex = 2;
    if (channelStride == null) channelStride = 4;
    const dstLen = dst.length;
    for (let pixelIndex = 0; pixelIndex < dstLen; pixelIndex++) {
        dst[pixelIndex] = src[channelIndex];
        channelIndex += channelStride
    }
};
PixelEngine.blendByMask = function (src, mask, dst, opacity) {
    if (opacity == null) opacity = 1;
    const pixelCount = mask.length;
    let pixelIndex = 0;
    let maskWeight;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        maskWeight = mask[pixelIndex];
        if (maskWeight) {
            maskWeight *= opacity;
            dst[pixelIndex] = ~~((maskWeight * src[pixelIndex] + (255 - maskWeight) * dst[pixelIndex]) / 255)
        }
    }
};
PixelEngine.blendRGBAByMask = function (src, mask, background, dst) {
    if (dst == null) dst = background;
    const pixelCount = mask.length;
    let rgbaIndex = 0;
    let maskWeight;
    let invMask;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        maskWeight = mask[pixelIndex];
        if (maskWeight) {
            invMask = 255 - maskWeight;
            dst[rgbaIndex] = ~~((maskWeight * src[rgbaIndex] + invMask * background[rgbaIndex]) / 255);
            dst[rgbaIndex + 1] = ~~((maskWeight * src[rgbaIndex + 1] + invMask * background[rgbaIndex + 1]) / 255);
            dst[rgbaIndex + 2] = ~~((maskWeight * src[rgbaIndex + 2] + invMask * background[rgbaIndex + 2]) / 255)
        }
        dst[rgbaIndex + 3] = src[rgbaIndex + 3];
        rgbaIndex += 4
    }
};
PixelEngine.screenBlend = function (src, background, dst, opacity) {
    const opacityScaled = ~~(opacity * 255);
    const pixelCount = dst.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = ((255 - opacityScaled * (255 - src[pixelIndex]) / 255) * background[pixelIndex] + src[pixelIndex] * (opacityScaled * (255 - src[pixelIndex]) / 255)) / 255
    }
};
PixelEngine.multiplyBlend = function (src, background, dst, opacity) {
    const opacityScaled = ~~(opacity * 255);
    const pixelCount = dst.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = ((255 - opacityScaled * src[pixelIndex] / 255) * background[pixelIndex] + src[pixelIndex] * (opacityScaled * src[pixelIndex] / 255)) / 255
    }
};
PixelEngine.scalePreserve = function (scaleFactors, dst, blendFactor) {
    const pixelCount = dst.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = ~~(scaleFactors[pixelIndex] * blendFactor + .5) + (dst[pixelIndex] - ~~(dst[pixelIndex] * blendFactor + .5))
    }
};
PixelEngine.subtract = function (src, dst) {
    const pixelCount = src.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = Math.max(src[pixelIndex] - dst[pixelIndex], 0)
    }
};
PixelEngine.add = function (src, dst) {
    const pixelCount = src.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = Math.min(src[pixelIndex] + dst[pixelIndex], 255)
    }
};
PixelEngine.addRaw = function (src, dst) {
    const pixelCount = src.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = src[pixelIndex] + dst[pixelIndex]
    }
};
PixelEngine.average = function (src, dst) {
    const pixelCount = src.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = src[pixelIndex] + dst[pixelIndex] >> 1
    }
};
PixelEngine.copyArray = function (src, dst) {
    const pixelCount = src.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = src[pixelIndex]
    }
};
PixelEngine.applyLUT = function (dst, lut) {
    const pixelCount = dst.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = lut[dst[pixelIndex]]
    }
};
PixelEngine.applyLUTToRGBA = function (rgba, lut) {
    const rgbaLen = PixelEngine.rgbaLen;
    for (let rgbaIndex = 0; rgbaIndex < rgbaLen; rgbaIndex += 4) {
        const red = rgba[rgbaIndex];
        const green = rgba[rgbaIndex + 1];
        const blue = rgba[rgbaIndex + 2];
        let maxChannel = red;
        if (green > red) maxChannel = green;
        if (blue > red) maxChannel = blue;
        const lutValue = lut[maxChannel];
        if (lutValue) {
            rgba[rgbaIndex] = ~~(lutValue * red / maxChannel);
            rgba[rgbaIndex + 1] = ~~(lutValue * green / maxChannel);
            rgba[rgbaIndex + 2] = ~~(lutValue * blue / maxChannel)
        } else {
            rgba[rgbaIndex] = lutValue;
            rgba[rgbaIndex + 1] = lutValue;
            rgba[rgbaIndex + 2] = lutValue
        }
    }
};
PixelEngine.multiplyScalar = function (dst, scalar) {
    for (let pixelIndex = 0, pixelCount = dst.length; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = Math.min(255, ~~(.5 + dst[pixelIndex] * scalar))
    }
};
PixelEngine.invertScale = function (dst, scale) {
    for (let pixelIndex = 0, pixelCount = dst.length; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = 255 - Math.min(255, ~~(.5 + (255 - dst[pixelIndex]) * scale))
    }
};
PixelEngine.invertChannel = function (dst) {
    const pixelCount = dst.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = 255 - dst[pixelIndex]
    }
};
PixelEngine.threshold = function (dst, threshold, lowValue, highValue) {
    if (lowValue == null) lowValue = 0;
    if (highValue == null) highValue = 255;
    for (let pixelIndex = 0, pixelCount = dst.length; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = dst[pixelIndex] >= threshold ? highValue : lowValue
    }
};
PixelEngine.unpackARGB = function (packedColor) {
    return [packedColor >> 24 & 255, packedColor >> 16 & 255, packedColor >> 8 & 255, packedColor & 255]
};
PixelEngine.posterize2 = function (rgba, threshold, highColor, lowColor) {
    if (highColor == null) highColor = 255;
    if (lowColor == null) lowColor = 4278190335;
    const self = PixelEngine;
    const rgbaLen = self.rgbaLen;
    const highRgba = self.unpackARGB(highColor);
    const lowRgba = self.unpackARGB(lowColor);
    for (let rgbaIndex = 0; rgbaIndex < rgbaLen; rgbaIndex += 4) {
        const grayValue = ~~((rgba[rgbaIndex] + rgba[rgbaIndex + 1] + rgba[rgbaIndex + 2] + 2) / 3);
        if (grayValue >= threshold) {
            rgba[rgbaIndex] = highRgba[0];
            rgba[rgbaIndex + 1] = highRgba[1];
            rgba[rgbaIndex + 2] = highRgba[2]
        } else {
            rgba[rgbaIndex] = lowRgba[0];
            rgba[rgbaIndex + 1] = lowRgba[1];
            rgba[rgbaIndex + 2] = lowRgba[2]
        }
    }
};
PixelEngine.fillColor = function (rgba, packedColor) {
    const self = PixelEngine;
    const rgbaLen = self.rgbaLen;
    const rgbaComponents = self.unpackARGB(packedColor);
    for (let rgbaIndex = 0; rgbaIndex < rgbaLen;) {
        rgba[rgbaIndex++] = rgbaComponents[0];
        rgba[rgbaIndex++] = rgbaComponents[1];
        rgba[rgbaIndex++] = rgbaComponents[2];
        rgba[rgbaIndex++] = rgbaComponents[3]
    }
};
PixelEngine.fillScalar = function (dst, value) {
    const pixelCount = dst.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount;) {
        dst[pixelIndex++] = value
    }
};
PixelEngine.buildBrightnessLUT = function (brightness, contrast) {
    brightness = brightness > 5 ? (100 - Math.max(4, brightness)) / 100 : .95;
    contrast = contrast != 100 ? Math.max(4, contrast) / 100 : .9995;
    const lut = new Uint8Array(256);
    const slope = contrast > .5 ? .5 / (1 - contrast) : contrast * 2;
    const slopeScaled = ~~(slope * 256);
    let intercept = ~~((.5 - brightness * slope) * 256) << 8;
    for (let lutIndex = 0; lutIndex < 256; lutIndex++) {
        lut[lutIndex] = PixelEngine.clamp(intercept >> 8);
        intercept += slopeScaled
    }
    return lut
};
PixelEngine.randomFill = function (dst) {
    const randField = PixelEngine._randField;
    if (randField) {
        for (let pixelIndex = 0, pixelCount = dst.length; pixelIndex < pixelCount; pixelIndex++) dst[pixelIndex] = randField[pixelIndex];
        return
    }
    for (let pixelIndex = 0, self = PixelEngine, pixelCount = dst.length; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = ~~(self.random() * 256)
    }
};
PixelEngine.randomBinary = function (dst, probability) {
    for (let pixelIndex = 0, self = PixelEngine, pixelCount = dst.length; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = self.random() < probability ? 255 : 0
    }
};
PixelEngine.randomReplace = function (dst, probability, replacementValue) {
    for (let pixelIndex = 0, self = PixelEngine, pixelCount = dst.length; pixelIndex < pixelCount; pixelIndex++) {
        if (self.random() < probability) dst[pixelIndex] = replacementValue
    }
};
PixelEngine.applyLUTOffset = function (dst, lut, offsetLut) {
    const pixelCount = dst.length;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        dst[pixelIndex] = PixelEngine.clamp(dst[pixelIndex] + offsetLut[lut[pixelIndex]])
    }
};
PixelEngine.histogram = function (src) {
    let bins = new Uint32Array(256);
    for (let pixelIndex = 0, pixelCount = src.length; pixelIndex < pixelCount; pixelIndex++) bins[src[pixelIndex]]++;
    return bins
};
PixelEngine.histogramWeighted = function (src, mask) {
    let exactCount = 0;
    let fractionalTotal = 0;
    const integerBins = new Uint32Array(256);
    const fractionalBins = new Float32Array(256);
    for (let pixelIndex = 0, pixelCount = src.length; pixelIndex < pixelCount; pixelIndex++) {
        const channelValue = src[pixelIndex];
        let maskWeight = mask[pixelIndex];
        if (maskWeight == 255) {
            integerBins[channelValue]++;
            exactCount++
        } else if (maskWeight > 0) {
            maskWeight /= 255;
            fractionalTotal += maskWeight;
            fractionalBins[channelValue] += maskWeight;
            if (fractionalTotal >= 1) {
                fractionalTotal--;
                exactCount++
            }
            if (fractionalBins[channelValue] >= 1) {
                fractionalBins[channelValue]--;
                integerBins[channelValue]++
            }
        }
    }
    return [exactCount, integerBins]
};
PixelEngine.computeLevelLUT = function (blackPointPercent, whitePointPercent, src, mask) {
    const self = PixelEngine;
    let bins;
    let pixelCountPerPercent;
    let runningCount = 0;
    let whitePointIndex = 256;
    if (mask) {
        const weightedHistogram = self.histogramWeighted(src, mask);
        bins = weightedHistogram[1];
        pixelCountPerPercent = weightedHistogram[0] / 100
    } else {
        bins = self.histogram(src);
        pixelCountPerPercent = self.pixelCount / 100
    }
    const lut = new Uint8Array(256);
    const blackTargetCount = pixelCountPerPercent * blackPointPercent;
    const whiteTargetCount = pixelCountPerPercent * whitePointPercent;
    let blackPointIndex = -1;
    do {
        runningCount += bins[++blackPointIndex]
    } while (runningCount <= blackTargetCount);
    runningCount = 0;
    do {
        runningCount += bins[--whitePointIndex]
    } while (runningCount <= whiteTargetCount);
    if (whitePointIndex - blackPointIndex <= 0) whitePointIndex = blackPointIndex + 1;
    if (whitePointIndex > 255) {
        whitePointIndex = 255;
        blackPointIndex = 254
    }
    const scale = 255 / (whitePointIndex - blackPointIndex);
    let lutOffset = -blackPointIndex;
    for (let lutIndex = 0; lutIndex < 256; lutIndex++) {
        lut[lutIndex] = self.clamp(scale * lutOffset + .5);
        lutOffset++
    }
    return lut
};
PixelEngine.applyLevels = function (dst, blackPointPercent, whitePointPercent, mask) {
    const self = PixelEngine;
    self.applyLUT(dst, self.computeLevelLUT(blackPointPercent, whitePointPercent, dst, mask))
};
PixelEngine.findPercentile = function (src, percentile) {
    const self = PixelEngine;
    let bins = self.histogram(src);
    const targetCount = self.pixelCount * percentile / 100;
    let runningCount = 0;
    let binIndex = -1;
    do {
        runningCount += bins[++binIndex]
    } while (runningCount <= targetCount);
    return binIndex
};
PixelEngine.computeGradients = function (src, gradientOut) {
    let gradientIndex = 0;
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const invPi = 1 / Math.PI;
    const angleScale = invPi * 255;
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
        let nextRowIndex = rowIndex + 1;
        if (nextRowIndex == height) nextRowIndex--;
        const rowOffset = rowIndex * width;
        const verticalCoord = ~~((1 - (rowIndex + 1) / height) * 255);
        for (let colIndex = 0; colIndex < width; colIndex++) {
            let nextColIndex = colIndex + 1;
            if (nextColIndex == width) nextColIndex--;
            const centerPixel = src[rowOffset + colIndex];
            const rightPixel = src[rowOffset + nextColIndex];
            const belowPixel = src[nextRowIndex * width + colIndex];
            if (centerPixel - belowPixel == 0) {
                gradientOut[gradientIndex++] = verticalCoord
            } else {
                let angleByte = centerPixel - belowPixel + 255;
                if (angleByte == 255) {
                    angleByte = 0
                } else {
                    angleByte = ~~(Math.atan2(1 / (255 - angleByte), 1) * angleScale + .5);
                    if (angleByte < 0) angleByte += 255
                }
                gradientOut[gradientIndex++] = angleByte
            }
            if (centerPixel - rightPixel == 0) {
                gradientOut[gradientIndex++] = ~~((1 - (colIndex + 1) / width) * 255)
            } else {
                let angleByte = centerPixel - rightPixel + 255;
                if (angleByte == 255) {
                    angleByte = 0
                } else {
                    angleByte = ~~(Math.atan2(1 / (255 - angleByte), 1) * angleScale + .5);
                    if (angleByte < 0) angleByte += 255
                }
                gradientOut[gradientIndex++] = angleByte
            }
        }
    }
};
PixelEngine.addCoordBias = function (dst, biasFactor) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    let coordIndex = 0;
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
        for (let colIndex = 0; colIndex < width; colIndex++) {
            dst[coordIndex] = ~~(rowIndex * biasFactor + .5) + ~~(dst[coordIndex] * (1 - biasFactor) + .5);
            coordIndex++;
            dst[coordIndex] = ~~(colIndex * biasFactor + .5) + ~~(dst[coordIndex] * (1 - biasFactor) + .5);
            coordIndex++
        }
    }
};
PixelEngine.blendCoords = function (srcCoords, dstCoords, dstBlendFactor, srcWeight) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    let coordIndex = 0;
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
        for (let colIndex = 0; colIndex < width; colIndex++) {
            dstCoords[coordIndex] = ~~(dstCoords[coordIndex] * (1 - dstBlendFactor) + .5) + ~~(srcCoords[coordIndex] * srcWeight + .5);
            coordIndex++;
            dstCoords[coordIndex] = ~~(dstCoords[coordIndex] * (1 - dstBlendFactor) + .5) + ~~(srcCoords[coordIndex] * srcWeight + .5);
            coordIndex++
        }
    }
};
PixelEngine.buildGrid = function (coords, gridOut, gridSize) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    let coordIndex = 0;
    let gridIndex = 0;
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
        for (let colIndex = 0; colIndex < width; colIndex++) {
            const coordY = coords[coordIndex++];
            const coordX = coords[coordIndex++];
            gridOut[gridIndex++] = coordX % gridSize >= 2 && coordY % gridSize >= 2 ? 255 : 0
        }
    }
};
PixelEngine.buildBorder = function (rowPeriod, colPeriod, rowInset, colInset, borderValue, innerValue, dst) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    let dstIndex = 0;
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
        const isBorderRow = rowIndex % rowPeriod < rowInset || height - rowInset <= rowIndex;
        for (let colIndex = 0; colIndex < width; colIndex++) {
            dst[dstIndex++] = isBorderRow || colIndex % colPeriod < colInset || width - colInset <= colIndex ? borderValue : innerValue
        }
    }
};
PixelEngine.applyPattern = function (dst, patternPath, scale, invert) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const textureBundle = PixelEngine.textureLoader(patternPath);
    const texturePixels = textureBundle[1];
    const textureWidth = textureBundle[0].s;
    const textureHeight = textureBundle[0].T;
    const sampleScale = 100 / scale;
    for (let rowIndex = 0; rowIndex < height; rowIndex++)
        for (let colIndex = 0; colIndex < width; colIndex++) {
            const sampleValue = PixelEngine.bilinearSample(colIndex * sampleScale, rowIndex * sampleScale, texturePixels, textureWidth, textureHeight);
            dst[rowIndex * width + colIndex] = invert ? 255 - sampleValue : sampleValue
        }
};
PixelEngine.clamp = function (value) {
    return ~~Math.min(255, Math.max(0, value))
};
PixelEngine.blurAmounts = [0, 5, 10, 15, 20, 25, 35, 45, 65, 85, 105, 125, 145, 165, 185, 205];
PixelEngine.blurFactors = [0, .2, .4, .5, .6, .7, .8, .9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10];
PixelEngine.blurFactor = function (blurAmount) {
    return blurAmount > 40 ? [1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 7.5, 10][blurAmount - 41] : blurAmount / 40
};
// Block-quantized averaging used by patchwork: the image becomes a grid of DxD
// tiles, each filled with the average colour of the LxL (L=D) window at the tile's
// top-left (edges clamp; per-pixel alpha is passed through). One average is computed
// per tile, so the cost is O(W*H), independent of D.
PixelEngine.gaussBlur = function (src, dst, tileSize) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    const windowSize = tileSize;
    const windowArea = windowSize * windowSize;

    const // Tiles align to the GLOBAL grid (tile tops are multiples of D in image
    // space), so a band produces the same tiling as the whole image. bandOffsetY
    // is the global row of local row 0; globalHeight for clamping. Both reduce
    // to the whole-image case (bandOffsetY=0, globalHeight=height) for single-threaded runs.
    bandOffsetY = self._bandOffY | 0;

    let globalHeight = self._bandFullH | 0;
    if (globalHeight <= 0) globalHeight = bandOffsetY + height;
    const firstTileTopGlobal = bandOffsetY - (((bandOffsetY % tileSize) + tileSize) % tileSize);
    for (let tileTopGlobalY = firstTileTopGlobal; tileTopGlobalY - bandOffsetY < height; tileTopGlobalY += tileSize) {
        const tileTopLocalY = tileTopGlobalY - bandOffsetY;
        for (let tileLeftX = 0; tileLeftX < width; tileLeftX += tileSize) {
            let sumR = 0;
            let sumG = 0;
            let sumB = 0;
            for (let windowRow = 0; windowRow < windowSize; windowRow++) {
                let globalY = tileTopGlobalY + windowRow;
                if (globalY >= globalHeight) globalY = globalHeight - 1;
                const rowBaseIndex = (globalY - bandOffsetY) * width;
                for (let windowCol = 0; windowCol < windowSize; windowCol++) {
                    let sampleX = tileLeftX + windowCol;
                    if (sampleX >= width) sampleX = width - 1;
                    let srcIndex = rowBaseIndex + sampleX << 2;
                    sumR += src[srcIndex];
                    sumG += src[srcIndex + 1];
                    sumB += src[srcIndex + 2];
                }
            }
            const avgR = ~~(sumR / windowArea);
            const avgG = ~~(sumG / windowArea);
            const avgB = ~~(sumB / windowArea);
            const yStart = tileTopLocalY < 0 ? 0 : tileTopLocalY;
            const yEnd = Math.min(tileTopLocalY + tileSize, height);
            const xEnd = Math.min(tileLeftX + tileSize, width);
            for (let tileRow = yStart; tileRow < yEnd; tileRow++) {
                const rowOffset = tileRow * width;
                for (let tileCol = tileLeftX; tileCol < xEnd; tileCol++) {
                    let dstIndex = rowOffset + tileCol << 2;
                    dst[dstIndex] = avgR;
                    dst[dstIndex + 1] = avgG;
                    dst[dstIndex + 2] = avgB;
                    dst[dstIndex + 3] = src[dstIndex + 3];
                }
            }
        }
    }
};
PixelEngine.mergeEdge = function (dst, rowPeriod, colPeriod, rowInset, colInset) {
    const self = PixelEngine;
    const width = self.width;
    const height = self.height;
    let dstIndex = 0;

    const // Row pattern is positional, so it uses the GLOBAL row index and height;
    // reduces to local (bandOffsetY=0, globalHeight=height) for whole-image runs.
    bandOffsetY = self._bandOffY | 0;

    let globalHeight = self._bandFullH | 0;
    if (globalHeight <= 0) globalHeight = height;
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
        const globalRow = bandOffsetY + rowIndex;
        const isBorderRow = globalRow % rowPeriod >= rowInset || globalRow < rowInset || globalHeight - rowInset <= globalRow;
        for (let colIndex = 0; colIndex < width; colIndex++) {
            dst[dstIndex++] = isBorderRow && (colIndex % colPeriod >= colInset || colIndex < colInset || width - colInset <= colIndex) ? 255 : 0
        }
    }
};
PixelEngine.applyTexture = function (src, dst, blendModeIndex) {
    const blendFn = buildTextureBlendFunctions()[blendModeIndex];
    let srcIndex = 0;
    let dstIndex = 0;
    for (let pixelIndex = 0; pixelIndex < PixelEngine.pixelCount; pixelIndex++) {
        const valueA = src[srcIndex++];
        const valueB = src[srcIndex++];
        dst[dstIndex++] = ~~(255 * blendFn(valueA, valueB))
    }
};

PixelEngine.bootstrapWasmKernels = function () {
    PixelEngine.loadMedianWasm();
    PixelEngine.loadBlurWasm();
};
PixelEngine.bootstrapWasmKernels();
