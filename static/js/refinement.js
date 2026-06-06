/**
 * Refinement Algorithms - Medical image-specific contour refinement methods
 * Includes: GrabCut, Random Walker, MorphGAC, Chan-Vese, and Dual-Region methods
 */

// ==================== Image Processing Utilities ====================

// Gaussian blur
function gaussianBlur(data, width, height, sigma) {
    const kernelSize = Math.ceil(sigma * 3) * 2 + 1;
    const kernel = [];
    const half = Math.floor(kernelSize / 2);
    let sum = 0;
    
    for (let i = -half; i <= half; i++) {
        const val = Math.exp(-(i * i) / (2 * sigma * sigma));
        kernel.push(val);
        sum += val;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    
    // Horizontal pass
    const temp = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let val = 0;
            for (let k = -half; k <= half; k++) {
                const xx = Math.min(Math.max(x + k, 0), width - 1);
                val += data[y * width + xx] * kernel[k + half];
            }
            temp[y * width + x] = val;
        }
    }
    
    // Vertical pass
    const result = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let val = 0;
            for (let k = -half; k <= half; k++) {
                const yy = Math.min(Math.max(y + k, 0), height - 1);
                val += temp[yy * width + x] * kernel[k + half];
            }
            result[y * width + x] = val;
        }
    }
    
    return result;
}

// Compute image gradient magnitude (edge stopping function)
function computeEdgeStoppingFunction(gray, width, height, sigma = 1.5) {
    // Gaussian blur first
    const blurred = gaussianBlur(gray, width, height, sigma);
    
    // Compute gradient magnitude
    const g = new Float32Array(width * height);
    
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            const gx = blurred[idx + 1] - blurred[idx - 1];
            const gy = blurred[idx + width] - blurred[idx - width];
            const mag = Math.sqrt(gx * gx + gy * gy);
            // Edge stopping function: g = 1 / (1 + |grad|^2)
            g[idx] = 1 / (1 + mag * mag / 1000);
        }
    }
    return g;
}

// ==================== Morphological Operations ====================

function dilate(binary, width, height, radius = 1) {
    const result = new Uint8Array(width * height);
    for (let y = radius; y < height - radius; y++) {
        for (let x = radius; x < width - radius; x++) {
            let maxVal = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx * dx + dy * dy <= radius * radius) {
                        maxVal = Math.max(maxVal, binary[(y + dy) * width + (x + dx)]);
                    }
                }
            }
            result[y * width + x] = maxVal;
        }
    }
    return result;
}

function erode(binary, width, height, radius = 1) {
    const result = new Uint8Array(width * height);
    for (let y = radius; y < height - radius; y++) {
        for (let x = radius; x < width - radius; x++) {
            let minVal = 1;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx * dx + dy * dy <= radius * radius) {
                        minVal = Math.min(minVal, binary[(y + dy) * width + (x + dx)]);
                    }
                }
            }
            result[y * width + x] = minVal;
        }
    }
    return result;
}

function morphSmooth(binary, width, height, radius = 2) {
    // Opening then closing
    let result = erode(binary, width, height, radius);
    result = dilate(result, width, height, radius);
    result = dilate(result, width, height, radius);
    result = erode(result, width, height, radius);
    return result;
}

// ==================== GrabCut-style Refinement ====================

function grabCutRefinement(binary, gray, width, height, iterations = 10) {
    // Compute foreground and background HU statistics
    let fgSum = 0, fgCount = 0, bgSum = 0, bgCount = 0;
    let fgSumSq = 0, bgSumSq = 0;
    
    for (let i = 0; i < width * height; i++) {
        if (binary[i] === 1) {
            fgSum += gray[i];
            fgSumSq += gray[i] * gray[i];
            fgCount++;
        } else if (binary[i] === 0) {
            bgSum += gray[i];
            bgSumSq += gray[i] * gray[i];
            bgCount++;
        }
    }
    
    if (fgCount === 0 || bgCount === 0) return binary;
    
    const fgMean = fgSum / fgCount;
    const bgMean = bgSum / bgCount;
    const fgVar = Math.max(1, fgSumSq / fgCount - fgMean * fgMean);
    const bgVar = Math.max(1, bgSumSq / bgCount - bgMean * bgMean);
    
    const result = new Uint8Array(width * height);
    
    for (let iter = 0; iter < iterations; iter++) {
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                const val = gray[idx];
                
                // Gaussian likelihood
                const fgProb = Math.exp(-Math.pow(val - fgMean, 2) / (2 * fgVar));
                const bgProb = Math.exp(-Math.pow(val - bgMean, 2) / (2 * bgVar));
                
                // Add spatial smoothness (neighbor voting)
                let neighborFg = 0;
                const neighbors = [
                    binary[idx - 1], binary[idx + 1],
                    binary[idx - width], binary[idx + width]
                ];
                neighbors.forEach(n => { if (n === 1) neighborFg++; });
                
                const spatialWeight = 0.3;
                const totalFg = fgProb + spatialWeight * neighborFg / 4;
                const totalBg = bgProb + spatialWeight * (4 - neighborFg) / 4;
                
                result[idx] = totalFg > totalBg ? 1 : 0;
            }
        }
        
        // Copy result back
        for (let i = 0; i < width * height; i++) binary[i] = result[i];
    }
    
    return result;
}

// ==================== Random Walker Segmentation ====================
function randomWalkerRefinement(binary, gray, g, width, height, iterations = 50) {
    const size = width * height;
    
    // Create a band around the mask boundary
    // Dilate the mask
    const dilated = dilate(binary, width, height, 3);
    // Erode the mask  
    const eroded = erode(binary, width, height, 3);
    
    // Band = dilated - eroded (pixels near the boundary)
    const band = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        band[i] = (dilated[i] === 1 && eroded[i] === 0) ? 1 : 0;
    }
    
    // Initialize probabilities from current mask
    const prob = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        prob[i] = binary[i] === 1 ? 1.0 : 0.0;
    }
    
    // Iterative diffusion - ONLY in the band
    for (let iter = 0; iter < iterations; iter++) {
        const newProb = new Float32Array(size);
        
        // Copy all probabilities first
        for (let i = 0; i < size; i++) {
            newProb[i] = prob[i];
        }
        
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                
                // Only process pixels in the band
                if (band[idx] !== 1) {
                    continue;
                }
                
                // Weighted average of neighbors
                const neighbors = [
                    { idx: idx - 1, w: g[idx - 1] },
                    { idx: idx + 1, w: g[idx + 1] },
                    { idx: idx - width, w: g[idx - width] },
                    { idx: idx + width, w: g[idx + width] }
                ];
                
                let sumP = 0, sumW = 0;
                neighbors.forEach(n => {
                    sumP += prob[n.idx] * n.w;
                    sumW += n.w;
                });
                
                newProb[idx] = sumW > 0 ? sumP / sumW : 0;
            }
        }
        
        for (let i = 0; i < size; i++) prob[i] = newProb[i];
    }
    
    // Threshold
    const result = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        result[i] = prob[i] > 0.5 ? 1 : 0;
    }
    
    return result;
}


// Keep only pixels in 'refined' that are connected to any pixel in 'seed'
function keepConnectedToSeed(refined, seed, width, height) {
    const size = width * height;
    const result = new Uint8Array(size);
    const visited = new Uint8Array(size);
    
    const neighbors = [-1, 1, -width, width];
    
    // Find all seed pixels that are also in refined (starting points for BFS)
    const queue = [];
    for (let i = 0; i < size; i++) {
        if (seed[i] === 1 && refined[i] === 1) {
            queue.push(i);
            visited[i] = 1;
            result[i] = 1;
        }
    }
    
    // BFS: expand to all connected refined pixels
    while (queue.length > 0) {
        const idx = queue.shift();
        const x = idx % width;
        
        for (const d of neighbors) {
            const nidx = idx + d;
            
            // Prevent wrap-around
            if (d === -1 && x === 0) continue;
            if (d === 1 && x === width - 1) continue;
            if (nidx < 0 || nidx >= size) continue;
            
            if (!visited[nidx] && refined[nidx] === 1) {
                visited[nidx] = 1;
                result[nidx] = 1;
                queue.push(nidx);
            }
        }
    }
    
    return result;
}

// Compute gradient magnitude for edge detection
function computeGradientMagnitude(gray, width, height) {
    const gradient = new Float32Array(width * height);
    
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            
            // Sobel-like gradient
            const gx = gray[idx + 1] - gray[idx - 1];
            const gy = gray[idx + width] - gray[idx - width];
            
            gradient[idx] = Math.sqrt(gx * gx + gy * gy);
        }
    }
    
    return gradient;
}

// Compute adaptive edge threshold (e.g., 70th percentile of non-zero gradients)
function computeEdgeThreshold(edgeMap, width, height) {
    const values = [];
    
    for (let i = 0; i < width * height; i++) {
        if (edgeMap[i] > 0) {
            values.push(edgeMap[i]);
        }
    }
    
    if (values.length === 0) return 100;
    
    values.sort((a, b) => a - b);
    
    // Use 70th percentile as threshold
    const percentileIdx = Math.floor(values.length * 0.70);
    return values[percentileIdx];
}

// Fill small holes in binary mask
function fillSmallHoles(binary, width, height, maxHoleSize) {
    const size = width * height;
    const result = new Uint8Array(binary);
    const visited = new Uint8Array(size);
    
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    
    // Find all background regions
    for (let startIdx = 0; startIdx < size; startIdx++) {
        if (binary[startIdx] === 0 && !visited[startIdx]) {
            // BFS to find connected background region
            const region = [];
            const queue = [startIdx];
            visited[startIdx] = 1;
            let touchesBorder = false;
            
            while (queue.length > 0) {
                const idx = queue.shift();
                region.push(idx);
                
                const x = idx % width;
                const y = Math.floor(idx / width);
                
                // Check if touches image border
                if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
                    touchesBorder = true;
                }
                
                for (const [dy, dx] of neighbors) {
                    const nx = x + dx;
                    const ny = y + dy;
                    
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    
                    const nidx = ny * width + nx;
                    if (!visited[nidx] && binary[nidx] === 0) {
                        visited[nidx] = 1;
                        queue.push(nidx);
                    }
                }
            }
            
            // Fill if it's a small hole not touching border
            if (!touchesBorder && region.length <= maxHoleSize) {
                for (const idx of region) {
                    result[idx] = 1;
                }
            }
        }
    }
    
    return result;
}

// ==================== Fluid-aware GrabCut Segmentation ====================
// GrabCut variant that respects HU thresholds for fluid/tagged stool regions
// Uses the same min/max HU parameters as the Fluid Brush tool
// More adaptive than pure threshold-based methods
function fluidAwareGrabCutRefinement(binary, huData, width, height, params = {}) {
    const minHU = params.minHU || -200;
    const maxHU = params.maxHU || 1200;
    const huTolerance = params.huTolerance || 150;
    
    const size = width * height;
    
    // Get seed pixel count
    let seedCount = 0;
    for (let i = 0; i < size; i++) {
        if (binary[i] === 1) seedCount++;
    }
    
    if (seedCount === 0) {
        console.log('[Fluid GrabCut] No seed pixels');
        return binary;
    }
    
    console.log(`[Fluid GrabCut] Starting flood fill from ${seedCount} seed pixels`);
    console.log(`[Fluid GrabCut] HU range: [${minHU}, ${maxHU}], tolerance: ${huTolerance}`);
    
    // Simple BFS flood fill
    const result = new Uint8Array(size);
    const visited = new Uint8Array(size);
    const queue = [];
    
    // Start from all seed pixels
    for (let i = 0; i < size; i++) {
        if (binary[i] === 1) {
            queue.push(i);
            visited[i] = 1;
            result[i] = 1;
        }
    }
    
    const neighbors = [-1, 1, -width, width];
    let addedCount = 0;
    
    while (queue.length > 0) {
        const i = queue.shift();
        const x = i % width;
        const currentHU = huData[i];
        
        for (const d of neighbors) {
            const ni = i + d;
            
            // Prevent wrap-around
            if (d === -1 && x === 0) continue;
            if (d === 1 && x === width - 1) continue;
            if (ni < 0 || ni >= size) continue;
            
            if (visited[ni]) continue;
            visited[ni] = 1;
            
            const neighborHU = huData[ni];
            
            // Criterion 1: Must be within global HU range
            if (neighborHU < minHU || neighborHU > maxHU) continue;
            
            // Criterion 2: Must be similar to current pixel (stops at edges)
            if (Math.abs(neighborHU - currentHU) > huTolerance) continue;
            
            // Accept this pixel
            result[ni] = 1;
            queue.push(ni);
            addedCount++;
        }
    }
    
    console.log(`[Fluid GrabCut] Flood fill added ${addedCount} pixels`);
    
    // Post-processing: fill small holes
    let processed = fillSmallHoles(result, width, height, 50);
    
    // Light morphological smoothing
    processed = morphSmooth(processed, width, height, 1);
    
    // One step of Random Walk for smoother edges
    const g = computeEdgeStoppingFunction(huData, width, height, 1.2);
    processed = randomWalkerRefinement(processed, huData, g, width, height, 1);
    
    console.log(`[Fluid GrabCut] Final: ${processed.reduce((a, b) => a + b, 0)} pixels`);
    
    return processed;
}

// Keep only the largest connected component
function keepLargestComponent(binary, width, height) {
    const size = width * height;
    const labels = new Int32Array(size);
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    
    let currentLabel = 0;
    const componentSizes = [];
    
    // Label connected components
    for (let startIdx = 0; startIdx < size; startIdx++) {
        if (binary[startIdx] === 1 && labels[startIdx] === 0) {
            currentLabel++;
            const queue = [startIdx];
            labels[startIdx] = currentLabel;
            let componentSize = 0;
            
            while (queue.length > 0) {
                const idx = queue.shift();
                componentSize++;
                
                const x = idx % width;
                const y = Math.floor(idx / width);
                
                for (const [dy, dx] of neighbors) {
                    const nx = x + dx;
                    const ny = y + dy;
                    
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    
                    const nidx = ny * width + nx;
                    if (binary[nidx] === 1 && labels[nidx] === 0) {
                        labels[nidx] = currentLabel;
                        queue.push(nidx);
                    }
                }
            }
            
            componentSizes[currentLabel] = componentSize;
        }
    }
    
    // Find largest component
    let largestLabel = 0;
    let largestSize = 0;
    for (let i = 1; i <= currentLabel; i++) {
        if (componentSizes[i] > largestSize) {
            largestSize = componentSizes[i];
            largestLabel = i;
        }
    }
    
    // Keep only largest
    const result = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        result[i] = labels[i] === largestLabel ? 1 : 0;
    }
    
    return result;
}

// ==================== Fluid Pocket Fill (for tagged stool/contrast) ====================
// Click-to-fill tool that captures bright fluid regions in CT colonography
// Targets high HU values (tagged stool, contrast) and stops at edges

function fluidPocketFill(seedX, seedY, gray, width, height, params = {}) {
    const minHU = params.minHU || 100;           // Minimum HU for fluid (tagged stool typically > 100-200)
    const maxGrowth = params.maxGrowth || 500;   // Max pixels to grow
    const edgeSensitivity = params.edgeSensitivity || 0.5;  // 0-1, higher = stops at weaker edges
    const huTolerance = params.huTolerance || 150;  // Allow some HU variation within fluid
    
    const size = width * height;
    const result = new Uint8Array(size);
    const visited = new Uint8Array(size);
    
    // Compute gradient magnitude for edge detection
    const gradient = computeGradientMagnitude(gray, width, height);
    const gradientThreshold = computeGradientThreshold(gradient, width, height, edgeSensitivity);
    
    // Get seed point info
    const seedIdx = seedY * width + seedX;
    const seedHU = gray[seedIdx];
    
    // Check if seed is in a bright region
    if (seedHU < minHU) {
        console.log(`Seed HU (${seedHU.toFixed(0)}) below threshold (${minHU}). Try clicking on brighter region.`);
        return result;  // Return empty - seed not in fluid
    }
    
    // BFS flood fill
    const queue = [{ idx: seedIdx, dist: 0 }];
    visited[seedIdx] = 1;
    result[seedIdx] = 1;
    
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    
    let filledCount = 1;
    
    while (queue.length > 0 && filledCount < maxGrowth) {
        const { idx, dist } = queue.shift();
        
        const x = idx % width;
        const y = Math.floor(idx / width);
        const currentHU = gray[idx];
        
        for (const [dy, dx] of neighbors) {
            const nx = x + dx;
            const ny = y + dy;
            
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            
            const nidx = ny * width + nx;
            if (visited[nidx]) continue;
            
            visited[nidx] = 1;
            
            const neighborHU = gray[nidx];
            
            // Check 1: Must be bright enough (fluid)
            if (neighborHU < minHU) continue;
            
            // Check 2: Don't cross strong edges
            if (gradient[nidx] > gradientThreshold) continue;
            
            // Check 3: HU shouldn't change too drastically (stay in same fluid pocket)
            const huDiff = Math.abs(neighborHU - seedHU);
            if (huDiff > huTolerance) continue;
            
            // Accept this pixel
            result[nidx] = 1;
            filledCount++;
            queue.push({ idx: nidx, dist: dist + 1 });
        }
    }
    
    console.log(`Fluid pocket fill: ${filledCount} pixels from seed HU=${seedHU.toFixed(0)}`);
    
    return result;
}

// Compute gradient threshold based on sensitivity (0-1)
// Higher sensitivity = lower threshold = stops at weaker edges
function computeGradientThreshold(gradient, width, height, sensitivity) {
    const values = [];
    
    for (let i = 0; i < width * height; i++) {
        if (gradient[i] > 0) {
            values.push(gradient[i]);
        }
    }
    
    if (values.length === 0) return 100;
    
    values.sort((a, b) => a - b);
    
    // sensitivity 0 = 90th percentile (only stops at very strong edges)
    // sensitivity 1 = 50th percentile (stops at medium edges)
    const percentile = 0.9 - (sensitivity * 0.4);
    const idx = Math.floor(values.length * percentile);
    
    return values[idx];
}

// Export functions globally
window.Refinement = {
    gaussianBlur,
    computeEdgeStoppingFunction,
    dilate,
    erode,
    morphSmooth,
    grabCutRefinement,
    randomWalkerRefinement,
    fluidAwareGrabCutRefinement,
    fillSmallHoles,
    keepLargestComponent,
    keepConnectedToSeed,
    computeGradientMagnitude,
    computeEdgeThreshold,
    fluidPocketFill,
    computeGradientThreshold
};
