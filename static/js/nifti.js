/**
 * NIfTI Parser - Handles NIfTI-1 and NIfTI-2 file formats
 * Preserves all spatial metadata for 3D Slicer alignment
 */

class NiftiParser {
    constructor() {
        this.data = null;
        this.dims = [0, 0, 0];
        this.isNifti2 = false;
        this.descrip = ''; 
        
        // Store ALL spatial parameters explicitly
        this.spatial = {
            pixdim: [1, 1, 1, 1, 1, 1, 1, 1],
            sformCode: 0,
            qformCode: 0,
            srow_x: [1, 0, 0, 0],
            srow_y: [0, 1, 0, 0],
            srow_z: [0, 0, 1, 0],
            quatern_b: 0,
            quatern_c: 0,
            quatern_d: 0,
            qoffset_x: 0,
            qoffset_y: 0,
            qoffset_z: 0,
            xyzt_units: 0
        };
    }
    
    /**
     * Detect orientation code (e.g., 'RAS', 'LPS') from sform affine.
     * Returns null if no valid sform is available.
     */
    getOrientationCode() {
        if (this.spatial.sformCode <= 0) return null;
        
        const rows = [this.spatial.srow_x, this.spatial.srow_y, this.spatial.srow_z];
        const labels = [
            ['R', 'L'],  // X+: Right, X-: Left
            ['A', 'P'],  // Y+: Anterior, Y-: Posterior
            ['S', 'I']   // Z+: Superior, Z-: Inferior
        ];
        
        let code = '';
        for (const row of rows) {
            // Find which voxel axis (column 0,1,2) has the largest contribution
            let maxVal = 0;
            let maxCol = 0;
            for (let col = 0; col < 3; col++) {
                if (Math.abs(row[col]) > Math.abs(maxVal)) {
                    maxVal = row[col];
                    maxCol = col;
                }
            }
            // Positive = first label, Negative = second label
            code += maxVal > 0 ? labels[maxCol][0] : labels[maxCol][1];
        }
        
        return code;
    }

    isRAS() { return this.getOrientationCode() === 'RAS'; }
    isLPS() { return this.getOrientationCode() === 'LPS'; }
    isFromCTColonTool() { return this.descrip.startsWith('CTColonTool'); }

    /**
     * Convert affine from RAS to LPS.
     * Negates X and Y rows (rows 0 and 1).
     * Voxel data stays the same — only the spatial mapping changes.
     */
    affineToLPS() {
        const sp = this.spatial;
        return [
            sp.srow_x.map(v => -v),    // negate X row
            sp.srow_y.map(v => -v),    // negate Y row
            [...sp.srow_z],            // Z unchanged
            [0, 0, 0, 1]
        ];
    }

    /**
     * Convert affine from LPS to RAS.
     * Same operation as RAS→LPS (negating X and Y is its own inverse).
     */
    affineToRAS() {
        return this.affineToLPS();  // identical operation
    }

    async load(file) {
        let buffer = await file.arrayBuffer();
        const arr = new Uint8Array(buffer);
        if (arr[0] === 0x1f && arr[1] === 0x8b) {
            buffer = pako.inflate(arr).buffer;
        }
        return this.parse(buffer);
    }
    
    parse(buffer) {
        const view = new DataView(buffer);
        const sizeof_hdr = view.getInt32(0, true);
        
        let dims, datatype, bitpix, vox_offset, scl_slope, scl_inter;
        
        if (sizeof_hdr === 348) {
            // ===== NIfTI-1 =====
            this.isNifti2 = false;
            
            // Dimensions
            dims = [];
            for (let i = 0; i < 8; i++) {
                dims.push(view.getInt16(40 + i*2, true));
            }
            
            datatype = view.getInt16(70, true);
            bitpix = view.getInt16(72, true);
            
            // Pixdim (voxel sizes) - bytes 76-107
            for (let i = 0; i < 8; i++) {
                this.spatial.pixdim[i] = view.getFloat32(76 + i*4, true);
            }
            
            vox_offset = view.getFloat32(108, true);
            scl_slope = view.getFloat32(112, true);
            scl_inter = view.getFloat32(116, true);
            
            // xyzt_units - byte 123
            this.spatial.xyzt_units = view.getUint8(123);

            // descrip field - bytes 148-227 (80 bytes)
            const descripBytes = new Uint8Array(buffer, 148, 80);
            this.descrip = String.fromCharCode(...descripBytes).replace(/\0/g, '').trim();
            
            // qform_code - bytes 252-253
            this.spatial.qformCode = view.getInt16(252, true);
            // sform_code - bytes 254-255
            this.spatial.sformCode = view.getInt16(254, true);
            
            // Quaternion parameters - bytes 256-279
            this.spatial.quatern_b = view.getFloat32(256, true);
            this.spatial.quatern_c = view.getFloat32(260, true);
            this.spatial.quatern_d = view.getFloat32(264, true);
            this.spatial.qoffset_x = view.getFloat32(268, true);
            this.spatial.qoffset_y = view.getFloat32(272, true);
            this.spatial.qoffset_z = view.getFloat32(276, true);
            
            // Sform affine matrix - bytes 280-331
            this.spatial.srow_x = [
                view.getFloat32(280, true), view.getFloat32(284, true),
                view.getFloat32(288, true), view.getFloat32(292, true)
            ];
            this.spatial.srow_y = [
                view.getFloat32(296, true), view.getFloat32(300, true),
                view.getFloat32(304, true), view.getFloat32(308, true)
            ];
            this.spatial.srow_z = [
                view.getFloat32(312, true), view.getFloat32(316, true),
                view.getFloat32(320, true), view.getFloat32(324, true)
            ];
            
        } else if (sizeof_hdr === 540) {
            // ===== NIfTI-2 =====
            this.isNifti2 = true;
            
            dims = [];
            for (let i = 0; i < 8; i++) {
                dims.push(Number(view.getBigInt64(16 + i*8, true)));
            }
            
            datatype = view.getInt16(12, true);
            bitpix = view.getInt16(14, true);
            
            for (let i = 0; i < 8; i++) {
                this.spatial.pixdim[i] = view.getFloat64(104 + i*8, true);
            }
            
            vox_offset = Number(view.getBigInt64(168, true));
            scl_slope = view.getFloat64(176, true);
            scl_inter = view.getFloat64(184, true);
            
            this.spatial.xyzt_units = view.getUint8(500);

            // descrip field - bytes 240-319 (80 bytes) for NIfTI-2
            const descripBytes = new Uint8Array(buffer, 240, 80);
            this.descrip = String.fromCharCode(...descripBytes).replace(/\0/g, '').trim();



            this.spatial.qformCode = view.getInt32(344, true);
            this.spatial.sformCode = view.getInt32(348, true);
            
            this.spatial.quatern_b = view.getFloat64(352, true);
            this.spatial.quatern_c = view.getFloat64(360, true);
            this.spatial.quatern_d = view.getFloat64(368, true);
            this.spatial.qoffset_x = view.getFloat64(376, true);
            this.spatial.qoffset_y = view.getFloat64(384, true);
            this.spatial.qoffset_z = view.getFloat64(392, true);
            
            this.spatial.srow_x = [
                view.getFloat64(400, true), view.getFloat64(408, true),
                view.getFloat64(416, true), view.getFloat64(424, true)
            ];
            this.spatial.srow_y = [
                view.getFloat64(432, true), view.getFloat64(440, true),
                view.getFloat64(448, true), view.getFloat64(456, true)
            ];
            this.spatial.srow_z = [
                view.getFloat64(464, true), view.getFloat64(472, true),
                view.getFloat64(480, true), view.getFloat64(488, true)
            ];
            
        } else {
            throw new Error('Unknown NIfTI format (sizeof_hdr=' + sizeof_hdr + ')');
        }
        
        this.dims = [dims[1], dims[2], dims[3]];
        
        const dataStart = Math.ceil(vox_offset);
        const numVoxels = this.dims[0] * this.dims[1] * this.dims[2];
        
        if (scl_slope === 0) scl_slope = 1;
        
        // Create data array based on datatype
        let typedData;
        switch (datatype) {
            case 2: typedData = new Uint8Array(buffer, dataStart, numVoxels); break;
            case 4: typedData = new Int16Array(buffer, dataStart, numVoxels); break;
            case 8: typedData = new Int32Array(buffer, dataStart, numVoxels); break;
            case 16: typedData = new Float32Array(buffer, dataStart, numVoxels); break;
            case 64: typedData = new Float64Array(buffer, dataStart, numVoxels); break;
            case 256: typedData = new Int8Array(buffer, dataStart, numVoxels); break;
            case 512: typedData = new Uint16Array(buffer, dataStart, numVoxels); break;
            default: throw new Error('Unsupported datatype: ' + datatype);
        }
        
        // Apply scaling and convert to Float32 for HU values
        this.data = new Float32Array(numVoxels);
        for (let i = 0; i < numVoxels; i++) {
            this.data[i] = typedData[i] * scl_slope + scl_inter;
        }
        
        console.log('=== NIfTI Spatial Parameters ===');
        console.log('Dims:', this.dims);
        console.log('Pixdim:', this.spatial.pixdim.slice(1, 4));
        console.log('sform_code:', this.spatial.sformCode);
        console.log('qform_code:', this.spatial.qformCode);
        console.log('srow_x:', this.spatial.srow_x);
        console.log('srow_y:', this.spatial.srow_y);
        console.log('srow_z:', this.spatial.srow_z);
        console.log('qoffset:', [this.spatial.qoffset_x, this.spatial.qoffset_y, this.spatial.qoffset_z]);
        console.log('xyzt_units:', this.spatial.xyzt_units);
        
        return {
            data: this.data,
            dims: this.dims,
            spatial: this.spatial
        };
    }
    
    getSlice(z) {
        const width = this.dims[0];
        const height = this.dims[1];
        const sliceSize = width * height;
        const offset = z * sliceSize;
        
        const sliceData = new Float32Array(sliceSize);
        for (let i = 0; i < sliceSize; i++) {
            sliceData[i] = this.data[offset + i];
        }
        
        return { data: sliceData, width, height };
    }
    
    // Get physical Z coordinate for a slice
    getPhysicalZ(sliceIndex) {
        if (this.spatial.sformCode > 0) {
            // Use sform: Z = srow_z[2] * k + srow_z[3]
            return this.spatial.srow_z[2] * sliceIndex + this.spatial.srow_z[3];
        } else if (this.spatial.qformCode > 0) {
            // Use qform (simplified for axial slices)
            return this.spatial.pixdim[3] * sliceIndex + this.spatial.qoffset_z;
        } else {
            // Fallback to pixdim
            return this.spatial.pixdim[3] * sliceIndex;
        }
    }
    
    // Build NIfTI-1 header preserving all spatial information
    buildNifti1Header() {
        const buffer = new ArrayBuffer(352);
        const view = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);
        
        // sizeof_hdr = 348
        view.setInt32(0, 348, true);
        
        // dim (dimensions)
        view.setInt16(40, 3, true);  // ndim = 3
        view.setInt16(42, this.dims[0], true);  // X
        view.setInt16(44, this.dims[1], true);  // Y
        view.setInt16(46, this.dims[2], true);  // Z
        view.setInt16(48, 1, true);  // T
        view.setInt16(50, 1, true);
        view.setInt16(52, 1, true);
        view.setInt16(54, 1, true);
        
        // datatype = 2 (uint8), bitpix = 8
        view.setInt16(70, 2, true);
        view.setInt16(72, 8, true);
        
        // pixdim - CRITICAL for alignment
        for (let i = 0; i < 8; i++) {
            view.setFloat32(76 + i*4, this.spatial.pixdim[i], true);
        }
        
        // vox_offset = 352
        view.setFloat32(108, 352, true);
        
        // scl_slope = 1, scl_inter = 0
        view.setFloat32(112, 1, true);
        view.setFloat32(116, 0, true);
        
        // xyzt_units - byte 123
        view.setUint8(123, this.spatial.xyzt_units);

        // descrip field - bytes 148-227 (80 bytes) - tool identification flag
        const descripStr = 'CTColonTool_v1';
        for (let i = 0; i < descripStr.length && i < 80; i++) {
            uint8[148 + i] = descripStr.charCodeAt(i);
        }
        
        // qform_code and sform_code
        view.setInt16(252, this.spatial.qformCode, true);
        view.setInt16(254, this.spatial.sformCode, true);
        
        // Quaternion parameters
        view.setFloat32(256, this.spatial.quatern_b, true);
        view.setFloat32(260, this.spatial.quatern_c, true);
        view.setFloat32(264, this.spatial.quatern_d, true);
        view.setFloat32(268, this.spatial.qoffset_x, true);
        view.setFloat32(272, this.spatial.qoffset_y, true);
        view.setFloat32(276, this.spatial.qoffset_z, true);
        
        // sform affine rows
        view.setFloat32(280, this.spatial.srow_x[0], true);
        view.setFloat32(284, this.spatial.srow_x[1], true);
        view.setFloat32(288, this.spatial.srow_x[2], true);
        view.setFloat32(292, this.spatial.srow_x[3], true);
        
        view.setFloat32(296, this.spatial.srow_y[0], true);
        view.setFloat32(300, this.spatial.srow_y[1], true);
        view.setFloat32(304, this.spatial.srow_y[2], true);
        view.setFloat32(308, this.spatial.srow_y[3], true);
        
        view.setFloat32(312, this.spatial.srow_z[0], true);
        view.setFloat32(316, this.spatial.srow_z[1], true);
        view.setFloat32(320, this.spatial.srow_z[2], true);
        view.setFloat32(324, this.spatial.srow_z[3], true);
        
        // Magic bytes "n+1" at 344
        uint8[344] = 0x6e; // 'n'
        uint8[345] = 0x2b; // '+'
        uint8[346] = 0x31; // '1'
        uint8[347] = 0x00;
        
        return buffer;
    }
    
    getDebugInfo() {
            const sp = this.spatial;
            const orient = this.getOrientationCode();
            return `Format: NIfTI-${this.isNifti2 ? '2' : '1'}
    Orientation: ${orient || 'unknown'}${orient && orient !== 'RAS' ? ' ⚠️ NOT RAS' : ''}
    Dims: ${this.dims.join(' × ')}
    Voxel Size: ${sp.pixdim.slice(1,4).map(v => v.toFixed(3)).join(' × ')} mm
    sform_code: ${sp.sformCode}
    qform_code: ${sp.qformCode}
    xyzt_units: ${sp.xyzt_units} (${sp.xyzt_units & 7 === 2 ? 'mm' : 'other'})

    srow_x: [${sp.srow_x.map(v => v.toFixed(3)).join(', ')}]
    srow_y: [${sp.srow_y.map(v => v.toFixed(3)).join(', ')}]
    srow_z: [${sp.srow_z.map(v => v.toFixed(3)).join(', ')}]

    qoffset: [${sp.qoffset_x.toFixed(2)}, ${sp.qoffset_y.toFixed(2)}, ${sp.qoffset_z.toFixed(2)}]`;
        }
}

// Make available globally
window.NiftiParser = NiftiParser;
window.NIfTIReader = NiftiParser;  // Alias for compatibility
