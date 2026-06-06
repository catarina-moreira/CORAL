/**
 * DICOM Parser and Progressive Loader
 * Handles slice-by-slice loading from Google Drive DICOM folders
 * 
 * Uses cornerstone dicomParser for DICOM file parsing
 */

// ==================== DICOM Parser Class ====================
class DICOMLoader {
    constructor() {
        this.folderId = null;
        this.folderName = null;
        this.sliceCount = 0;
        this.sliceInfo = [];           // Metadata for each slice
        this.loadedSlices = new Set(); // Which slices are loaded
        this.sliceData = [];           // Actual pixel data (Float32Array per slice)
        this.sliceMetadata = [];       // DICOM metadata per slice
        
        // Image dimensions (from first loaded slice)
        this.width = 0;
        this.height = 0;
        this.pixelSpacing = [1, 1];
        this.sliceThickness = 1;
        
        // ===== CRITICAL FOR 3D SLICER ALIGNMENT =====
        // Spatial transform data from DICOM
        this.imageOrientationPatient = null;  // [row_x, row_y, row_z, col_x, col_y, col_z]
        this.slicePositions = [];              // Array of IPP z-values for each slice index
        this.firstSliceOrigin = null;          // IPP of first slice [x, y, z]
        this.calculatedSliceSpacing = null;    // Actual spacing between slices (from IPP)
        this.sliceSortOrder = 'ascending';     // Track if z increases or decreases with slice index
        
        // Loading state
        this.isLoading = false;
        this.loadQueue = [];           // Priority queue of slice indices to load
        this.activeLoads = 0;
        this.maxConcurrentLoads = 1;   // Sequential downloads to avoid SSL errors
        
        // Callbacks
        this.onSliceLoaded = null;     // Called when a slice is ready
        this.onProgress = null;        // Called with loading progress
        this.onError = null;           // Called on error
        this.onReady = null;           // Called when first slice is ready for annotation
    }
    
    /**
     * Initialize loading from a DICOM folder on Google Drive
     * @param {string} folderId - Google Drive folder ID
     * @param {number} startSlice - Which slice to load first (default: middle)
     */
    async initFromDrive(folderId, startSlice = null) {
        this.folderId = folderId;
        this.useLocalEndpoint = false;
        this.localFolderPath = null;
        this.loadedSlices.clear();
        this.sliceData = [];
        this.sliceMetadata = [];
        this.loadQueue = [];
        
        // Reset spatial params
        this.imageOrientationPatient = null;
        this.slicePositions = [];
        this.firstSliceOrigin = null;
        this.calculatedSliceSpacing = null;
        this.sliceSortOrder = 'ascending';
        
        try {
            // Get series info
            const response = await fetch(`/api/drive/dicom/${folderId}/info`);
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Failed to get DICOM series info');
            }
            
            this.folderName = data.folderName;
            this.sliceCount = data.sliceCount;
            this.sliceInfo = data.slices;
            
            // Initialize empty arrays for each slice
            this.sliceData = new Array(this.sliceCount).fill(null);
            this.sliceMetadata = new Array(this.sliceCount).fill(null);
            this.slicePositions = new Array(this.sliceCount).fill(null);
            
            // Determine starting slice
            const firstSlice = startSlice !== null ? startSlice : Math.floor(this.sliceCount / 2);
            
            // Build priority queue: start with requested slice, then expand outward
            this.buildPriorityQueue(firstSlice);
            
            // Report progress
            if (this.onProgress) {
                this.onProgress(0, this.sliceCount, 'Starting download...');
            }
            
            // Start loading
            this.isLoading = true;
            this.startLoading();
            
            return {
                sliceCount: this.sliceCount,
                folderName: this.folderName,
                firstSlice: firstSlice
            };
            
        } catch (error) {
            if (this.onError) this.onError(error);
            throw error;
        }
    }
    
    /**
     * Initialize loading from a LOCAL DICOM folder - FAST!
     * @param {string} folderPath - Local folder path relative to LOCAL_DATA_PATH
     * @param {number} startSlice - Which slice to load first (default: middle)
     */
    async initFromLocal(folderPath, startSlice = null) {
        this.folderId = null;
        this.useLocalEndpoint = true;
        this.localFolderPath = folderPath;
        this.loadedSlices.clear();
        this.sliceData = [];
        this.sliceMetadata = [];
        this.loadQueue = [];
        
        // Reset spatial params
        this.imageOrientationPatient = null;
        this.slicePositions = [];
        this.firstSliceOrigin = null;
        this.calculatedSliceSpacing = null;
        this.sliceSortOrder = 'ascending';
        
        try {
            // Get series info from local endpoint
            const response = await fetch(`/api/local/dicom/${encodeURIComponent(folderPath)}/info`);
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Failed to get local DICOM series info');
            }
            
            this.folderName = data.folderName;
            this.sliceCount = data.sliceCount;
            this.sliceInfo = data.slices;
            
            // Initialize empty arrays for each slice
            this.sliceData = new Array(this.sliceCount).fill(null);
            this.sliceMetadata = new Array(this.sliceCount).fill(null);
            this.slicePositions = new Array(this.sliceCount).fill(null);
            
            // Determine starting slice
            const firstSlice = startSlice !== null ? startSlice : Math.floor(this.sliceCount / 2);
            
            // Build priority queue
            this.buildPriorityQueue(firstSlice);
            
            // Report progress
            if (this.onProgress) {
                this.onProgress(0, this.sliceCount, 'Loading from local disk (fast!)...');
            }
            
            // For local loading, we can be more aggressive with concurrency
            this.maxConcurrentLoads = 5;  // Local disk can handle more!
            
            // Start loading
            this.isLoading = true;
            this.startLoading();
            
            return {
                sliceCount: this.sliceCount,
                folderName: this.folderName,
                firstSlice: firstSlice
            };
            
        } catch (error) {
            if (this.onError) this.onError(error);
            throw error;
        }
    }
    
    /**
     * Build priority queue - load slices near the current view first
     */
    buildPriorityQueue(centerSlice) {
        this.loadQueue = [];
        const added = new Set();
        
        // Add center slice first
        this.loadQueue.push(centerSlice);
        added.add(centerSlice);
        
        // Expand outward from center
        for (let offset = 1; offset < this.sliceCount; offset++) {
            const before = centerSlice - offset;
            const after = centerSlice + offset;
            
            if (before >= 0 && !added.has(before)) {
                this.loadQueue.push(before);
                added.add(before);
            }
            if (after < this.sliceCount && !added.has(after)) {
                this.loadQueue.push(after);
                added.add(after);
            }
        }
    }
    
    /**
     * Prioritize loading a specific slice (e.g., when user navigates)
     */
    prioritizeSlice(sliceIndex) {
        if (this.loadedSlices.has(sliceIndex)) return; // Already loaded
        
        // Move this slice to front of queue
        const idx = this.loadQueue.indexOf(sliceIndex);
        if (idx > 0) {
            this.loadQueue.splice(idx, 1);
            this.loadQueue.unshift(sliceIndex);
        }
    }
    
    /**
     * Start/continue the loading process
     */
    startLoading() {
        while (this.activeLoads < this.maxConcurrentLoads && this.loadQueue.length > 0) {
            const sliceIndex = this.loadQueue.shift();
            if (!this.loadedSlices.has(sliceIndex)) {
                this.loadSlice(sliceIndex);
            }
        }
    }
    
    /**
     * Load a single slice with retry logic
     */
    async loadSlice(sliceIndex, retryCount = 0) {
        const maxRetries = this.useLocalEndpoint ? 1 : 3;  // Less retries for local (faster fail)
        this.activeLoads++;
        
        try {
            // Choose endpoint based on source
            const url = this.useLocalEndpoint 
                ? `/api/local/dicom/${encodeURIComponent(this.localFolderPath)}/slice/${sliceIndex}`
                : `/api/drive/dicom/${this.folderId}/slice/${sliceIndex}`;
            
            const response = await fetch(url);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            const byteArray = new Uint8Array(arrayBuffer);
            
            // Parse DICOM
            const dataSet = dicomParser.parseDicom(byteArray);
            
            // Extract pixel data and metadata
            const result = this.extractPixelData(dataSet, sliceIndex);
            
            this.sliceData[sliceIndex] = result.pixelData;
            this.sliceMetadata[sliceIndex] = result.metadata;
            this.loadedSlices.add(sliceIndex);
            
            // Set dimensions from first loaded slice
            if (this.width === 0) {
                this.width = result.metadata.columns;
                this.height = result.metadata.rows;
                this.pixelSpacing = result.metadata.pixelSpacing;
                this.sliceThickness = result.metadata.sliceThickness;
                
                // Store orientation (should be same for all slices in series)
                if (result.metadata.imageOrientationPatient) {
                    this.imageOrientationPatient = result.metadata.imageOrientationPatient;
                }
            }
            
            // Track slice position for proper z-ordering
            if (result.metadata.imagePositionPatient) {
                this.slicePositions[sliceIndex] = result.metadata.imagePositionPatient[2]; // z-coordinate
                
                // Update first slice origin if this is lowest index we've seen with valid IPP
                if (this.firstSliceOrigin === null || sliceIndex === 0) {
                    // We need to track by actual position, will finalize after more slices load
                }
            }
            
            // Callback
            if (this.onSliceLoaded) {
                this.onSliceLoaded(sliceIndex, result.pixelData, result.metadata);
            }
            
            // First slice ready - signal that annotation can begin
            if (this.loadedSlices.size === 1 && this.onReady) {
                this.onReady(sliceIndex);
            }
            
            // Progress update
            if (this.onProgress) {
                const percent = Math.round((this.loadedSlices.size / this.sliceCount) * 100);
                this.onProgress(
                    this.loadedSlices.size, 
                    this.sliceCount, 
                    `Loading: ${this.loadedSlices.size}/${this.sliceCount} slices (${percent}%)`
                );
            }
            
        } catch (error) {
            console.error(`Error loading slice ${sliceIndex} (attempt ${retryCount + 1}):`, error);
            
            // Retry logic
            if (retryCount < maxRetries) {
                console.log(`Retrying slice ${sliceIndex} in ${(retryCount + 1) * 2}s...`);
                this.activeLoads--;
                
                // Wait before retry with exponential backoff
                await new Promise(resolve => setTimeout(resolve, (retryCount + 1) * 2000));
                
                // Re-add to front of queue for retry
                this.loadQueue.unshift(sliceIndex);
                this.startLoading();
                return;
            }
            
            if (this.onError) this.onError(error, sliceIndex);
        }
        
        this.activeLoads--;
        
        // Continue loading more slices
        if (this.isLoading && this.loadQueue.length > 0) {
            this.startLoading();
        }
        
        // Check if all done
        if (this.loadedSlices.size === this.sliceCount) {
            this.isLoading = false;
            if (this.onProgress) {
                this.onProgress(this.sliceCount, this.sliceCount, 'All slices loaded');
            }
        }
    }
    
    /**
     * Extract pixel data from DICOM dataset and convert to Hounsfield Units
     */
    extractPixelData(dataSet, sliceIndex) {
        // Get image dimensions
        const rows = dataSet.uint16('x00280010');
        const columns = dataSet.uint16('x00280011');
        const bitsAllocated = dataSet.uint16('x00280100') || 16;
        const bitsStored = dataSet.uint16('x00280101') || bitsAllocated;
        const highBit = dataSet.uint16('x00280102') || (bitsStored - 1);
        const pixelRepresentation = dataSet.uint16('x00280103') || 0; // 0=unsigned, 1=signed
        const samplesPerPixel = dataSet.uint16('x00280002') || 1;
        
        // Rescale parameters for HU conversion
        const rescaleIntercept = dataSet.floatString('x00281052') || 0;
        const rescaleSlope = dataSet.floatString('x00281053') || 1;
        
        // Pixel spacing
        const pixelSpacingStr = dataSet.string('x00280030');
        let pixelSpacing = [1, 1];
        if (pixelSpacingStr) {
            const parts = pixelSpacingStr.split('\\');
            if (parts.length >= 2) {
                pixelSpacing = [parseFloat(parts[0]), parseFloat(parts[1])];
            }
        }
        
        // Slice thickness
        const sliceThickness = dataSet.floatString('x00180050') || 1;
        
        // Slice location (for sorting verification)
        const sliceLocation = dataSet.floatString('x00201041');
        const instanceNumber = dataSet.intString('x00200013');
        
        // ===== CRITICAL FOR 3D SLICER ALIGNMENT =====
        // Image Position Patient (0020,0032) - x, y, z position of first voxel
        let imagePositionPatient = [0, 0, 0];
        const ippStr = dataSet.string('x00200032');
        if (ippStr) {
            const parts = ippStr.split('\\');
            if (parts.length >= 3) {
                imagePositionPatient = [
                    parseFloat(parts[0]),
                    parseFloat(parts[1]),
                    parseFloat(parts[2])
                ];
            }
        }
        
        // Image Orientation Patient (0020,0037) - row and column direction cosines
        // Format: row_x\row_y\row_z\col_x\col_y\col_z
        let imageOrientationPatient = [1, 0, 0, 0, 1, 0]; // Default: standard axial
        const iopStr = dataSet.string('x00200037');
        if (iopStr) {
            const parts = iopStr.split('\\');
            if (parts.length >= 6) {
                imageOrientationPatient = parts.slice(0, 6).map(parseFloat);
            }
        }
        
        // Get pixel data element
        const pixelDataElement = dataSet.elements.x7fe00010;
        if (!pixelDataElement) {
            throw new Error('No pixel data found in DICOM file');
        }
        
        // Extract raw pixel data
        const pixelDataOffset = pixelDataElement.dataOffset;
        const pixelDataLength = pixelDataElement.length;
        
        // Create typed array view based on bits allocated
        let rawPixels;
        const numPixels = rows * columns;
        
        if (bitsAllocated === 16) {
            if (pixelRepresentation === 1) {
                // Signed 16-bit
                rawPixels = new Int16Array(dataSet.byteArray.buffer, pixelDataOffset, numPixels);
            } else {
                // Unsigned 16-bit
                rawPixels = new Uint16Array(dataSet.byteArray.buffer, pixelDataOffset, numPixels);
            }
        } else if (bitsAllocated === 8) {
            if (pixelRepresentation === 1) {
                rawPixels = new Int8Array(dataSet.byteArray.buffer, pixelDataOffset, numPixels);
            } else {
                rawPixels = new Uint8Array(dataSet.byteArray.buffer, pixelDataOffset, numPixels);
            }
        } else {
            throw new Error(`Unsupported bits allocated: ${bitsAllocated}`);
        }
        
        // Convert to Hounsfield Units (Float32 for precision)
        const huPixels = new Float32Array(numPixels);
        for (let i = 0; i < numPixels; i++) {
            huPixels[i] = rawPixels[i] * rescaleSlope + rescaleIntercept;
        }
        
        return {
            pixelData: huPixels,
            metadata: {
                rows,
                columns,
                bitsAllocated,
                bitsStored,
                pixelRepresentation,
                rescaleIntercept,
                rescaleSlope,
                pixelSpacing,
                sliceThickness,
                sliceLocation,
                instanceNumber,
                sliceIndex,
                imagePositionPatient,
                imageOrientationPatient
            }
        };
    }
    
    /**
     * Check if a slice is loaded
     */
    isSliceLoaded(sliceIndex) {
        return this.loadedSlices.has(sliceIndex);
    }
    
    /**
     * Get pixel data for a slice (returns null if not loaded)
     */
    getSliceData(sliceIndex) {
        return this.sliceData[sliceIndex];
    }
    
    /**
     * Get metadata for a slice
     */
    getSliceMetadata(sliceIndex) {
        return this.sliceMetadata[sliceIndex];
    }
    
    /**
     * Get all loaded slice indices
     */
    getLoadedSlices() {
        return Array.from(this.loadedSlices).sort((a, b) => a - b);
    }
    
    /**
     * Stop loading (e.g., when switching to different dataset)
     */
    stopLoading() {
        this.isLoading = false;
        this.loadQueue = [];
    }
    
    /**
     * Get dimensions (width, height, depth)
     */
    getDimensions() {
        return [this.width, this.height, this.sliceCount];
    }
    
    /**
     * Get voxel spacing (x, y, z)
     */
    getVoxelSpacing() {
        return [this.pixelSpacing[0], this.pixelSpacing[1], this.sliceThickness];
    }
    
    /**
     * Get debug info string
     */
    getDebugInfo() {
        const loaded = this.loadedSlices.size;
        const total = this.sliceCount;
        const dims = `${this.width} × ${this.height} × ${total}`;
        const spacing = `${this.pixelSpacing[0].toFixed(2)} × ${this.pixelSpacing[1].toFixed(2)} × ${this.sliceThickness.toFixed(2)} mm`;
        return `DICOM Series: ${dims}\nVoxel spacing: ${spacing}\nLoaded: ${loaded}/${total} slices`;
    }
    
    /**
     * Finalize spatial parameters after loading slices
     * Call this when you need accurate spatial info (e.g., before saving mask)
     */
    finalizeSpatialParams() {
        // Find the origin from the first available slice (preferably slice 0)
        // But handle case where slice 0 might not be loaded yet
        const loadedIndices = Array.from(this.loadedSlices).sort((a, b) => a - b);
        
        // First, find a slice with valid IPP data
        let referenceIdx = null;
        let referenceIPP = null;
        
        for (const idx of loadedIndices) {
            const meta = this.sliceMetadata[idx];
            if (meta?.imagePositionPatient) {
                if (referenceIdx === null || idx < referenceIdx) {
                    referenceIdx = idx;
                    referenceIPP = meta.imagePositionPatient;
                }
                // If we found slice 0, use it
                if (idx === 0) break;
            }
        }
        
        // Calculate actual slice spacing from consecutive loaded slices
        this.calculatedSliceSpacing = null;
        this.sliceSortOrder = 'ascending';
        
        if (loadedIndices.length >= 2) {
            // Find two consecutive slices to calculate spacing
            for (let i = 0; i < loadedIndices.length - 1; i++) {
                const idx1 = loadedIndices[i];
                const idx2 = loadedIndices[i + 1];
                
                if (idx2 - idx1 === 1) { // Consecutive slices
                    const meta1 = this.sliceMetadata[idx1];
                    const meta2 = this.sliceMetadata[idx2];
                    
                    if (meta1?.imagePositionPatient && meta2?.imagePositionPatient) {
                        const z1 = meta1.imagePositionPatient[2];
                        const z2 = meta2.imagePositionPatient[2];
                        const spacing = z2 - z1;
                        
                        this.calculatedSliceSpacing = Math.abs(spacing);
                        this.sliceSortOrder = spacing >= 0 ? 'ascending' : 'descending';
                        
                        console.log(`[DICOM] Calculated slice spacing: ${this.calculatedSliceSpacing.toFixed(3)}mm (${this.sliceSortOrder})`);
                        break;
                    }
                }
            }
        }
        
        // Fallback to sliceThickness if we couldn't calculate
        if (!this.calculatedSliceSpacing) {
            this.calculatedSliceSpacing = this.sliceThickness;
            console.log(`[DICOM] Using sliceThickness as spacing: ${this.sliceThickness}mm`);
        }
        
        // Now extrapolate to get slice 0's position if we don't have it directly
        if (referenceIdx !== null && referenceIPP) {
            if (referenceIdx === 0) {
                // We have slice 0 directly
                this.firstSliceOrigin = referenceIPP.slice();
            } else {
                // Extrapolate back to slice 0
                // slice0_z = reference_z - (referenceIdx * sliceSpacing * direction)
                const direction = this.sliceSortOrder === 'ascending' ? 1 : -1;
                this.firstSliceOrigin = [
                    referenceIPP[0],  // x usually doesn't change between slices
                    referenceIPP[1],  // y usually doesn't change between slices
                    referenceIPP[2] - (referenceIdx * this.calculatedSliceSpacing * direction)
                ];
                console.log(`[DICOM] Extrapolated slice 0 origin from slice ${referenceIdx}`);
            }
        } else {
            // No spatial data available - use zero origin
            this.firstSliceOrigin = [0, 0, 0];
            console.warn('[DICOM] No Image Position Patient data available, using zero origin');
        }
        
        console.log('[DICOM] Spatial params finalized:');
        console.log('  Origin (IPP slice 0):', this.firstSliceOrigin);
        console.log('  Orientation (IOP):', this.imageOrientationPatient);
        console.log('  Pixel spacing:', this.pixelSpacing);
        console.log('  Slice spacing:', this.calculatedSliceSpacing);
        console.log('  Sort order:', this.sliceSortOrder);
    }
    
    /**
     * Get the NIfTI-compatible affine transformation matrix
     * This maps voxel coordinates [i, j, k] to patient coordinates [x, y, z]
     * 
     * CRITICAL: This must match what 3D Slicer expects!
     * 
     * DICOM coordinate mapping:
     * - ImageOrientationPatient gives direction cosines for:
     *   - Row direction (first 3): direction along image rows (increasing column index)
     *   - Column direction (next 3): direction along image columns (increasing row index)
     * - PixelSpacing gives:
     *   - [0]: row spacing (distance between rows, i.e., column direction distance)
     *   - [1]: column spacing (distance between columns, i.e., row direction distance)
     * 
     * IMPORTANT: Canvas/screen coordinates have y=0 at TOP, increasing downward.
     * DICOM's ImagePositionPatient is at the top-left corner of the image.
     * To properly align with NIfTI/3D Slicer, we need to flip the j-axis
     * so that our stored data matches the expected orientation.
     * 
     * In our voxel array [i, j, k]:
     * - i = column index (x in image) → moves along row direction
     * - j = row index (y in image) → canvas y, 0 at top, increases downward
     * - k = slice index (z) → moves along slice normal direction
     */
    getAffineMatrix() {
        // Ensure spatial params are calculated
        if (!this.firstSliceOrigin) {
            this.finalizeSpatialParams();
        }
        
        // DICOM PixelSpacing: [row_spacing, column_spacing]
        const rowSpacing = this.pixelSpacing[0] || 1;
        const colSpacing = this.pixelSpacing[1] || 1;
        const sliceSpacing = this.calculatedSliceSpacing || this.sliceThickness || 1;
        
        // ImageOrientationPatient: [rowDir_x, rowDir_y, rowDir_z, colDir_x, colDir_y, colDir_z]
        const iop = this.imageOrientationPatient || [1, 0, 0, 0, 1, 0];
        
        const rowDirX = iop[0], rowDirY = iop[1], rowDirZ = iop[2];
        const colDirX = iop[3], colDirY = iop[4], colDirZ = iop[5];
        
        // Slice direction = cross product of row and column directions
        const sliceDirX = rowDirY * colDirZ - rowDirZ * colDirY;
        const sliceDirY = rowDirZ * colDirX - rowDirX * colDirZ;
        const sliceDirZ = rowDirX * colDirY - rowDirY * colDirX;
        
        const sliceSign = this.sliceSortOrder === 'descending' ? -1 : 1;
        
        // ImagePositionPatient: position of pixel [0,0] in DICOM LPS coordinates
        const origin = this.firstSliceOrigin || [0, 0, 0];
        
        // ============================================================
        // CRITICAL: DICOM uses LPS, NIfTI/3D Slicer uses RAS
        // ============================================================
        // DICOM LPS: X+ = Left, Y+ = Posterior, Z+ = Superior
        // NIfTI RAS: X+ = Right, Y+ = Anterior, Z+ = Superior
        //
        // Conversion: RAS_x = -LPS_x, RAS_y = -LPS_y, RAS_z = LPS_z
        //
        // So we negate the X and Y components of everything:
        // - Direction vectors: negate X and Y components
        // - Origin: negate X and Y components
        
        // Convert direction vectors from LPS to RAS (negate X and Y components)
        const rowDirX_RAS = -rowDirX;
        const rowDirY_RAS = -rowDirY;
        const rowDirZ_RAS = rowDirZ;
        
        const colDirX_RAS = -colDirX;
        const colDirY_RAS = -colDirY;
        const colDirZ_RAS = colDirZ;
        
        const sliceDirX_RAS = -sliceDirX;
        const sliceDirY_RAS = -sliceDirY;
        const sliceDirZ_RAS = sliceDirZ;
        
        // Convert origin from LPS to RAS
        const originX_RAS = -origin[0];
        const originY_RAS = -origin[1];
        const originZ_RAS = origin[2];
        
        // Build the affine matrix in RAS coordinates
        const affine = [
            [rowDirX_RAS * colSpacing, colDirX_RAS * rowSpacing, sliceDirX_RAS * sliceSpacing * sliceSign, originX_RAS],
            [rowDirY_RAS * colSpacing, colDirY_RAS * rowSpacing, sliceDirY_RAS * sliceSpacing * sliceSign, originY_RAS],
            [rowDirZ_RAS * colSpacing, colDirZ_RAS * rowSpacing, sliceDirZ_RAS * sliceSpacing * sliceSign, originZ_RAS],
            [0, 0, 0, 1]
        ];
        
        console.log('[DICOM] ===== AFFINE MATRIX DEBUG =====');
        console.log('  Image dims:', this.width, 'x', this.height, 'x', this.sliceCount);
        console.log('  PixelSpacing [row, col]:', [rowSpacing, colSpacing]);
        console.log('  SliceSpacing:', sliceSpacing, '(sort:', this.sliceSortOrder, ', sign:', sliceSign, ')');
        console.log('  IOP rowDir (LPS):', [rowDirX, rowDirY, rowDirZ]);
        console.log('  IOP colDir (LPS):', [colDirX, colDirY, colDirZ]);
        console.log('  IPP origin (LPS):', origin);
        console.log('  Origin (RAS):', [originX_RAS, originY_RAS, originZ_RAS]);
        console.log('  Affine (RAS for NIfTI/Slicer):');
        affine.forEach((row, i) => console.log(`    [${row.map(v => v.toFixed(4)).join(', ')}]`));
        console.log('  ================================');
        
        return affine;
    }
    
    /**
     * Get spatial debug info for troubleshooting alignment
     */
    getSpatialDebugInfo() {
        this.finalizeSpatialParams();
        
        let info = '=== DICOM Spatial Information ===\n';
        info += `Image Orientation Patient: ${this.imageOrientationPatient?.map(v => v.toFixed(4)).join(', ') || 'N/A'}\n`;
        info += `First Slice Origin (IPP): ${this.firstSliceOrigin?.map(v => v.toFixed(2)).join(', ') || 'N/A'}\n`;
        info += `Pixel Spacing: ${this.pixelSpacing[0].toFixed(3)} x ${this.pixelSpacing[1].toFixed(3)} mm\n`;
        info += `Slice Thickness (DICOM): ${this.sliceThickness.toFixed(3)} mm\n`;
        info += `Calculated Slice Spacing: ${this.calculatedSliceSpacing?.toFixed(3) || 'N/A'} mm\n`;
        info += `Slice Sort Order: ${this.sliceSortOrder}\n`;
        
        // Show a few slice positions
        info += '\nSlice Z-positions (from IPP):\n';
        const indices = [0, 1, 2, Math.floor(this.sliceCount/2), this.sliceCount - 1];
        for (const idx of indices) {
            const meta = this.sliceMetadata[idx];
            if (meta?.imagePositionPatient) {
                info += `  Slice ${idx}: z = ${meta.imagePositionPatient[2].toFixed(2)} mm\n`;
            }
        }
        
        return info;
    }
}

// ==================== Slice Loading UI Controller ====================
class SliceLoadingUI {
    constructor(containerSelector) {
        this.container = document.querySelector(containerSelector);
        this.sliceCount = 0;
        this.indicators = [];
    }
    
    /**
     * Initialize the loading indicator bar
     */
    init(sliceCount) {
        this.sliceCount = sliceCount;
        this.indicators = [];
        
        if (!this.container) return;
        
        // Create a simple progress bar with slice indicators
        this.container.innerHTML = `
            <div class="dicom-loading-header">
                <span class="dicom-loading-label">📥 Loading slices:</span>
                <span class="dicom-loading-count">0/${sliceCount}</span>
            </div>
            <div class="dicom-loading-bar">
                <div class="dicom-loading-progress" style="width: 0%"></div>
            </div>
            <div class="dicom-slice-indicators"></div>
        `;
        
        // For small slice counts, show individual indicators
        if (sliceCount <= 100) {
            const indicatorContainer = this.container.querySelector('.dicom-slice-indicators');
            for (let i = 0; i < sliceCount; i++) {
                const indicator = document.createElement('div');
                indicator.className = 'dicom-slice-indicator pending';
                indicator.title = `Slice ${i + 1}`;
                indicatorContainer.appendChild(indicator);
                this.indicators.push(indicator);
            }
        }
    }
    
    /**
     * Mark a slice as loaded
     */
    markLoaded(sliceIndex, loadedCount, totalCount) {
        // Update count
        const countEl = this.container?.querySelector('.dicom-loading-count');
        if (countEl) {
            countEl.textContent = `${loadedCount}/${totalCount}`;
        }
        
        // Update progress bar
        const progressEl = this.container?.querySelector('.dicom-loading-progress');
        if (progressEl) {
            const percent = (loadedCount / totalCount) * 100;
            progressEl.style.width = `${percent}%`;
        }
        
        // Update individual indicator
        if (this.indicators[sliceIndex]) {
            this.indicators[sliceIndex].className = 'dicom-slice-indicator loaded';
        }
    }
    
    /**
     * Mark loading as complete
     */
    complete() {
        if (this.container) {
            const header = this.container.querySelector('.dicom-loading-header');
            if (header) {
                header.innerHTML = `
                    <span class="dicom-loading-label">✅ All slices loaded</span>
                    <span class="dicom-loading-count">${this.sliceCount}/${this.sliceCount}</span>
                `;
            }
        }
    }
    
    /**
     * Hide the loading UI
     */
    hide() {
        if (this.container) {
            this.container.style.display = 'none';
        }
    }
    
    /**
     * Show the loading UI
     */
    show() {
        if (this.container) {
            this.container.style.display = 'block';
        }
    }
}

// Export globally
window.DICOMLoader = DICOMLoader;
window.SliceLoadingUI = SliceLoadingUI;
