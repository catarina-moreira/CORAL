/**
 * CORAL - Main JavaScript
 * Coordinates all modules and handles core functionality
 */

// ==================== Global State ====================
let canvas, ctx;
let nifti = null;
let ctData = null;
let ctDims = null;
let masks = null;
let currentSlice = 0;
let totalSlices = 0;
let currentMask = null;
let maskCtx = null;
let currentImage = null;
let isDrawing = false;
let isEraseMode = false;

// Bounding box mode for fluid pockets
let isBoundingBoxMode = false;
let isDrawingBBox = false;
let bboxStartX = 0, bboxStartY = 0;
let bboxEndX = 0, bboxEndY = 0;
let bboxRect = null;  // For visual feedback


// History for undo/redo
let maskHistory = [];
let historyIndex = -1;
const MAX_HISTORY = 50;

// Store original state for reset functionality
let originalSliceState = null;

// Loaded file name for server upload
let loadedCtFileName = null;

// Google Drive state
let currentDriveFolder = null;
let driveBreadcrumbPath = [];

// Zoom and Pan state
let currentZoom = 100;
const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 5;  // Smaller step for smoother zoom
let zoomAccumulator = 0;  // Accumulate scroll for slower zoom
const ZOOM_THRESHOLD = 100;  // Pixels of scroll needed for one zoom step (higher = slower)

// Pan step for keyboard panning (Ctrl+Arrow)
const PAN_STEP = 80;

// Pan state
let panX = 0;
let panY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let lastPanX = 0;
let lastPanY = 0;
let spacebarHeld = false;

// Edge detection cache
let cachedEdgeMap = null;
let cachedEdgeSlice = -1;

// Mask visibility state
let maskVisible = true;

// Initial slice when CT was loaded (for reset)
let initialSlice = 0;

// Default window values
const DEFAULT_WINDOW_CENTER = 40;
const DEFAULT_WINDOW_WIDTH = 400;

// Colors for labels
const COLORS = { 1: '#B79069', 2: '#00FF00', 3: '#0000FF', 4: '#FFFF00' };

// Label visibility state (all visible by default)
const labelVisibility = { 1: true, 2: true, 3: true, 4: true };

// Multi-slice undo state
let multiSliceUndoState = null;
let multiSliceUndoSlice = null;

// ==================== Measurement Tools State ====================
let measurementMode = null;  // null, 'distance', or 'angle'
let measurementDragging = false;  // Currently dragging a measurement
let measurementStart = null;  // Start point of current drag {x, y}
let measurementEnd = null;    // End point of current drag {x, y}
let measurementLines = [];    // For angle: array of completed lines [{start, end}, ...]
let measurementsPerSlice = {};  // Store completed measurements by slice index
let selectedMeasurementIndex = -1;  // Index of currently selected measurement (-1 = none)
let measurementUndoStack = [];  // Undo stack for measurements: [{slice, measurements}, ...]
let measurementRedoStack = [];  // Redo stack for measurements

// ==================== Comments State ====================
let commentsPerSlice = {};  // Store comments by slice index: { sliceIndex: [{id, text, timestamp}, ...] }
let commentIdCounter = 0;   // Auto-increment ID for comments
let currentPatientId = '';  // Patient ID extracted from folder path
let currentSeriesId = '';   // Series ID (DICOM folder name)

// ==================== DICOM Progressive Loading State ====================
let dicomLoader = null;           // DICOMLoader instance
let isDicomMode = false;          // true = loading from DICOM folder, false = NIfTI file
let dicomFolderId = null;         // Current DICOM folder ID on Google Drive

// ==================== Helper Function for Slice Data ====================
/**
 * Get the current slice data (HU values) regardless of loading mode
 * @returns {Float32Array|null} - HU data for current slice, or null if unavailable
 */
function getCurrentSliceHUData() {
    if (nifti) {
        const slice = nifti.getSlice(currentSlice);
        return slice ? slice.data : null;
    } else if (isDicomMode && ctDims) {
        const width = ctDims[0];
        const height = ctDims[1];
        const sliceSize = width * height;
        
        // First check if dicomLoader has the data (primary source for DICOM)
        if (dicomLoader && dicomLoader.isSliceLoaded(currentSlice)) {
            const sliceData = dicomLoader.getSliceData(currentSlice);
            if (sliceData) {
                // Also update ctData for future use and consistency
                if (ctData) {
                    const offset = currentSlice * sliceSize;
                    for (let i = 0; i < sliceSize; i++) {
                        ctData[offset + i] = sliceData[i];
                    }
                }
                return sliceData;
            }
        }
        
        // Fallback to ctData if already populated there
        if (ctData) {
            const offset = currentSlice * sliceSize;
            // Check if first pixel is non-zero (rough check that data exists)
            if (ctData[offset] !== 0) {
                const data = new Float32Array(sliceSize);
                for (let i = 0; i < sliceSize; i++) {
                    data[i] = ctData[offset + i];
                }
                return data;
            }
        }
        
        return null; // Slice not available
    }
    return null;
}

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('annotationCanvas');
    ctx = canvas.getContext('2d');
    
    setupCanvasEventListeners();
    setupKeyboardShortcuts();
    setupZoomPanControls();
    setupFileInputListeners();
});

// ==================== File Input Listeners ====================
function setupFileInputListeners() {
    // CT Scan file input
    document.getElementById('fileInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        showLoading(true);
        showStatus('Loading ' + file.name + '...', 'success');
        
        // Clear polyp data from previous scan
        clearPolypData();
        
        // Clear measurements from previous scan
        clearAllMeasurements();
        
        // Clear comments from previous scan
        clearAllComments();
        
        // Set patient/series ID from filename for NIfTI (best effort)
        const baseName = file.name.replace(/\.(nii|nii\.gz|gz)$/i, '');
        currentPatientId = baseName;
        currentSeriesId = baseName;
        
        try {
            nifti = new NIfTIReader();
            const result = await nifti.load(file);

            // Check orientation
            const orientation = nifti.getOrientationCode();
            console.log('Orientation:', orientation);
            if (orientation && orientation !== 'RAS') {
                showStatus(`⚠️ NIfTI is ${orientation}, not RAS — mask alignment may differ in 3D Slicer`, 'error');
            }

            ctData = result.data;
            ctDims = result.dims;
            totalSlices = ctDims[2];
            loadedCtFileName = file.name;
            
            masks = new Uint8Array(ctDims[0] * ctDims[1] * ctDims[2]);
            
            // Update vertical slider only
            document.getElementById('sliceSliderVertical').max = totalSlices - 1;
            document.getElementById('sliceSliderVertical').value = Math.floor(totalSlices / 2);
            
            document.getElementById('totalSlices').textContent = totalSlices;
            document.getElementById('gotoSlice').max = totalSlices;
            
            currentSlice = Math.floor(totalSlices / 2);
            initialSlice = currentSlice;  // Save for reset functionality
            
            document.getElementById('debugInfo').textContent = nifti.getDebugInfo();
            
            // Show loaded file indicator
            document.getElementById('loadedCtFile').classList.remove('hidden');
            document.getElementById('loadedCtFileName').textContent = file.name;
            
            showStatus('Loaded: ' + file.name + ' (' + ctDims.join(' x ') + ')', 'success');
            changeSliceVertical();
            fitToView();
            
            // Enable mask loading
            document.getElementById('maskInput').disabled = false;
            document.getElementById('maskStatus').textContent = 'Ready to load mask (same dimensions required)';
            document.getElementById('maskStatus').style.color = '#00d9ff';
            
        } catch (err) {
            showStatus('Error: ' + err.message, 'error');
            console.error(err);
        }
        
        showLoading(false);
    });
    
    // Mask file input
    document.getElementById('maskInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        if (!ctDims) {
            showMaskStatus('Please load a CT scan first', 'error');
            return;
        }
        
        showLoading(true);
        showMaskStatus('Loading mask ' + file.name + '...', 'loading');
        
        try {
            // Parse the mask NIfTI file
            const maskReader = new NIfTIReader();
            const maskResult = await maskReader.load(file);
            
            const maskDims = maskResult.dims;
            const maskData = maskResult.data;
            
            // Check dimensions match
            if (maskDims[0] !== ctDims[0] || maskDims[1] !== ctDims[1] || maskDims[2] !== ctDims[2]) {
                throw new Error('Mask dimensions (' + maskDims.join('x') + ') do not match CT dimensions (' + ctDims.join('x') + ')');
            }
            
            // Use the currently selected label for all non-zero mask voxels
            // Check if mask is from our tool
            const isOurTool = maskReader.isFromCTColonTool();
            
            let voxelCount = 0;
            
            if (isOurTool) {
                // From our tool: load with original labels preserved
                console.log('Mask from CTColonTool — loading with original labels');
                for (let i = 0; i < maskData.length; i++) {
                    if (maskData[i] !== 0) {
                        masks[i] = maskData[i];
                        voxelCount++;
                    }
                }
            } else {
                // External mask (e.g., 3D Slicer): reverse slice order and use selected label
                console.log('External mask — reversing slice order and applying selected label');
                const selectedLabel = parseInt(document.getElementById('labelSelect').value);
                const w = maskDims[0];
                const h = maskDims[1];
                const d = maskDims[2];
                const sliceSize = w * h;
                
                for (let z = 0; z < d; z++) {
                    const srcSliceOffset = z * sliceSize;
                    const dstSliceOffset = (d - 1 - z) * sliceSize;
                    for (let i = 0; i < sliceSize; i++) {
                        if (maskData[srcSliceOffset + i] !== 0) {
                            masks[dstSliceOffset + i] = selectedLabel;
                            voxelCount++;
                        }
                    }
                }
            }
            
            // Re-render current slice to show the mask
            renderSlice();
            updateStats();
            
            const LABEL_NAMES = {1: 'Colon', 2: 'Polyp', 3: 'Fluid Pockets', 4: 'Other'};
            if (isOurTool) {
                showMaskStatus('Loaded mask: ' + voxelCount.toLocaleString() + ' voxels (CTColonTool, labels preserved)', 'success');
                showStatus('Mask loaded with original labels', 'success');
            } else {
                const selectedLabel = parseInt(document.getElementById('labelSelect').value);
                const labelName = LABEL_NAMES[selectedLabel] || 'Label ' + selectedLabel;
                showMaskStatus('Loaded mask: ' + voxelCount.toLocaleString() + ' voxels as ' + labelName + ' (slices reversed)', 'success');
                showStatus('🔄 External mask: slices reversed, applied as ' + labelName, 'success');
            }
            
        } catch (err) {
            showMaskStatus('Error: ' + err.message, 'error');
            console.error(err);
        }
        
        showLoading(false);
    });
    
    // CSV file input
    document.getElementById('csvInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const lines = text.trim().split('\n');
            const polyps = [];
            
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;
                
                const parts = line.split(',');
                if (parts.length >= 4) {
                    const slicesStr = parts[0].trim();
                    const slices = [];
                    if (slicesStr) {
                        slicesStr.replace(/\//g, ',').split(',').forEach(s => {
                            s = s.trim();
                            if (s && !isNaN(parseInt(s))) slices.push(parseInt(s));
                        });
                    }
                    
                    polyps.push({
                        slices: slices,
                        location: parts[1].trim(),
                        histology: parts[2].trim(),
                        size: parts[3].trim(),
                        source: parts[4] ? parts[4].trim() : ''
                    });
                }
            }
            
            displayPolypData(polyps);
            showCSVStatus('Loaded: ' + file.name + ' (' + polyps.length + ' polyps)', 'success');
            
            // Show loaded file indicator
            document.getElementById('loadedCsvFile').classList.remove('hidden');
            document.getElementById('loadedCsvFileName').textContent = file.name;
            
        } catch (err) {
            showCSVStatus('Error: ' + err.message, 'error');
            console.error(err);
        }
    });
}

function showMaskStatus(msg, type) {
    const status = document.getElementById('maskStatus');
    status.textContent = msg;
    if (type === 'success') {
        status.style.color = '#00c853';
    } else if (type === 'error') {
        status.style.color = '#ff4757';
    } else if (type === 'loading') {
        status.style.color = '#ff9800';
    } else {
        status.style.color = '#888';
    }
}
// ==================== Zoom and Pan Functions ====================
function setZoom(value, preservePan = true) {
    currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, parseInt(value)));
    document.getElementById('zoomSlider').value = currentZoom;
    document.getElementById('zoomValue').textContent = currentZoom + '%';
    applyTransform();
}

function zoomIn() {
    setZoom(currentZoom + ZOOM_STEP);
}

function zoomOut() {
    setZoom(currentZoom - ZOOM_STEP);
}

function resetZoom() {
    currentZoom = 100;
    panX = 0;
    panY = 0;
    document.getElementById('zoomSlider').value = currentZoom;
    document.getElementById('zoomValue').textContent = currentZoom + '%';
    applyTransform();
}

function fitToView() {
    if (!canvas.width || !canvas.height) return;
    
    const container = document.getElementById('canvasContainer');
    const containerWidth = container.clientWidth - 20;
    const containerHeight = container.clientHeight - 20;
    
    const scaleX = containerWidth / canvas.width;
    const scaleY = containerHeight / canvas.height;
    const scale = Math.min(scaleX, scaleY, 4); // Max 400%
    
    currentZoom = Math.round(scale * 100);
    currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom));
    panX = 0;
    panY = 0;
    
    document.getElementById('zoomSlider').value = currentZoom;
    document.getElementById('zoomValue').textContent = currentZoom + '%';
    applyTransform();
}

function applyTransform() {
    const wrapper = document.getElementById('canvasWrapper');
    const scale = currentZoom / 100;
    wrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function setupZoomPanControls() {
    const container = document.getElementById('canvasContainer');
    
    // Mouse wheel zoom with accumulator for slower response
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left - rect.width / 2;
        const mouseY = e.clientY - rect.top - rect.height / 2;
        
        // Accumulate scroll delta
        zoomAccumulator += e.deltaY;
        
        // Only zoom when accumulated enough scroll
        if (Math.abs(zoomAccumulator) >= ZOOM_THRESHOLD) {
            const oldZoom = currentZoom;
            
            if (zoomAccumulator < 0) {
                currentZoom = Math.min(MAX_ZOOM, currentZoom + ZOOM_STEP);
            } else {
                currentZoom = Math.max(MIN_ZOOM, currentZoom - ZOOM_STEP);
            }
            
            // Reset accumulator
            zoomAccumulator = 0;
            
            if (oldZoom !== currentZoom) {
                const zoomFactor = currentZoom / oldZoom;
                panX = mouseX - (mouseX - panX) * zoomFactor;
                panY = mouseY - (mouseY - panY) * zoomFactor;
            }
            
            document.getElementById('zoomSlider').value = currentZoom;
            document.getElementById('zoomValue').textContent = currentZoom + '%';
            applyTransform();
        }
    }, { passive: false });
    
    // Panning with middle mouse or space+drag
    container.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (spacebarHeld && e.button === 0)) {
            e.preventDefault();
            startPan(e);
        }
    });
    
    container.addEventListener('mousemove', (e) => {
        if (isPanning) doPan(e);
    });
    
    container.addEventListener('mouseup', (e) => {
        if (e.button === 1 || (spacebarHeld && e.button === 0)) endPan();
    });
    
    container.addEventListener('mouseleave', () => {
        if (isPanning) endPan();
    });
    
    container.addEventListener('auxclick', (e) => {
        if (e.button === 1) e.preventDefault();
    });
}

function startPan(e) {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    lastPanX = panX;
    lastPanY = panY;
    canvas.classList.add('panning');
}

function doPan(e) {
    if (!isPanning) return;
    panX = lastPanX + (e.clientX - panStartX);
    panY = lastPanY + (e.clientY - panStartY);
    applyTransform();
}

function endPan() {
    isPanning = false;
    canvas.classList.remove('panning');
}

// ==================== Display Functions ====================
function showLoading(show, message = null) {
    const overlay = document.getElementById('loadingOverlay');
    overlay.classList.toggle('hidden', !show);
    if (message) {
        overlay.querySelector('.loading-text').innerHTML = message + ' <span id="loadingProgress"></span>';
    } else if (!show) {
        overlay.querySelector('.loading-text').innerHTML = 'Loading... <span id="loadingProgress"></span>';
    }
    if (!show) {
        const detail = document.getElementById('loadingDetail');
        if (detail) detail.textContent = '';
    }
}

function showStatus(msg, type) {
    const status = document.getElementById('status');
    status.textContent = msg;
    status.className = type;
    setTimeout(() => status.className = '', 5000);
}

function showCSVStatus(msg, type) {
    const status = document.getElementById('csvStatus');
    status.textContent = msg;
    status.style.padding = '10px';
    status.style.marginTop = '10px';
    status.style.borderRadius = '5px';
    status.style.display = 'block';
    status.style.background = type === 'success' ? '#00c853' : '#ff4757';
    status.style.color = type === 'success' ? '#000' : '#fff';
    setTimeout(() => { status.style.display = 'none'; }, 5000);
}

function showLoadingDetail(text) {
    const detail = document.getElementById('loadingDetail');
    if (detail) detail.textContent = text;
}

// ==================== Slice Navigation ====================
function changeSliceVertical(forcedSlice) {
    const slider = document.getElementById('sliceSliderVertical');
    const newSlice = forcedSlice !== undefined ? forcedSlice : parseInt(slider.value);

    if (currentMask && masks && currentSlice !== newSlice) {
        saveMaskSilent();
    }

    currentSlice = newSlice;
    document.getElementById('sliceNum').textContent = currentSlice + 1;
    document.getElementById('gotoSlice').value = currentSlice + 1;
    
    // Clear measurement selection when changing slices
    selectedMeasurementIndex = -1;
    
    // Update comment panel for new slice
    updateCommentPanel();
    updateCommentIndicator();
    
    if (nifti) {
        const physZ = nifti.getPhysicalZ(currentSlice);
        document.getElementById('physicalZ').textContent = physZ.toFixed(2);
    } else if (isDicomMode && dicomLoader) {
        // For DICOM mode, use actual Image Position Patient z-coordinate if available
        const sliceMeta = dicomLoader.getSliceMetadata(currentSlice);
        if (sliceMeta && sliceMeta.imagePositionPatient) {
            const physZ = sliceMeta.imagePositionPatient[2];
            document.getElementById('physicalZ').textContent = physZ.toFixed(2);
        } else {
            // Fallback: calculate from slice thickness (less accurate)
            const spacing = dicomLoader.getVoxelSpacing();
            const physZ = currentSlice * spacing[2];
            document.getElementById('physicalZ').textContent = physZ.toFixed(2);
        }
        
        // Ensure this slice is loaded (prioritize it if not)
        ensureSliceLoaded(currentSlice);
    }
    
    clearHistory();
    renderSlice();
}

(function setupSmoothSliceSlider() {
    const init = () => {
        const slider = document.getElementById('sliceSliderVertical');
        if (!slider) return;

        let pointerDown = false;
        let pointerMoved = false;
        let dragTarget = null;
        let rafId = null;

        const tick = () => {
            rafId = null;
            if (dragTarget === null || dragTarget === currentSlice) return;
            const dir = dragTarget > currentSlice ? 1 : -1;
            // Render as many slices as fit in a soft per-frame budget, then yield
            // so the browser can repaint the thumb in lockstep with the canvas.
            const start = performance.now();
            while (currentSlice !== dragTarget && (performance.now() - start) < 8) {
                changeSliceVertical(currentSlice + dir);
            }
            slider.value = currentSlice;
            if (currentSlice !== dragTarget) rafId = requestAnimationFrame(tick);
        };

        slider.addEventListener('pointerdown', () => {
            pointerDown = true;
            pointerMoved = false;
        });
        slider.addEventListener('pointermove', () => {
            if (pointerDown) pointerMoved = true;
        });
        const onUp = () => {
            if (!pointerDown && dragTarget === null) return;
            pointerDown = false;
            // Stop chasing the target immediately; thumb stays at currentSlice.
            dragTarget = null;
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            slider.value = currentSlice;
        };
        slider.addEventListener('pointerup', onUp);
        slider.addEventListener('pointercancel', onUp);
        window.addEventListener('pointerup', onUp);

        slider.addEventListener('input', () => {
            const target = parseInt(slider.value);
            if (isNaN(target)) return;

            if (pointerDown && pointerMoved) {
                // Dragging: remember where the user wants to go, but pin the thumb
                // to the rendered slice so it can never lead the canvas.
                dragTarget = target;
                if (parseInt(slider.value) !== currentSlice) slider.value = currentSlice;
                if (!rafId) rafId = requestAnimationFrame(tick);
            } else {
                // Click on the track, keyboard, or programmatic input: jump directly.
                dragTarget = null;
                if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
                changeSliceVertical();
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

function prevSlice() {
    if (currentSlice > 0) {
        // Auto-save current slice before changing
        if (currentMask && masks) {
            saveMaskSilent();
        }
        document.getElementById('sliceSliderVertical').value = currentSlice - 1;
        changeSliceVertical();
    }
}

function nextSlice() {
    if (currentSlice < totalSlices - 1) {
        // Auto-save current slice before changing
        if (currentMask && masks) {
            saveMaskSilent();
        }
        document.getElementById('sliceSliderVertical').value = currentSlice + 1;
        changeSliceVertical();
    }
}

function goToSlice(slice) {
    const targetSlice = parseInt(slice) - 1;
    if (targetSlice >= 0 && targetSlice < totalSlices) {
        // Auto-save current slice before changing
        if (currentMask && masks) {
            saveMaskSilent();
        }
        document.getElementById('sliceSliderVertical').value = targetSlice;
        changeSliceVertical();
    }
}

function gotoSliceNum() {
    const val = parseInt(document.getElementById('gotoSlice').value);
    if (val >= 1 && val <= totalSlices) goToSlice(val);
}

// ==================== Rendering ====================
function renderSlice() {
    // Handle both NIfTI and DICOM modes
    let data, width, height;
    
    if (nifti) {
        // NIfTI mode
        const slice = nifti.getSlice(currentSlice);
        data = slice.data;
        width = slice.width;
        height = slice.height;
    } else if (isDicomMode && ctDims) {
        // DICOM mode
        width = ctDims[0];
        height = ctDims[1];
        const sliceSize = width * height;
        
        // First try to get data directly from dicomLoader (primary source)
        if (dicomLoader && dicomLoader.isSliceLoaded(currentSlice)) {
            const sliceData = dicomLoader.getSliceData(currentSlice);
            if (sliceData) {
                data = sliceData;
                // Also update ctData for consistency
                if (ctData) {
                    const offset = currentSlice * sliceSize;
                    for (let i = 0; i < sliceSize; i++) {
                        ctData[offset + i] = sliceData[i];
                    }
                }
            }
        }
        
        // Fallback to ctData if dicomLoader didn't have it
        if (!data && ctData) {
            const offset = currentSlice * sliceSize;
            if (ctData[offset] !== 0) {
                data = new Float32Array(sliceSize);
                for (let i = 0; i < sliceSize; i++) {
                    data[i] = ctData[offset + i];
                }
            }
        }
        
        // If still no data, show placeholder
        if (!data) {
            renderSlicePlaceholder(width, height);
            if (dicomLoader) dicomLoader.prioritizeSlice(currentSlice);
            return;
        }
    } else {
        return; // No data available
    }
    
    const isFirstRender = canvas.width === 0 || canvas.width !== width;
    
    canvas.width = width;
    canvas.height = height;
    currentImage = ctx.createImageData(width, height);
    
    const wc = parseInt(document.getElementById('windowCenter').value);
    const ww = parseInt(document.getElementById('windowWidth').value);
    const wmin = wc - ww / 2;
    const wmax = wc + ww / 2;
    
    for (let i = 0; i < data.length; i++) {
        const val = data[i];
        let normalized = (val - wmin) / (wmax - wmin);
        normalized = Math.max(0, Math.min(1, normalized));
        const pixel = Math.round(normalized * 255);
        
        const idx = i * 4;
        currentImage.data[idx] = pixel;
        currentImage.data[idx + 1] = pixel;
        currentImage.data[idx + 2] = pixel;
        currentImage.data[idx + 3] = 255;
    }
    
    if (!currentMask || currentMask.width !== width || currentMask.height !== height) {
        currentMask = document.createElement('canvas');
        currentMask.width = width;
        currentMask.height = height;
        maskCtx = currentMask.getContext('2d');
    } else {
        maskCtx.clearRect(0, 0, width, height);
    }
    
    const sliceOffset = currentSlice * width * height;
    for (let i = 0; i < width * height; i++) {
        const label = masks[sliceOffset + i];
        if (label > 0 && COLORS[label]) {
            const x = i % width;
            const y = Math.floor(i / width);
            maskCtx.fillStyle = COLORS[label];
            maskCtx.fillRect(x, y, 1, 1);
        }
    }
    
    originalSliceState = currentMask.toDataURL();
    
    redraw();
    saveToHistory();
    updateCursor();
    
    if (isFirstRender) {
        setTimeout(fitToView, 50);
    }
}

// Render a placeholder when DICOM slice is not yet loaded
function renderSlicePlaceholder(width, height) {
    canvas.width = width;
    canvas.height = height;
    
    // Create a dark gray background with loading indicator
    currentImage = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        currentImage.data[idx] = 30;     // Dark gray
        currentImage.data[idx + 1] = 30;
        currentImage.data[idx + 2] = 40;
        currentImage.data[idx + 3] = 255;
    }
    ctx.putImageData(currentImage, 0, 0);
    
    // Draw loading text
    ctx.fillStyle = '#ff9800';
    ctx.font = '20px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⏳ Loading slice ' + (currentSlice + 1) + '...', width / 2, height / 2 - 15);
    
    ctx.fillStyle = '#888';
    ctx.font = '14px Arial';
    ctx.fillText('Please wait or navigate to a loaded slice', width / 2, height / 2 + 15);
    
    // Show which slices are available
    if (dicomLoader) {
        const loaded = dicomLoader.loadedSlices.size;
        const total = dicomLoader.sliceCount;
        ctx.fillStyle = '#4caf50';
        ctx.font = '12px Arial';
        ctx.fillText(`${loaded}/${total} slices loaded`, width / 2, height / 2 + 40);
    }
}

function redraw() {
    ctx.putImageData(currentImage, 0, 0);
    if (maskVisible && currentMask) {
        // Check if all labels are visible
        const allVisible = Object.values(labelVisibility).every(v => v);
        
        if (allVisible) {
            // Fast path: draw entire mask
            ctx.globalAlpha = 0.5;
            ctx.drawImage(currentMask, 0, 0);
            ctx.globalAlpha = 1.0;
        } else {
            // Selective drawing: only show visible labels
            const width = currentMask.width;
            const height = currentMask.height;
            const maskData = maskCtx.getImageData(0, 0, width, height);
            const filteredData = ctx.createImageData(width, height);
            
            // Pre-compute color values
            const colorValues = {};
            for (const [label, color] of Object.entries(COLORS)) {
                colorValues[label] = {
                    r: parseInt(color.substr(1, 2), 16),
                    g: parseInt(color.substr(3, 2), 16),
                    b: parseInt(color.substr(5, 2), 16)
                };
            }
            
            for (let i = 0; i < width * height; i++) {
                const idx = i * 4;
                const r = maskData.data[idx];
                const g = maskData.data[idx + 1];
                const b = maskData.data[idx + 2];
                const a = maskData.data[idx + 3];
                
                if (a > 0) {
                    // Find which label this pixel belongs to
                    let bestLabel = 0;
                    let bestDist = Infinity;
                    
                    for (const [label, cv] of Object.entries(colorValues)) {
                        const dist = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestLabel = parseInt(label);
                        }
                    }
                    
                    // Only show if this label is visible
                    if (bestDist < 100 && labelVisibility[bestLabel]) {
                        filteredData.data[idx] = r;
                        filteredData.data[idx + 1] = g;
                        filteredData.data[idx + 2] = b;
                        filteredData.data[idx + 3] = 128; // 50% alpha
                    }
                }
            }
            
            // Create temporary canvas for filtered mask
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = width;
            tempCanvas.height = height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.putImageData(filteredData, 0, 0);
            
            ctx.drawImage(tempCanvas, 0, 0);
        }
    }
    
    // Draw measurements on top of everything
    drawMeasurements();
}

function toggleLabelVisibility(label) {
    labelVisibility[label] = !labelVisibility[label];
    
    // Update UI
    const legendItem = document.getElementById('legend-' + label);
    const eyeIcon = document.getElementById('eye-' + label);
    
    if (labelVisibility[label]) {
        legendItem.classList.remove('label-hidden');
        eyeIcon.textContent = '👁️';
    } else {
        legendItem.classList.add('label-hidden');
        eyeIcon.textContent = '🙈';
    }
    
    // Redraw to reflect visibility change
    redraw();
}

function updateWL() {
    const wc = document.getElementById('windowCenter').value;
    const ww = document.getElementById('windowWidth').value;
    document.getElementById('wcVal').value = wc;
    document.getElementById('wwVal').value = ww;
    document.getElementById('wcTop').textContent = wc;
    document.getElementById('wwTop').textContent = ww;
    
    // Update display without losing mask (works for both NIfTI and DICOM)
    if (nifti && currentImage) {
        updateImageDisplay();
    } else if (isDicomMode && ctDims && currentImage) {
        updateImageDisplay();
    }
}

function updateWLFromInput() {
    const wc = parseInt(document.getElementById('wcVal').value) || 0;
    const ww = parseInt(document.getElementById('wwVal').value) || 1;
    
    // Clamp values to valid range
    const clampedWC = Math.max(-1000, Math.min(1000, wc));
    const clampedWW = Math.max(1, Math.min(4000, ww));
    
    // Update sliders
    document.getElementById('windowCenter').value = clampedWC;
    document.getElementById('windowWidth').value = clampedWW;
    
    // Update input fields if clamped
    document.getElementById('wcVal').value = clampedWC;
    document.getElementById('wwVal').value = clampedWW;
    
    // Update top bar displays
    document.getElementById('wcTop').textContent = clampedWC;
    document.getElementById('wwTop').textContent = clampedWW;
    
    // Update image (works for both NIfTI and DICOM)
    if (nifti && currentImage) {
        updateImageDisplay();
    } else if (isDicomMode && ctDims && currentImage) {
        updateImageDisplay();
    }
}

function updateImageDisplay() {
    console.log('updateImageDisplay called');
    console.log('isDicomMode:', isDicomMode);
    console.log('ctDims:', ctDims);
    console.log('currentImage:', currentImage);
    console.log('dicomLoader:', dicomLoader);
    console.log('currentSlice:', currentSlice);
    
    // Handle both NIfTI and DICOM modes
    let data, width, height;
    
    if (nifti) {
        console.log('Using NIfTI path');
        const slice = nifti.getSlice(currentSlice);
        data = slice.data;
        width = slice.width;
        height = slice.height;
    } else if (isDicomMode && ctDims) {
        console.log('Using DICOM path');
        width = ctDims[0];
        height = ctDims[1];
        const sliceSize = width * height;
        
        // First try to get data directly from dicomLoader (primary source)
        if (dicomLoader && dicomLoader.isSliceLoaded(currentSlice)) {
            console.log('Slice is loaded in dicomLoader');
            const sliceData = dicomLoader.getSliceData(currentSlice);
            console.log('sliceData:', sliceData ? 'exists' : 'null');
            if (sliceData) {
                data = sliceData;
                // Also update ctData for consistency
                if (ctData) {
                    const offset = currentSlice * sliceSize;
                    for (let i = 0; i < sliceSize; i++) {
                        ctData[offset + i] = sliceData[i];
                    }
                }
            }
        } else {
            console.log('Slice NOT loaded in dicomLoader, isSliceLoaded:', dicomLoader ? dicomLoader.isSliceLoaded(currentSlice) : 'no loader');
        }
        
        // Fallback to ctData if dicomLoader didn't have it
        if (!data && ctData) {
            console.log('Trying ctData fallback');
            const offset = currentSlice * sliceSize;
            // Check multiple pixels since first pixel could legitimately be 0
            if (ctData[offset] !== 0 || ctData[offset + 1] !== 0 || ctData[offset + sliceSize/2] !== 0) {
                console.log('ctData has data');
                data = new Float32Array(sliceSize);
                for (let i = 0; i < sliceSize; i++) {
                    data[i] = ctData[offset + i];
                }
            } else {
                console.log('ctData appears empty at offset', offset);
            }
        }
        
        if (!data) {
            console.log('No data available, returning');
            return; // Can't update if slice not available
        }
    } else {
        console.log('Neither NIfTI nor DICOM conditions met');
        return;
    }
    
    console.log('Data obtained, length:', data.length);
    
    const wc = parseInt(document.getElementById('windowCenter').value);
    const ww = parseInt(document.getElementById('windowWidth').value);
    const wmin = wc - ww / 2;
    const wmax = wc + ww / 2;
    
    console.log('Window settings - WC:', wc, 'WW:', ww, 'wmin:', wmin, 'wmax:', wmax);
    
    for (let i = 0; i < data.length; i++) {
        const val = data[i];
        let normalized = (val - wmin) / (wmax - wmin);
        normalized = Math.max(0, Math.min(1, normalized));
        const pixel = Math.round(normalized * 255);
        
        const idx = i * 4;
        currentImage.data[idx] = pixel;
        currentImage.data[idx + 1] = pixel;
        currentImage.data[idx + 2] = pixel;
    }
    
    console.log('Pixels updated, calling redraw');
    
    // Update toolbar display
    document.getElementById('wcTop').textContent = wc;
    document.getElementById('wwTop').textContent = ww;
    
    redraw();
}

// ==================== Drawing Functions ====================
function setupCanvasEventListeners() {
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseleave', stopDrawing);
}

function startDrawing(e) {
    if (isPanning || spacebarHeld) return;
    if (e.button !== 0) return;
    
    
    // Bounding box mode
    if (isBoundingBoxMode && !isEraseMode) {
        const wrapper = document.getElementById('canvasWrapper');
        const wrapperRect = wrapper.getBoundingClientRect();
        const scale = currentZoom / 100;
        const x = (e.clientX -wrapperRect.left) / scale;
        const y = (e.clientY -  wrapperRect.top) / scale;
        
        bboxStartX = x;
        bboxStartY = y;
        bboxEndX = x;
        bboxEndY = y;
        isDrawingBBox = true;
        return;
    }
    
    // Handle measurement mode - start drag
    if (measurementMode) {
        startMeasurementDrag(e);
        return;
    }
    
    if (!maskCtx) return;
    
    isDrawing = true;
    draw(e);
}

function draw(e) {
    // Handle measurement drag update
    if (measurementDragging && measurementMode) {
        updateMeasurementDrag(e);
        return;
    }

    // Bounding box mode
    if (isDrawingBBox && isBoundingBoxMode) {
        const wrapper = document.getElementById('canvasWrapper');
        const wrapperRect = wrapper.getBoundingClientRect();
        const scale = currentZoom / 100;
        const x = (e.clientX - wrapperRect.left) / scale;
        const y = (e.clientY -  wrapperRect.top) / scale;
        
        bboxEndX = x;
        bboxEndY = y;
        
        // Redraw to show rectangle
        redraw();
        drawBoundingBoxPreview();
        return;
    }
    
    if (!isDrawing || !maskCtx || isPanning || spacebarHeld) return;
    
    const wrapper = document.getElementById('canvasWrapper');
    const wrapperRect = wrapper.getBoundingClientRect();
    const scale = currentZoom / 100;
    
    // Calculate position relative to the canvas
    const x = (e.clientX - wrapperRect.left) / scale;
    const y = (e.clientY - wrapperRect.top) / scale;
    
    // Check if within canvas bounds
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return;
    
    const brush = parseInt(document.getElementById('brushSize').value);
    const edgeAware = document.getElementById('edgeAwareBrush').checked;
    const edgeSensitivity = parseInt(document.getElementById('edgeSensitivity').value) / 100;
    
    // Get selected label
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    const selectedColor = COLORS[selectedLabel];
    const selR = parseInt(selectedColor.substr(1, 2), 16);
    const selG = parseInt(selectedColor.substr(3, 2), 16);
    const selB = parseInt(selectedColor.substr(5, 2), 16);
    
    // Pre-compute all label colors for matching
    const colorValues = {};
    for (const [label, color] of Object.entries(COLORS)) {
        colorValues[label] = {
            r: parseInt(color.substr(1, 2), 16),
            g: parseInt(color.substr(3, 2), 16),
            b: parseInt(color.substr(5, 2), 16)
        };
    }
    
    if (isEraseMode) {
        // Label-specific erase: only erase pixels matching selected label
        const width = canvas.width;
        const height = canvas.height;
        const radius = brush / 2;
        const imageData = maskCtx.getImageData(0, 0, width, height);
        
        const minX = Math.max(0, Math.floor(x - radius));
        const maxX = Math.min(width - 1, Math.ceil(x + radius));
        const minY = Math.max(0, Math.floor(y - radius));
        const maxY = Math.min(height - 1, Math.ceil(y + radius));
        
        for (let py = minY; py <= maxY; py++) {
            for (let px = minX; px <= maxX; px++) {
                const dx = px - x;
                const dy = py - y;
                if (dx * dx + dy * dy <= radius * radius) {
                    const idx = (py * width + px) * 4;
                    const r = imageData.data[idx];
                    const g = imageData.data[idx + 1];
                    const b = imageData.data[idx + 2];
                    const a = imageData.data[idx + 3];
                    
                    if (a > 0) {
                        // Check if this pixel matches the selected label
                        const dist = Math.abs(r - selR) + Math.abs(g - selG) + Math.abs(b - selB);
                        if (dist < 100) {
                            // Erase only this label
                            imageData.data[idx + 3] = 0;
                        }
                    }
                }
            }
        }
        
        maskCtx.putImageData(imageData, 0, 0);
    } else {
        // Draw mode: paint with selected color, don't overwrite other labels
        const fluidBrush = document.getElementById('fluidBrush').checked;
        
        if (fluidBrush) {
            // Fluid brush: only paint bright pixels (tagged stool/fluid)
            drawFluidAware(x, y, brush, selectedColor, edgeSensitivity);
        } else if (edgeAware) {
            drawEdgeAware(x, y, brush, selectedColor, false, edgeSensitivity);
        } else {
            // Label-aware drawing: don't overwrite pixels from other labels
            const width = canvas.width;
            const height = canvas.height;
            const radius = brush / 2;
            const imageData = maskCtx.getImageData(0, 0, width, height);
            
            const minX = Math.max(0, Math.floor(x - radius));
            const maxX = Math.min(width - 1, Math.ceil(x + radius));
            const minY = Math.max(0, Math.floor(y - radius));
            const maxY = Math.min(height - 1, Math.ceil(y + radius));
            
            for (let py = minY; py <= maxY; py++) {
                for (let px = minX; px <= maxX; px++) {
                    const dx = px - x;
                    const dy = py - y;
                    if (dx * dx + dy * dy <= radius * radius) {
                        const idx = (py * width + px) * 4;
                        const r = imageData.data[idx];
                        const g = imageData.data[idx + 1];
                        const b = imageData.data[idx + 2];
                        const a = imageData.data[idx + 3];
                        
                        // Check if pixel is empty or has same label
                        let canPaint = true;
                        if (a > 0) {
                            // Find which label this pixel belongs to
                            let pixelLabel = 0;
                            let bestDist = Infinity;
                            for (const [label, cv] of Object.entries(colorValues)) {
                                const d = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                                if (d < bestDist) {
                                    bestDist = d;
                                    pixelLabel = parseInt(label);
                                }
                            }
                            // Only paint if same label or no valid label
                            if (bestDist < 100 && pixelLabel !== selectedLabel) {
                                canPaint = false; // Different label, don't overwrite
                            }
                        }
                        
                        if (canPaint) {
                            imageData.data[idx] = selR;
                            imageData.data[idx + 1] = selG;
                            imageData.data[idx + 2] = selB;
                            imageData.data[idx + 3] = 255;
                        }
                    }
                }
            }
            
            maskCtx.putImageData(imageData, 0, 0);
        }
    }
    
    redraw();
}

function toggleBoundingBoxMode() {
    const checkbox = document.getElementById('fluidBoundingBox');
    const instructions = document.getElementById('bboxInstructions');
    isBoundingBoxMode = checkbox.checked;
    
    if (instructions) {
        instructions.style.display = isBoundingBoxMode ? 'block' : 'none';
    }

     // Update cursor based on mode
    updateCursor();
    
    if (isBoundingBoxMode) {
        showStatus('📦 Bounding Box Mode: Draw a rectangle around the fluid region', 'success');
    } else {
        showStatus('Bounding Box Mode disabled', 'success');
    }
}


function stopDrawing() {
    // Handle measurement drag end
    if (measurementDragging && measurementMode) {
        endMeasurementDrag();
        return;
    }

    // Bounding box mode - execute fill on release
    if (isDrawingBBox && isBoundingBoxMode) {
        isDrawingBBox = false;
        fillBoundingBoxByHU();
        saveToHistory();
        redraw();
        return;
    }
    
    if (isDrawing) {
        isDrawing = false;
        saveToHistory();
    }
}

// Edge-aware brush: only paints pixels where edges are weak AND HU is similar
// Also label-aware: doesn't overwrite other labels
function drawEdgeAware(cx, cy, brushSize, color, isErase, edgeSensitivity) {
    const width = canvas.width;
    const height = canvas.height;
    const radius = brushSize / 2;
    const edgeMap = getEdgeMap();
    
    // Get HU data for intensity-based clipping
    const huData = getCurrentSliceHUData();
    
    // Thresholds
    const edgeThreshold = edgeSensitivity;
    const huTolerance = parseInt(document.getElementById('huTolerance').value);
    
    // Get image data to draw pixel by pixel
    const imageData = maskCtx.getImageData(0, 0, width, height);
    const data = imageData.data;
    
    // Parse color
    let cr = 0, cg = 0, cb = 0;
    if (color) {
        cr = parseInt(color.substr(1, 2), 16);
        cg = parseInt(color.substr(3, 2), 16);
        cb = parseInt(color.substr(5, 2), 16);
    }
    
    // Get selected label for label-aware operations
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    
    // Pre-compute all label colors for matching
    const colorValues = {};
    for (const [label, clr] of Object.entries(COLORS)) {
        colorValues[label] = {
            r: parseInt(clr.substr(1, 2), 16),
            g: parseInt(clr.substr(3, 2), 16),
            b: parseInt(clr.substr(5, 2), 16)
        };
    }
    
    // Get reference values at brush center
    const centerIdx = Math.floor(cy) * width + Math.floor(cx);
    const centerDisplayIntensity = currentImage.data[centerIdx * 4];
    const centerHU = huData ? huData[centerIdx] : centerDisplayIntensity;
    
    // Draw within brush radius, respecting edges and HU
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));
    
    for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
            // Check if within brush circle
            const dx = px - cx;
            const dy = py - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist <= radius) {
                const idx = py * width + px;
                const pixelIdx = idx * 4;
                
                // Check 1: Edge strength along path from center to this pixel
                let maxEdgeOnPath = 0;
                const steps = Math.max(1, Math.floor(dist));
                
                for (let s = 1; s <= steps; s++) {
                    const t = s / steps;
                    const sx = Math.floor(cx + dx * t);
                    const sy = Math.floor(cy + dy * t);
                    const sIdx = sy * width + sx;
                    
                    if (sIdx >= 0 && sIdx < edgeMap.length) {
                        maxEdgeOnPath = Math.max(maxEdgeOnPath, edgeMap[sIdx]);
                    }
                }
                
                // Check 2: HU/intensity similarity to center
                const pixelHU = huData ? huData[idx] : currentImage.data[pixelIdx];
                const huDiff = Math.abs(pixelHU - centerHU);
                
                // Combine both criteria
                const passesEdge = maxEdgeOnPath < edgeThreshold;
                const passesHU = huDiff <= huTolerance;
                
                if (passesEdge && passesHU) {
                    if (isErase) {
                        // Label-specific erase
                        const r = data[pixelIdx];
                        const g = data[pixelIdx + 1];
                        const b = data[pixelIdx + 2];
                        const a = data[pixelIdx + 3];
                        
                        if (a > 0) {
                            const dist = Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb);
                            if (dist < 100) {
                                data[pixelIdx + 3] = 0;
                            }
                        }
                    } else {
                        // Label-aware drawing: don't overwrite other labels
                        const r = data[pixelIdx];
                        const g = data[pixelIdx + 1];
                        const b = data[pixelIdx + 2];
                        const a = data[pixelIdx + 3];
                        
                        let canPaint = true;
                        if (a > 0) {
                            // Find which label this pixel belongs to
                            let pixelLabel = 0;
                            let bestDist = Infinity;
                            for (const [label, cv] of Object.entries(colorValues)) {
                                const d = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                                if (d < bestDist) {
                                    bestDist = d;
                                    pixelLabel = parseInt(label);
                                }
                            }
                            if (bestDist < 100 && pixelLabel !== selectedLabel) {
                                canPaint = false;
                            }
                        }
                        
                        if (canPaint) {
                            data[pixelIdx] = cr;
                            data[pixelIdx + 1] = cg;
                            data[pixelIdx + 2] = cb;
                            data[pixelIdx + 3] = 255;
                        }
                    }
                }
            }
        }
    }
    
    maskCtx.putImageData(imageData, 0, 0);
}

function getEdgeMap() {
    const width = canvas.width;
    const height = canvas.height;
    
    if (cachedEdgeSlice === currentSlice && cachedEdgeMap) {
        return cachedEdgeMap;
    }
    
    const edgeMap = new Float32Array(width * height);
    
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            const gx = currentImage.data[(idx + 1) * 4] - currentImage.data[(idx - 1) * 4];
            const gy = currentImage.data[(idx + width) * 4] - currentImage.data[(idx - width) * 4];
            edgeMap[idx] = Math.sqrt(gx * gx + gy * gy);
        }
    }
    
    cachedEdgeMap = edgeMap;
    cachedEdgeSlice = currentSlice;
    return edgeMap;
}

// Fluid-aware brush: only paints bright pixels (tagged stool/fluid pockets)
function drawFluidAware(cx, cy, brushSize, color, edgeSensitivity) {
    const width = canvas.width;
    const height = canvas.height;
    const edgeMap = getEdgeMap();
    
    // Get HU data
    const huData = getCurrentSliceHUData();
    
    if (!huData) {
        console.log('Fluid brush requires HU data');
        return;
    }
    
    // Get minimum HU threshold for fluid
    const minHU = parseInt(document.getElementById('fluidMinHU').value);
    const edgeThreshold = edgeSensitivity;
    const floodFillMode = document.getElementById('fluidFloodFill').checked;
    
    // Get image data to draw pixel by pixel
    const imageData = maskCtx.getImageData(0, 0, width, height);
    const data = imageData.data;
    
    // Parse color
    const cr = parseInt(color.substr(1, 2), 16);
    const cg = parseInt(color.substr(3, 2), 16);
    const cb = parseInt(color.substr(5, 2), 16);
    
    // Get selected label for label-aware operations
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    
    // Pre-compute all label colors for matching
    const colorValues = {};
    for (const [label, clr] of Object.entries(COLORS)) {
        colorValues[label] = {
            r: parseInt(clr.substr(1, 2), 16),
            g: parseInt(clr.substr(3, 2), 16),
            b: parseInt(clr.substr(5, 2), 16)
        };
    }
    
    // Check if center point is in fluid region
    const centerIdx = Math.floor(cy) * width + Math.floor(cx);
    const centerHU = huData[centerIdx];
    
    if (floodFillMode) {
        // Flood fill mode: fill entire connected bright region
        if (centerHU < minHU) {
            showStatus(`HU at click: ${centerHU.toFixed(0)} (below ${minHU} threshold - click on brighter area)`, 'warning');
            return;
        }
        
        const visited = new Uint8Array(width * height);
        const queue = [centerIdx];
        visited[centerIdx] = 1;
        
        let filledCount = 0;
        const maxFill = 50000;  // Safety limit
        
        while (queue.length > 0 && filledCount < maxFill) {
            const idx = queue.shift();
            const pixelIdx = idx * 4;
            
            // Check: Don't overwrite other labels
            const a = data[pixelIdx + 3];
            let canPaint = true;
            
            if (a > 0) {
                const r = data[pixelIdx];
                const g = data[pixelIdx + 1];
                const b = data[pixelIdx + 2];
                
                let pixelLabel = 0;
                let bestDist = Infinity;
                
                for (const [label, cv] of Object.entries(colorValues)) {
                    const d = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                    if (d < bestDist) {
                        bestDist = d;
                        pixelLabel = parseInt(label);
                    }
                }
                
                if (bestDist < 100 && pixelLabel !== selectedLabel) {
                    canPaint = false;
                }
            }
            
            if (canPaint) {
                data[pixelIdx] = cr;
                data[pixelIdx + 1] = cg;
                data[pixelIdx + 2] = cb;
                data[pixelIdx + 3] = 255;
                filledCount++;
            }
            
            // Check 4-connected neighbors
            const x = idx % width;
            const y = Math.floor(idx / width);
            const neighbors = [
                [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]
            ];
            
            for (const [nx, ny] of neighbors) {
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                
                const nidx = ny * width + nx;
                if (visited[nidx]) continue;
                visited[nidx] = 1;
                
                // Check if neighbor is bright enough
                const neighborHU = huData[nidx];
                if (neighborHU < minHU) continue;
                
                // Check edge - don't cross strong edges
                if (edgeMap[nidx] > edgeThreshold * 200) continue;
                
                queue.push(nidx);
            }
        }
        
        maskCtx.putImageData(imageData, 0, 0);
        showStatus(`💧 Filled ${filledCount} pixels (HU ≥ ${minHU})`, 'success');
        return;
    }
    
    // Normal brush mode (not flood fill)
    const radius = brushSize / 2;
    
    // Draw within brush radius, only on bright pixels
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));
    
    let paintedCount = 0;
    
    for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
            // Check if within brush circle
            const dx = px - cx;
            const dy = py - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist <= radius) {
                const idx = py * width + px;
                const pixelIdx = idx * 4;
                
                // Check 1: Pixel must be bright enough (fluid/tagged stool)
                const pixelHU = huData[idx];
                if (pixelHU < minHU) continue;
                
                // Check 2: Edge strength - don't cross strong edges
                const steps = Math.max(1, Math.floor(dist));
                let maxEdgeOnPath = 0;
                
                for (let s = 1; s <= steps; s++) {
                    const t = s / steps;
                    const sx = Math.floor(cx + dx * t);
                    const sy = Math.floor(cy + dy * t);
                    const sIdx = sy * width + sx;
                    
                    if (sIdx >= 0 && sIdx < edgeMap.length) {
                        maxEdgeOnPath = Math.max(maxEdgeOnPath, edgeMap[sIdx]);
                    }
                }
                
                if (maxEdgeOnPath >= edgeThreshold * 255) continue;
                
                // Check 3: Don't overwrite other labels
                const a = data[pixelIdx + 3];
                let canPaint = true;
                
                if (a > 0) {
                    const r = data[pixelIdx];
                    const g = data[pixelIdx + 1];
                    const b = data[pixelIdx + 2];
                    
                    let pixelLabel = 0;
                    let bestDist = Infinity;
                    
                    for (const [label, cv] of Object.entries(colorValues)) {
                        const d = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                        if (d < bestDist) {
                            bestDist = d;
                            pixelLabel = parseInt(label);
                        }
                    }
                    
                    if (bestDist < 100 && pixelLabel !== selectedLabel) {
                        canPaint = false;
                    }
                }
                
                if (canPaint) {
                    data[pixelIdx] = cr;
                    data[pixelIdx + 1] = cg;
                    data[pixelIdx + 2] = cb;
                    data[pixelIdx + 3] = 255;
                    paintedCount++;
                }
            }
        }
    }
    
    maskCtx.putImageData(imageData, 0, 0);
    
    // Show feedback on first stroke
    if (paintedCount === 0 && centerHU < minHU) {
        showStatus(`HU at cursor: ${centerHU.toFixed(0)} (below ${minHU} threshold)`, 'warning');
    }
}

// Toggle fluid brush options visibility
function toggleFluidBrush() {
    const checkbox = document.getElementById('fluidBrush');
    const options = document.getElementById('fluidBrushOptions');
    const propagateInfo = document.getElementById('fluidPropagateInfo');
    const propagateMethod = document.getElementById('propagateMethod');
    const fluidFloodFill = document.getElementById('fluidFloodFill');
    
    options.style.display = checkbox.checked ? 'block' : 'none';

    // If unchecking Fluid Brush, also disable Bounding Box mode
    if (!checkbox.checked) {
        const fluidBoundingBox = document.getElementById('fluidBoundingBox');
        if (fluidBoundingBox && fluidBoundingBox.checked) {
            fluidBoundingBox.checked = false;
            toggleBoundingBoxMode();
        }
    }
    
    if (checkbox.checked) {
        // Auto-enable Flood Fill mode when Fluid Brush is turned on
        if (fluidFloodFill) {
            fluidFloodFill.checked = true;
        }
        showStatus('💧 Fluid Brush ON - Flood Fill mode enabled for bright regions', 'success');
        // Also switch refinement and propagation to Random Walker
        const refineMethod = document.getElementById('refineMethod');
        if (refineMethod) {
            refineMethod.value = 'randomwalk';
        }
        if (propagateMethod) {
            propagateMethod.value = 'randomwalk';
            if (propagateInfo) propagateInfo.style.display = 'none';
        }
    }
}

// Toggle fluid brush advanced options
function toggleFluidAdvanced() {
    const checkbox = document.getElementById('showFluidAdvanced');
    const options = document.getElementById('fluidAdvancedOptions');
    options.style.display = checkbox.checked ? 'block' : 'none';
}

// Toggle fluid propagate info based on method selection
function togglePropagateMethod() {
    const method = document.getElementById('propagateMethod').value;
    const info = document.getElementById('fluidPropagateInfo');
    if (info) {
        info.style.display = method === 'fluid' ? 'block' : 'none';
    }
}

// Handle label change - set appropriate defaults for brushes and refinement methods
function onLabelChange() {
    const label = parseInt(document.getElementById('labelSelect').value);
    const edgeAwareBrush = document.getElementById('edgeAwareBrush');
    const fluidBrush = document.getElementById('fluidBrush');
    const fluidBrushOptions = document.getElementById('fluidBrushOptions');
    const refineMethod = document.getElementById('refineMethod');
    const propagateMethod = document.getElementById('propagateMethod');
    const fluidPropagateInfo = document.getElementById('fluidPropagateInfo');
    const fluidFloodFill = document.getElementById('fluidFloodFill');
    const fluidBoundingBox = document.getElementById('fluidBoundingBox');
    
    switch (label) {
        case 1: // Colon
            // Edge-Aware Brush ON, Fluid Brush OFF
            edgeAwareBrush.checked = true;
            fluidBrush.checked = false;
            fluidBrushOptions.style.display = 'none';
            // Combined contour refinement
            refineMethod.value = 'combined';
            // Standard (GrabCut) for mask propagation
            propagateMethod.value = 'grabcut';
            fluidPropagateInfo.style.display = 'none';
            showStatus('🫁 Colon: Edge-Aware brush, Combined refinement, GrabCut propagation', 'success');
            break;
            
        case 3: // Fluid Pockets
            // Fluid Brush ON with Flood Fill, Edge-Aware OFF
            fluidBrush.checked = true;
            fluidBrushOptions.style.display = 'block';
            edgeAwareBrush.checked = false;
            // Auto-enable Flood Fill for Fluid Pockets
            if (fluidFloodFill) fluidFloodFill.checked = true;
            if (fluidBoundingBox) {
                fluidBoundingBox.checked = true;
                toggleBoundingBoxMode();
            }
            // Random Walk contour refinement
            refineMethod.value = 'randomwalk';
            // Fluid-aware for mask propagation
            propagateMethod.value = 'randomwalk';
            fluidPropagateInfo.style.display = 'block';
            showStatus('💧 Fluid Pockets: Fluid brush + Flood Fill, Random Walker refinement, Fluid-aware propagation', 'success');
            break;
            
        default: // Polyp (2), Other (4)
            // No default brush
            edgeAwareBrush.checked = false;
            fluidBrush.checked = false;
            fluidBrushOptions.style.display = 'none';
            // Disable Bounding Box mode if active
            if (fluidBoundingBox && fluidBoundingBox.checked) {
                fluidBoundingBox.checked = false;
                toggleBoundingBoxMode();
            }
            // Disable Flood Fill
            if (fluidFloodFill) fluidFloodFill.checked = false;
            // Random Walk refinement
            refineMethod.value = 'randomwalk';
            // Random Walk propagation
            propagateMethod.value = 'randomwalk';
            fluidPropagateInfo.style.display = 'none';
            showStatus('🖌️ Standard: No brush preset, Random Walker refinement & propagation', 'success');
            break;
    }
}

function setDrawMode() {
    isEraseMode = false;
    document.getElementById('drawBtn').style.background = '#00d9ff';
    document.getElementById('drawBtn').style.color = '#000';
    document.getElementById('eraseBtn').style.background = '';
    document.getElementById('eraseBtn').style.color = '';
    updateCursor();
}

function setEraseMode() {
    isEraseMode = true;
    document.getElementById('eraseBtn').style.background = '#ff4757';
    document.getElementById('eraseBtn').style.color = '#fff';
    document.getElementById('drawBtn').style.background = '';
    document.getElementById('drawBtn').style.color = '';
    updateCursor();
}

function updateCursor() {

     // If in bounding box mode and NOT erasing, use crosshair
    if (isBoundingBoxMode && !isEraseMode) {
        canvas.style.cursor = 'crosshair';
        return;
    }
    const size = parseInt(document.getElementById('brushSize').value);
    const color = isEraseMode ? 'rgba(255,71,87,0.5)' : 'rgba(0,217,255,0.5)';
    
    const cursorCanvas = document.createElement('canvas');
    cursorCanvas.width = size + 2;
    cursorCanvas.height = size + 2;
    const cursorCtx = cursorCanvas.getContext('2d');
    
    cursorCtx.beginPath();
    cursorCtx.arc(size/2 + 1, size/2 + 1, size/2, 0, Math.PI * 2);
    cursorCtx.strokeStyle = color;
    cursorCtx.lineWidth = 2;
    cursorCtx.stroke();
    
    canvas.style.cursor = `url(${cursorCanvas.toDataURL()}) ${size/2 + 1} ${size/2 + 1}, crosshair`;
}

function updateBrushSize() {
    document.getElementById('brushSizeVal').textContent = document.getElementById('brushSize').value;
    updateCursor();
}

// ==================== History ====================
function saveToHistory() {
    if (!currentMask) return;
    maskHistory = maskHistory.slice(0, historyIndex + 1);
    maskHistory.push(currentMask.toDataURL());
    historyIndex = maskHistory.length - 1;
    if (maskHistory.length > MAX_HISTORY) { 
        maskHistory.shift(); 
        historyIndex--; 
    }
}

function undo() {
    // If in measurement mode, only undo measurements
    if (measurementMode !== null) {
        if (measurementUndoStack.length > 0) {
            if (undoMeasurement()) {
                showStatus('Undo measurement', 'success');
                return;
            }
        }
        showStatus('Nothing to undo (measurement mode)', 'error');
        return;
    }
    
    // Not in measurement mode - undo annotations only
    // First try regular single-slice undo (local edits)
    if (historyIndex > 0) { 
        historyIndex--; 
        restoreFromHistory(); 
        showStatus('Undo', 'success'); 
        return;
    }
    
    // If no local edits to undo, try multi-slice undo (propagation)
    if (multiSliceUndoState !== null) {
        // Restore the entire masks array
        masks.set(multiSliceUndoState);
        
        // Navigate back to the original slice
        if (multiSliceUndoSlice !== null) {
            document.getElementById('sliceSliderVertical').value = multiSliceUndoSlice;
            currentSlice = multiSliceUndoSlice;
            document.getElementById('sliceNum').textContent = currentSlice + 1;
            document.getElementById('gotoSlice').value = currentSlice + 1;
        }
        
        // Clear multi-slice undo state
        multiSliceUndoState = null;
        multiSliceUndoSlice = null;
        
        // Re-render current slice
        renderSlice();
        updateStats();
        
        showStatus('Undid propagation', 'success');
        return;
    }
    
    showStatus('Nothing to undo', 'error');
}

function redo() {
    // If in measurement mode, only redo measurements
    if (measurementMode !== null) {
        if (measurementRedoStack.length > 0) {
            if (redoMeasurement()) {
                showStatus('Redo measurement', 'success');
                return;
            }
        }
        showStatus('Nothing to redo (measurement mode)', 'error');
        return;
    }
    
    // Not in measurement mode - redo annotations only
    if (historyIndex < maskHistory.length - 1) { 
        historyIndex++; 
        restoreFromHistory(); 
        showStatus('Redo', 'success'); 
    } else {
        showStatus('Nothing to redo', 'error');
    }
}

function resetChanges() {
    if (!masks || !ctDims) {
        showStatus('No data to reset', 'error');
        return;
    }
    
    // Confirm with user
    if (!confirm('This will delete ALL masks on ALL slices and return to the initial slice. Continue?')) {
        return;
    }
    
    // Clear all masks
    masks.fill(0);
    
    // Clear current mask canvas
    if (maskCtx && currentMask) {
        maskCtx.clearRect(0, 0, currentMask.width, currentMask.height);
    }
    
    // Go back to initial slice
    currentSlice = initialSlice;
    document.getElementById('sliceSliderVertical').value = currentSlice;
    document.getElementById('sliceNum').textContent = currentSlice + 1;
    document.getElementById('gotoSlice').value = currentSlice + 1;
    
    // Re-render
    renderSlice();
    clearHistory();
    updateStats();
    
    showStatus('All masks cleared, returned to slice ' + (initialSlice + 1), 'success');
}

function toggleMaskVisibility() {
    maskVisible = !maskVisible;
    const btn = document.getElementById('toggleMaskBtn');
    
    if (maskVisible) {
        btn.innerHTML = '👁️ Hide Mask';
        btn.title = 'Hide mask overlay';
    } else {
        btn.innerHTML = '🙈 Show Mask';
        btn.title = 'Show mask overlay';
    }
    
    redraw();
}

function resetWindow() {
    document.getElementById('windowCenter').value = DEFAULT_WINDOW_CENTER;
    document.getElementById('windowWidth').value = DEFAULT_WINDOW_WIDTH;
    updateWL();
    showStatus('Window reset to defaults (WC: ' + DEFAULT_WINDOW_CENTER + ', WW: ' + DEFAULT_WINDOW_WIDTH + ')', 'success');
}

function restoreFromHistory() {
    if (historyIndex < 0 || historyIndex >= maskHistory.length) return;
    const img = new Image();
    img.onload = () => { 
        maskCtx.clearRect(0, 0, currentMask.width, currentMask.height); 
        maskCtx.drawImage(img, 0, 0); 
        redraw();
        // Update the masks array from the restored canvas and refresh annotated slices display
        syncMaskToArray();
        updateAnnotatedSlicesDisplay();
    };
    img.src = maskHistory[historyIndex];
}

// Sync current mask canvas to masks array (without triggering updateStats which calls updateAnnotatedSlicesDisplay)
function syncMaskToArray() {
    if (!currentMask || !masks || !ctDims) return;
    
    const width = ctDims[0];
    const height = ctDims[1];
    const sliceOffset = currentSlice * width * height;
    const imageData = maskCtx.getImageData(0, 0, width, height);
    
    // Pre-compute color values for faster matching
    const colorValues = {};
    for (const [label, color] of Object.entries(COLORS)) {
        colorValues[label] = {
            r: parseInt(color.substr(1, 2), 16),
            g: parseInt(color.substr(3, 2), 16),
            b: parseInt(color.substr(5, 2), 16)
        };
    }
    
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        const a = imageData.data[idx + 3];
        
        if (a > 0) {
            let bestLabel = 0;
            let bestDist = Infinity;
            
            for (const [label, cv] of Object.entries(colorValues)) {
                const dist = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestLabel = parseInt(label);
                }
            }
            
            if (bestDist < 100) {
                masks[sliceOffset + i] = bestLabel;
            } else {
                masks[sliceOffset + i] = 0;
            }
        } else {
            masks[sliceOffset + i] = 0;
        }
    }
}

function clearHistory() { 
    maskHistory = []; 
    historyIndex = -1; 
    cachedEdgeMap = null; 
    cachedEdgeSlice = -1; 
}

// ==================== Mask Operations ====================
function saveMask() {
    if (!currentMask || !masks) { 
        showStatus('No mask to save', 'error'); 
        return; 
    }
    
    saveMaskSilent();
    showStatus('Saved slice ' + (currentSlice + 1), 'success');
}

function saveMaskSilent() {
    if (!currentMask || !masks) return;
    
    const width = ctDims[0];
    const height = ctDims[1];
    const sliceOffset = currentSlice * width * height;
    const imageData = maskCtx.getImageData(0, 0, width, height);
    
    // Pre-compute color values for faster matching
    const colorValues = {};
    for (const [label, color] of Object.entries(COLORS)) {
        colorValues[label] = {
            r: parseInt(color.substr(1, 2), 16),
            g: parseInt(color.substr(3, 2), 16),
            b: parseInt(color.substr(5, 2), 16)
        };
    }
    
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        const a = imageData.data[idx + 3];
        
        if (a > 0) {
            // Find best matching color (with tolerance for anti-aliased pixels)
            let bestLabel = 0;
            let bestDist = Infinity;
            
            for (const [label, cv] of Object.entries(colorValues)) {
                const dist = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestLabel = parseInt(label);
                }
            }
            
            // Only save if reasonably close to a known color (tolerance of 100)
            if (bestDist < 100) {
                masks[sliceOffset + i] = bestLabel;
            } else {
                masks[sliceOffset + i] = 0;
            }
        } else {
            masks[sliceOffset + i] = 0;
        }
    }
    
    originalSliceState = currentMask.toDataURL();
    updateStats();
}

function clearMask() {
    if (!maskCtx) return;
    maskCtx.clearRect(0, 0, currentMask.width, currentMask.height);
    redraw();
    saveToHistory();
    
    if (masks) {
        const width = ctDims[0], height = ctDims[1];
        const sliceOffset = currentSlice * width * height;
        for (let i = 0; i < width * height; i++) masks[sliceOffset + i] = 0;
    }
    showStatus('Cleared', 'success');
    updateStats();
}

function exportMasks() {
    if (!masks || !ctDims) { 
        showStatus('No masks to export', 'error'); 
        return; 
    }
    
    saveMaskSilent();
    
    let hasData = false;
    const sliceSize = ctDims[0] * ctDims[1];
    
    for (let i = 0; i < masks.length; i++) {
        if (masks[i] > 0) { hasData = true; break; }
    }
    
    if (!hasData) { 
        showStatus('No annotations to export', 'error'); 
        return; 
    }
    
    try {
        let headerBuffer;
        
        if (nifti) {
            // NIfTI mode - use existing header builder
            headerBuffer = nifti.buildNifti1Header();
        } else {
            // DICOM mode - build a simple NIfTI header from DICOM metadata
            headerBuffer = buildNiftiHeaderForDicom();
        }
        
        const dataSize = ctDims[0] * ctDims[1] * ctDims[2];
        const totalSize = 352 + dataSize;
        
        const buffer = new ArrayBuffer(totalSize);
        const uint8 = new Uint8Array(buffer);
        
        // Copy header
        uint8.set(new Uint8Array(headerBuffer), 0);
        
        // Copy mask data
        for (let i = 0; i < dataSize; i++) {
            uint8[352 + i] = masks[i];
        }
        
        // Compress with pako
        const compressed = pako.gzip(uint8);
        
        // Download
        const blob = new Blob([compressed], { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const baseName = loadedCtFileName ? loadedCtFileName.replace(/\.nii(\.gz)?$/, '').replace(/\.dcm$/i, '') : 'annotation';
        a.href = url;
        a.download = `${baseName}_mask.nii.gz`;
        a.click();
        URL.revokeObjectURL(url);
        
        showStatus('Exported mask successfully!', 'success');
    } catch (err) {
        console.error('Export error:', err);
        showStatus('Error: ' + err.message, 'error');
    }
}

// Build a simple NIfTI-1 header for DICOM data
function buildNiftiHeaderForDicom() {
    const buffer = new ArrayBuffer(352);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    
    // Get spacing from DICOM loader or use defaults
    let pixelSpacing = [1, 1];
    let sliceThickness = 1;
    
    if (isDicomMode && dicomLoader) {
        pixelSpacing = dicomLoader.pixelSpacing || [1, 1];
        sliceThickness = dicomLoader.sliceThickness || 1;
    }
    
    // sizeof_hdr = 348
    view.setInt32(0, 348, true);
    
    // dim (dimensions)
    view.setInt16(40, 3, true);  // ndim = 3
    view.setInt16(42, ctDims[0], true);  // X
    view.setInt16(44, ctDims[1], true);  // Y
    view.setInt16(46, ctDims[2], true);  // Z
    view.setInt16(48, 1, true);  // T
    view.setInt16(50, 1, true);
    view.setInt16(52, 1, true);
    view.setInt16(54, 1, true);
    
    // datatype = 2 (uint8), bitpix = 8
    view.setInt16(70, 2, true);
    view.setInt16(72, 8, true);
    
    // pixdim - voxel dimensions
    view.setFloat32(76, 1, true);  // pixdim[0] - qfac, usually 1
    view.setFloat32(80, pixelSpacing[0], true);  // pixdim[1] - X spacing
    view.setFloat32(84, pixelSpacing[1], true);  // pixdim[2] - Y spacing
    view.setFloat32(88, sliceThickness, true);   // pixdim[3] - Z spacing
    view.setFloat32(92, 1, true);  // pixdim[4]
    view.setFloat32(96, 1, true);  // pixdim[5]
    view.setFloat32(100, 1, true); // pixdim[6]
    view.setFloat32(104, 1, true); // pixdim[7]
    
    // vox_offset = 352
    view.setFloat32(108, 352, true);
    
    // scl_slope = 1, scl_inter = 0
    view.setFloat32(112, 1, true);
    view.setFloat32(116, 0, true);
    
    // xyzt_units - mm and seconds (2 | 8 = 10)
    view.setUint8(123, 10);

    // descrip field - bytes 148-227 (80 bytes) - tool identification flag
    const descripStr = 'CTColonTool_v1';
    for (let i = 0; i < descripStr.length && i < 80; i++) {
        uint8[148 + i] = descripStr.charCodeAt(i);
    }
    
    // qform_code = 1 (scanner), sform_code = 1 (scanner)
    view.setInt16(252, 1, true);
    view.setInt16(254, 1, true);
    
    // Simple sform affine (diagonal with spacing)
    view.setFloat32(280, pixelSpacing[0], true);  // srow_x[0]
    view.setFloat32(284, 0, true);                // srow_x[1]
    view.setFloat32(288, 0, true);                // srow_x[2]
    view.setFloat32(292, 0, true);                // srow_x[3] - offset
    
    view.setFloat32(296, 0, true);                // srow_y[0]
    view.setFloat32(300, pixelSpacing[1], true);  // srow_y[1]
    view.setFloat32(304, 0, true);                // srow_y[2]
    view.setFloat32(308, 0, true);                // srow_y[3] - offset
    
    view.setFloat32(312, 0, true);                // srow_z[0]
    view.setFloat32(316, 0, true);                // srow_z[1]
    view.setFloat32(320, sliceThickness, true);   // srow_z[2]
    view.setFloat32(324, 0, true);                // srow_z[3] - offset
    
    // Magic bytes "n+1" at 344
    uint8[344] = 0x6e; // 'n'
    uint8[345] = 0x2b; // '+'
    uint8[346] = 0x31; // '1'
    uint8[347] = 0x00;
    
    return buffer;
}

function updateStats() {
    if (!masks) {
        document.getElementById('statVoxels').textContent = '0';
        document.getElementById('statSlices').textContent = '0/0';
        document.getElementById('statProgress').textContent = '0%';
        return;
    }
    
    let voxels = 0;
    const sliceSize = ctDims[0] * ctDims[1];
    let annotatedSlices = 0;
    
    for (let z = 0; z < totalSlices; z++) {
        let sliceHasData = false;
        for (let i = 0; i < sliceSize; i++) {
            if (masks[z * sliceSize + i] > 0) { 
                voxels++; 
                sliceHasData = true; 
            }
        }
        if (sliceHasData) annotatedSlices++;
    }
    
    const progress = totalSlices > 0 ? Math.round(annotatedSlices / totalSlices * 100 * 10) / 10 : 0;
    document.getElementById('statVoxels').textContent = voxels.toLocaleString();
    document.getElementById('statSlices').textContent = annotatedSlices + '/' + totalSlices;
    document.getElementById('statProgress').textContent = progress + '%';
    
    // Update annotated slices navigation
    updateAnnotatedSlicesDisplay();
}

// ==================== Keyboard Shortcuts ====================
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Skip keyboard shortcuts when typing in input fields
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        
        // Spacebar for pan mode
        if (e.code === 'Space' && !e.repeat) {
            spacebarHeld = true;
            canvas.classList.add('panning');
            e.preventDefault();
            return;
        }
        
        // Ctrl+Arrow for panning (trackpad-friendly)
        if (e.ctrlKey && !e.shiftKey) {
            if (e.key === 'ArrowLeft') { e.preventDefault(); panX += PAN_STEP; applyTransform(); return; }
            if (e.key === 'ArrowRight') { e.preventDefault(); panX -= PAN_STEP; applyTransform(); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); panY += PAN_STEP; applyTransform(); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); panY -= PAN_STEP; applyTransform(); return; }
        }
        
        // Propagation shortcuts (Shift + Arrow)
        if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            propagateMask(-1);
            return;
        }
        if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
            e.preventDefault();
            propagateMask(1);
            return;
        }
        
        if (e.key === 'ArrowLeft' || e.key === 'a') prevSlice();
        if (e.key === 'ArrowRight' || e.key === 'd') nextSlice();
        if (e.key === 'ArrowUp') prevSlice();
        if (e.key === 'ArrowDown') nextSlice();
        if (e.key === 's' && !e.ctrlKey) saveMask();
        if (e.key === 'e') { isEraseMode ? setDrawMode() : setEraseMode(); }
        if (e.key === 'r' && !e.ctrlKey) refineContours();
        if (e.key === 'b') { 
            const cb = document.getElementById('edgeAwareBrush');
            cb.checked = !cb.checked;
            showStatus('Edge-aware brush: ' + (cb.checked ? 'ON' : 'OFF'), 'success');
        }
        if (e.key === 'z' && e.ctrlKey && !e.shiftKey) { e.preventDefault(); undo(); }
        if ((e.key === 'y' && e.ctrlKey) || (e.key === 'z' && e.ctrlKey && e.shiftKey)) { e.preventDefault(); redo(); }
        if (e.key === 'f' || e.key === 'F') { fitToView(); }
        if (e.key === '0' && !e.ctrlKey) { resetZoom(); }
        
        // Measurement tool shortcuts
        if (e.key === 'm' || e.key === 'M') { toggleDistanceMeasurement(); }
        if (e.key === 'n' || e.key === 'N') { toggleAngleMeasurement(); }
        if (e.key === 'Escape') { 
            cancelMeasurement(); 
            selectedMeasurementIndex = -1;  // Deselect measurement
            redraw();
        }
        // Delete selected measurement
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedMeasurementIndex >= 0) {
                e.preventDefault();
                deleteSelectedMeasurement();
            }
        }
        // Navigate annotated slices with Page Up/Down
        if (e.key === 'PageUp') {
            e.preventDefault();
            goToPrevAnnotatedSlice();
        }
        if (e.key === 'PageDown') {
            e.preventDefault();
            goToNextAnnotatedSlice();
        }
    });
    
    document.addEventListener('keyup', (e) => {
        // Skip when typing in input fields
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        
        if (e.code === 'Space') {
            spacebarHeld = false;
            if (!isPanning) canvas.classList.remove('panning');
        }
    });
}

// ==================== Advanced Options Toggles ====================
function toggleBrushAdvanced() {
    const checkbox = document.getElementById('showBrushAdvanced');
    const options = document.getElementById('brushAdvancedOptions');
    options.style.display = checkbox.checked ? 'block' : 'none';
}

function toggleRefineAdvanced() {
    const checkbox = document.getElementById('showRefineAdvanced');
    const options = document.getElementById('refineAdvancedOptions');
    options.style.display = checkbox.checked ? 'block' : 'none';
}

// ==================== Polyp Panel Toggle ====================
let polypPanelExpanded = false;
let polypPanelResizedMaxHeight = null;
let polypPanelResizedScrollerHeight = null;

function togglePolypPanel() {
    polypPanelExpanded = !polypPanelExpanded;
    const content = document.getElementById('polypPanelContent');
    const toggle = document.getElementById('polypPanelToggle');
    const scroller = content ? content.querySelector('.polyp-panel') : null;

    if (polypPanelExpanded) {
        content.classList.remove('collapsed');
        content.classList.add('expanded');
        toggle.classList.remove('collapsed');
        // Restore the user's resized height (if any); otherwise let CSS take over.
        if (polypPanelResizedMaxHeight) content.style.maxHeight = polypPanelResizedMaxHeight;
        else content.style.removeProperty('max-height');
        if (scroller) {
            if (polypPanelResizedScrollerHeight) {
                scroller.style.maxHeight = polypPanelResizedScrollerHeight;
                scroller.style.height = polypPanelResizedScrollerHeight;
            } else {
                scroller.style.removeProperty('max-height');
                scroller.style.removeProperty('height');
            }
        }
    } else {
        // Remember the user's resize before collapsing so we can restore it on expand.
        if (content.style.maxHeight) polypPanelResizedMaxHeight = content.style.maxHeight;
        if (scroller && scroller.style.maxHeight) polypPanelResizedScrollerHeight = scroller.style.maxHeight;
        content.classList.add('collapsed');
        content.classList.remove('expanded');
        toggle.classList.add('collapsed');
        // Force inline max-height to 0 so it overrides any leftover inline resize value.
        content.style.maxHeight = '0px';
        if (scroller) {
            scroller.style.removeProperty('max-height');
            scroller.style.removeProperty('height');
        }
    }
}

(function setupPolypPanelResize() {
    const init = () => {
        const handle = document.getElementById('polypPanelResizeHandle');
        if (!handle) return;
        const MIN_H = 60;
        const MAX_H = 800;
        let dragging = false;
        let startY = 0;
        let startHeight = 0;

        const getScroller = () => document.querySelector('#polypPanelContent .polyp-panel');

        handle.addEventListener('mousedown', (e) => {
            const content = document.getElementById('polypPanelContent');
            const toggle = document.getElementById('polypPanelToggle');
            // If collapsed, expand first so the drag has something to resize.
            if (content && content.classList.contains('collapsed')) {
                polypPanelExpanded = true;
                content.classList.remove('collapsed');
                content.classList.add('expanded');
                if (toggle) toggle.classList.remove('collapsed');
            }
            const scroller = getScroller();
            if (!scroller) return;
            dragging = true;
            startY = e.clientY;
            startHeight = scroller.getBoundingClientRect().height || 150;
            handle.classList.add('dragging');
            if (content) content.classList.add('resizing');
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const scroller = getScroller();
            const content = document.getElementById('polypPanelContent');
            if (!scroller || !content) return;
            // Drag up (negative delta in clientY) grows the panel.
            const delta = startY - e.clientY;
            const newH = Math.max(MIN_H, Math.min(MAX_H, startHeight + delta));
            scroller.style.maxHeight = newH + 'px';
            scroller.style.height = newH + 'px';
            // The outer content wrapper has its own max-height cap; lift it too.
            content.style.maxHeight = (newH + 40) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            const content = document.getElementById('polypPanelContent');
            if (content) content.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

// ==================== Mask Propagation ====================
function copyMaskToSlice(targetSlice, doRefine = true) {
    // Check for masks and CT data (works for both NIfTI and DICOM modes)
    if (!ctDims || !masks || !currentMask) {
        showStatus('No mask to propagate', 'error');
        return false;
    }
    
    if (targetSlice < 0 || targetSlice >= totalSlices) {
        showStatus('Target slice out of range', 'error');
        return false;
    }
    
    const width = ctDims[0];
    const height = ctDims[1];
    
    // Get selected label
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    const selectedColor = COLORS[selectedLabel];
    const selR = parseInt(selectedColor.substr(1, 2), 16);
    const selG = parseInt(selectedColor.substr(3, 2), 16);
    const selB = parseInt(selectedColor.substr(5, 2), 16);
    
    // Save current mask to masks array first (important for multi-slice propagation)
    saveMaskSilent();
    
    // Get current mask image data (the mask we're propagating FROM the current slice)
    // This should be the refined mask from the previous propagation iteration
    const currentMaskData = maskCtx.getImageData(0, 0, currentMask.width, currentMask.height);
    
    // Extract ONLY the selected label from current mask (with tolerance)
    const selectedLabelMask = new Uint8Array(width * height);
    let maskPixelCount = 0;
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const r = currentMaskData.data[idx];
        const g = currentMaskData.data[idx + 1];
        const b = currentMaskData.data[idx + 2];
        const a = currentMaskData.data[idx + 3];
        
        if (a > 0) {
            const dist = Math.abs(r - selR) + Math.abs(g - selG) + Math.abs(b - selB);
            if (dist < 100) {
                selectedLabelMask[i] = 1;
                maskPixelCount++;
            }
        }
    }
    
    // Check if we have any mask to propagate
    if (maskPixelCount === 0) {
        showStatus('No mask found for selected label to propagate', 'error');
        return false;
    }
    
    // Get ALL existing masks from target slice (all labels)
    const targetSliceOffset = targetSlice * width * height;
    const existingLabels = new Uint8Array(width * height);
    
    for (let i = 0; i < width * height; i++) {
        existingLabels[i] = masks[targetSliceOffset + i];
    }
    
    // Navigate to target slice
    document.getElementById('sliceSliderVertical').value = targetSlice;
    currentSlice = targetSlice;
    document.getElementById('sliceNum').textContent = currentSlice + 1;
    document.getElementById('gotoSlice').value = currentSlice + 1;
    
    if (nifti) {
        const physZ = nifti.getPhysicalZ(currentSlice);
        document.getElementById('physicalZ').textContent = physZ.toFixed(2);
    } else if (isDicomMode && dicomLoader) {
        // Use actual Image Position Patient z-coordinate if available
        const sliceMeta = dicomLoader.getSliceMetadata(currentSlice);
        if (sliceMeta && sliceMeta.imagePositionPatient) {
            const physZ = sliceMeta.imagePositionPatient[2];
            document.getElementById('physicalZ').textContent = physZ.toFixed(2);
        } else {
            const spacing = dicomLoader.getVoxelSpacing();
            const physZ = currentSlice * spacing[2];
            document.getElementById('physicalZ').textContent = physZ.toFixed(2);
        }
    }
    
    // Check if target slice data is available in DICOM mode
    if (isDicomMode) {
        const hasData = (dicomLoader && dicomLoader.isSliceLoaded(currentSlice)) ||
                        (ctData && ctData[currentSlice * ctDims[0] * ctDims[1]] !== 0);
        if (!hasData) {
            showStatus('Target slice not loaded yet. Please wait or choose another slice.', 'error');
            return false;
        }
    }
    
    // Get slice HU data for the target slice
    const sliceHUData = getCurrentSliceHUData();
    if (!sliceHUData) {
        showStatus('Cannot get slice data', 'error');
        return false;
    }
    
    // Clear edge cache BEFORE doing any work on the new slice
    cachedEdgeMap = null;
    cachedEdgeSlice = -1;
    
    // Ensure canvas has correct dimensions
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    
    // Create fresh currentImage for this slice
    currentImage = ctx.createImageData(width, height);
    
    // Ensure currentMask exists with correct dimensions
    if (!currentMask || currentMask.width !== width || currentMask.height !== height) {
        currentMask = document.createElement('canvas');
        currentMask.width = width;
        currentMask.height = height;
        maskCtx = currentMask.getContext('2d');
    }
    
    // Render the target slice CT image
    const wc = parseInt(document.getElementById('windowCenter').value);
    const ww = parseInt(document.getElementById('windowWidth').value);
    const wmin = wc - ww / 2;
    const wmax = wc + ww / 2;
    
    for (let i = 0; i < sliceHUData.length; i++) {
        const val = sliceHUData[i];
        let normalized = (val - wmin) / (wmax - wmin);
        normalized = Math.max(0, Math.min(1, normalized));
        const pixel = Math.round(normalized * 255);
        
        const idx = i * 4;
        currentImage.data[idx] = pixel;
        currentImage.data[idx + 1] = pixel;
        currentImage.data[idx + 2] = pixel;
        currentImage.data[idx + 3] = 255;
    }
    
    // Build merged mask: existing labels + propagated selected label (allowing overlap)
    maskCtx.clearRect(0, 0, width, height);
    const mergedMaskData = maskCtx.createImageData(width, height);
    
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        
        // Check if we're propagating this pixel (selected label only)
        const isPropagating = selectedLabelMask[i] === 1;
        const existingLabel = existingLabels[i];
        
        if (existingLabel > 0 && existingLabel !== selectedLabel && COLORS[existingLabel]) {
            // Keep existing DIFFERENT label (don't overwrite with propagating)
            const color = COLORS[existingLabel];
            mergedMaskData.data[idx] = parseInt(color.substr(1, 2), 16);
            mergedMaskData.data[idx + 1] = parseInt(color.substr(3, 2), 16);
            mergedMaskData.data[idx + 2] = parseInt(color.substr(5, 2), 16);
            mergedMaskData.data[idx + 3] = 255;
        } else if (isPropagating) {
            // Propagating pixel (no conflicting different label)
            mergedMaskData.data[idx] = selR;
            mergedMaskData.data[idx + 1] = selG;
            mergedMaskData.data[idx + 2] = selB;
            mergedMaskData.data[idx + 3] = 255;
        } else if (existingLabel > 0 && COLORS[existingLabel]) {
            // Keep existing same label
            const color = COLORS[existingLabel];
            mergedMaskData.data[idx] = parseInt(color.substr(1, 2), 16);
            mergedMaskData.data[idx + 1] = parseInt(color.substr(3, 2), 16);
            mergedMaskData.data[idx + 2] = parseInt(color.substr(5, 2), 16);
            mergedMaskData.data[idx + 3] = 255;
        }
    }
    
    maskCtx.putImageData(mergedMaskData, 0, 0);
    
    // Optionally refine the mask to fit the new slice (only selected label)
    // Do 3 iterations of refinement for better edge fitting
    if (doRefine) {
        const iterations = (selectedLabel === 3) ? 5 : 3;
        for (let i = 0; i < iterations; i++) {
            refinePropagate();
        }
    }
    
    // Redraw
    redraw();
    
    // Save propagated mask to masks array
    saveMaskSilent();
    
    // Clear and save history
    clearHistory();
    saveToHistory();
    originalSliceState = currentMask.toDataURL();
    
    return true;
}

// Lightweight refinement for propagation (faster than full refine)
function refinePropagate() {
    if (!currentMask || !maskCtx) return;
    
    let method = document.getElementById('propagateMethod').value;
    
    // Get selected label - use combined for Colon mask (label 1)
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    if (selectedLabel === 1 && method !== 'fluid') {
        method = 'combined';  // Force combined for Colon mask
    }
    
    if (method === 'fluid') {
        refineFluidPropagate();
        return;
    }
    
    // GrabCut, Random Walker, or Combined refinement
    const grayData = getGrayscaleData();
    if (!grayData) return;
    
    const { gray, width, height } = grayData;
    
    const selectedColor = COLORS[selectedLabel];
    const selR = parseInt(selectedColor.substr(1, 2), 16);
    const selG = parseInt(selectedColor.substr(3, 2), 16);
    const selB = parseInt(selectedColor.substr(5, 2), 16);
    
    // Get current mask
    const imageData = maskCtx.getImageData(0, 0, width, height);
    
    // Pre-compute color values for tolerance matching
    const colorValues = {};
    for (const [label, color] of Object.entries(COLORS)) {
        colorValues[label] = {
            r: parseInt(color.substr(1, 2), 16),
            g: parseInt(color.substr(3, 2), 16),
            b: parseInt(color.substr(5, 2), 16)
        };
    }
    
    // Classify all pixels and extract ONLY selected label for refinement
    const binary = new Uint8Array(width * height);
    const otherLabelsData = new Uint8Array(width * height); // Store other labels
    let hasSelectedLabel = false;
    
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        const a = imageData.data[idx + 3];
        
        if (a > 0) {
            let bestLabel = 0;
            let bestDist = Infinity;
            
            for (const [label, cv] of Object.entries(colorValues)) {
                const dist = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestLabel = parseInt(label);
                }
            }
            
            if (bestDist < 100) {
                if (bestLabel === selectedLabel) {
                    binary[i] = 1;
                    hasSelectedLabel = true;
                } else {
                    otherLabelsData[i] = bestLabel; // Store other labels to preserve
                }
            }
        }
    }
    
    if (!hasSelectedLabel) return;
    
    // Apply refinement ONLY to selected label based on method
    let refined;
    if (method === 'randomwalk') {
        // Random Walker refinement
        const g = Refinement.computeEdgeStoppingFunction(gray, width, height, 1.2);
        refined = Refinement.randomWalkerRefinement(binary, gray, g, width, height, 20);
        refined = Refinement.morphSmooth(refined, width, height, 1);
        
        // GUARDRAIL for Fluid Pockets (label 3): Keep only regions connected to original mask
        if (selectedLabel === 3) {
            refined = keepConnectedToSeed(refined, binary, width, height);
        }
    } else if (method === 'combined') {
        // Combined: GrabCut + stronger morphological smoothing (best for Colon)
        refined = Refinement.grabCutRefinement(binary, gray, width, height, 15);
        refined = Refinement.morphSmooth(refined, width, height, 2);
    } else {
        // Default: GrabCut refinement
        refined = Refinement.grabCutRefinement(binary, gray, width, height, 15);
        refined = Refinement.morphSmooth(refined, width, height, 2);
        
        // GUARDRAIL for Fluid Pockets (label 3): Keep only regions connected to original mask
        if (selectedLabel === 3) {
            refined = keepConnectedToSeed(refined, binary, width, height);
        }
    }
    
    // Build output: refined selected label + preserved other labels
    const outputData = maskCtx.createImageData(width, height);
    
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        
        if (refined[i] === 1) {
            // Refined selected label
            outputData.data[idx] = selR;
            outputData.data[idx + 1] = selG;
            outputData.data[idx + 2] = selB;
            outputData.data[idx + 3] = 255;
        } else if (otherLabelsData[i] > 0) {
            // Preserved other label
            const otherColor = COLORS[otherLabelsData[i]];
            outputData.data[idx] = parseInt(otherColor.substr(1, 2), 16);
            outputData.data[idx + 1] = parseInt(otherColor.substr(3, 2), 16);
            outputData.data[idx + 2] = parseInt(otherColor.substr(5, 2), 16);
            outputData.data[idx + 3] = 255;
        }
    }
    
    maskCtx.clearRect(0, 0, width, height);
    maskCtx.putImageData(outputData, 0, 0);
}

// Fluid-aware refinement for propagation
// ULTRA-CONSERVATIVE: Only keeps/shrinks the mask, never expands beyond original boundary
// - Validates each original mask pixel against HU thresholds
// - Removes pixels that no longer meet criteria
// - NO expansion beyond original mask footprint
function refineFluidPropagate() {
    if (!currentMask || !maskCtx) return;

    const width = canvas.width;
    const height = canvas.height;

    // HU data (best). If unavailable, abort (fluid logic expects HU).
    const huData = getCurrentSliceHUData();
    if (!huData) {
        console.log('[refineFluidPropagate] No HU data available, skipping refinement');
        return;  // Keep existing mask unchanged
    }

    // Thresholds from UI
    const minHU = parseInt(document.getElementById('fluidMinHU').value);
    const maxHU = parseInt(document.getElementById('fluidMaxHU').value);

    // Selected label + color
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    const selectedColor = COLORS[selectedLabel];
    const selR = parseInt(selectedColor.substr(1, 2), 16);
    const selG = parseInt(selectedColor.substr(3, 2), 16);
    const selB = parseInt(selectedColor.substr(5, 2), 16);

    // Current mask image
    const imageData = maskCtx.getImageData(0, 0, width, height);

    // Pre-compute color values (for label decoding & preserving others)
    const colorValues = {};
    for (const [label, color] of Object.entries(COLORS)) {
        colorValues[label] = {
            r: parseInt(color.substr(1, 2), 16),
            g: parseInt(color.substr(3, 2), 16),
            b: parseInt(color.substr(5, 2), 16)
        };
    }

    function decodeLabelAt(r, g, b) {
        let bestLabel = 0;
        let bestDist = Infinity;
        for (const [label, cv] of Object.entries(colorValues)) {
            const dist = Math.abs(r - cv.r) + Math.abs(g - cv.g) + Math.abs(b - cv.b);
            if (dist < bestDist) {
                bestDist = dist;
                bestLabel = parseInt(label);
            }
        }
        return (bestDist < 100) ? bestLabel : 0;
    }

    // Extract seed mask for selected label (from propagated previous slice)
    // Preserve other labels
    const seedMask = new Uint8Array(width * height);
    const otherLabelsData = new Uint8Array(width * height);
    let seedCount = 0;

    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const a = imageData.data[idx + 3];
        if (a === 0) continue;

        const label = decodeLabelAt(
            imageData.data[idx],
            imageData.data[idx + 1],
            imageData.data[idx + 2]
        );

        if (label === selectedLabel) {
            seedMask[i] = 1;
            seedCount++;
        } else if (label > 0) {
            otherLabelsData[i] = label;
        }
    }

    if (seedCount === 0) return;

    // Validate seeds against HU range (relax if needed)
    const validSeed = new Uint8Array(width * height);
    let validSeedCount = 0;

    for (let i = 0; i < width * height; i++) {
        if (!seedMask[i]) continue;
        const hu = huData[i];
        if (hu >= minHU && hu <= maxHU) {
            validSeed[i] = 1;
            validSeedCount++;
        }
    }

    if (validSeedCount < Math.max(10, seedCount * 0.1)) {
        const relaxedMin = minHU - 150;
        const relaxedMax = maxHU + 150;
        validSeedCount = 0;
        for (let i = 0; i < width * height; i++) {
            if (!seedMask[i]) continue;
            const hu = huData[i];
            if (hu >= relaxedMin && hu <= relaxedMax) {
                validSeed[i] = 1;
                validSeedCount++;
            }
        }
    }

    if (validSeedCount < 10) {
        console.log('[refineFluidPropagate] Too few valid seed pixels, keeping original mask');
        return;
    }

    // Build an edge map for stopping. Prefer HU gradient; fallback to windowed edgeMap.
    const useHuEdges = true;
    const edge = new Float32Array(width * height);

    if (useHuEdges) {
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const i = row + x;
                const c = huData[i];
                const r = (x + 1 < width) ? huData[i + 1] : c;
                const d = (y + 1 < height) ? huData[i + width] : c;
                const gx = r - c;
                const gy = d - c;
                edge[i] = Math.sqrt(gx * gx + gy * gy);
            }
        }
    } else {
        const edgeMap = getEdgeMap(); // from currentImage (0–255)
        for (let i = 0; i < edge.length; i++) edge[i] = edgeMap[i];
    }

    // Adaptive edge threshold: use percentile so it self-tunes per slice
    // Higher percentile => only stop at strongest edges.
    let edgeThr = 0;
    {
        const vals = [];
        for (let i = 0; i < edge.length; i++) {
            const v = edge[i];
            if (v > 0) vals.push(v);
        }
        vals.sort((a, b) => a - b);
        edgeThr = vals.length ? vals[Math.floor(vals.length * 0.85)] : 100; // 85th percentile
        // Clamp to avoid extremes
        edgeThr = Math.max(edgeThr, 20);
    }

    // Optional: infer a local air–fluid interface row from seeds to prevent growing into air above
    // Very lightweight: compute seed centroid, then scan upward for max HU drop.
    let interfaceY = null;
    {
        let sx = 0, sy = 0, n = 0;
        for (let i = 0; i < width * height; i++) {
            if (!validSeed[i]) continue;
            const y = (i / width) | 0;
            const x = i - y * width;
            sx += x; sy += y; n++;
        }
        if (n > 0) {
            const cx = (sx / n) | 0;
            const cy = (sy / n) | 0;

            let bestY = null;
            let bestDrop = 0;
            const maxScan = 120;

            for (let dy = 5; dy <= maxScan && cy - dy - 1 >= 0; dy++) {
                const y = cy - dy;
                const i1 = y * width + cx;
                const i2 = (y - 1) * width + cx;
                const drop = huData[i1] - huData[i2]; // bright->dark going upward => positive
                if (drop > bestDrop) {
                    bestDrop = drop;
                    bestY = y;
                }
            }

            // Require a meaningful HU drop to trust the interface
            if (bestY !== null && bestDrop > 150) interfaceY = bestY;
        }
    }

    // Multi-source BFS region growing
    const visited = new Uint8Array(width * height);
    const region = new Uint8Array(width * height);

    const queue = new Int32Array(width * height);
    let qh = 0, qt = 0;

    for (let i = 0; i < width * height; i++) {
        if (!validSeed[i]) continue;
        visited[i] = 1;
        queue[qt++] = i;
    }

    const dirs = [1, -1, width, -width];

    while (qh < qt) {
        const i = queue[qh++];

        // Optional: constrain to below interface
        if (interfaceY !== null) {
            const y = (i / width) | 0;
            if (y < interfaceY - 2) continue;
        }

        const hu = huData[i];
        
        // Always include original seed pixels, check HU only for expansion
        const isSeed = seedMask[i] === 1;
        if (!isSeed && (hu < minHU || hu > maxHU)) continue;

        region[i] = 1;

        for (let k = 0; k < 4; k++) {
            const ni = i + dirs[k];

            // prevent wrap
            if (k === 0 && (i % width) === width - 1) continue;
            if (k === 1 && (i % width) === 0) continue;
            if (ni < 0 || ni >= width * height) continue;

            if (visited[ni]) continue;
            visited[ni] = 1;

            // Stop at strong edges
            const e = Math.max(edge[i], edge[ni]);
            if (e > edgeThr) continue;

            queue[qt++] = ni;
        }
    }

    // Post-process: close tiny gaps + fill small holes
    let final = region;
    final = Refinement.dilate(final, width, height, 1);
    final = Refinement.erode(final, width, height, 1);
    final = Refinement.fillSmallHoles(final, width, height, 80);

    // Keep only the component connected to the original seeds (avoid picking up other bright regions)
    if (typeof Refinement.keepConnectedToSeed === 'function') {
        final = Refinement.keepConnectedToSeed(final, seedMask, width, height);
    } else {
        // Fallback: keep largest component
        final = Refinement.keepLargestComponent(final, width, height);
    }

     // Safeguard: if processing removed too much, keep original seed
    let finalCount = 0;
    for (let i = 0; i < final.length; i++) {
        if (final[i] === 1) finalCount++;
    }
    if (finalCount < seedCount * 0.3) {
        console.log('[refineFluidPropagate] Processing removed too many pixels, keeping original');
        final = seedMask;
    }

    // One step of Random Walk for smoother edges
    const g = Refinement.computeEdgeStoppingFunction(huData, width, height, 1.2);
    final = Refinement.randomWalkerRefinement(final, huData, g, width, height, 1);

    // Write output: final selected label + preserved other labels
    const outputData = maskCtx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;

        if (final[i] === 1) {
            outputData.data[idx] = selR;
            outputData.data[idx + 1] = selG;
            outputData.data[idx + 2] = selB;
            outputData.data[idx + 3] = 255;
        } else if (otherLabelsData[i] > 0) {
            const otherColor = COLORS[otherLabelsData[i]];
            outputData.data[idx] = parseInt(otherColor.substr(1, 2), 16);
            outputData.data[idx + 1] = parseInt(otherColor.substr(3, 2), 16);
            outputData.data[idx + 2] = parseInt(otherColor.substr(5, 2), 16);
            outputData.data[idx + 3] = 255;
        }
    }

    maskCtx.clearRect(0, 0, width, height);
    maskCtx.putImageData(outputData, 0, 0);
}

// Propagate mask to a single adjacent slice
function propagateMask(direction) {
    if (!currentMask || !masks) {
        showStatus('No mask to propagate', 'error');
        return;
    }
    
    // Check if current mask has any content for the selected label
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    const selectedColor = COLORS[selectedLabel];
    const cr = parseInt(selectedColor.substr(1, 2), 16);
    const cg = parseInt(selectedColor.substr(3, 2), 16);
    const cb = parseInt(selectedColor.substr(5, 2), 16);
    
    const imageData = maskCtx.getImageData(0, 0, canvas.width, canvas.height);
    let hasContent = false;
    for (let i = 0; i < imageData.data.length / 4; i++) {
        const idx = i * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        const a = imageData.data[idx + 3];
        
        if (a > 0) {
            // Check if this pixel matches the selected label (with tolerance)
            const dist = Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb);
            if (dist < 100) {
                hasContent = true;
                break;
            }
        }
    }
    
    if (!hasContent) {
        showStatus('Current slice has no mask for selected label to propagate', 'error');
        return;
    }
    
    const targetSlice = currentSlice + direction;
    
    if (targetSlice < 0 || targetSlice >= totalSlices) {
        showStatus('Cannot propagate beyond slice range', 'error');
        return;
    }
    
    // IMPORTANT: Save current mask to masks array FIRST, then capture undo state
    // This ensures the undo state includes the current slice's annotation
    saveMaskSilent();
    
    // Now save undo state (includes current slice annotation)
    multiSliceUndoState = new Uint8Array(masks);
    multiSliceUndoSlice = currentSlice;
    
    const doRefine = document.getElementById('propagateRefine').checked;
    
    showStatus('Propagating mask to slice ' + (targetSlice + 1) + '...', 'success');
    
    setTimeout(() => {
        if (copyMaskToSlice(targetSlice, doRefine)) {
            showStatus('Mask propagated to slice ' + (targetSlice + 1), 'success');
            updateStats();
        }
    }, 50);
}

// Propagate mask to multiple slices
function propagateMultiple(direction) {
    if (!currentMask || !masks) {
        showStatus('No mask to propagate', 'error');
        return;
    }
    
    // Check if current mask has any content for the selected label
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    const selectedColor = COLORS[selectedLabel];
    const cr = parseInt(selectedColor.substr(1, 2), 16);
    const cg = parseInt(selectedColor.substr(3, 2), 16);
    const cb = parseInt(selectedColor.substr(5, 2), 16);
    
    const imageData = maskCtx.getImageData(0, 0, canvas.width, canvas.height);
    let hasContent = false;
    for (let i = 0; i < imageData.data.length / 4; i++) {
        const idx = i * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        const a = imageData.data[idx + 3];
        
        if (a > 0) {
            // Check if this pixel matches the selected label (with tolerance)
            const dist = Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb);
            if (dist < 100) {
                hasContent = true;
                break;
            }
        }
    }
    
    if (!hasContent) {
        showStatus('Current slice has no mask for selected label to propagate', 'error');
        return;
    }
    
    const count = parseInt(document.getElementById('propagateCount').value) || 5;
    const doRefine = document.getElementById('propagateRefine').checked;
    const startSlice = currentSlice;
    
    // Calculate valid range
    let endSlice = startSlice + (direction * count);
    endSlice = Math.max(0, Math.min(totalSlices - 1, endSlice));
    const actualCount = Math.abs(endSlice - startSlice);
    
    if (actualCount === 0) {
        showStatus('Cannot propagate beyond slice range', 'error');
        return;
    }
    
    // IMPORTANT: Save current mask to masks array FIRST, then capture undo state
    // This ensures the undo state includes the current slice's annotation
    saveMaskSilent();
    
    // Save undo state BEFORE propagation (now includes current slice annotation)
    multiSliceUndoState = new Uint8Array(masks);
    multiSliceUndoSlice = startSlice;
    
    showStatus('Propagating mask to ' + actualCount + ' slices...', 'success');
    
    // Propagate slice by slice with small delay for UI feedback
    let currentTarget = startSlice;
    let propagated = 0;
    
    function propagateNext() {
        currentTarget += direction;
        
        if ((direction > 0 && currentTarget > endSlice) || 
            (direction < 0 && currentTarget < endSlice) ||
            currentTarget < 0 || currentTarget >= totalSlices) {
            showStatus('Propagated mask to ' + propagated + ' slices (Ctrl+Z to undo)', 'success');
            updateStats();
            document.getElementById('loadingOverlay').classList.add('hidden');
            return;
        }
        
        if (copyMaskToSlice(currentTarget, doRefine)) {
            propagated++;
            document.getElementById('loadingProgress').textContent = propagated + '/' + actualCount;
            // Increase delay to ensure rendering and refinement completes fully
            setTimeout(propagateNext, 100);
        } else {
            showStatus('Propagation stopped at slice ' + (currentTarget + 1), 'error');
            document.getElementById('loadingOverlay').classList.add('hidden');
        }
    }
    
    // Show loading overlay
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingProgress').textContent = '0/' + actualCount;
    
    setTimeout(() => {
        propagateNext();
    }, 100);
}

// ==================== Refinement Functions ====================
function getGrayscaleData() {
    if (!currentImage) return null;
    
    const width = canvas.width;
    const height = canvas.height;
    const gray = new Float32Array(width * height);
    
    for (let i = 0; i < width * height; i++) {
        gray[i] = currentImage.data[i * 4];
    }
    
    return { gray, width, height };
}

function refineContours() {
    if (!currentMask || !maskCtx) {
        showStatus('No mask to refine', 'error');
        return;
    }
    
    showStatus('Refining contours...', 'success');
    
    setTimeout(() => {
        try {
            const grayData = getGrayscaleData();
            if (!grayData) {
                showStatus('No image data', 'error');
                return;
            }
            
            const { gray, width, height } = grayData;
            const method = document.getElementById('refineMethod').value;
            const iterations = parseInt(document.getElementById('refineIterations').value);
            const edgeStrength = parseInt(document.getElementById('refineEdgeStrength').value) / 100;
            const smoothness = parseInt(document.getElementById('refineSmoothness').value) / 100;
            
            // Compute edge stopping function
            const g = Refinement.computeEdgeStoppingFunction(gray, width, height, 1.5 * (1 - edgeStrength));
            
            // Get selected label
            const selectedLabel = parseInt(document.getElementById('labelSelect').value);
            const selectedColor = COLORS[selectedLabel];
            const selR = parseInt(selectedColor.substr(1, 2), 16);
            const selG = parseInt(selectedColor.substr(3, 2), 16);
            const selB = parseInt(selectedColor.substr(5, 2), 16);
            
            // Get current mask
            const imageData = maskCtx.getImageData(0, 0, width, height);
            
            // Pre-compute color values for tolerance matching
            const colorValues = {};
            for (const [label, color] of Object.entries(COLORS)) {
                colorValues[label] = {
                    r: parseInt(color.substr(1, 2), 16),
                    g: parseInt(color.substr(3, 2), 16),
                    b: parseInt(color.substr(5, 2), 16)
                };
            }
            
            // Classify all pixels and extract ONLY selected label for refinement
            const binary = new Uint8Array(width * height);
            const otherLabelsData = new Uint8Array(width * height); // Store other labels
            let hasSelectedLabel = false;
            
            for (let i = 0; i < width * height; i++) {
                const idx = i * 4;
                const r = imageData.data[idx];
                const gVal = imageData.data[idx + 1];
                const b = imageData.data[idx + 2];
                const a = imageData.data[idx + 3];
                
                if (a > 0) {
                    let bestLabel = 0;
                    let bestDist = Infinity;
                    
                    for (const [label, cv] of Object.entries(colorValues)) {
                        const dist = Math.abs(r - cv.r) + Math.abs(gVal - cv.g) + Math.abs(b - cv.b);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestLabel = parseInt(label);
                        }
                    }
                    
                    if (bestDist < 100) {
                        if (bestLabel === selectedLabel) {
                            binary[i] = 1;
                            hasSelectedLabel = true;
                        } else {
                            otherLabelsData[i] = bestLabel; // Store other labels to preserve
                        }
                    }
                }
            }
            
            if (!hasSelectedLabel) {
                showStatus('No mask found for selected label', 'error');
                return;
            }
            
            // Apply selected refinement method ONLY to selected label
            let refined;
            switch (method) {
                case 'grabcut':
                    refined = Refinement.grabCutRefinement(binary, gray, width, height, iterations);
                    refined = Refinement.morphSmooth(refined, width, height, 2);
                    break;
                case 'randomwalk':
                    refined = Refinement.randomWalkerRefinement(binary, gray, g, width, height, iterations);
                    refined = Refinement.morphSmooth(refined, width, height, 1);
                    break;
                case 'fluidgrabcut':
                        const fluidMinHU = parseInt(document.getElementById('fluidMinHU').value);
                        const fluidMaxHU = parseInt(document.getElementById('fluidMaxHU').value);
                        const fluidHUTolerance = parseInt(document.getElementById('fluidHUTolerance')?.value || 150);
                        const huData = getCurrentSliceHUData();
                        if (huData) {
                            refined = Refinement.fluidAwareGrabCutRefinement(binary, huData, width, height, {
                                minHU: fluidMinHU,
                                maxHU: fluidMaxHU,
                                huTolerance: fluidHUTolerance
                            });
                    } else {
                        // Fallback to regular GrabCut if no HU data
                        console.log('[refineFluidPropagate] No HU data available, skipping refinement');
                        refined = Refinement.grabCutRefinement(binary, gray, width, height, iterations);
                        refined = Refinement.morphSmooth(refined, width, height, 1);
                    }
                    break;
                case 'combined':
                default:
                    refined = Refinement.grabCutRefinement(binary, gray, width, height, iterations);
                    refined = Refinement.morphSmooth(refined, width, height, 2);
                    break;
            }
            
            // Build output: refined selected label + preserved other labels
            const outputData = maskCtx.createImageData(width, height);
            
            for (let i = 0; i < width * height; i++) {
                const idx = i * 4;
                
                if (refined[i] === 1) {
                    // Refined selected label
                    outputData.data[idx] = selR;
                    outputData.data[idx + 1] = selG;
                    outputData.data[idx + 2] = selB;
                    outputData.data[idx + 3] = 255;
                } else if (otherLabelsData[i] > 0) {
                    // Preserved other label
                    const otherColor = COLORS[otherLabelsData[i]];
                    outputData.data[idx] = parseInt(otherColor.substr(1, 2), 16);
                    outputData.data[idx + 1] = parseInt(otherColor.substr(3, 2), 16);
                    outputData.data[idx + 2] = parseInt(otherColor.substr(5, 2), 16);
                    outputData.data[idx + 3] = 255;
                }
            }
            
            // Update mask
            maskCtx.clearRect(0, 0, width, height);
            maskCtx.putImageData(outputData, 0, 0);
            
            redraw();
            saveToHistory();
            
            showStatus('Contours refined!', 'success');
            
        } catch (err) {
            console.error('Refinement error:', err);
            showStatus('Error: ' + err.message, 'error');
        }
    }, 50);
}

// ==================== 3D Visualization ====================
function show3DView() {
    if (!masks || !ctDims) {
        showStatus('No masks to visualize', 'error');
        return;
    }
    
    // Save current mask first
    saveMaskSilent();
    
    // Show modal
    document.getElementById('modal3D').classList.add('visible');
    
    // Initialize Three.js if needed
    if (!window.scene3D) {
        Visualization3D.init3DScene();
    }
    
    // Show building message
    const container = document.getElementById('canvas3D').parentElement;
    const existingMsg = container.querySelector('.building-msg');
    if (existingMsg) existingMsg.remove();
    
    const msg = document.createElement('div');
    msg.className = 'building-msg';
    msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#00d9ff;font-size:1.2em;z-index:10;';
    msg.textContent = 'Building 3D mesh...';
    container.appendChild(msg);
    
    // Build mesh with delay to allow UI update
    setTimeout(() => {
        Visualization3D.build3DMesh();
        msg.remove();
        Visualization3D.animate3D();
    }, 50);
}

function close3DView() {
    document.getElementById('modal3D').classList.remove('visible');
    Visualization3D.close3DModal();
}

function update3DView() {
    Visualization3D.update3DView();
}

function updatePointSize() {
    Visualization3D.updatePointSize();
}

function updateShading() {
    Visualization3D.updateShading();
}

function toggleAutoRotate() {
    Visualization3D.toggleAutoRotate();
}

// ==================== Send to Server ====================
async function sendMaskToServer() {
    // Check if we have masks and CT data (works for both NIfTI and DICOM modes)
    if (!masks || !ctDims) {
        showStatus('No masks to send - load a CT scan first', 'error');
        return;
    }
    
    saveMaskSilent();
    
    // Create sparse data (only non-zero voxels)
    const sparseData = [];
    const sliceSize = ctDims[0] * ctDims[1];
    
    for (let i = 0; i < masks.length; i++) {
        if (masks[i] > 0) {
            const z = Math.floor(i / sliceSize);
            const remainder = i % sliceSize;
            const y = Math.floor(remainder / ctDims[0]);
            const x = remainder % ctDims[0];
            sparseData.push([x, y, z, masks[i]]);
        }
    }
    
    if (sparseData.length === 0) {
        showStatus('No annotations to send', 'error');
        return;
    }
    
    showLoading(true, 'Sending mask to server...');
    
    try {
        // Build affine from spatial params (handle both NIfTI and DICOM modes)
        let affine;
        
        if (nifti && nifti.spatial) {
            // NIfTI mode - use stored spatial params
            const sp = nifti.spatial;
            affine = [
                sp.srow_x,
                sp.srow_y,
                sp.srow_z,
                [0, 0, 0, 1]
            ];
        } else if (isDicomMode && dicomLoader) {
            // DICOM mode - get proper affine from DICOM spatial metadata
            // This includes orientation, spacing, AND origin for 3D Slicer compatibility
            affine = dicomLoader.getAffineMatrix();
            
            // Log spatial debug info for troubleshooting
            console.log(dicomLoader.getSpatialDebugInfo());
        } else {
            // Fallback - identity affine with unit spacing
            affine = [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
                [0, 0, 1, 0],
                [0, 0, 0, 1]
            ];
        }
        
        // Prepare comments for export
        const commentsData = getCommentsForExport();
        
        const response = await fetch('/api/upload_mask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                patientId: currentPatientId,
                seriesId: currentSeriesId,
                originalFilename: loadedCtFileName || 'unknown.nii',
                dimensions: ctDims,
                affine: affine,
                sparseData: sparseData,
                comments: commentsData
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            let statusMsg = `Mask saved as ${result.filename} (${result.voxels.toLocaleString()} voxels)`;
            if (result.commentsFile) {
                statusMsg += ` | Comments: ${result.commentsFile}`;
            }
            showStatus(statusMsg, 'success');
        } else {
            showStatus('Error: ' + result.error, 'error');
        }
    } catch (err) {
        showStatus('Error sending mask: ' + err.message, 'error');
    }
    
    showLoading(false);
}

// ==================== File Browser Integration (Local + Google Drive) ====================
let currentBrowserMode = 'local';  // 'local' or 'drive'
let localBreadcrumbPath = [];

function openDriveModal() {
    document.getElementById('driveModal').classList.add('visible');
    // Default to local if available, otherwise Google Drive
    checkLocalStatus().then(available => {
        if (available) {
            switchBrowserTab('local');
        } else {
            switchBrowserTab('drive');
        }
    });
}

function closeDriveModal() {
    document.getElementById('driveModal').classList.remove('visible');
}

async function checkLocalStatus() {
    try {
        const response = await fetch('/api/local/status');
        const data = await response.json();
        return data.success;
    } catch {
        return false;
    }
}

function switchBrowserTab(mode) {
    currentBrowserMode = mode;
    
    // Update tab styles
    document.getElementById('tabLocal').classList.toggle('active', mode === 'local');
    document.getElementById('tabDrive').classList.toggle('active', mode === 'drive');
    
    // Browse the selected source
    if (mode === 'local') {
        browseLocal();
    } else {
        browseDrive();
    }
}

// ==================== Local Folder Browser ====================
async function browseLocal(folderPath = '') {
    const content = document.getElementById('driveContent');
    content.innerHTML = '<div class="drive-loading">📂 Loading local folder...</div>';
    
    try {
        // First check if local is configured
        const statusResponse = await fetch('/api/local/status');
        const status = await statusResponse.json();
        
        if (!status.success) {
            content.innerHTML = `
                <div class="local-status error">
                    <strong>⚠️ Local folder not configured</strong><br>
                    <p>Edit <code>config.py</code> and set <code>LOCAL_DATA_PATH</code> to your DICOM folder.</p>
                    <p>Example: <code>LOCAL_DATA_PATH = r'C:\\CT_Data'</code></p>
                    <p style="margin-top:10px;color:#888;">Error: ${status.error}</p>
                </div>
            `;
            return;
        }
        
        const url = folderPath ? `/api/local/browse/${encodeURIComponent(folderPath)}` : '/api/local/browse';
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.success) {
            content.innerHTML = `<div class="drive-error">❌ ${data.error}</div>`;
            return;
        }
        
        updateLocalBreadcrumb(data);
        renderLocalContents(data);
        
    } catch (err) {
        content.innerHTML = `<div class="drive-error">❌ Failed to load: ${err.message}</div>`;
    }
}

function updateLocalBreadcrumb(data) {
    const breadcrumb = document.getElementById('driveBreadcrumb');
    
    if (data.isRoot) {
        localBreadcrumbPath = [{ path: '', name: '🏠 Local Data' }];
    } else {
        // Build path from folder path
        const parts = data.folderPath.split(/[/\\]/);
        localBreadcrumbPath = [{ path: '', name: '🏠 Local Data' }];
        let currentPath = '';
        for (const part of parts) {
            if (part) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                localBreadcrumbPath.push({ path: currentPath, name: part });
            }
        }
    }
    
    breadcrumb.innerHTML = localBreadcrumbPath.map((item, index) => {
        if (index === localBreadcrumbPath.length - 1) {
            return `<span class="drive-breadcrumb-current">${escapeHtml(item.name)}</span>`;
        } else {
            const encodedPath = encodeURIComponent(item.path);
            return `<span class="drive-breadcrumb-item" onclick="browseLocal(decodeURIComponent('${encodedPath}'))">${escapeHtml(item.name)}</span>
                    <span class="drive-breadcrumb-separator">›</span>`;
        }
    }).join('');
}

function renderLocalContents(data) {
    const content = document.getElementById('driveContent');
    let html = '';
    
    // Show speed badge for local
    html += `<div class="local-status success">
        <strong>⚡ Local folder active</strong> - Loading is instant!
    </div>`;
    
    // Check if this folder IS a DICOM series
    if (data.isDicomFolder) {
        const encodedFolderPath = encodeURIComponent(data.folderPath);
        const encodedFolderName = encodeURIComponent(data.folderName);
        html += `<div class="drive-section">
            <div class="drive-section-title" style="color: #00d9ff;">
                🏥 This folder contains a DICOM series
                <span class="dicom-folder-badge">${data.dicomCount} slices</span>
                <span class="speed-badge">⚡ INSTANT</span>
            </div>
            <div class="drive-item dicom-folder" style="margin: 10px 0;">
                <span class="drive-item-icon">📂</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${escapeHtml(data.folderName)}</div>
                    <div class="drive-item-meta">${data.dicomCount} DICOM files • Local disk = instant loading!</div>
                </div>
                <div class="drive-item-actions">
                    <button class="drive-item-btn load-dicom" onclick="event.stopPropagation(); loadLocalDicom(decodeURIComponent('${encodedFolderPath}'), decodeURIComponent('${encodedFolderName}'))">
                        ⚡ Load DICOM
                    </button>
                </div>
            </div>
        </div>`;
    }
    
    // Folders section
    if (data.folders.length > 0) {
        html += `<div class="drive-section">
            <div class="drive-section-title">📁 Folders (${data.folders.length})</div>`;
        data.folders.forEach(folder => {
            const encodedPath = encodeURIComponent(folder.path);
            html += `<div class="drive-item" onclick="browseLocal(decodeURIComponent('${encodedPath}'))">
                <span class="drive-item-icon folder">📁</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${escapeHtml(folder.name)}</div>
                    <div class="drive-item-meta">Folder</div>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // NIfTI files section
    if (data.niftiFiles && data.niftiFiles.length > 0) {
        html += `<div class="drive-section">
            <div class="drive-section-title">🧠 NIfTI Files (${data.niftiFiles.length})
                <span class="speed-badge">⚡ FAST</span>
            </div>`;
        data.niftiFiles.forEach(file => {
            const encodedPath = encodeURIComponent(file.path);
            const encodedName = encodeURIComponent(file.name);
            const isMask = file.name.toLowerCase().includes('mask') || file.name.toLowerCase().includes('seg');
            html += `<div class="drive-item">
                <span class="drive-item-icon nifti">${isMask ? '🎭' : '🧠'}</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${escapeHtml(file.name)}</div>
                    <div class="drive-item-meta">${formatFileSize(file.size)}${isMask ? ' • Mask file' : ''}</div>
                </div>
                <div class="drive-item-actions">
                    ${isMask ? 
                        `<button class="drive-item-btn" onclick="event.stopPropagation(); loadLocalMask(decodeURIComponent('${encodedPath}'), decodeURIComponent('${encodedName}'))">Load Mask</button>` :
                        `<button class="drive-item-btn load-ct" onclick="event.stopPropagation(); loadLocalNifti(decodeURIComponent('${encodedPath}'), decodeURIComponent('${encodedName}'))">⚡ Load CT</button>`
                    }
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // CSV files section (for masks/polyp data)
    if (data.csvFiles && data.csvFiles.length > 0) {
        html += `<div class="drive-section">
            <div class="drive-section-title">📊 CSV Files (${data.csvFiles.length})</div>`;
        data.csvFiles.forEach(file => {
            const encodedPath = encodeURIComponent(file.path);
            const encodedName = encodeURIComponent(file.name);
            html += `<div class="drive-item">
                <span class="drive-item-icon csv">📊</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${escapeHtml(file.name)}</div>
                    <div class="drive-item-meta">${formatFileSize(file.size)}</div>
                </div>
                <div class="drive-item-actions">
                    <button class="drive-item-btn" onclick="event.stopPropagation(); loadLocalCsv(decodeURIComponent('${encodedPath}'), decodeURIComponent('${encodedName}'))">Load CSV</button>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // Empty state
    if (data.folders.length === 0 && (!data.niftiFiles || data.niftiFiles.length === 0) && !data.isDicomFolder) {
        html += '<div class="drive-empty">📭 This folder is empty or contains no supported files</div>';
    }
    
    content.innerHTML = html;
}

// ==================== Load from Local Disk ====================
async function loadLocalDicom(folderPath, folderName) {
    try {
        // Stop any existing loading
        if (dicomLoader) {
            dicomLoader.stopLoading();
        }
        
        // Close the modal immediately
        closeDriveModal();
        
        // Reset state
        isDicomMode = true;
        dicomFolderId = null;  // Not using Drive
        nifti = null;
        
        // Extract patient ID and series ID from folder path
        // folderPath format: ".../PatientID/SeriesID" or "PatientID/SeriesID"
        const pathParts = folderPath.split(/[/\\]/).filter(p => p.length > 0);
        if (pathParts.length >= 2) {
            currentSeriesId = pathParts[pathParts.length - 1];  // Last part is series (DICOM folder)
            currentPatientId = pathParts[pathParts.length - 2]; // Second to last is patient
        } else if (pathParts.length === 1) {
            currentSeriesId = pathParts[0];
            currentPatientId = 'unknown';
        } else {
            currentSeriesId = folderName;
            currentPatientId = 'unknown';
        }
        console.log(`[DICOM] Patient ID: ${currentPatientId}, Series ID: ${currentSeriesId}`);
        
        // Clear polyp data, measurements, and comments from previous scan
        clearPolypData();
        clearAllMeasurements();
        clearAllComments();
        
        // Show progress UI
        const progressContainer = document.getElementById('dicomLoadingProgress');
        progressContainer.classList.remove('hidden');
        document.getElementById('dicomSliceStatus').textContent = 'Loading from local disk...';
        
        // Create loader with local endpoints
        dicomLoader = new DICOMLoader();
        dicomLoader.useLocalEndpoint = true;
        dicomLoader.localFolderPath = folderPath;
        
        // Set up callbacks (same as Drive version)
        dicomLoader.onProgress = (loaded, total, message) => {
            const percent = Math.round((loaded / total) * 100);
            document.getElementById('dicomLoadingCount').textContent = `${loaded}/${total}`;
            document.getElementById('dicomProgressBar').style.width = `${percent}%`;
            document.getElementById('dicomSliceStatus').textContent = message;
        };
        
        dicomLoader.onSliceLoaded = (sliceIndex, pixelData, metadata) => {
            if (sliceIndex === currentSlice && ctData) {
                const sliceSize = ctDims[0] * ctDims[1];
                const offset = sliceIndex * sliceSize;
                for (let i = 0; i < sliceSize; i++) {
                    ctData[offset + i] = pixelData[i];
                }
                renderSlice();
            }
        };
        
        dicomLoader.onReady = (firstSlice) => {
            const dims = dicomLoader.getDimensions();
            ctDims = dims;
            totalSlices = dims[2];
            
            const totalVoxels = dims[0] * dims[1] * dims[2];
            ctData = new Float32Array(totalVoxels);
            
            const firstSliceData = dicomLoader.getSliceData(firstSlice);
            const sliceSize = dims[0] * dims[1];
            const offset = firstSlice * sliceSize;
            for (let i = 0; i < sliceSize; i++) {
                ctData[offset + i] = firstSliceData[i];
            }
            
            masks = new Uint8Array(totalVoxels);
            
            document.getElementById('sliceSliderVertical').max = totalSlices - 1;
            document.getElementById('sliceSliderVertical').value = firstSlice;
            document.getElementById('totalSlices').textContent = totalSlices;
            document.getElementById('gotoSlice').max = totalSlices;
            
            currentSlice = firstSlice;
            initialSlice = currentSlice;
            
            document.getElementById('debugInfo').textContent = dicomLoader.getDebugInfo();
            document.getElementById('loadedCtFile').classList.remove('hidden');
            document.getElementById('loadedCtFileName').textContent = `💻 ${folderName} (Local DICOM)`;
            loadedCtFileName = folderName;
            
            document.getElementById('maskInput').disabled = false;
            document.getElementById('maskStatus').textContent = 'Ready to load mask';
            document.getElementById('maskStatus').style.color = '#00d9ff';
            
            showStatus(`Local DICOM loaded: ${folderName} (${dims.join(' × ')})`, 'success');
            changeSliceVertical();
            fitToView();

            // Auto-load polyp CSV if it exists
            // CSV should be at: parentFolder/seriesFolder.csv (same level as DICOM folder)
            autoLoadPolypCSV(folderPath, folderName);
        };
        
        dicomLoader.onError = (error, sliceIndex) => {
            console.error('Local DICOM loading error:', error, 'slice:', sliceIndex);
            if (sliceIndex === undefined) {
                showStatus('Error loading local DICOM: ' + error.message, 'error');
                progressContainer.classList.add('hidden');
            }
        };
        
        // Start loading from local endpoint
        const info = await dicomLoader.initFromLocal(folderPath);
        console.log(`Starting local DICOM load: ${info.sliceCount} slices`);
        
    } catch (err) {
        showStatus('Error loading local DICOM: ' + err.message, 'error');
        console.error(err);
        document.getElementById('dicomLoadingProgress').classList.add('hidden');
    }
}

async function loadLocalNifti(filePath, fileName) {
    showLoading(true, `Loading ${fileName}...`);
    showLoadingDetail('Reading file...');
    
    // Close the modal immediately so user sees the progress
    closeDriveModal();
    
    // Clear polyp data, measurements, and comments from previous scan
    clearPolypData();
    clearAllMeasurements();
    clearAllComments();
    
    // Extract patient/series ID from file path
    const pathParts = filePath.split(/[/\\]/).filter(p => p.length > 0);
    const baseName = fileName.replace(/\.(nii|nii\.gz|gz)$/i, '');
    if (pathParts.length >= 2) {
        currentPatientId = pathParts[pathParts.length - 2];
        currentSeriesId = baseName;
    } else {
        currentPatientId = baseName;
        currentSeriesId = baseName;
    }
    console.log(`[NIfTI Local] Patient ID: ${currentPatientId}, Series ID: ${currentSeriesId}`);
    
    try {
        const response = await fetch(`/api/local/file/${encodeURIComponent(filePath)}`);
        if (!response.ok) throw new Error('Failed to load file');
        
        // Get total size from Content-Length header
        const contentLength = response.headers.get('Content-Length');
        const totalSize = contentLength ? parseInt(contentLength) : 0;
        
        // Read the response as a stream to track progress
        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            chunks.push(value);
            receivedLength += value.length;
            
            // Update progress
            if (totalSize > 0) {
                const percent = Math.round((receivedLength / totalSize) * 100);
                const receivedMB = (receivedLength / (1024 * 1024)).toFixed(1);
                const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
                showLoadingDetail(`${percent}% (${receivedMB} MB / ${totalMB} MB)`);
            } else {
                const receivedMB = (receivedLength / (1024 * 1024)).toFixed(1);
                showLoadingDetail(`Downloaded ${receivedMB} MB...`);
            }
        }
        
        // Combine chunks into a single Uint8Array
        const allChunks = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
            allChunks.set(chunk, position);
            position += chunk.length;
        }
        
        showLoadingDetail('Parsing NIfTI data...');
        
        const blob = new Blob([allChunks]);
        const file = new File([blob], fileName);
        
        nifti = new NIfTIReader();
        const result = await nifti.load(file);
        
        isDicomMode = false;
        ctData = result.data;
        ctDims = nifti.dims;
        totalSlices = ctDims[2];
        loadedCtFileName = fileName;
        
        masks = new Uint8Array(ctDims[0] * ctDims[1] * ctDims[2]);
        
        document.getElementById('sliceSliderVertical').max = totalSlices - 1;
        document.getElementById('sliceSliderVertical').value = Math.floor(totalSlices / 2);
        document.getElementById('totalSlices').textContent = totalSlices;
        document.getElementById('gotoSlice').max = totalSlices;
        
        currentSlice = Math.floor(totalSlices / 2);
        initialSlice = currentSlice;
        document.getElementById('debugInfo').textContent = nifti.getDebugInfo();
        
        document.getElementById('loadedCtFile').classList.remove('hidden');
        document.getElementById('loadedCtFileName').textContent = `💻 ${fileName}`;
        
        document.getElementById('maskInput').disabled = false;
        document.getElementById('maskStatus').textContent = 'Ready to load mask';
        document.getElementById('maskStatus').style.color = '#00d9ff';
        
        showStatus(`Loaded: ${fileName} (${ctDims.join(' × ')})`, 'success');
        changeSliceVertical();
        fitToView();
        
    } catch (err) {
        showStatus('Error: ' + err.message, 'error');
        console.error(err);
    }
    
    showLoading(false);
}

async function loadLocalCsv(filePath, fileName) {
    showLoading(true, `Loading ${fileName}...`);
    
    try {
        const response = await fetch(`/api/local/file/${encodeURIComponent(filePath)}`);
        if (!response.ok) throw new Error('Failed to load file');
        
        const text = await response.text();
        
        // Parse CSV - same format as other CSV loaders (slices, location, histology, size, source)
        const lines = text.trim().split('\n');
        if (lines.length < 2) throw new Error('CSV file is empty or has no data rows');
        
        const polyps = [];
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            
            const parts = line.split(',');
            if (parts.length >= 4) {
                const slicesStr = parts[0].trim();
                const slices = [];
                if (slicesStr) {
                    slicesStr.replace(/\//g, ',').split(',').forEach(s => {
                        s = s.trim();
                        if (s && !isNaN(parseInt(s))) slices.push(parseInt(s));
                    });
                }
                
                polyps.push({
                    slices: slices,
                    location: parts[1].trim(),
                    histology: parts[2].trim(),
                    size: parts[3].trim(),
                    source: parts[4] ? parts[4].trim() : ''
                });
            }
        }
        
        displayPolypData(polyps);
        
        document.getElementById('loadedCsvFile').classList.remove('hidden');
        document.getElementById('loadedCsvFileName').textContent = `💻 ${fileName}`;
        
        showCSVStatus(`Loaded: ${fileName} (${polyps.length} polyps)`, 'success');
        closeDriveModal();
        
    } catch (err) {
        showStatus('Error loading CSV: ' + err.message, 'error');
        console.error(err);
    }
    
    showLoading(false);
}

// Auto-load polyp CSV file if it exists alongside the DICOM folder
// DICOM folder: /path/to/PatientID/SeriesID/
// CSV file: /path/to/PatientID/SeriesID.csv
async function autoLoadPolypCSV(folderPath, folderName) {
    try {
        // Build CSV path: parent directory + folder name + .csv
        // folderPath might end with / or not, and might use / or \
        const normalizedPath = folderPath.replace(/[/\\]+$/, ''); // Remove trailing slashes
        const csvPath = normalizedPath + '.csv';
        const csvFileName = folderName + '.csv';
        
        console.log(`[Auto CSV] Checking for polyp CSV at: ${csvPath}`);
        
        // Try to fetch the CSV file
        const response = await fetch(`/api/local/file/${encodeURIComponent(csvPath)}`);
        
        if (!response.ok) {
            console.log(`[Auto CSV] No CSV file found at ${csvPath} (this is normal if no polyp data exists)`);
            return;
        }
        
        const text = await response.text();
        
        // Parse CSV
        const lines = text.trim().split('\n');
        if (lines.length < 2) {
            console.log('[Auto CSV] CSV file is empty or has no data rows');
            return;
        }
        
        const polyps = [];
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            
            const parts = line.split(',');
            if (parts.length >= 4) {
                const slicesStr = parts[0].trim();
                const slices = [];
                if (slicesStr) {
                    slicesStr.replace(/\//g, ',').split(',').forEach(s => {
                        s = s.trim();
                        if (s && !isNaN(parseInt(s))) slices.push(parseInt(s));
                    });
                }
                
                polyps.push({
                    slices: slices,
                    location: parts[1].trim(),
                    histology: parts[2].trim(),
                    size: parts[3].trim(),
                    source: parts[4] ? parts[4].trim() : ''
                });
            }
        }
        
        if (polyps.length > 0) {
            displayPolypData(polyps);
            
            document.getElementById('loadedCsvFile').classList.remove('hidden');
            document.getElementById('loadedCsvFileName').textContent = `💻 ${csvFileName} (auto-loaded)`;
            
            showCSVStatus(`Auto-loaded: ${csvFileName} (${polyps.length} polyps)`, 'success');
            console.log(`[Auto CSV] Successfully loaded ${polyps.length} polyps from ${csvFileName}`);
        }
        
    } catch (err) {
        // Silently fail - it's okay if CSV doesn't exist
        console.log('[Auto CSV] Could not auto-load CSV:', err.message);
    }
}

async function loadLocalMask(filePath, fileName) {
    if (!ctData || !ctDims) {
        showStatus('Please load a CT scan first before loading a mask', 'error');
        return;
    }
    
    showLoading(true, `Loading mask ${fileName}...`);
    
    try {
        const response = await fetch(`/api/local/file/${encodeURIComponent(filePath)}`);
        if (!response.ok) throw new Error('Failed to load mask file');
        
        const blob = await response.blob();
        const file = new File([blob], fileName);
        
        const maskReader = new NIfTIReader();
        const result = await maskReader.load(file);
        
        // Check dimensions match
        if (maskReader.dims[0] !== ctDims[0] || 
            maskReader.dims[1] !== ctDims[1] || 
            maskReader.dims[2] !== ctDims[2]) {
            throw new Error(`Mask dimensions (${maskReader.dims.join('×')}) don't match CT (${ctDims.join('×')})`);
        }
        
        // Copy mask data
        const maskData = result.data;
        for (let i = 0; i < masks.length; i++) {
            masks[i] = maskData[i] > 0 ? 1 : 0;
        }
        
        document.getElementById('maskStatus').textContent = `Loaded: ${fileName}`;
        document.getElementById('maskStatus').style.color = '#4caf50';
        
        showStatus(`Loaded mask: ${fileName}`, 'success');
        renderSlice();
        closeDriveModal();
        
    } catch (err) {
        showStatus('Error loading mask: ' + err.message, 'error');
        console.error(err);
    }
    
    showLoading(false);
}

// ==================== Google Drive Browser ====================
async function browseDrive(folderId = null) {
    const content = document.getElementById('driveContent');
    content.innerHTML = '<div class="drive-loading">📂 Loading Google Drive...</div>';
    
    try {
        const url = folderId ? `/api/drive/browse/${folderId}` : '/api/drive/browse';
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.success) {
            content.innerHTML = `<div class="drive-error">âŒ ${data.error}</div>`;
            return;
        }
        
        currentDriveFolder = data.folderId;
        updateBreadcrumb(data);
        renderDriveContents(data);
        
    } catch (err) {
        content.innerHTML = `<div class="drive-error">âŒ Failed to load: ${err.message}</div>`;
    }
}

function updateBreadcrumb(data) {
    const breadcrumb = document.getElementById('driveBreadcrumb');
    
    if (data.isRoot) {
        driveBreadcrumbPath = [{ id: null, name: '🏠 Root' }];
    } else {
        const existingIndex = driveBreadcrumbPath.findIndex(b => b.id === data.folderId);
        if (existingIndex >= 0) {
            driveBreadcrumbPath = driveBreadcrumbPath.slice(0, existingIndex + 1);
        } else {
            driveBreadcrumbPath.push({ id: data.folderId, name: data.folderName });
        }
    }
    
    breadcrumb.innerHTML = driveBreadcrumbPath.map((item, index) => {
        if (index === driveBreadcrumbPath.length - 1) {
            return `<span class="drive-breadcrumb-current">${item.name}</span>`;
        } else {
            return `<span class="drive-breadcrumb-item" onclick="browseDrive(${item.id ? "'" + item.id + "'" : 'null'})">${item.name}</span>
                    <span class="drive-breadcrumb-separator">›</span>`;
        }
    }).join('');
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeJsString(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function renderDriveContents(data) {
    const content = document.getElementById('driveContent');
    let html = '';
    
    // Check if this folder IS a DICOM series
    if (data.isDicomFolder) {
        html += `<div class="drive-section">
            <div class="drive-section-title" style="color: #00d9ff;">
                🏥 This folder contains a DICOM series
                <span class="dicom-folder-badge">${data.dicomCount} slices</span>
            </div>
            <div class="drive-item dicom-folder" style="margin: 10px 0;">
                <span class="drive-item-icon">📂</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${data.folderName}</div>
                    <div class="drive-item-meta">${data.dicomCount} DICOM files • Ready to load slice-by-slice</div>
                </div>
                <div class="drive-item-actions">
                    <button class="drive-item-btn load-dicom" onclick="event.stopPropagation(); loadDicomFromDrive('${data.folderId}', '${data.folderName.replace(/'/g, "\\'")}')">
                        ⚡ Load DICOM (Fast)
                    </button>
                </div>
            </div>
            <div style="font-size: 0.8em; color: #888; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 5px; margin-bottom: 15px;">
                <strong>💡 Tip:</strong> DICOM loading lets you start annotating immediately while remaining slices download in background.
            </div>
        </div>`;
    }
    
    // Folders section
    if (data.folders.length > 0) {
        html += `<div class="drive-section">
            <div class="drive-section-title">📁 Folders (${data.folders.length})</div>`;
        data.folders.forEach(folder => {
            html += `<div class="drive-item" onclick="browseDrive('${folder.id}')">
                <span class="drive-item-icon folder">📁</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${folder.name}</div>
                    <div class="drive-item-meta">Folder</div>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // NIfTI files section
    if (data.niftiFiles.length > 0) {
        html += `<div class="drive-section">
            <div class="drive-section-title">🧠 CT Scans - NIfTI (${data.niftiFiles.length})</div>`;
        data.niftiFiles.forEach(file => {
            html += `<div class="drive-item">
                <span class="drive-item-icon nifti">🧠</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${file.name}</div>
                    <div class="drive-item-meta">${formatFileSize(file.size)} • Full download required</div>
                </div>
                <div class="drive-item-actions">
                    <button class="drive-item-btn load-ct" onclick="event.stopPropagation(); loadCtFromDrive('${file.id}', '${file.name.replace(/'/g, "\\'")}')">Load CT</button>
                    <button class="drive-item-btn load-mask" onclick="event.stopPropagation(); loadMaskFromDrive('${file.id}', '${file.name.replace(/'/g, "\\'")}')">As Mask</button>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // CSV files section
    if (data.csvFiles.length > 0) {
        html += `<div class="drive-section">
            <div class="drive-section-title">📊 Polyp Data (${data.csvFiles.length})</div>`;
        data.csvFiles.forEach(file => {
            html += `<div class="drive-item">
                <span class="drive-item-icon csv">📊</span>
                <div class="drive-item-info">
                    <div class="drive-item-name">${file.name}</div>
                    <div class="drive-item-meta">${formatFileSize(file.size)}</div>
                </div>
                <div class="drive-item-actions">
                    <button class="drive-item-btn load-csv" onclick="event.stopPropagation(); loadCsvFromDrive('${file.id}', '${file.name.replace(/'/g, "\\'")}')">Load CSV</button>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    
    // Empty state
    if (data.folders.length === 0 && data.niftiFiles.length === 0 && data.csvFiles.length === 0 && !data.isDicomFolder) {
        html = '<div class="drive-empty">📭 This folder is empty</div>';
    }
    
    content.innerHTML = html;
}

async function loadCtFromDrive(fileId, fileName) {
    showLoading(true, `Downloading ${fileName}...`);
    showLoadingDetail('Connecting to Google Drive...');
    
    // Close the modal immediately so user sees the progress
    closeDriveModal();
    
    // Clear polyp data, measurements, and comments from previous scan
    clearPolypData();
    clearAllMeasurements();
    clearAllComments();
    
    // Extract patient/series ID from Drive breadcrumb and filename
    const baseName = fileName.replace(/\.(nii|nii\.gz|gz)$/i, '');
    if (driveBreadcrumbPath.length >= 2) {
        currentPatientId = driveBreadcrumbPath[driveBreadcrumbPath.length - 1].name;
    } else {
        currentPatientId = baseName;
    }
    currentSeriesId = baseName;
    console.log(`[NIfTI Drive] Patient ID: ${currentPatientId}, Series ID: ${currentSeriesId}`);
    
    try {
        const response = await fetch(`/api/drive/file/${fileId}`);
        if (!response.ok) throw new Error('Failed to download file');
        
        // Get total size from Content-Length header
        const contentLength = response.headers.get('Content-Length');
        const totalSize = contentLength ? parseInt(contentLength) : 0;
        
        // Read the response as a stream to track progress
        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            chunks.push(value);
            receivedLength += value.length;
            
            // Update progress
            if (totalSize > 0) {
                const percent = Math.round((receivedLength / totalSize) * 100);
                const receivedMB = (receivedLength / (1024 * 1024)).toFixed(1);
                const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
                showLoadingDetail(`${percent}% (${receivedMB} MB / ${totalMB} MB)`);
            } else {
                const receivedMB = (receivedLength / (1024 * 1024)).toFixed(1);
                showLoadingDetail(`Downloaded ${receivedMB} MB...`);
            }
        }
        
        // Combine chunks into a single Uint8Array
        const allChunks = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
            allChunks.set(chunk, position);
            position += chunk.length;
        }
        
        const blob = new Blob([allChunks]);
        const file = new File([blob], fileName);
        
        showLoadingDetail('Parsing NIfTI data...');
        
        nifti = new NIfTIReader();
        const result = await nifti.load(file);
        
        ctData = result.data;
        ctDims = nifti.dims;
        totalSlices = ctDims[2];
        loadedCtFileName = fileName;
        
        masks = new Uint8Array(ctDims[0] * ctDims[1] * ctDims[2]);
        
        document.getElementById('sliceSliderVertical').max = totalSlices - 1;
        document.getElementById('sliceSliderVertical').value = Math.floor(totalSlices / 2);
        document.getElementById('totalSlices').textContent = totalSlices;
        document.getElementById('gotoSlice').max = totalSlices;
        
        currentSlice = Math.floor(totalSlices / 2);
        initialSlice = currentSlice;  // Save for reset functionality
        document.getElementById('debugInfo').textContent = nifti.getDebugInfo();
        
        // Show loaded file indicator
        document.getElementById('loadedCtFile').classList.remove('hidden');
        document.getElementById('loadedCtFileName').textContent = fileName;
        
        // Enable mask loading
        document.getElementById('maskInput').disabled = false;
        document.getElementById('maskStatus').textContent = 'Ready to load mask';
        document.getElementById('maskStatus').style.color = '#00d9ff';
        
        showStatus(`Loaded: ${fileName} (${ctDims.join(' × ')})`, 'success');
        changeSliceVertical();
        fitToView();
        
    } catch (err) {
        showStatus('Error: ' + err.message, 'error');
        console.error(err);
    }
    
    showLoading(false);
}

// ==================== DICOM Slice-by-Slice Loading ====================
async function loadDicomFromDrive(folderId, folderName) {
    try {
        // Stop any existing DICOM loading
        if (dicomLoader) {
            dicomLoader.stopLoading();
        }
        
        // Close the modal immediately so user doesn't have to wait
        closeDriveModal();
        
        // Reset state
        isDicomMode = true;
        dicomFolderId = folderId;
        nifti = null;  // Clear NIfTI reference
        
        // Extract patient ID and series ID from Drive breadcrumb path
        // Breadcrumb format: [Root, ..., PatientID, SeriesID]
        currentSeriesId = folderName;  // The DICOM folder name is the series ID
        if (driveBreadcrumbPath.length >= 2) {
            // Get the parent folder name as patient ID
            currentPatientId = driveBreadcrumbPath[driveBreadcrumbPath.length - 1].name;
        } else {
            currentPatientId = 'unknown';
        }
        console.log(`[DICOM Drive] Patient ID: ${currentPatientId}, Series ID: ${currentSeriesId}`);
        
        // Clear polyp data, measurements, and comments from previous scan
        clearPolypData();
        clearAllMeasurements();
        clearAllComments();
        
        // Show DICOM loading progress UI
        const progressContainer = document.getElementById('dicomLoadingProgress');
        progressContainer.classList.remove('hidden');
        document.getElementById('dicomSliceStatus').textContent = 'Connecting to Google Drive...';
        
        // Create new loader
        dicomLoader = new DICOMLoader();
        
        // Set up callbacks
        dicomLoader.onProgress = (loaded, total, message) => {
            const percent = Math.round((loaded / total) * 100);
            document.getElementById('dicomLoadingCount').textContent = `${loaded}/${total}`;
            document.getElementById('dicomProgressBar').style.width = `${percent}%`;
            document.getElementById('dicomSliceStatus').textContent = message;
        };
        
        dicomLoader.onSliceLoaded = (sliceIndex, pixelData, metadata) => {
            // Update ctData for this slice if we're viewing it
            if (sliceIndex === currentSlice && ctData) {
                // Copy the loaded slice data to ctData
                const sliceSize = ctDims[0] * ctDims[1];
                const offset = sliceIndex * sliceSize;
                for (let i = 0; i < sliceSize; i++) {
                    ctData[offset + i] = pixelData[i];
                }
                // Re-render if this is the current slice
                renderSlice();
            }
        };
        
        dicomLoader.onReady = (firstSlice) => {
            // First slice is loaded - initialize the viewer
            const dims = dicomLoader.getDimensions();
            ctDims = dims;
            totalSlices = dims[2];
            
            // Create ctData array (will be filled progressively)
            const totalVoxels = dims[0] * dims[1] * dims[2];
            ctData = new Float32Array(totalVoxels);
            
            // Copy first slice data
            const firstSliceData = dicomLoader.getSliceData(firstSlice);
            const sliceSize = dims[0] * dims[1];
            const offset = firstSlice * sliceSize;
            for (let i = 0; i < sliceSize; i++) {
                ctData[offset + i] = firstSliceData[i];
            }
            
            // Initialize masks
            masks = new Uint8Array(totalVoxels);
            
            // Update UI
            document.getElementById('sliceSliderVertical').max = totalSlices - 1;
            document.getElementById('sliceSliderVertical').value = firstSlice;
            document.getElementById('totalSlices').textContent = totalSlices;
            document.getElementById('gotoSlice').max = totalSlices;
            
            currentSlice = firstSlice;
            initialSlice = currentSlice;
            
            // Update debug info
            document.getElementById('debugInfo').textContent = dicomLoader.getDebugInfo();
            
            // Show loaded file indicator
            document.getElementById('loadedCtFile').classList.remove('hidden');
            document.getElementById('loadedCtFileName').textContent = `📂 ${folderName} (DICOM)`;
            loadedCtFileName = folderName;
            
            // Enable mask loading
            document.getElementById('maskInput').disabled = false;
            document.getElementById('maskStatus').textContent = 'Ready to load mask';
            document.getElementById('maskStatus').style.color = '#00d9ff';
            
            // Render the first slice
            showStatus(`DICOM loaded: ${folderName} (${dims.join(' × ')}) - annotate now while loading continues`, 'success');
            changeSliceVertical();
            fitToView();
        };
        
        dicomLoader.onError = (error, sliceIndex) => {
            console.error('DICOM loading error:', error, 'slice:', sliceIndex);
            if (sliceIndex === undefined) {
                // Fatal error
                showStatus('Error loading DICOM: ' + error.message, 'error');
                progressContainer.classList.add('hidden');
            }
        };
        
        // Start loading
        const info = await dicomLoader.initFromDrive(folderId);
        console.log(`Starting DICOM load: ${info.sliceCount} slices, first slice: ${info.firstSlice}`);
        
    } catch (err) {
        showStatus('Error loading DICOM folder: ' + err.message, 'error');
        console.error(err);
        document.getElementById('dicomLoadingProgress').classList.add('hidden');
    }
}

// Update the slice data when navigating (for DICOM mode)
function ensureSliceLoaded(sliceIndex) {
    if (!isDicomMode || !dicomLoader) return true;
    
    if (dicomLoader.isSliceLoaded(sliceIndex)) {
        // Copy data from loader to ctData if needed
        const sliceData = dicomLoader.getSliceData(sliceIndex);
        if (sliceData && ctData) {
            const sliceSize = ctDims[0] * ctDims[1];
            const offset = sliceIndex * sliceSize;
            for (let i = 0; i < sliceSize; i++) {
                ctData[offset + i] = sliceData[i];
            }
        }
        return true;
    } else {
        // Prioritize loading this slice
        dicomLoader.prioritizeSlice(sliceIndex);
        return false;
    }
}

// Check if slice is available (for UI feedback)
function isSliceAvailable(sliceIndex) {
    if (!isDicomMode) return true;
    if (!dicomLoader) return false;
    return dicomLoader.isSliceLoaded(sliceIndex);
}

async function loadCsvFromDrive(fileId, fileName) {
    showLoading(true, `Loading ${fileName}...`);
    
    try {
        const response = await fetch(`/api/drive/file/${fileId}`);
        if (!response.ok) throw new Error('Failed to download file');
        
        const text = await response.text();
        parseAndDisplayCsvFromDrive(text, fileName);
        
        // Show loaded file indicator
        document.getElementById('loadedCsvFile').classList.remove('hidden');
        document.getElementById('loadedCsvFileName').textContent = fileName;
        
        closeDriveModal();
        
    } catch (err) {
        showStatus('Error loading CSV: ' + err.message, 'error');
        console.error(err);
    }
    
    showLoading(false);
}

async function loadMaskFromDrive(fileId, fileName) {
    const LABEL_NAMES = {1: 'Colon', 2: 'Polyp', 3: 'Fluid Pockets', 4: 'Other'};
    if (!ctDims) {
        alert('Please load a CT scan first');
        return;
    }
    
    showLoading(true, `Loading mask ${fileName}...`);
    showLoadingDetail('Connecting to Google Drive...');
    
    try {
        const response = await fetch(`/api/drive/file/${fileId}`);
        if (!response.ok) throw new Error('Failed to download file');
        
        // Get total size from Content-Length header
        const contentLength = response.headers.get('Content-Length');
        const totalSize = contentLength ? parseInt(contentLength) : 0;
        
        // Read the response as a stream to track progress
        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            chunks.push(value);
            receivedLength += value.length;
            
            // Update progress
            if (totalSize > 0) {
                const percent = Math.round((receivedLength / totalSize) * 100);
                const receivedMB = (receivedLength / (1024 * 1024)).toFixed(1);
                const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
                showLoadingDetail(`${percent}% (${receivedMB} MB / ${totalMB} MB)`);
            } else {
                const receivedMB = (receivedLength / (1024 * 1024)).toFixed(1);
                showLoadingDetail(`Downloaded ${receivedMB} MB...`);
            }
        }
        
        // Combine chunks into a single Uint8Array
        const allChunks = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
            allChunks.set(chunk, position);
            position += chunk.length;
        }
        
        const blob = new Blob([allChunks]);
        const file = new File([blob], fileName);
        
        showLoadingDetail('Parsing mask data...');
        
        const maskReader = new NIfTIReader();
        const maskResult = await maskReader.load(file);
        
        const maskDims = maskReader.dims;
        const maskData = maskResult.data;
        
        if (maskDims[0] !== ctDims[0] || maskDims[1] !== ctDims[1] || maskDims[2] !== ctDims[2]) {
            throw new Error(`Mask dimensions (${maskDims.join('x')}) don't match CT (${ctDims.join('x')})`);
        }
        
        // Check mask orientation and convert LPS to RAS if needed
        const maskOrientation = maskReader.getOrientationCode();
        if (maskOrientation === 'LPS') {
            console.log('Mask is LPS — flipping X and Y axes to convert to RAS');
            const w = maskDims[0];
            const h = maskDims[1];
            const d = maskDims[2];
            const flipped = new Float32Array(maskData.length);
            for (let z = 0; z < d; z++) {
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const srcIdx = z * (w * h) + y * w + x;
                        const dstIdx = z * (w * h) + ((h - 1) - y) * w + ((w - 1) - x);
                        flipped[dstIdx] = maskData[srcIdx];
                    }
                }
            }
            for (let i = 0; i < maskData.length; i++) {
                maskData[i] = flipped[i];
            }
        }
        
        // Use the currently selected label for all non-zero mask voxels
        const selectedLabel = parseInt(document.getElementById('labelSelect').value);
        
        // Apply mask data with selected label
        // Check if mask is from our tool
        const isOurTool = maskReader.isFromCTColonTool();
        
        let voxelCount = 0;
        
        if (isOurTool) {
            // From our tool: load with original labels preserved
            console.log('Mask from CTColonTool — loading with original labels');
            for (let i = 0; i < maskData.length; i++) {
                if (maskData[i] !== 0) {
                    masks[i] = maskData[i];
                    voxelCount++;
                }
            }
        } else {
            // External mask (e.g., 3D Slicer): reverse slice order and use selected label
            console.log('External mask — reversing slice order and applying selected label');
            const selectedLabel = parseInt(document.getElementById('labelSelect').value);
            const w = maskDims[0];
            const h = maskDims[1];
            const d = maskDims[2];
            const sliceSize = w * h;
            
            for (let z = 0; z < d; z++) {
                const srcSliceOffset = z * sliceSize;
                const dstSliceOffset = (d - 1 - z) * sliceSize;
                for (let i = 0; i < sliceSize; i++) {
                    if (maskData[srcSliceOffset + i] !== 0) {
                        masks[dstSliceOffset + i] = selectedLabel;
                        voxelCount++;
                    }
                }
            }
        }
        
        renderSlice();
        updateStats();
        
        if (isOurTool) {
            showStatus(`Loaded mask: ${voxelCount.toLocaleString()} voxels (CTColonTool, labels preserved)`, 'success');
        } else {
            const selectedLabel = parseInt(document.getElementById('labelSelect').value);
            const labelName = LABEL_NAMES[selectedLabel] || 'Label ' + selectedLabel;
            showStatus(`🔄 External mask: ${voxelCount.toLocaleString()} voxels as ${labelName} (slices reversed)`, 'success');
        }
        closeDriveModal();
        
    } catch (err) {
        showStatus('Error: ' + err.message, 'error');
        console.error(err);
    }
    
    showLoading(false);
}

function parseAndDisplayCsvFromDrive(text, fileName) {
    const lines = text.trim().split('\n');
    const polyps = [];
    
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        
        const parts = line.split(',');
        if (parts.length >= 4) {
            const slicesStr = parts[0].trim();
            const slices = [];
            if (slicesStr) {
                slicesStr.replace(/\//g, ',').split(',').forEach(s => {
                    s = s.trim();
                    if (s && !isNaN(parseInt(s))) slices.push(parseInt(s));
                });
            }
            
            polyps.push({
                slices: slices,
                location: parts[1].trim(),
                histology: parts[2].trim(),
                size: parts[3].trim(),
                source: parts[4] ? parts[4].trim() : ''
            });
        }
    }
    
    displayPolypData(polyps);
    showCSVStatus(`Loaded: ${fileName}`, 'success');
}

function getSourceBadge(source) {
    if (!source) return '-';
    const s = source.toLowerCase();
    if (s.includes('colonoscopy')) return `<span class="source-badge colonoscopy">${source}</span>`;
    if (s.includes('pathology')) return `<span class="source-badge pathology">${source}</span>`;
    return source;
}

function getHistologyBadge(histology) {
    if (!histology) return '<span class="polyp-badge other">Unknown</span>';
    const h = histology.toLowerCase();
    if (h.includes('carcinoma') || h.includes('adenocarcinoma') || h.includes('mucinous') || h.includes('signet')) {
        return `<span class="polyp-badge carcinoma">${histology}</span>`;
    }
    if (h.includes('adenoma') || h.includes('tubular') || h.includes('villous') || h.includes('dysplasia')) {
        return `<span class="polyp-badge adenoma">${histology}</span>`;
    }
    if (h.includes('hyperplastic')) {
        return `<span class="polyp-badge hyperplastic">${histology}</span>`;
    }
    if (h.includes('normal')) {
        return `<span class="polyp-badge normal">${histology}</span>`;
    }
    if (h.includes('lipoma') || h.includes('lipomatous')) {
        return `<span class="polyp-badge lipomatous">${histology}</span>`;
    }
    return `<span class="polyp-badge other">${histology}</span>`;
}

// ==================== Polyp Data Display ====================

// Clear polyp data when loading new CT scan
function clearPolypData() {
    const container = document.getElementById('polypPanelContainer');
    const tbody = document.getElementById('polypTableBody');
    const countBadge = document.getElementById('polypCountBadge');
    
    if (tbody) tbody.innerHTML = '';
    if (countBadge) countBadge.textContent = '0';
    if (container) container.style.display = 'none';
    
    // Clear visited slices
    visitedSlices.clear();
    
    // Clear CSV status
    const csvStatus = document.getElementById('csvStatus');
    if (csvStatus) {
        csvStatus.textContent = 'No polyp data loaded';
        csvStatus.className = 'csv-status';
    }
    
    console.log('[Polyp] Cleared polyp data');
}

function displayPolypData(polyps) {
    const container = document.getElementById('polypPanelContainer');
    const tbody = document.getElementById('polypTableBody');
    const countBadge = document.getElementById('polypCountBadge');
    tbody.innerHTML = '';
    
    if (!polyps || polyps.length === 0) { 
        container.style.display = 'none'; 
        return; 
    }
    
    container.style.display = 'block';
    countBadge.textContent = polyps.length;
    
    polyps.forEach((polyp, polypIndex) => {
        // Row 1: candidate slice links from the dataset. Other columns intentionally blank —
        // the CSV gives a range of slices but doesn't tell us which one shows the polyp.
        const trSlices = document.createElement('tr');
        trSlices.id = `polyp-row-${polypIndex}-slices`;
        trSlices.className = 'polyp-slices-row';

        const slicesTd = document.createElement('td');
        if (polyp.slices && polyp.slices.length > 0) {
            polyp.slices.forEach((slice, i) => {
                const link = document.createElement('span');
                link.className = 'slice-link';
                link.id = `slice-link-${polypIndex}-${i}`;
                link.textContent = slice;
                if (visitedSlices.has(slice)) link.classList.add('visited');
                link.onclick = () => {
                    goToSlice(slice);
                    markSliceVisited(slice);
                };
                slicesTd.appendChild(link);
                if (i < polyp.slices.length - 1) slicesTd.appendChild(document.createTextNode(', '));
            });
        } else slicesTd.textContent = '-';
        trSlices.appendChild(slicesTd);
        trSlices.appendChild(Object.assign(document.createElement('td'), { colSpan: 6, className: 'polyp-slices-row-filler' }));
        tbody.appendChild(trSlices);

        // Only render the data row if the CSV actually has polyp metadata for this entry.
        // Otherwise the row would just be empty inputs/dashes next to a slice-only record.
        const hasMetadata = !!(polyp.location || polyp.histology || polyp.type || polyp.size || polyp.source);
        if (!hasMetadata) return;

        // Row 2: radiologist-entered slice + metadata.
        const tr = document.createElement('tr');
        tr.id = `polyp-row-${polypIndex}`;
        tr.className = 'polyp-data-row';

        tr.appendChild(document.createElement('td'));

        const radSliceTd = document.createElement('td');
        radSliceTd.className = 'rad-slice-cell';
        renderRadiologistSliceCell(radSliceTd, polyp, polypIndex);
        tr.appendChild(radSliceTd);

        const locTd = document.createElement('td');
        locTd.innerHTML = `<span class="location-badge">${polyp.location || '-'}</span>`;
        tr.appendChild(locTd);

        const confirmedTd = document.createElement('td');
        confirmedTd.style.textAlign = 'center';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `confirm-polyp-${polypIndex}`;
        checkbox.style.cursor = 'pointer';
        checkbox.style.width = '18px';
        checkbox.style.height = '18px';
        checkbox.onchange = () => togglePolypConfirmed(polypIndex, checkbox.checked);
        confirmedTd.appendChild(checkbox);
        tr.appendChild(confirmedTd);

        const typeTd = document.createElement('td');
        const histValue = polyp.histology || polyp.type || '-';
        typeTd.innerHTML = getHistologyBadge(histValue);
        tr.appendChild(typeTd);

        const sizeTd = document.createElement('td');
        sizeTd.textContent = polyp.size || '-';
        tr.appendChild(sizeTd);

        const sourceTd = document.createElement('td');
        sourceTd.innerHTML = getSourceBadge(polyp.source);
        tr.appendChild(sourceTd);

        tbody.appendChild(tr);
    });
}

// Track visited slices
const visitedSlices = new Set();

function markSliceVisited(slice) {
    visitedSlices.add(slice);
    // Update all slice links with this slice number
    document.querySelectorAll('.slice-link').forEach(link => {
        if (parseInt(link.textContent) === slice) {
            link.classList.add('visited');
        }
    });
}

function togglePolypConfirmed(polypIndex, confirmed) {
    const rows = [
        document.getElementById(`polyp-row-${polypIndex}-slices`),
        document.getElementById(`polyp-row-${polypIndex}`)
    ];
    rows.forEach(row => {
        if (!row) return;
        if (confirmed) row.classList.add('confirmed');
        else row.classList.remove('confirmed');
    });
}

function renderRadiologistSliceCell(cell, polyp, polypIndex) {
    cell.innerHTML = '';

    const recorded = polyp.radiologistSlice;
    if (recorded && totalSlices && recorded >= 1 && recorded <= totalSlices) {
        const link = document.createElement('span');
        link.className = 'slice-link rad-slice-link';
        link.textContent = recorded;
        link.title = 'Click to jump to slice · Double-click to edit';
        if (visitedSlices.has(recorded)) link.classList.add('visited');
        link.onclick = () => {
            goToSlice(recorded);
            markSliceVisited(recorded);
        };
        link.ondblclick = (e) => {
            e.stopPropagation();
            polyp.radiologistSlice = null;
            renderRadiologistSliceCell(cell, polyp, polypIndex);
            const input = cell.querySelector('input');
            if (input) input.focus();
        };
        cell.appendChild(link);
        return;
    }

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'rad-slice-input';
    input.min = '1';
    if (totalSlices) input.max = String(totalSlices);
    input.placeholder = '#';
    input.title = 'Enter slice number and press Enter';

    const errorMsg = document.createElement('div');
    errorMsg.className = 'rad-slice-error';
    errorMsg.style.display = 'none';

    const showError = (msg) => {
        errorMsg.textContent = msg;
        errorMsg.style.display = 'block';
        input.classList.add('invalid');
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const raw = input.value.trim();
            if (!totalSlices) { showError('No CT scan loaded'); return; }
            if (raw === '' || !/^\d+$/.test(raw)) { showError('Enter a whole number'); return; }
            const val = parseInt(raw, 10);
            if (val < 1 || val > totalSlices) { showError(`Must be between 1 and ${totalSlices}`); return; }
            polyp.radiologistSlice = val;
            renderRadiologistSliceCell(cell, polyp, polypIndex);
        }
    });
    input.addEventListener('input', () => {
        input.classList.remove('invalid');
        errorMsg.style.display = 'none';
    });

    cell.appendChild(input);
    cell.appendChild(errorMsg);
}

// ==================== Measurement Tools ====================

function toggleDistanceMeasurement() {
    if (measurementMode === 'distance') {
        cancelMeasurement();
        showStatus('Distance measurement: OFF', 'success');
    } else {
        cancelMeasurement();  // Clear any existing state
        measurementMode = 'distance';
        canvas.classList.add('measuring');
        showStatus('📏 Distance: Click and drag to measure (M to toggle, Esc to cancel)', 'success');
        updateMeasurementUI();
    }
}

function toggleAngleMeasurement() {
    if (measurementMode === 'angle') {
        cancelMeasurement();
        showStatus('Angle measurement: OFF', 'success');
    } else {
        cancelMeasurement();  // Clear any existing state
        measurementMode = 'angle';
        measurementLines = [];
        canvas.classList.add('measuring');
        showStatus('📐 Angle: Draw first line (click & drag), then second line (N to toggle, Esc to cancel)', 'success');
        updateMeasurementUI();
    }
}

function cancelMeasurement() {
    measurementMode = null;
    measurementDragging = false;
    measurementStart = null;
    measurementEnd = null;
    measurementLines = [];
    canvas.classList.remove('measuring');
    updateMeasurementUI();
    redraw();
}

function updateMeasurementUI() {
    const distBtn = document.getElementById('distanceMeasureBtn');
    const angleBtn = document.getElementById('angleMeasureBtn');
    
    if (distBtn) {
        distBtn.classList.toggle('active', measurementMode === 'distance');
    }
    if (angleBtn) {
        angleBtn.classList.toggle('active', measurementMode === 'angle');
    }
}

function getCanvasCoords(e) {
    const wrapper = document.getElementById('canvasWrapper');
    const wrapperRect = wrapper.getBoundingClientRect();
    const scale = currentZoom / 100;
    
    return {
        x: (e.clientX - wrapperRect.left) / scale,
        y: (e.clientY - wrapperRect.top) / scale
    };
}

function startMeasurementDrag(e) {
    const coords = getCanvasCoords(e);
    
    // Check bounds
    if (coords.x < 0 || coords.x >= canvas.width || coords.y < 0 || coords.y >= canvas.height) return;
    
    // Check if clicking on an existing measurement (for selection)
    const clickedIndex = findMeasurementAtPoint(coords.x, coords.y);
    
    if (clickedIndex >= 0) {
        // Select/deselect measurement
        if (selectedMeasurementIndex === clickedIndex) {
            selectedMeasurementIndex = -1;  // Deselect
            showStatus('Measurement deselected', 'success');
        } else {
            selectedMeasurementIndex = clickedIndex;
            const m = measurementsPerSlice[currentSlice][clickedIndex];
            const typeStr = m.type === 'distance' ? `📏 ${m.distance.toFixed(2)} mm` : `📐 ${m.angle.toFixed(1)}°`;
            showStatus(`Selected: ${typeStr} (press Delete or Backspace to remove)`, 'success');
        }
        redraw();
        return;
    }
    
    // Clear selection when starting a new measurement
    selectedMeasurementIndex = -1;
    
    measurementDragging = true;
    measurementStart = coords;
    measurementEnd = coords;
    redraw();
}

function updateMeasurementDrag(e) {
    if (!measurementDragging) return;
    
    const coords = getCanvasCoords(e);
    
    // Clamp to canvas bounds
    measurementEnd = {
        x: Math.max(0, Math.min(canvas.width - 1, coords.x)),
        y: Math.max(0, Math.min(canvas.height - 1, coords.y))
    };
    
    redraw();
}

function endMeasurementDrag() {
    if (!measurementDragging || !measurementStart || !measurementEnd) {
        measurementDragging = false;
        return;
    }
    
    // Check if we actually dragged (not just clicked)
    const dx = measurementEnd.x - measurementStart.x;
    const dy = measurementEnd.y - measurementStart.y;
    const dragDist = Math.sqrt(dx * dx + dy * dy);
    
    if (dragDist < 5) {
        // Too short, ignore
        measurementDragging = false;
        measurementStart = null;
        measurementEnd = null;
        redraw();
        return;
    }
    
    if (measurementMode === 'distance') {
        // Complete distance measurement
        completeMeasurement();
    } else if (measurementMode === 'angle') {
        // Add line to the angle measurement
        measurementLines.push({
            start: { ...measurementStart },
            end: { ...measurementEnd }
        });
        
        if (measurementLines.length === 1) {
            showStatus('📐 Angle: Now draw the second line', 'success');
        } else if (measurementLines.length === 2) {
            // Complete angle measurement
            completeMeasurement();
        }
    }
    
    measurementDragging = false;
    measurementStart = null;
    measurementEnd = null;
    redraw();
}

function getPixelSpacing() {
    let pixelSpacingX = 1, pixelSpacingY = 1;
    
    if (nifti && nifti.spatial) {
        pixelSpacingX = Math.abs(nifti.spatial.pixdim[1]) || 1;
        pixelSpacingY = Math.abs(nifti.spatial.pixdim[2]) || 1;
    } else if (isDicomMode && dicomLoader) {
        pixelSpacingX = dicomLoader.pixelSpacing[1] || 1;  // column spacing
        pixelSpacingY = dicomLoader.pixelSpacing[0] || 1;  // row spacing
    }
    
    return { x: pixelSpacingX, y: pixelSpacingY };
}

function calculateDistance(p1, p2, spacing) {
    const dx = (p2.x - p1.x) * spacing.x;
    const dy = (p2.y - p1.y) * spacing.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function lineIntersection(line1, line2) {
    // Calculate intersection of two lines
    // Line 1: from (x1, y1) to (x2, y2)
    // Line 2: from (x3, y3) to (x4, y4)
    const x1 = line1.start.x, y1 = line1.start.y;
    const x2 = line1.end.x, y2 = line1.end.y;
    const x3 = line2.start.x, y3 = line2.start.y;
    const x4 = line2.end.x, y4 = line2.end.y;
    
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    
    if (Math.abs(denom) < 0.0001) {
        // Lines are parallel, use midpoint between the two closest endpoints
        return {
            x: (x2 + x3) / 2,
            y: (y2 + y3) / 2
        };
    }
    
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    
    return {
        x: x1 + t * (x2 - x1),
        y: y1 + t * (y2 - y1)
    };
}

function calculateAngleBetweenLines(line1, line2, spacing) {
    // Get direction vectors (from start to end) with pixel spacing
    const v1x = (line1.end.x - line1.start.x) * spacing.x;
    const v1y = (line1.end.y - line1.start.y) * spacing.y;
    const v2x = (line2.end.x - line2.start.x) * spacing.x;
    const v2y = (line2.end.y - line2.start.y) * spacing.y;
    
    // Calculate angle using dot product
    const dot = v1x * v2x + v1y * v2y;
    const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (mag1 < 0.0001 || mag2 < 0.0001) return 0;
    
    const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    return Math.acos(cosAngle) * (180 / Math.PI);
}

function completeMeasurement() {
    const spacing = getPixelSpacing();
    
    // Save current state for undo before adding new measurement
    saveMeasurementState();
    
    if (measurementMode === 'distance' && measurementStart && measurementEnd) {
        const distance = calculateDistance(measurementStart, measurementEnd, spacing);
        
        const measurement = {
            type: 'distance',
            start: { ...measurementStart },
            end: { ...measurementEnd },
            distance: distance,
            slice: currentSlice
        };
        
        if (!measurementsPerSlice[currentSlice]) {
            measurementsPerSlice[currentSlice] = [];
        }
        measurementsPerSlice[currentSlice].push(measurement);
        
        showStatus(`📏 Distance: ${distance.toFixed(2)} mm`, 'success');
        
    } else if (measurementMode === 'angle' && measurementLines.length === 2) {
        const line1 = measurementLines[0];
        const line2 = measurementLines[1];
        const intersection = lineIntersection(line1, line2);
        const angle = calculateAngleBetweenLines(line1, line2, spacing);
        
        const measurement = {
            type: 'angle',
            line1: { ...line1 },
            line2: { ...line2 },
            intersection: intersection,
            angle: angle,
            slice: currentSlice
        };
        
        if (!measurementsPerSlice[currentSlice]) {
            measurementsPerSlice[currentSlice] = [];
        }
        measurementsPerSlice[currentSlice].push(measurement);
        
        showStatus(`📐 Angle: ${angle.toFixed(1)}°`, 'success');
        
        // Reset for next angle measurement
        measurementLines = [];
    }
    
    // Clear redo stack when new measurement is made
    measurementRedoStack = [];
}

// Save current measurement state for undo
function saveMeasurementState() {
    // Deep copy current measurements for the current slice
    const currentMeasurements = measurementsPerSlice[currentSlice] 
        ? JSON.parse(JSON.stringify(measurementsPerSlice[currentSlice]))
        : [];
    
    measurementUndoStack.push({
        slice: currentSlice,
        measurements: currentMeasurements
    });
    
    // Limit undo stack size
    if (measurementUndoStack.length > 50) {
        measurementUndoStack.shift();
    }
}

function drawMeasurements() {
    if (!ctx) return;
    
    const spacing = getPixelSpacing();
    
    // Draw completed measurements for current slice
    const sliceMeasurements = measurementsPerSlice[currentSlice] || [];
    
    for (let i = 0; i < sliceMeasurements.length; i++) {
        const m = sliceMeasurements[i];
        const isSelected = (i === selectedMeasurementIndex);
        
        if (m.type === 'distance') {
            drawDistanceMeasurement(m.start, m.end, m.distance, false, isSelected);
        } else if (m.type === 'angle') {
            drawAngleMeasurement(m.line1, m.line2, m.intersection, m.angle, false, isSelected);
        }
    }
    
    // Draw in-progress measurement
    if (measurementMode === 'distance' && measurementDragging && measurementStart && measurementEnd) {
        const liveDistance = calculateDistance(measurementStart, measurementEnd, spacing);
        drawDistanceMeasurement(measurementStart, measurementEnd, liveDistance, true);
    } else if (measurementMode === 'angle') {
        // Draw completed lines for angle measurement
        for (const line of measurementLines) {
            drawArrowLine(line.start, line.end, true);
        }
        // Draw in-progress line
        if (measurementDragging && measurementStart && measurementEnd) {
            drawArrowLine(measurementStart, measurementEnd, true);
            
            // If we have one line already, show preview of angle
            if (measurementLines.length === 1) {
                const tempLine2 = { start: measurementStart, end: measurementEnd };
                const intersection = lineIntersection(measurementLines[0], tempLine2);
                const angle = calculateAngleBetweenLines(measurementLines[0], tempLine2, spacing);
                drawAngleArc(intersection, measurementLines[0], tempLine2, angle, true);
            }
        }
    }
}

function drawDistanceMeasurement(start, end, distance, isInProgress, isSelected = false) {
    ctx.save();
    
    // Line style - thinner lines
    ctx.strokeStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.fillStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.lineWidth = 1;
    ctx.setLineDash(isInProgress ? [5, 3] : []);
    
    // Draw line
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    
    // Draw endpoints with + markers
    const markerSize = 5;
    ctx.setLineDash([]);
    
    // Start point +
    ctx.beginPath();
    ctx.moveTo(start.x - markerSize, start.y);
    ctx.lineTo(start.x + markerSize, start.y);
    ctx.moveTo(start.x, start.y - markerSize);
    ctx.lineTo(start.x, start.y + markerSize);
    ctx.stroke();
    
    // End point +
    ctx.beginPath();
    ctx.moveTo(end.x - markerSize, end.y);
    ctx.lineTo(end.x + markerSize, end.y);
    ctx.moveTo(end.x, end.y - markerSize);
    ctx.lineTo(end.x, end.y + markerSize);
    ctx.stroke();
    
    // Draw distance label at midpoint - no background
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const text = `${distance.toFixed(2)} mm`;
    
    // Text with shadow for readability (no background box)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 3;
    ctx.strokeText(text, midX, midY - 10);
    ctx.fillStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.fillText(text, midX, midY - 10);
    
    ctx.restore();
}

function drawArrowLine(start, end, isInProgress, isSelected = false) {
    ctx.save();
    
    ctx.strokeStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.fillStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.lineWidth = 1;
    ctx.setLineDash(isInProgress ? [5, 3] : []);
    
    // Draw main line
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    
    // Draw arrow head at end
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const arrowLength = 10;
    const arrowAngle = Math.PI / 6;
    
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
        end.x - arrowLength * Math.cos(angle - arrowAngle),
        end.y - arrowLength * Math.sin(angle - arrowAngle)
    );
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
        end.x - arrowLength * Math.cos(angle + arrowAngle),
        end.y - arrowLength * Math.sin(angle + arrowAngle)
    );
    ctx.stroke();
    
    // Draw + at start
    const markerSize = 5;
    ctx.beginPath();
    ctx.moveTo(start.x - markerSize, start.y);
    ctx.lineTo(start.x + markerSize, start.y);
    ctx.moveTo(start.x, start.y - markerSize);
    ctx.lineTo(start.x, start.y + markerSize);
    ctx.stroke();
    
    ctx.restore();
}

function drawAngleMeasurement(line1, line2, intersection, angle, isInProgress, isSelected = false) {
    // Draw both arrow lines
    drawArrowLine(line1.start, line1.end, isInProgress, isSelected);
    drawArrowLine(line2.start, line2.end, isInProgress, isSelected);
    
    // Draw angle arc and label
    drawAngleArc(intersection, line1, line2, angle, isInProgress, isSelected);
}

function drawAngleArc(intersection, line1, line2, angle, isInProgress, isSelected = false) {
    ctx.save();
    
    ctx.strokeStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.fillStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.lineWidth = 1;
    
    // Calculate angles from intersection to line ends
    const angle1 = Math.atan2(line1.end.y - intersection.y, line1.end.x - intersection.x);
    const angle2 = Math.atan2(line2.end.y - intersection.y, line2.end.x - intersection.x);
    
    // Draw arc
    const arcRadius = 25;
    ctx.beginPath();
    ctx.arc(intersection.x, intersection.y, arcRadius, angle1, angle2);
    ctx.stroke();
    
    // Draw intersection marker
    ctx.beginPath();
    ctx.arc(intersection.x, intersection.y, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw angle label - no background
    const midAngle = (angle1 + angle2) / 2;
    const labelRadius = 45;
    const labelX = intersection.x + Math.cos(midAngle) * labelRadius;
    const labelY = intersection.y + Math.sin(midAngle) * labelRadius;
    
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const text = `${angle.toFixed(1)}°`;
    
    // Text with shadow for readability (no background box)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 3;
    ctx.strokeText(text, labelX, labelY);
    ctx.fillStyle = isSelected ? '#ff6666' : (isInProgress ? '#00ff00' : '#ffff00');
    ctx.fillText(text, labelX, labelY);
    
    ctx.restore();
}

function clearSliceMeasurements() {
    if (measurementsPerSlice[currentSlice] && measurementsPerSlice[currentSlice].length > 0) {
        // Save state for undo
        saveMeasurementState();
        measurementsPerSlice[currentSlice] = [];
        measurementRedoStack = [];
        selectedMeasurementIndex = -1;
        showStatus('Measurements cleared for this slice', 'success');
        redraw();
    }
}

function clearAllMeasurements() {
    measurementsPerSlice = {};
    measurementDragging = false;
    measurementStart = null;
    measurementEnd = null;
    measurementLines = [];
    measurementMode = null;
    selectedMeasurementIndex = -1;
    measurementUndoStack = [];
    measurementRedoStack = [];
    canvas.classList.remove('measuring');
    updateMeasurementUI();
    console.log('[Measurements] Cleared all measurements');
}

function undoLastMeasurement() {
    const sliceMeasurements = measurementsPerSlice[currentSlice];
    if (sliceMeasurements && sliceMeasurements.length > 0) {
        sliceMeasurements.pop();
        showStatus('Last measurement removed', 'success');
        redraw();
    }
}

// Undo measurement (called from main undo function)
function undoMeasurement() {
    if (measurementUndoStack.length === 0) {
        return false;  // Nothing to undo
    }
    
    const state = measurementUndoStack.pop();
    
    // Save current state to redo stack
    const currentMeasurements = measurementsPerSlice[state.slice] 
        ? JSON.parse(JSON.stringify(measurementsPerSlice[state.slice]))
        : [];
    measurementRedoStack.push({
        slice: state.slice,
        measurements: currentMeasurements
    });
    
    // Restore previous state
    measurementsPerSlice[state.slice] = state.measurements;
    selectedMeasurementIndex = -1;
    
    // If we're on a different slice, navigate there
    if (state.slice !== currentSlice) {
        currentSlice = state.slice;
        document.getElementById('sliceSliderVertical').value = currentSlice;
        document.getElementById('sliceNum').textContent = currentSlice + 1;
        document.getElementById('gotoSlice').value = currentSlice + 1;
        renderSlice();
    }
    
    redraw();
    return true;
}

// Redo measurement (called from main redo function)
function redoMeasurement() {
    if (measurementRedoStack.length === 0) {
        return false;  // Nothing to redo
    }
    
    const state = measurementRedoStack.pop();
    
    // Save current state to undo stack
    const currentMeasurements = measurementsPerSlice[state.slice] 
        ? JSON.parse(JSON.stringify(measurementsPerSlice[state.slice]))
        : [];
    measurementUndoStack.push({
        slice: state.slice,
        measurements: currentMeasurements
    });
    
    // Restore redo state
    measurementsPerSlice[state.slice] = state.measurements;
    selectedMeasurementIndex = -1;
    
    // If we're on a different slice, navigate there
    if (state.slice !== currentSlice) {
        currentSlice = state.slice;
        document.getElementById('sliceSliderVertical').value = currentSlice;
        document.getElementById('sliceNum').textContent = currentSlice + 1;
        document.getElementById('gotoSlice').value = currentSlice + 1;
        renderSlice();
    }
    
    redraw();
    return true;
}

// Delete a specific measurement by index
function deleteSelectedMeasurement() {
    if (selectedMeasurementIndex < 0) {
        showStatus('No measurement selected. Click on a measurement to select it.', 'error');
        return;
    }
    
    const sliceMeasurements = measurementsPerSlice[currentSlice];
    if (!sliceMeasurements || selectedMeasurementIndex >= sliceMeasurements.length) {
        selectedMeasurementIndex = -1;
        return;
    }
    
    // Save state for undo
    saveMeasurementState();
    measurementRedoStack = [];
    
    // Remove the selected measurement
    sliceMeasurements.splice(selectedMeasurementIndex, 1);
    selectedMeasurementIndex = -1;
    
    showStatus('Measurement deleted', 'success');
    redraw();
}

// Check if a point is near a measurement (for selection)
function findMeasurementAtPoint(x, y) {
    const sliceMeasurements = measurementsPerSlice[currentSlice] || [];
    const threshold = 10;  // Distance threshold for selection
    
    for (let i = sliceMeasurements.length - 1; i >= 0; i--) {
        const m = sliceMeasurements[i];
        
        if (m.type === 'distance') {
            // Check distance to line segment
            const dist = pointToLineDistance(x, y, m.start, m.end);
            if (dist < threshold) {
                return i;
            }
        } else if (m.type === 'angle') {
            // Check distance to both lines
            const dist1 = pointToLineDistance(x, y, m.line1.start, m.line1.end);
            const dist2 = pointToLineDistance(x, y, m.line2.start, m.line2.end);
            if (dist1 < threshold || dist2 < threshold) {
                return i;
            }
        }
    }
    
    return -1;
}

// Calculate distance from point to line segment
function pointToLineDistance(px, py, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    
    if (lenSq === 0) {
        // Line segment is a point
        return Math.sqrt((px - start.x) ** 2 + (py - start.y) ** 2);
    }
    
    // Project point onto line
    let t = ((px - start.x) * dx + (py - start.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    const projX = start.x + t * dx;
    const projY = start.y + t * dy;
    
    return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

// ==================== Comments System ====================

function clearAllComments() {
    commentsPerSlice = {};
    commentIdCounter = 0;
    updateCommentPanel();
    console.log('[Comments] Cleared all comments');
}

function addComment() {
    const textarea = document.getElementById('commentTextarea');
    const text = textarea.value.trim();
    
    if (!text) {
        showStatus('Please enter a comment', 'error');
        return;
    }
    
    if (!commentsPerSlice[currentSlice]) {
        commentsPerSlice[currentSlice] = [];
    }
    
    const comment = {
        id: ++commentIdCounter,
        text: text,
        timestamp: new Date().toISOString(),
        slice: currentSlice
    };
    
    commentsPerSlice[currentSlice].push(comment);
    textarea.value = '';
    
    updateCommentPanel();
    updateCommentIndicator();
    showStatus('Comment added', 'success');
}

function deleteComment(commentId) {
    const sliceComments = commentsPerSlice[currentSlice];
    if (!sliceComments) return;
    
    const index = sliceComments.findIndex(c => c.id === commentId);
    if (index >= 0) {
        sliceComments.splice(index, 1);
        updateCommentPanel();
        updateCommentIndicator();
        showStatus('Comment deleted', 'success');
    }
}

function editComment(commentId) {
    const sliceComments = commentsPerSlice[currentSlice];
    if (!sliceComments) return;
    
    const comment = sliceComments.find(c => c.id === commentId);
    if (!comment) return;
    
    const newText = prompt('Edit comment:', comment.text);
    if (newText !== null && newText.trim()) {
        comment.text = newText.trim();
        comment.timestamp = new Date().toISOString();
        updateCommentPanel();
        showStatus('Comment updated', 'success');
    }
}

function updateCommentPanel() {
    const container = document.getElementById('commentsListContainer');
    if (!container) return;
    
    const sliceComments = commentsPerSlice[currentSlice] || [];
    
    if (sliceComments.length === 0) {
        container.innerHTML = '<div class="no-comments">No comments on this slice</div>';
        return;
    }
    
    let html = '';
    for (const comment of sliceComments) {
        const date = new Date(comment.timestamp);
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = date.toLocaleDateString();
        const sliceNum = comment.slice + 1;  // Display as 1-indexed
        
        html += `
            <div class="comment-item" data-id="${comment.id}">
                <div class="comment-header">
                    <span class="comment-slice-link" onclick="goToSliceWithComment(${comment.slice})" title="Go to slice ${sliceNum}">📍 Slice ${sliceNum}</span>
                </div>
                <div class="comment-text">${escapeHtml(comment.text)}</div>
                <div class="comment-meta">
                    <span class="comment-time">${dateStr} ${timeStr}</span>
                    <span class="comment-actions">
                        <button class="comment-btn edit" onclick="editComment(${comment.id})" title="Edit">✏️</button>
                        <button class="comment-btn delete" onclick="deleteComment(${comment.id})" title="Delete">🗑️</button>
                    </span>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

function updateCommentIndicator() {
    const badge = document.getElementById('commentCountBadge');
    if (!badge) return;
    
    const sliceComments = commentsPerSlice[currentSlice] || [];
    badge.textContent = sliceComments.length;
    badge.style.display = sliceComments.length > 0 ? 'inline-block' : 'none';
    
    // Also update total comments count
    const totalBadge = document.getElementById('totalCommentsBadge');
    if (totalBadge) {
        let totalComments = 0;
        for (const slice in commentsPerSlice) {
            totalComments += commentsPerSlice[slice].length;
        }
        totalBadge.textContent = totalComments;
        totalBadge.style.display = totalComments > 0 ? 'inline-block' : 'none';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function toggleCommentPanel() {
    const content = document.getElementById('commentPanelContent');
    const toggle = document.getElementById('commentPanelToggle');
    
    if (content.classList.contains('expanded')) {
        content.classList.remove('expanded');
        toggle.textContent = '▶';
    } else {
        content.classList.add('expanded');
        toggle.textContent = '▼';
    }
}

function getCommentsForExport() {
    // Prepare comments data for export with patient/series info
    const commentsData = {
        patientId: currentPatientId,
        seriesId: currentSeriesId,
        exportTimestamp: new Date().toISOString(),
        totalComments: 0,
        slices: {}
    };
    
    for (const slice in commentsPerSlice) {
        if (commentsPerSlice[slice].length > 0) {
            commentsData.slices[slice] = commentsPerSlice[slice].map(c => ({
                id: c.id,
                text: c.text,
                timestamp: c.timestamp
            }));
            commentsData.totalComments += commentsPerSlice[slice].length;
        }
    }
    
    return commentsData;
}

function goToSliceWithComment(slice) {
    const targetSlice = parseInt(slice);
    if (targetSlice >= 0 && targetSlice < totalSlices) {
        if (currentMask && masks) {
            saveMaskSilent();
        }
        document.getElementById('sliceSliderVertical').value = targetSlice;
        changeSliceVertical();
    }
}

function showAllCommentsSummary() {
    const sortedSlices = Object.keys(commentsPerSlice)
        .map(Number)
        .sort((a, b) => a - b);
    
    let hasComments = false;
    let html = '';
    
    for (const slice of sortedSlices) {
        if (commentsPerSlice[slice].length > 0) {
            hasComments = true;
            const sliceNum = parseInt(slice) + 1;
            html += `<div class="summary-slice-group">`;
            html += `<div class="summary-slice-header" onclick="goToSliceWithComment(${slice}); closeCommentsSummary();">📍 Slice ${sliceNum}</div>`;
            for (const comment of commentsPerSlice[slice]) {
                const date = new Date(comment.timestamp);
                const timeStr = date.toLocaleString();
                html += `<div class="summary-comment">`;
                html += `<div class="summary-comment-text">${escapeHtml(comment.text)}</div>`;
                html += `<div class="summary-comment-time">${timeStr}</div>`;
                html += `</div>`;
            }
            html += `</div>`;
        }
    }
    
    if (!hasComments) {
        html = '<div class="summary-empty">No comments have been added yet.</div>';
    }
    
    // Create and show modal
    let modal = document.getElementById('commentsSummaryModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'commentsSummaryModal';
        modal.className = 'comments-summary-modal';
        modal.innerHTML = `
            <div class="comments-summary-content">
                <div class="comments-summary-header">
                    <h2>📋 All Comments Summary</h2>
                    <button class="comments-summary-close" onclick="closeCommentsSummary()" title="Close">✕</button>
                </div>
                <div class="comments-summary-body" id="commentsSummaryBody"></div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    document.getElementById('commentsSummaryBody').innerHTML = html;
    modal.classList.add('visible');
}

function closeCommentsSummary() {
    const modal = document.getElementById('commentsSummaryModal');
    if (modal) {
        modal.classList.remove('visible');
    }
}

// ==================== Annotated Slice Navigation ====================

function getAnnotatedSlices() {
    if (!masks || !ctDims) return [];
    
    const annotatedSlices = [];
    const sliceSize = ctDims[0] * ctDims[1];
    
    for (let z = 0; z < ctDims[2]; z++) {
        const offset = z * sliceSize;
        let hasAnnotation = false;
        
        // Check if this slice has any non-zero mask values
        for (let i = 0; i < sliceSize; i++) {
            if (masks[offset + i] > 0) {
                hasAnnotation = true;
                break;
            }
        }
        
        if (hasAnnotation) {
            annotatedSlices.push(z);
        }
    }
    
    return annotatedSlices;
}

function updateAnnotatedSlicesDisplay() {
    const annotatedSlices = getAnnotatedSlices();
    const countSpan = document.getElementById('annotatedSliceCount');
    const listDiv = document.getElementById('annotatedSlicesList');
    
    if (countSpan) {
        countSpan.textContent = `(${annotatedSlices.length})`;
    }
    
    if (listDiv) {
        if (annotatedSlices.length === 0) {
            listDiv.classList.remove('visible');
            listDiv.innerHTML = '';
        } else {
            listDiv.classList.add('visible');
            let html = '';
            for (const slice of annotatedSlices) {
                const isCurrent = slice === currentSlice;
                html += `<span class="annotated-slice-chip ${isCurrent ? 'current' : ''}" onclick="goToAnnotatedSlice(${slice})">${slice + 1}</span>`;
            }
            listDiv.innerHTML = html;
        }
    }
}

function goToAnnotatedSlice(slice) {
    if (slice >= 0 && slice < totalSlices) {
        if (currentMask && masks) {
            saveMaskSilent();
        }
        document.getElementById('sliceSliderVertical').value = slice;
        changeSliceVertical();
        updateAnnotatedSlicesDisplay();
    }
}

function goToNextAnnotatedSlice() {
    const annotatedSlices = getAnnotatedSlices();
    
    if (annotatedSlices.length === 0) {
        showStatus('No annotated slices found', 'error');
        return;
    }
    
    // Find the next annotated slice after current
    let nextSlice = null;
    for (const slice of annotatedSlices) {
        if (slice > currentSlice) {
            nextSlice = slice;
            break;
        }
    }
    
    // Wrap around to first annotated slice if at end
    if (nextSlice === null) {
        nextSlice = annotatedSlices[0];
        showStatus(`Wrapped to first annotated slice (${nextSlice + 1})`, 'success');
    }
    
    goToAnnotatedSlice(nextSlice);
}

function goToPrevAnnotatedSlice() {
    const annotatedSlices = getAnnotatedSlices();
    
    if (annotatedSlices.length === 0) {
        showStatus('No annotated slices found', 'error');
        return;
    }
    
    // Find the previous annotated slice before current
    let prevSlice = null;
    for (let i = annotatedSlices.length - 1; i >= 0; i--) {
        if (annotatedSlices[i] < currentSlice) {
            prevSlice = annotatedSlices[i];
            break;
        }
    }
    
    // Wrap around to last annotated slice if at beginning
    if (prevSlice === null) {
        prevSlice = annotatedSlices[annotatedSlices.length - 1];
        showStatus(`Wrapped to last annotated slice (${prevSlice + 1})`, 'success');
    }
    
    goToAnnotatedSlice(prevSlice);
}

// ==================== Guardrail Functions for Propagation ====================

/**
 * Keep only pixels in 'refined' that are connected (via 4-connectivity) to any pixel in 'seed'.
 * This prevents the refinement from "jumping" to disconnected regions.
 * Used as a guardrail for Fluid Pockets (label 3) propagation.
 */
function keepConnectedToSeed(refined, seed, width, height) {
    const size = width * height;
    const result = new Uint8Array(size);
    const visited = new Uint8Array(size);
    
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    
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
        const y = Math.floor(idx / width);
        
        for (const [dy, dx] of neighbors) {
            const nx = x + dx;
            const ny = y + dy;
            
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            
            const nidx = ny * width + nx;
            
            // Only expand to refined pixels that haven't been visited
            if (!visited[nidx] && refined[nidx] === 1) {
                visited[nidx] = 1;
                result[nidx] = 1;
                queue.push(nidx);
            }
        }
    }
    
    // Log how many pixels were filtered out
    let originalCount = 0, finalCount = 0;
    for (let i = 0; i < size; i++) {
        if (refined[i] === 1) originalCount++;
        if (result[i] === 1) finalCount++;
    }
    
    if (originalCount !== finalCount) {
        console.log(`[Fluid Guardrail] Filtered ${originalCount - finalCount} disconnected pixels (${originalCount} -> ${finalCount})`);
    }
    
    return result;
}


function drawBoundingBoxPreview() {
    if (!ctx) return;
    
    const x1 = Math.min(bboxStartX, bboxEndX);
    const y1 = Math.min(bboxStartY, bboxEndY);
    const x2 = Math.max(bboxStartX, bboxEndX);
    const y2 = Math.max(bboxStartY, bboxEndY);
    
    const width = x2 - x1;
    const height = y2 - y1;
    
    // Draw rectangle on main canvas (temporary)
    ctx.save();
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(x1, y1, width, height);
    ctx.restore();
}

function fillBoundingBoxByHU() {
    if (!currentMask || !maskCtx) {
        showStatus('No mask canvas available', 'error');
        return;
    }
    
    const huData = getCurrentSliceHUData();
    if (!huData) {
        showStatus('No HU data available', 'error');
        return;
    }
    
    const minHU = parseInt(document.getElementById('fluidMinHU').value);
    const maxHU = parseInt(document.getElementById('fluidMaxHU').value);
    
    // Get bounding box coordinates (ensure integers and proper order)
    const x1 = Math.max(0, Math.floor(Math.min(bboxStartX, bboxEndX)));
    const y1 = Math.max(0, Math.floor(Math.min(bboxStartY, bboxEndY)));
    const x2 = Math.min(canvas.width - 1, Math.floor(Math.max(bboxStartX, bboxEndX)));
    const y2 = Math.min(canvas.height - 1, Math.floor(Math.max(bboxStartY, bboxEndY)));
    
    const width = canvas.width;
    const height = canvas.height;
    
    // Get selected label color
    const selectedLabel = parseInt(document.getElementById('labelSelect').value);
    const selectedColor = COLORS[selectedLabel];
    const r = parseInt(selectedColor.substr(1, 2), 16);
    const g = parseInt(selectedColor.substr(3, 2), 16);
    const b = parseInt(selectedColor.substr(5, 2), 16);
    
    // Get current mask data
    const imageData = maskCtx.getImageData(0, 0, width, height);
    
    let filledCount = 0;
    
    // Fill all pixels within bounding box that are within HU range
    for (let y = y1; y <= y2; y++) {
        for (let x = x1; x <= x2; x++) {
            const i = y * width + x;
            const hu = huData[i];
            
            if (hu >= minHU && hu <= maxHU) {
                const idx = i * 4;
                imageData.data[idx] = r;
                imageData.data[idx + 1] = g;
                imageData.data[idx + 2] = b;
                imageData.data[idx + 3] = 255;
                filledCount++;
            }
        }
    }
    
    maskCtx.putImageData(imageData, 0, 0);

    // Remove small islands (connected components below threshold)
    removeSmallIslands(10); // Remove islands smaller than 10 pixels
    
    // Sync to mask array
    syncMaskToArray();
    
    console.log(`[BoundingBox] Filled ${filledCount} pixels within HU range [${minHU}, ${maxHU}]`);
    showStatus(`📦 Filled ${filledCount} pixels within HU range [${minHU}, ${maxHU}]`, 'success');
}

function removeSmallIslands(minSize) {
    const width = canvas.width;
    const height = canvas.height;
    const imageData = maskCtx.getImageData(0, 0, width, height);
    const data = imageData.data;
    
    // Create a visited array and label array
    const visited = new Uint8Array(width * height);
    const labels = new Int32Array(width * height);
    let currentLabel = 0;
    const componentSizes = [];
    
    // Find connected components using flood fill
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const idx = i * 4;
            
            // Skip if already visited or transparent
            if (visited[i] || data[idx + 3] === 0) continue;
            
            // BFS flood fill
            currentLabel++;
            const queue = [{x, y}];
            let size = 0;
            
            while (queue.length > 0) {
                const {x: cx, y: cy} = queue.shift();
                const ci = cy * width + cx;
                
                if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
                if (visited[ci]) continue;
                
                const cidx = ci * 4;
                if (data[cidx + 3] === 0) continue;
                
                visited[ci] = 1;
                labels[ci] = currentLabel;
                size++;
                
                // Add 4-connected neighbors
                queue.push({x: cx + 1, y: cy});
                queue.push({x: cx - 1, y: cy});
                queue.push({x: cx, y: cy + 1});
                queue.push({x: cx, y: cy - 1});
            }
            
            componentSizes[currentLabel] = size;
        }
    }
    
    // Remove small components
    let removedCount = 0;
    for (let i = 0; i < width * height; i++) {
        if (labels[i] > 0 && componentSizes[labels[i]] < minSize) {
            const idx = i * 4;
            data[idx + 3] = 0; // Make transparent
            removedCount++;
        }
    }
    
    maskCtx.putImageData(imageData, 0, 0);
    
    if (removedCount > 0) {
        console.log(`[BoundingBox] Removed ${removedCount} pixels from small islands (< ${minSize} px)`);
    }
}