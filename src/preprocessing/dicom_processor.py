"""
DICOM Processor
===============

A comprehensive class for loading and processing CT Colonography DICOM files.

Usage:
    processor = DICOMProcessor("path/to/dicom/series")
    volume, metadata = processor.load_volume()
    
    # Or step by step
    processor = DICOMProcessor("path/to/dicom/series")
    processor.scan_files()
    print(processor.get_series_info())
    volume = processor.build_volume()
"""

import os
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
import json
import warnings

import pydicom

from data.metadata import DICOMMetadata


class DICOMProcessor:
    """
    Process CT Colonography DICOM files.
    
    Handles:
        - Scanning directories for DICOM files
        - Extracting metadata
        - Sorting slices by position
        - Building 3D volumes in Hounsfield Units
        - Validating data consistency
    
    Example:
        processor = DICOMProcessor("path/to/dicom/folder")
        volume, metadata = processor.load_volume()
        
        print(f"Shape: {volume.shape}")
        print(f"Spacing: {metadata.spacing_3d}")
        print(f"Position: {metadata.position_string}")
    """
    
    # DICOM properties organized by category
    DICOM_PROPERTIES = {
        "identifiers": [
            "Patient ID",                    # (0010,0020) → patient_id
            "Series Instance UID",           # (0020,000E) → series_uid
            "Study Instance UID",            # (0020,000D) → study_uid
        ],
        
        "geometry": [
            "Rows",                          # (0028,0010) → rows
            "Columns",                       # (0028,0011) → columns
            "Pixel Spacing",                 # (0028,0030) → pixel_spacing
            "Slice Thickness",               # (0018,0050) → slice_thickness
            "Image Position (Patient)",      # (0020,0032) → image_position
            "Image Orientation (Patient)",   # (0020,0037) → image_orientation
            "Slice Location",                # (0020,1041) → slice_location
            "Reconstruction Diameter",       # (0018,1100) → reconstruction_diameter
        ],
        
        "intensity": [
            "Rescale Intercept",             # (0028,1052) → rescale_intercept
            "Rescale Slope",                 # (0028,1053) → rescale_slope
        ],
        
        "series_info": [
            "Series Description",            # (0008,103E) → series_description
            "Study Description",             # (0008,1030) → study_description
            "Protocol Name",                 # (0018,1030) → protocol_name
            "Body Part Examined",            # (0018,0015) → body_part_examined
        ],
        
        "patient_info": [
            "Patient Position",              # (0018,5100) → patient_position
            "Patient's Sex",                 # (0010,0040) → patient_sex
            "Patient's Age",                 # (0010,1010) → patient_age
            "Image Comments",                # (0020,4000) → image_comments
        ],
        
        "scanner_info": [
            "Manufacturer",                  # (0008,0070) → manufacturer
            "Manufacturer's Model Name",     # (0008,1090) → manufacturer_model
            "Convolution Kernel",            # (0018,1210) → convolution_kernel
            "KVP",                           # (0018,0060) → kvp
            "Distance Source to Patient",    # (0018,1111) → distance_source_to_patient
        ],
        
        "display": [
            "Window Center",                 # (0028,1050) → window_center
            "Window Width",                  # (0028,1051) → window_width
        ],
    }
    
    # Mapping from DICOM tag name to pydicom attribute name
    DICOM_TO_PYDICOM = {
        "Patient ID": "PatientID",
        "Series Instance UID": "SeriesInstanceUID",
        "Study Instance UID": "StudyInstanceUID",
        "Rows": "Rows",
        "Columns": "Columns",
        "Pixel Spacing": "PixelSpacing",
        "Slice Thickness": "SliceThickness",
        "Image Position (Patient)": "ImagePositionPatient",
        "Image Orientation (Patient)": "ImageOrientationPatient",
        "Slice Location": "SliceLocation",
        "Reconstruction Diameter": "ReconstructionDiameter",
        "Rescale Intercept": "RescaleIntercept",
        "Rescale Slope": "RescaleSlope",
        "Series Description": "SeriesDescription",
        "Study Description": "StudyDescription",
        "Protocol Name": "ProtocolName",
        "Body Part Examined": "BodyPartExamined",
        "Patient Position": "PatientPosition",
        "Patient's Sex": "PatientSex",
        "Patient's Age": "PatientAge",
        "Image Comments": "ImageComments",
        "Manufacturer": "Manufacturer",
        "Manufacturer's Model Name": "ManufacturerModelName",
        "Convolution Kernel": "ConvolutionKernel",
        "KVP": "KVP",
        "Distance Source to Patient": "DistanceSourceToPatient",
        "Window Center": "WindowCenter",
        "Window Width": "WindowWidth",
    }
    
    # Valid file extensions
    DICOM_EXTENSIONS = {'.dcm', '.dicom', '.dic', ''}  # '' for extensionless DICOM
    
    def __init__(self, dicom_dir: str):
        """
        Initialize DICOM processor.
        
        Args:
            dicom_dir: Path to directory containing DICOM files for ONE series
        """
     
        self.dicom_dir = Path(dicom_dir)
        if not self.dicom_dir.exists():
            raise FileNotFoundError(f"Directory not found: {dicom_dir}")
        
        # Will be populated by scan_files()
        self.dicom_files: List[Path] = []
        self.slice_data: List[Dict] = []  # [{filepath, z_position, dcm_header}, ...]
        self.metadata: Optional[DICOMMetadata] = None
        self.actual_slice_spacing: float = 0.0
        
        # State
        self._scanned = False
        self._sorted = False
    
    # =========================================================================
    # FILE SCANNING
    # =========================================================================
    
    def scan_files(self) -> 'DICOMProcessor':
        """
        Scan directory for DICOM files.
        
        Returns:
            self (for method chaining)
        """
        self.dicom_files = []
        
        for f in self.dicom_dir.iterdir():
            if not f.is_file():
                continue
            
            # Check extension
            if f.suffix.lower() not in self.DICOM_EXTENSIONS:
                # Skip known non-DICOM files
                if f.suffix.lower() in {'.txt', '.xml', '.json', '.csv', '.pdf', '.png', '.jpg'}:
                    continue
            
            # Try to read as DICOM
            try:
                dcm = pydicom.dcmread(str(f), stop_before_pixels=True)
                # Check if it has pixel data (skip DICOMDIR, etc.)
                if hasattr(dcm, 'Rows') and hasattr(dcm, 'Columns'):
                    self.dicom_files.append(f)
            except Exception:
                continue
        
        if not self.dicom_files:
            raise ValueError(f"No valid DICOM files found in {self.dicom_dir}")
        
        self._scanned = True
        print(f"Found {len(self.dicom_files)} DICOM files")
        
        return self
    
    def _ensure_scanned(self):
        """Ensure files have been scanned."""
        if not self._scanned:
            self.scan_files()
    
    # =========================================================================
    # METADATA EXTRACTION
    # =========================================================================
    
    def extract_metadata(self, dcm=None) -> DICOMMetadata:
        """
        Extract metadata from a DICOM dataset.
        
        Args:
            dcm: pydicom Dataset. If None, reads first file.
            
        Returns:
            DICOMMetadata object
        """
        self._ensure_scanned()
        
        if dcm is None:
            dcm = pydicom.dcmread(str(self.dicom_files[0]), stop_before_pixels=True)
        
        self.metadata = DICOMMetadata.from_pydicom(dcm)
        return self.metadata
    
    def get_series_info(self) -> Dict:
        """
        Get quick summary of the series.
        
        Returns:
            Dictionary with key series information
        """
        self._ensure_scanned()
        
        if self.metadata is None:
            self.extract_metadata()
        
        return {
            'patient_id': self.metadata.patient_id,
            'series_uid': self.metadata.series_uid,
            'series_description': self.metadata.series_description,
            'patient_position': self.metadata.patient_position,
            'position': self.metadata.position_string,
            'num_files': len(self.dicom_files),
            'dimensions': (self.metadata.rows, self.metadata.columns),
            'pixel_spacing': self.metadata.pixel_spacing,
            'slice_thickness': self.metadata.slice_thickness,
            'manufacturer': self.metadata.manufacturer,
            'model': self.metadata.manufacturer_model,
        }
    
    # =========================================================================
    # SLICE SORTING
    # =========================================================================
    
    def sort_slices(self) -> 'DICOMProcessor':
        """
        Read all slice headers and sort by z-position.
        
        Returns:
            self (for method chaining)
        """
        self._ensure_scanned()
        
        self.slice_data = []
        
        for filepath in self.dicom_files:
            try:
                dcm = pydicom.dcmread(str(filepath), stop_before_pixels=True)
                
                # Get z-position for sorting (try multiple methods)
                z_pos = self._get_z_position(dcm)
                
                self.slice_data.append({
                    'filepath': filepath,
                    'z_position': z_pos,
                    'instance_number': getattr(dcm, 'InstanceNumber', 0),
                    'dcm': dcm,
                })
            except Exception as e:
                warnings.warn(f"Could not read {filepath}: {e}")
                continue
        
        if not self.slice_data:
            raise ValueError("No valid slices found")
        
        # Sort by z-position
        self.slice_data.sort(key=lambda x: x['z_position'])
        
        # Calculate actual slice spacing
        if len(self.slice_data) > 1:
            z_positions = [s['z_position'] for s in self.slice_data]
            spacings = [z_positions[i+1] - z_positions[i] for i in range(len(z_positions)-1)]
            self.actual_slice_spacing = float(np.median(spacings))
        else:
            self.actual_slice_spacing = self.metadata.slice_thickness if self.metadata else 1.0
        
        self._sorted = True
        print(f"Sorted {len(self.slice_data)} slices (spacing: {self.actual_slice_spacing:.3f} mm)")
        
        return self
    
    def _get_z_position(self, dcm) -> float:
        """
        Get z-position from DICOM header for slice ordering.
        
        Priority:
            1. ImagePositionPatient[2]
            2. SliceLocation
            3. InstanceNumber
        """
        # Try ImagePositionPatient (most reliable)
        if hasattr(dcm, 'ImagePositionPatient') and dcm.ImagePositionPatient:
            return float(dcm.ImagePositionPatient[2])
        
        # Try SliceLocation
        if hasattr(dcm, 'SliceLocation') and dcm.SliceLocation is not None:
            return float(dcm.SliceLocation)
        
        # Fallback to InstanceNumber
        return float(getattr(dcm, 'InstanceNumber', 0))
    
    def _ensure_sorted(self):
        """Ensure slices have been sorted."""
        if not self._sorted:
            self.sort_slices()
    
    # =========================================================================
    # VOLUME BUILDING
    # =========================================================================
    
    def build_volume(self, dtype: np.dtype = np.int16) -> np.ndarray:
        """
        Build 3D volume from sorted slices.
        
        Args:
            dtype: Output data type (default int16 for HU values)
            
        Returns:
            3D numpy array in Hounsfield Units, shape (slices, height, width)
        """
        self._ensure_sorted()
        
        if self.metadata is None:
            self.extract_metadata(self.slice_data[0]['dcm'])
        
        # Initialize volume
        num_slices = len(self.slice_data)
        rows = self.metadata.rows
        cols = self.metadata.columns
        
        volume = np.zeros((num_slices, rows, cols), dtype=dtype)
        
        print(f"Building volume: {num_slices} x {rows} x {cols}")
        
        for i, slice_info in enumerate(self.slice_data):
            # Load pixel data
            dcm = pydicom.dcmread(str(slice_info['filepath']))
            
            # Get rescale parameters (may vary per slice)
            intercept = float(getattr(dcm, 'RescaleIntercept', 0))
            slope = float(getattr(dcm, 'RescaleSlope', 1))
            
            # Convert to Hounsfield Units
            volume[i] = dcm.pixel_array * slope + intercept
        
        # Update metadata
        self.metadata.num_slices = num_slices
        self.metadata.actual_slice_spacing = self.actual_slice_spacing
        
        return volume
    
    def load_volume(self) -> Tuple[np.ndarray, DICOMMetadata]:
        """
        Load DICOM series as 3D volume with metadata.
        
        This is the main entry point - it handles scanning, sorting, 
        and building the volume in one call.
        
        Returns:
            volume: 3D numpy array in Hounsfield Units (slices, height, width)
            metadata: DICOMMetadata object
            
        Example:
            processor = DICOMProcessor("path/to/dicom")
            volume, meta = processor.load_volume()
            
            print(f"Shape: {volume.shape}")
            print(f"Spacing (z,y,x): {meta.spacing_3d}")
        """
        self.scan_files()
        self.sort_slices()
        self.extract_metadata(self.slice_data[0]['dcm'])
        volume = self.build_volume()
        
        return volume, self.metadata
    
    # =========================================================================
    # VALIDATION
    # =========================================================================
    
    def validate(self) -> Dict[str, Any]:
        """
        Validate the DICOM series for common issues.
        
        Returns:
            Dictionary with validation results
        """
        self._ensure_sorted()
        
        results = {
            'valid': True,
            'warnings': [],
            'errors': [],
            'info': {},
        }
        
        # Check slice count
        num_slices = len(self.slice_data)
        results['info']['num_slices'] = num_slices
        
        if num_slices < 50:
            results['warnings'].append(f"Low slice count: {num_slices} (expected >50 for CT)")
        
        # Check for consistent dimensions
        dimensions = set()
        for slice_info in self.slice_data:
            dcm = slice_info['dcm']
            dimensions.add((dcm.Rows, dcm.Columns))
        
        if len(dimensions) > 1:
            results['errors'].append(f"Inconsistent dimensions: {dimensions}")
            results['valid'] = False
        
        results['info']['dimensions'] = list(dimensions)[0] if dimensions else None
        
        # Check slice spacing consistency
        z_positions = [s['z_position'] for s in self.slice_data]
        spacings = [z_positions[i+1] - z_positions[i] for i in range(len(z_positions)-1)]
        
        if spacings:
            spacing_std = np.std(spacings)
            spacing_mean = np.mean(spacings)
            
            results['info']['slice_spacing_mean'] = spacing_mean
            results['info']['slice_spacing_std'] = spacing_std
            
            if spacing_std > 0.1 * spacing_mean:  # >10% variation
                results['warnings'].append(
                    f"Variable slice spacing: mean={spacing_mean:.3f}, std={spacing_std:.3f}"
                )
        
        # Check for missing slices (gaps)
        if spacings:
            median_spacing = np.median(spacings)
            gaps = [i for i, s in enumerate(spacings) if s > 1.5 * median_spacing]
            
            if gaps:
                results['warnings'].append(f"Possible missing slices at positions: {gaps}")
        
        # Check patient position
        if self.metadata:
            if not self.metadata.is_prone and not self.metadata.is_supine:
                results['warnings'].append("Could not determine patient position (prone/supine)")
        
        # Check for scout vs CT
        if self.metadata and num_slices < 10:
            results['warnings'].append("Very few slices - may be scout/localizer, not CT volume")
        
        return results
    
    # =========================================================================
    # UTILITIES
    # =========================================================================
    
    def get_slice_positions(self) -> List[float]:
        """Get z-positions of all slices."""
        self._ensure_sorted()
        return [s['z_position'] for s in self.slice_data]
    
    def get_slice(self, index: int) -> Tuple[np.ndarray, Dict]:
        """
        Load a single slice.
        
        Args:
            index: Slice index (0-based, after sorting)
            
        Returns:
            pixel_array: 2D numpy array in HU
            slice_info: Dictionary with slice metadata
        """
        self._ensure_sorted()
        
        if index < 0 or index >= len(self.slice_data):
            raise IndexError(f"Slice index {index} out of range (0-{len(self.slice_data)-1})")
        
        slice_info = self.slice_data[index]
        dcm = pydicom.dcmread(str(slice_info['filepath']))
        
        # Convert to HU
        intercept = float(getattr(dcm, 'RescaleIntercept', 0))
        slope = float(getattr(dcm, 'RescaleSlope', 1))
        pixel_array = dcm.pixel_array * slope + intercept
        
        return pixel_array, {
            'z_position': slice_info['z_position'],
            'instance_number': slice_info['instance_number'],
            'filepath': str(slice_info['filepath']),
        }
    
    def save_volume(
        self, 
        output_path: str, 
        volume: np.ndarray = None,
        save_metadata: bool = True,
    ):
        """
        Save volume and metadata to disk.
        
        Args:
            output_path: Path for .npy file (metadata saved as .json)
            volume: Volume to save. If None, builds it first.
            save_metadata: Whether to save metadata JSON alongside
        """
        if volume is None:
            volume, _ = self.load_volume()
        
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Save volume
        np.save(str(output_path), volume)
        print(f"Saved volume to {output_path}")
        
        # Save metadata
        if save_metadata and self.metadata:
            meta_path = output_path.with_suffix('.json')
            self.metadata.save_json(str(meta_path))
            print(f"Saved metadata to {meta_path}")
    
    def __repr__(self) -> str:
        status = []
        if self._scanned:
            status.append(f"{len(self.dicom_files)} files")
        if self._sorted:
            status.append(f"{len(self.slice_data)} slices")
        if self.metadata:
            status.append(self.metadata.position_string)
        
        return f"DICOMProcessor({self.dicom_dir.name}, {', '.join(status) or 'not loaded'})"
    
    def __len__(self) -> int:
        """Return number of slices."""
        if self._sorted:
            return len(self.slice_data)
        elif self._scanned:
            return len(self.dicom_files)
        return 0
