"""
Mask upload and save routes.
"""

from flask import Blueprint, jsonify, request
from datetime import datetime
import os
import json
import numpy as np
import nibabel as nib

from config import MASKS_DIR

mask_bp = Blueprint('mask', __name__)


@mask_bp.route('/upload_mask', methods=['POST'])
def upload_mask():
    """Receive and save annotation masks and comments from the client."""
    try:
        data = request.get_json()
        
        # Extract patient and series IDs
        patient_id = data.get('patientId', 'unknown')
        series_id = data.get('seriesId', 'unknown')
        
        original_filename = data.get('originalFilename', 'unknown')
        dimensions = data.get('dimensions', [0, 0, 0])
        affine = data.get('affine', None)
        sparse_data = data.get('sparseData', [])
        comments_data = data.get('comments', None)
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        # Create filename with patient and series IDs
        base_name = f"{patient_id}_{series_id}"
        output_filename = f"{base_name}_mask_{timestamp}.nii.gz"
        output_path = os.path.join(MASKS_DIR, output_filename)
        
        mask_volume = np.zeros(dimensions, dtype=np.uint8)
        
        for item in sparse_data:
            x, y, z, label = item
            if 0 <= x < dimensions[0] and 0 <= y < dimensions[1] and 0 <= z < dimensions[2]:
                mask_volume[x, y, z] = label
        
        # Build affine matrix
        affine_matrix = np.array(affine, dtype=np.float64) if affine else np.eye(4)
        
        # Create NIfTI image with explicit header configuration for 3D Slicer compatibility
        nii_img = nib.Nifti1Image(mask_volume, affine_matrix)
        
        # Get header and configure it properly
        header = nii_img.header
        
        # Set sform_code to indicate scanner-based coordinate system (critical for 3D Slicer)
        # 1 = NIFTI_XFORM_SCANNER_ANAT - scanner-based anatomical coordinates
        header.set_sform(affine_matrix, code=1)
        
        # Also set qform for compatibility with tools that prefer it
        header.set_qform(affine_matrix, code=1)
        
        # Set xyzt_units: spatial=mm (2), temporal=sec (8)
        header.set_xyzt_units(xyz='mm', t='sec')

        # Set descrip field to identify masks from our tool
        header['descrip'] = b'CTColonTool_v1'
        
        # Save the NIfTI file
        nib.save(nii_img, output_path)
        
        annotated_voxels = len(sparse_data)
        
        # Save comments as JSON if present
        comments_filename = None
        if comments_data and comments_data.get('totalComments', 0) > 0:
            comments_filename = f"{base_name}_comments_{timestamp}.json"
            comments_path = os.path.join(MASKS_DIR, comments_filename)
            
            # Add metadata to comments
            comments_data['maskFile'] = output_filename
            comments_data['originalFilename'] = original_filename
            comments_data['dimensions'] = dimensions
            
            with open(comments_path, 'w', encoding='utf-8') as f:
                json.dump(comments_data, f, indent=2, ensure_ascii=False)
            
            print(f"   💬 Comments saved: {comments_filename} ({comments_data['totalComments']} comments)")
        
        print("=" * 60)
        print(f"📥 NEW MASK RECEIVED!")
        print(f"   Patient ID: {patient_id}")
        print(f"   Series ID: {series_id}")
        print(f"   Original CT: {original_filename}")
        print(f"   Dimensions: {dimensions[0]} x {dimensions[1]} x {dimensions[2]}")
        print(f"   Annotated voxels: {annotated_voxels:,}")
        print(f"   Saved to: {output_path}")
        if comments_filename:
            print(f"   Comments file: {comments_filename}")
        print(f"\n   Affine matrix:")
        for i, row in enumerate(affine_matrix):
            print(f"     Row {i}: [{row[0]:10.4f}, {row[1]:10.4f}, {row[2]:10.4f}, {row[3]:10.4f}]")
        
        # Calculate and print physical bounds
        corners = [
            [0, 0, 0],
            [dimensions[0]-1, 0, 0],
            [0, dimensions[1]-1, 0],
            [0, 0, dimensions[2]-1],
            [dimensions[0]-1, dimensions[1]-1, dimensions[2]-1]
        ]
        print(f"\n   Physical coordinate bounds:")
        for corner in corners:
            phys = affine_matrix @ np.array([corner[0], corner[1], corner[2], 1])
            print(f"     Voxel {corner} -> Physical [{phys[0]:.2f}, {phys[1]:.2f}, {phys[2]:.2f}]")
        
        print("=" * 60)
        
        return jsonify({
            'success': True,
            'filename': output_filename,
            'voxels': annotated_voxels,
            'commentsFile': comments_filename
        })
        
    except Exception as e:
        import traceback
        print(f"Error saving mask: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500
