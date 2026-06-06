"""
DICOM Loader
============

Load DICOM files into numpy arrays with proper ordering and metadata extraction.

Key functions:
    - load_dicom_series: Load entire series into 3D volume
    - load_dicom_metadata: Extract metadata without loading pixels
    - get_series_info: Quick summary of a series
"""
import os
import numpy as np
from pathlib import Path
from typing import Tuple, Dict, List, Optional
import pydicom
import nibabel as nib
from datetime import datetime

import json


from data.metadata import DICOMMetadata


def load_dicom_series(
    series_path: str,
    return_metadata: bool = True,
) -> Tuple[np.ndarray, Optional[DICOMMetadata]]:
    """
    Load a DICOM series into a 3D numpy array.
    
    Args:
        series_path: Path to folder containing DICOM files for ONE series
        return_metadata: If True, return metadata from first slice
        
    Returns:
        volume: 3D numpy array in Hounsfield Units, shape (slices, height, width)
        metadata: DICOMMetadata object (or None if return_metadata=False)
        
    Example:
        volume, meta = load_dicom_series('data/raw/dicom/patient_001/series_prone')
        print(f"Volume shape: {volume.shape}")
        print(f"Spacing (z,y,x): {meta.spacing_3d}")
        print(f"Position: {'Prone' if meta.is_prone else 'Supine'}")
    """

    series_path = Path(series_path)
    
    # Step 1: Read all DICOM files and extract position for sorting
    slices = []
    for filepath in series_path.iterdir():
        if not filepath.is_file():
            continue
        
        # Skip non-DICOM files
        if filepath.suffix.lower() in ['.txt', '.xml', '.json', '.csv']:
            continue
        
        try:
            # Read header only first (faster)
            dcm = pydicom.dcmread(str(filepath), stop_before_pixels=True)
            
            # Get z-position for sorting
            if hasattr(dcm, 'ImagePositionPatient'):
                z_pos = float(dcm.ImagePositionPatient[2])
            elif hasattr(dcm, 'SliceLocation'):
                z_pos = float(dcm.SliceLocation)
            else:
                z_pos = float(getattr(dcm, 'InstanceNumber', 0))
            
            slices.append((filepath, z_pos, dcm))
            
        except Exception as e:
            # Skip files that can't be read as DICOM
            continue
    
    if not slices:
        raise ValueError(f"No valid DICOM files found in {series_path}")
    
    # Step 2: Sort by z-position (ascending)
    slices.sort(key=lambda x: x[1])
    
    # Step 3: Extract metadata from first slice
    first_dcm = slices[0][2]
    metadata = DICOMMetadata.from_pydicom(first_dcm) if return_metadata else None
    
    # Set num_slices and calculate actual slice spacing from positions
    if metadata:
        metadata.num_slices = len(slices)
        
        if len(slices) > 1:
            z_positions = [s[1] for s in slices]
            metadata.actual_slice_spacing = abs(z_positions[1] - z_positions[0])
    
    # Step 4: Load pixel data into volume
    rows = first_dcm.Rows
    cols = first_dcm.Columns
    volume = np.zeros((len(slices), rows, cols), dtype=np.int16)
    
    for i, (filepath, _, _) in enumerate(slices):
        # Now load with pixel data
        dcm = pydicom.dcmread(str(filepath))
        
        # Convert to Hounsfield Units
        intercept = float(getattr(dcm, 'RescaleIntercept', 0))
        slope = float(getattr(dcm, 'RescaleSlope', 1))
        
        volume[i] = dcm.pixel_array * slope + intercept
    
    return volume, metadata


def save_as_nifti(
    series_path: str,
    output_path: str = None,
    compress: bool = True,
) -> str:
    """
    Load a DICOM series and save it as a NIfTI file with ALL metadata embedded.
    
    This function:
    1. Loads the DICOM series using load_dicom_series()
    2. Creates a proper affine matrix from DICOM metadata
    3. Embeds ALL DICOM metadata as a NIfTI header extension (JSON format)
    4. Saves as NIfTI (.nii or .nii.gz) format
    
    The metadata is stored inside the NIfTI file itself using NIfTI extensions,
    so no separate JSON file is needed. Use load_nifti_with_metadata() to
    retrieve both the volume and full metadata.
    
    Args:
        series_path: Path to folder containing DICOM files for ONE series
        output_path: Output NIfTI file path. If None, saves in same directory
                    as series with name based on series description
        compress: If True, save as .nii.gz (compressed), else .nii
        
    Returns:
        Path to the saved NIfTI file
        
    Example:
        # Save DICOM as NIfTI
        nifti_path = save_as_nifti('data/raw/dicom/patient_001/series_supine')
        
        # Load it back with all metadata
        volume, metadata, affine = load_nifti_with_metadata(nifti_path)
        print(f"Patient: {metadata['PatientID']}")
        print(f"Position: {metadata['PositionString']}")
        print(f"Window: L:{metadata['WindowCenter']} W:{metadata['WindowWidth']}")
        
    Note:
        Requires nibabel: pip install nibabel
    """

    
    series_path = Path(series_path)
    
    # Load DICOM series
    print(f"Loading DICOM series from: {series_path}")
    volume, metadata = load_dicom_series(str(series_path), return_metadata=True)
    
    print(f"  Volume shape: {volume.shape}")
    print(f"  Spacing (z,y,x): {metadata.spacing_3d}")
    print(f"  Position: {metadata.position_string}")
    
    # Create affine matrix from DICOM metadata
    affine = _create_affine_from_metadata(metadata)
    
    # NIfTI expects (x, y, z) but our volume is (z, y, x)
    # Transpose to (x, y, z) for NIfTI convention
    volume_nifti = np.transpose(volume, (2, 1, 0))
    
    # Create NIfTI image
    nifti_img = nib.Nifti1Image(volume_nifti, affine)
    
    # Set header info
    header = nifti_img.header
    header.set_xyzt_units('mm', 'sec')
    
    # Get window/level from DICOM metadata
    wc = metadata.window_center if metadata.window_center else 40
    ww = metadata.window_width if metadata.window_width else 400
    
    # Set cal_min and cal_max for display range hint
    # These are used by viewers like 3D Slicer for initial window/level
    cal_min = wc - ww / 2  # Lower bound of display window
    cal_max = wc + ww / 2  # Upper bound of display window
    header['cal_min'] = cal_min
    header['cal_max'] = cal_max
    
    # Store brief info in description field (max 80 chars)
    description = f"WL:{wc:.0f}/{ww:.0f}|"
    description += f"Pos:{metadata.position_string}|"
    if metadata.patient_id:
        pid = metadata.patient_id.split('.')[-1][:10]
        description += f"ID:{pid}"
    header['descrip'] = description[:80].encode('ascii', 'ignore')
    
    # Print window/level info for user
    print(f"  Window Level: L:{wc:.0f} W:{ww:.0f}")
    print(f"  HU range displayed: [{cal_min:.0f} to {cal_max:.0f}]")
    
    # =========================================================================
    # BUILD COMPLETE METADATA DICTIONARY
    # =========================================================================
    metadata_dict = {
        # Conversion info
        "_ConversionInfo": {
            "ConversionTool": "CT Colonography Project - save_as_nifti",
            "ConversionDate": datetime.now().isoformat(),
            "OriginalFormat": "DICOM",
            "OriginalShape_ZYX": list(volume.shape),
            "NIfTIShape_XYZ": list(volume_nifti.shape),
        },
        
        # Patient
        "PatientID": metadata.patient_id,
        "PatientSex": metadata.patient_sex,
        "PatientAge": metadata.patient_age,
        
        # Study
        "StudyDate": metadata.study_date,
        "StudyDescription": metadata.study_description,
        
        # Series
        "SeriesUID": metadata.series_uid,
        "StudyUID": metadata.study_uid,
        "SOPInstanceUID": metadata.sop_instance_uid,
        "SeriesDescription": metadata.series_description,
        "SeriesNumber": metadata.series_number,
        "Modality": metadata.modality,
        "BodyPartExamined": metadata.body_part_examined,
        "ProtocolName": metadata.protocol_name,
        
        # Patient Position (CRITICAL for CTC)
        "PatientPosition": metadata.patient_position,
        "ImageComments": metadata.image_comments,
        "IsProne": metadata.is_prone,
        "IsSupine": metadata.is_supine,
        "PositionString": metadata.position_string,
        
        # Geometry (CRITICAL)
        "Rows": metadata.rows,
        "Columns": metadata.columns,
        "NumberOfSlices": volume.shape[0],
        "PixelSpacing": list(metadata.pixel_spacing) if metadata.pixel_spacing else None,
        "SliceThickness": metadata.slice_thickness,
        "ActualSliceSpacing": metadata.actual_slice_spacing,
        "Spacing3D_ZYX": list(metadata.spacing_3d),
        "ReconstructionDiameter": metadata.reconstruction_diameter,
        
        # Orientation (CRITICAL)
        "ImagePositionPatient": list(metadata.image_position) if metadata.image_position else None,
        "ImageOrientationPatient": list(metadata.image_orientation) if metadata.image_orientation else None,
        "SliceLocation": metadata.slice_location,
        "InstanceNumber": metadata.instance_number,
        "IsStandardAxial": metadata.is_standard_axial,
        
        # Intensity (CRITICAL for HU)
        "RescaleIntercept": metadata.rescale_intercept,
        "RescaleSlope": metadata.rescale_slope,
        "WindowCenter": metadata.window_center,
        "WindowWidth": metadata.window_width,
        
        # Scanner
        "Manufacturer": metadata.manufacturer,
        "ManufacturerModel": metadata.manufacturer_model,
        "ConvolutionKernel": metadata.convolution_kernel,
        "KVP": metadata.kvp,
        "DistanceSourceToPatient": metadata.distance_source_to_patient,
        
        # Affine matrix
        "AffineMatrix": affine.tolist(),
    }
    
    # Remove None values
    metadata_dict = {k: v for k, v in metadata_dict.items() if v is not None}
    
    # =========================================================================
    # EMBED METADATA AS NIFTI EXTENSION
    # =========================================================================
    # Extension code 44 is for "DICOM-like" metadata (arbitrary JSON)
    # Extension code 6 is for plain text
    json_bytes = json.dumps(metadata_dict, indent=2).encode('utf-8')
    
    # Create extension (code=44 for DICOM, or 6 for plain text)
    # Using ecode=6 (plain text) for better compatibility
    extension = nib.nifti1.Nifti1Extension(code=6, content=json_bytes)
    nifti_img.header.extensions.append(extension)
    
    # =========================================================================
    # DETERMINE OUTPUT PATH
    # =========================================================================
    if output_path is None:
        name_parts = []
        if metadata.patient_id:
            pid = metadata.patient_id.split('.')[-1]
            name_parts.append(f"patient_{pid}")
        if metadata.position_string and metadata.position_string != "unknown":
            name_parts.append(metadata.position_string.lower())
        if metadata.series_description:
            desc = metadata.series_description.replace(' ', '_').replace('/', '_')
            desc = ''.join(c for c in desc if c.isalnum() or c == '_')
            name_parts.append(desc[:30])
        
        if not name_parts:
            name_parts = ["volume"]
        
        filename = "_".join(name_parts)
        ext = ".nii.gz" if compress else ".nii"
        output_path = series_path.parent / f"{filename}{ext}"
    else:
        output_path = Path(output_path)
        if compress and not str(output_path).endswith('.gz'):
            if not str(output_path).endswith('.nii'):
                output_path = Path(str(output_path) + '.nii.gz')
            else:
                output_path = Path(str(output_path) + '.gz')
        elif not compress and str(output_path).endswith('.gz'):
            output_path = Path(str(output_path)[:-3])
    
    # Create output directory if needed
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Save NIfTI
    print(f"Saving NIfTI to: {output_path}")
    nib.save(nifti_img, str(output_path))
    
    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"  Saved successfully! Size: {file_size_mb:.1f} MB")
    print(f"  Metadata embedded in NIfTI header extension")
    
    return str(output_path)


def load_nifti_with_metadata(nifti_path: str) -> Tuple[np.ndarray, DICOMMetadata, np.ndarray]:
    """
    Load a NIfTI file and extract the embedded DICOM metadata.
    
    Args:
        nifti_path: Path to .nii or .nii.gz file
        
    Returns:
        volume: 3D numpy array in (z, y, x) order (same as DICOM convention)
        metadata: DICOMMetadata object with all DICOM metadata
        affine: 4x4 affine transformation matrix
        
    Example:
        volume, metadata, affine = load_nifti_with_metadata('patient_001.nii.gz')
        
        # Access metadata properties directly
        print(f"Patient ID: {metadata.patient_id}")
        print(f"Position: {metadata.position_string}")
        print(f"Window: L:{metadata.window_center} W:{metadata.window_width}")
        print(f"Spacing: {metadata.spacing_3d}")
        
        # Visualize metadata
        metadata.visualize()
        
        # Use with DICOMViewer
        from src.visualization import DICOMViewer
        viewer = DICOMViewer(volume, metadata)
        viewer.browse_jupyter()
    """

    
    nifti_path = Path(nifti_path)
    
    # Load NIfTI
    nifti_img = nib.load(str(nifti_path))
    volume_nifti = nifti_img.get_fdata()
    affine = nifti_img.affine
    
    # Transpose back to DICOM order (z, y, x)
    volume = np.transpose(volume_nifti, (2, 1, 0)).astype(np.int16)
    
    # Extract metadata from extension
    metadata = {}
    for ext in nifti_img.header.extensions:
        if ext.get_code() == 6:  # Plain text extension
            try:
                json_str = ext.get_content().decode('utf-8')
                # Remove any null bytes that might be padding
                json_str = json_str.rstrip('\x00')
                metadata = json.loads(json_str)
                break
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                print(f"Warning: Could not parse metadata extension: {e}")
                continue
    
    if not metadata:
        print(f"Warning: No embedded metadata found in {nifti_path}")
        # Try to extract basic info from header
        header = nifti_img.header
        descrip = header['descrip'].tobytes().decode('ascii', 'ignore').strip('\x00')
        metadata = {'_header_descrip': descrip}
    
    # Convert dict to DICOMMetadata object for consistent API
    metadata_obj = DICOMMetadata.from_dict(metadata)
    
    return volume, metadata_obj, affine


def print_nifti_metadata(nifti_path: str) -> None:
    """
    Print all metadata embedded in a NIfTI file.
    
    Args:
        nifti_path: Path to .nii or .nii.gz file
        
    Example:
        print_nifti_metadata('patient_001.nii.gz')
    """
    _, metadata, affine = load_nifti_with_metadata(nifti_path)
    
    # Use the DICOMMetadata's built-in visualization
    metadata.visualize()


def _create_affine_from_metadata(metadata: DICOMMetadata) -> np.ndarray:
    """
    Create a 4x4 affine transformation matrix from DICOM metadata.
    
    The affine matrix transforms from voxel indices (i, j, k) to 
    world coordinates (x, y, z) in mm.
    
    IMPORTANT: DICOM uses LPS+ convention (Left-Posterior-Superior positive)
    while NIfTI uses RAS+ convention (Right-Anterior-Superior positive).
    We need to negate X and Y axes to convert.
    
    Args:
        metadata: DICOMMetadata object
        
    Returns:
        4x4 affine matrix in RAS+ convention for NIfTI
    """
    # Get spacing (z, y, x) -> need (x, y, z) for affine
    sz, sy, sx = metadata.spacing_3d
    
    # Get image position (origin) - this is position of first voxel in LPS
    if metadata.image_position:
        origin_lps = np.array(metadata.image_position)
    else:
        origin_lps = np.array([0.0, 0.0, 0.0])
    
    # Get orientation vectors (in LPS convention from DICOM)
    if metadata.image_orientation:
        # image_orientation contains [row_x, row_y, row_z, col_x, col_y, col_z]
        orientation = metadata.image_orientation
        row_cosines_lps = np.array(orientation[0:3])  # Direction of rows (x in image)
        col_cosines_lps = np.array(orientation[3:6])  # Direction of columns (y in image)
        
        # Slice direction is cross product of row and column
        slice_cosines_lps = np.cross(row_cosines_lps, col_cosines_lps)
    else:
        # Default: standard axial orientation in LPS
        row_cosines_lps = np.array([1.0, 0.0, 0.0])
        col_cosines_lps = np.array([0.0, 1.0, 0.0])
        slice_cosines_lps = np.array([0.0, 0.0, 1.0])
    
    # Convert from LPS to RAS by negating X and Y components
    # LPS -> RAS conversion matrix: diag([-1, -1, 1])
    lps_to_ras = np.diag([-1, -1, 1])
    
    row_cosines_ras = lps_to_ras @ row_cosines_lps
    col_cosines_ras = lps_to_ras @ col_cosines_lps
    slice_cosines_ras = lps_to_ras @ slice_cosines_lps
    origin_ras = lps_to_ras @ origin_lps
    
    # Build affine matrix in RAS+ convention
    # For NIfTI with volume transposed to (x, y, z):
    affine = np.eye(4)
    
    # Column 0: direction and spacing for x (originally columns in DICOM)
    affine[0:3, 0] = row_cosines_ras * sx
    
    # Column 1: direction and spacing for y (originally rows in DICOM)  
    affine[0:3, 1] = col_cosines_ras * sy
    
    # Column 2: direction and spacing for z (slice direction)
    affine[0:3, 2] = slice_cosines_ras * sz
    
    # Column 3: origin (translation) in RAS
    affine[0:3, 3] = origin_ras
    
    return affine


def load_dicom_metadata(filepath: str) -> DICOMMetadata:
    """
    Load metadata from a single DICOM file without loading pixel data.
    
    Args:
        filepath: Path to a DICOM file
        
    Returns:
        DICOMMetadata object
    """
 
    dcm = pydicom.dcmread(filepath, stop_before_pixels=True)
    return DICOMMetadata.from_pydicom(dcm)


def get_series_info(series_path: str) -> Dict:
    """
    Get quick summary info about a DICOM series.
    
    Args:
        series_path: Path to folder containing DICOM files
        
    Returns:
        Dictionary with series information
    """

    series_path = Path(series_path)
    
    # Find first valid DICOM file
    dcm = None
    num_files = 0
    
    for filepath in series_path.iterdir():
        if not filepath.is_file():
            continue
        if filepath.suffix.lower() in ['.txt', '.xml', '.json']:
            continue
        
        num_files += 1
        
        if dcm is None:
            try:
                dcm = pydicom.dcmread(str(filepath), stop_before_pixels=True)
            except:
                continue
    
    if dcm is None:
        raise ValueError(f"No valid DICOM files in {series_path}")
    
    meta = DICOMMetadata.from_pydicom(dcm)
    
    return {
        'series_uid': meta.series_uid,
        'series_description': meta.series_description,
        'patient_id': meta.patient_id,
        'patient_position': meta.patient_position,
        'is_prone': meta.is_prone,
        'is_supine': meta.is_supine,
        'num_files': num_files,
        'dimensions': (meta.rows, meta.columns),
        'pixel_spacing': meta.pixel_spacing,
        'slice_thickness': meta.slice_thickness,
        'manufacturer': meta.manufacturer,
        'model': meta.manufacturer_model,
    }


def scan_dicom_directory(root_path: str) -> List[Dict]:
    """
    Scan a directory tree for DICOM series.
    
    Args:
        root_path: Root directory to scan
        
    Returns:
        List of dictionaries with series information
    """
    root_path = Path(root_path)
    series_list = []
    
    # Walk through directory tree
    for folder in root_path.rglob('*'):
        if not folder.is_dir():
            continue
        
        # Check if folder contains DICOM files
        has_dicom = False
        for f in folder.iterdir():
            if f.is_file() and f.suffix.lower() not in ['.txt', '.xml', '.json', '.csv']:
                try:
                    pydicom.dcmread(str(f), stop_before_pixels=True)
                    has_dicom = True
                    break
                except:
                    continue
        
        if has_dicom:
            try:
                info = get_series_info(str(folder))
                info['path'] = str(folder)
                series_list.append(info)
            except:
                continue
    
    return series_list
