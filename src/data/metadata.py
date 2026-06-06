from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Tuple



@dataclass
class DICOMMetadata:
    """
    Relevant DICOM metadata extracted from CT Colonography images.
    
    This stores only the fields needed for preprocessing and analysis,
    not the full DICOM header.
    
    Critical fields:
        - For slice ordering: image_position, slice_location, image_orientation
        - For HU conversion: rescale_intercept, rescale_slope
        - For resampling: pixel_spacing, slice_thickness
        
    Usage:
        meta = DICOMMetadata.from_pydicom(dcm)
        hu_volume = pixel_array * meta.rescale_slope + meta.rescale_intercept
    """
    
    # ===== Identifiers =====
    patient_id: str = ""
    series_uid: str = ""
    study_uid: str = ""
    sop_instance_uid: str = ""  # Unique per image
    
    # ===== Series Info =====
    series_description: str = ""
    study_description: str = ""
    series_number: int = 0
    modality: str = "CT"
    body_part_examined: str = ""  # e.g., "COLON"
    protocol_name: str = ""  # e.g., "24ACRIN_Colo_IRB2415-04"
    
    # ===== Patient Info =====
    patient_sex: str = ""
    patient_age: str = ""  # e.g., "059Y"
    patient_position: str = ""  # e.g., "FFS" (Feet First Supine), "FFP" (Feet First Prone)
    
    # ===== Geometry (CRITICAL for preprocessing) =====
    rows: int = 512
    columns: int = 512
    pixel_spacing: Tuple[float, float] = (1.0, 1.0)  # (row_spacing, col_spacing) in mm
    slice_thickness: float = 1.0  # mm
    reconstruction_diameter: float = 0.0  # mm, field of view
    
    # For slice ordering and 3D orientation
    image_position: Tuple[float, float, float] = (0.0, 0.0, 0.0)  # (x, y, z) in mm
    image_orientation: Tuple[float, ...] = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)  # Row and column direction cosines
    slice_location: float = 0.0
    instance_number: int = 0
    
    # ===== Intensity (CRITICAL for HU conversion) =====
    rescale_intercept: float = -1024.0
    rescale_slope: float = 1.0
    
    # ===== Display Settings =====
    window_center: float = 40.0
    window_width: float = 400.0
    
    # ===== Scanner Info =====
    manufacturer: str = ""
    manufacturer_model: str = ""
    convolution_kernel: str = ""  # e.g., "T20s"
    kvp: float = 120.0  # X-ray tube voltage
    distance_source_to_patient: float = 0.0  # mm
    
    # ===== Study Info =====
    study_date: str = ""
    
    # ===== Additional useful fields =====
    image_comments: str = ""  # Often contains position info like "supine"
    
    # ===== Computed after loading volume =====
    num_slices: int = 0
    actual_slice_spacing: float = 0.0
    
    @classmethod
    def from_pydicom(cls, dcm) -> 'DICOMMetadata':
        """
        Create DICOMMetadata from a pydicom Dataset.
        
        Args:
            dcm: pydicom.Dataset object
            
        Returns:
            DICOMMetadata with extracted values
        """
        def get_str(attr: str, default: str = "") -> str:
            val = getattr(dcm, attr, default)
            return str(val).strip() if val else default
        
        def get_float(attr: str, default: float = 0.0) -> float:
            val = getattr(dcm, attr, default)
            if hasattr(val, '__iter__') and not isinstance(val, str):
                return float(list(val)[0]) if val else default
            return float(val) if val else default
        
        def get_int(attr: str, default: int = 0) -> int:
            val = getattr(dcm, attr, default)
            return int(val) if val else default
        
        # Parse pixel spacing (row, col)
        ps = getattr(dcm, 'PixelSpacing', [1.0, 1.0])
        pixel_spacing = (float(ps[0]), float(ps[1])) if ps else (1.0, 1.0)
        
        # Parse image position (x, y, z)
        ipp = getattr(dcm, 'ImagePositionPatient', [0.0, 0.0, 0.0])
        image_position = tuple(float(x) for x in ipp) if ipp else (0.0, 0.0, 0.0)
        
        # Parse image orientation (6 direction cosines)
        iop = getattr(dcm, 'ImageOrientationPatient', [1.0, 0.0, 0.0, 0.0, 1.0, 0.0])
        image_orientation = tuple(float(x) for x in iop) if iop else (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
        
        return cls(
            # Identifiers
            patient_id=get_str('PatientID'),
            series_uid=get_str('SeriesInstanceUID'),
            study_uid=get_str('StudyInstanceUID'),
            sop_instance_uid=get_str('SOPInstanceUID'),
            
            # Series Info
            series_description=get_str('SeriesDescription'),
            study_description=get_str('StudyDescription'),
            series_number=get_int('SeriesNumber'),
            modality=get_str('Modality', 'CT'),
            body_part_examined=get_str('BodyPartExamined'),
            protocol_name=get_str('ProtocolName'),
            
            # Patient Info
            patient_sex=get_str('PatientSex'),
            patient_age=get_str('PatientAge'),
            patient_position=get_str('PatientPosition'),
            
            # Geometry
            rows=get_int('Rows', 512),
            columns=get_int('Columns', 512),
            pixel_spacing=pixel_spacing,
            slice_thickness=get_float('SliceThickness', 1.0),
            reconstruction_diameter=get_float('ReconstructionDiameter'),
            image_position=image_position,
            image_orientation=image_orientation,
            slice_location=get_float('SliceLocation'),
            instance_number=get_int('InstanceNumber'),
            
            # Intensity
            rescale_intercept=get_float('RescaleIntercept', -1024.0),
            rescale_slope=get_float('RescaleSlope', 1.0),
            
            # Display
            window_center=get_float('WindowCenter', 40.0),
            window_width=get_float('WindowWidth', 400.0),
            
            # Scanner
            manufacturer=get_str('Manufacturer'),
            manufacturer_model=get_str('ManufacturerModelName'),
            convolution_kernel=get_str('ConvolutionKernel'),
            kvp=get_float('KVP', 120.0),
            distance_source_to_patient=get_float('DistanceSourceToPatient'),
            
            # Study
            study_date=get_str('StudyDate'),
            
            # Additional
            image_comments=get_str('ImageComments'),
        )
    
    @classmethod
    def from_dict(cls, d: dict) -> 'DICOMMetadata':
        """
        Create DICOMMetadata from a dictionary (e.g., from NIfTI metadata).
        
        This is the inverse of the metadata saved in save_as_nifti().
        
        Args:
            d: Dictionary with metadata keys (e.g., from load_nifti_with_metadata())
            
        Returns:
            DICOMMetadata object
            
        Example:
            volume, meta_dict, affine = load_nifti_with_metadata('scan.nii.gz')
            metadata = DICOMMetadata.from_dict(meta_dict)
            metadata.visualize()
        """
        # Helper to safely get values with type conversion
        def get(key: str, default=None):
            return d.get(key, default)
        
        def get_tuple(key: str, default: tuple) -> tuple:
            val = d.get(key)
            if val is None:
                return default
            return tuple(val) if isinstance(val, (list, tuple)) else default
        
        return cls(
            # Identifiers
            patient_id=get('PatientID', ''),
            series_uid=get('SeriesUID', ''),
            study_uid=get('StudyUID', ''),
            sop_instance_uid=get('SOPInstanceUID', ''),
            
            # Series Info
            series_description=get('SeriesDescription', ''),
            study_description=get('StudyDescription', ''),
            series_number=get('SeriesNumber', 0),
            modality=get('Modality', 'CT'),
            body_part_examined=get('BodyPartExamined', ''),
            protocol_name=get('ProtocolName', ''),
            
            # Patient Info
            patient_sex=get('PatientSex', ''),
            patient_age=get('PatientAge', ''),
            patient_position=get('PatientPosition', ''),
            
            # Geometry
            rows=get('Rows', 512),
            columns=get('Columns', 512),
            pixel_spacing=get_tuple('PixelSpacing', (1.0, 1.0)),
            slice_thickness=get('SliceThickness', 1.0),
            reconstruction_diameter=get('ReconstructionDiameter', 0.0),
            image_position=get_tuple('ImagePositionPatient', (0.0, 0.0, 0.0)),
            image_orientation=get_tuple('ImageOrientationPatient', (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)),
            slice_location=get('SliceLocation', 0.0),
            instance_number=get('InstanceNumber', 0),
            
            # Computed geometry (from NIfTI)
            num_slices=get('NumberOfSlices', 0),
            actual_slice_spacing=get('ActualSliceSpacing', 0.0),
            
            # Intensity
            rescale_intercept=get('RescaleIntercept', -1024.0),
            rescale_slope=get('RescaleSlope', 1.0),
            window_center=get('WindowCenter', 40.0),
            window_width=get('WindowWidth', 400.0),
            
            # Scanner
            manufacturer=get('Manufacturer', ''),
            manufacturer_model=get('ManufacturerModel', ''),
            convolution_kernel=get('ConvolutionKernel', ''),
            kvp=get('KVP', 120.0),
            distance_source_to_patient=get('DistanceSourceToPatient', 0.0),
            
            # Study
            study_date=get('StudyDate', ''),
            
            # Additional
            image_comments=get('ImageComments', ''),
        )
    
    @property
    def z_position(self) -> float:
        """Get Z position for slice ordering."""
        return self.image_position[2] if self.image_position else self.slice_location
    
    @property
    def spacing_3d(self) -> Tuple[float, float, float]:
        """Get 3D spacing as (z, y, x) in mm."""
        z_spacing = self.actual_slice_spacing if self.actual_slice_spacing > 0 else self.slice_thickness
        return (z_spacing, self.pixel_spacing[0], self.pixel_spacing[1])
    
    @property
    def is_prone(self) -> bool:
        """Check if patient position is prone (face down)."""
        # Check PatientPosition tag (FFS, FFP, HFS, HFP)
        pos = self.patient_position.upper()
        if pos.endswith('P'):  # FFP, HFP
            return True
        # Also check ImageComments and SeriesDescription
        comments = (self.image_comments + " " + self.series_description).lower()
        return 'prone' in comments
    
    @property
    def is_supine(self) -> bool:
        """Check if patient position is supine (face up)."""
        # Check PatientPosition tag
        pos = self.patient_position.upper()
        if pos.endswith('S'):  # FFS, HFS
            return True
        # Also check ImageComments and SeriesDescription
        comments = (self.image_comments + " " + self.series_description).lower()
        return 'supine' in comments
    
    @property
    def position_string(self) -> str:
        """Get position as human-readable string."""
        if self.is_prone:
            return "prone"
        elif self.is_supine:
            return "supine"
        return "unknown"
    
    @property
    def row_direction(self) -> Tuple[float, float, float]:
        """Get row direction cosine (first 3 values of ImageOrientationPatient)."""
        return self.image_orientation[:3]
    
    @property
    def column_direction(self) -> Tuple[float, float, float]:
        """Get column direction cosine (last 3 values of ImageOrientationPatient)."""
        return self.image_orientation[3:6]
    
    @property
    def is_standard_axial(self) -> bool:
        """Check if image has standard axial orientation."""
        # Standard axial: row along X, column along Y
        # ImageOrientation ≈ [1, 0, 0, 0, 1, 0]
        row = self.row_direction
        col = self.column_direction
        tolerance = 0.1
        return (
            abs(row[0] - 1.0) < tolerance and 
            abs(row[1]) < tolerance and
            abs(col[1] - 1.0) < tolerance
        )
    
    @property
    def field_of_view(self) -> float:
        """Get field of view in mm."""
        if self.reconstruction_diameter > 0:
            return self.reconstruction_diameter
        # Estimate from pixel spacing and columns
        return self.pixel_spacing[1] * self.columns
    
    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            # Identifiers
            'patient_id': self.patient_id,
            'series_uid': self.series_uid,
            'study_uid': self.study_uid,
            
            # Series Info
            'series_description': self.series_description,
            'study_description': self.study_description,
            'body_part_examined': self.body_part_examined,
            'protocol_name': self.protocol_name,
            
            # Patient
            'patient_sex': self.patient_sex,
            'patient_age': self.patient_age,
            'patient_position': self.patient_position,
            
            # Geometry
            'rows': self.rows,
            'columns': self.columns,
            'num_slices': self.num_slices,
            'pixel_spacing': list(self.pixel_spacing),
            'slice_thickness': self.slice_thickness,
            'actual_slice_spacing': self.actual_slice_spacing,
            'reconstruction_diameter': self.reconstruction_diameter,
            'image_orientation': list(self.image_orientation),
            
            # Intensity
            'rescale_intercept': self.rescale_intercept,
            'rescale_slope': self.rescale_slope,
            
            # Display
            'window_center': self.window_center,
            'window_width': self.window_width,
            
            # Scanner
            'manufacturer': self.manufacturer,
            'manufacturer_model': self.manufacturer_model,
            'convolution_kernel': self.convolution_kernel,
            'kvp': self.kvp,
            
            # Computed properties
            'spacing_3d': list(self.spacing_3d),
            'is_prone': self.is_prone,
            'is_supine': self.is_supine,
            'field_of_view': self.field_of_view,
        }
    
    def save_json(self, filepath: str):
        """Save metadata to JSON file."""
        import json
        with open(filepath, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)
    
    @classmethod
    def from_json(cls, filepath: str) -> 'DICOMMetadata':
        """Load metadata from JSON file."""
        import json
        with open(filepath, 'r') as f:
            data = json.load(f)
        
        return cls(
            patient_id=data.get('patient_id', ''),
            series_uid=data.get('series_uid', ''),
            study_uid=data.get('study_uid', ''),
            series_description=data.get('series_description', ''),
            study_description=data.get('study_description', ''),
            body_part_examined=data.get('body_part_examined', ''),
            protocol_name=data.get('protocol_name', ''),
            patient_sex=data.get('patient_sex', ''),
            patient_age=data.get('patient_age', ''),
            patient_position=data.get('patient_position', ''),
            rows=data.get('rows', 512),
            columns=data.get('columns', 512),
            num_slices=data.get('num_slices', 0),
            pixel_spacing=tuple(data.get('pixel_spacing', [1.0, 1.0])),
            slice_thickness=data.get('slice_thickness', 1.0),
            actual_slice_spacing=data.get('actual_slice_spacing', 0.0),
            reconstruction_diameter=data.get('reconstruction_diameter', 0.0),
            image_orientation=tuple(data.get('image_orientation', [1, 0, 0, 0, 1, 0])),
            rescale_intercept=data.get('rescale_intercept', -1024.0),
            rescale_slope=data.get('rescale_slope', 1.0),
            window_center=data.get('window_center', 40.0),
            window_width=data.get('window_width', 400.0),
            manufacturer=data.get('manufacturer', ''),
            manufacturer_model=data.get('manufacturer_model', ''),
            convolution_kernel=data.get('convolution_kernel', ''),
            kvp=data.get('kvp', 120.0),
        )
    def visualize(self, use_color: bool = True, show_all: bool = False):
        """
        Print a nicely formatted summary of the metadata.
        
        Args:
            use_color: Use ANSI colors for terminal output
            show_all: Show all fields including empty ones
        """
        print(self._format_summary(use_color=use_color, show_all=show_all))
    
    def summary(self, use_color: bool = False, show_all: bool = False) -> str:
        """
        Return a formatted string summary of the metadata.
        
        Args:
            use_color: Use ANSI colors
            show_all: Show all fields including empty ones
            
        Returns:
            Formatted string
        """
        return self._format_summary(use_color=use_color, show_all=show_all)
    
    def _format_summary(self, use_color: bool = True, show_all: bool = False) -> str:
        """Generate formatted summary string."""
        
        # ANSI color codes
        if use_color:
            BOLD = "\033[1m"
            CYAN = "\033[96m"
            GREEN = "\033[92m"
            YELLOW = "\033[93m"
            RED = "\033[91m"
            MAGENTA = "\033[95m"
            BLUE = "\033[94m"
            DIM = "\033[2m"
            RESET = "\033[0m"
        else:
            BOLD = CYAN = GREEN = YELLOW = RED = MAGENTA = BLUE = DIM = RESET = ""
        
        lines = []
        
        # Header
        width = 60
        lines.append(f"{CYAN}{'═' * width}{RESET}")
        lines.append(f"{CYAN}║{RESET} {BOLD}DICOM METADATA{RESET}".ljust(width + len(BOLD) + len(RESET) + len(CYAN) + len(RESET) + 1))
        lines.append(f"{CYAN}{'═' * width}{RESET}")
        
        def add_section(title: str, color: str):
            lines.append("")
            lines.append(f"{color}{BOLD}┌─ {title} {'─' * (width - len(title) - 5)}┐{RESET}")
        
        def add_field(label: str, value, unit: str = "", critical: bool = False):
            # Skip empty values unless show_all
            if not show_all and (value == "" or value == 0 or value == 0.0):
                if not critical:
                    return
            
            # Format value
            if isinstance(value, float):
                if value == int(value):
                    val_str = f"{int(value)}"
                else:
                    val_str = f"{value:.4f}".rstrip('0').rstrip('.')
            elif isinstance(value, tuple):
                val_str = ", ".join(f"{v:.3f}" if isinstance(v, float) else str(v) for v in value)
                val_str = f"({val_str})"
            else:
                val_str = str(value)
            
            # Add unit
            if unit:
                val_str = f"{val_str} {DIM}{unit}{RESET}"
            
            # Format line
            label_width = 26
            marker = f"{RED}●{RESET}" if critical else " "
            lines.append(f"  {marker} {label:<{label_width}} {val_str}")
        
        def add_computed(label: str, value, unit: str = ""):
            """Add computed property with special styling."""
            if isinstance(value, float):
                val_str = f"{value:.3f}".rstrip('0').rstrip('.')
            elif isinstance(value, tuple):
                val_str = ", ".join(f"{v:.3f}" if isinstance(v, float) else str(v) for v in value)
                val_str = f"({val_str})"
            elif isinstance(value, bool):
                val_str = f"{GREEN}Yes{RESET}" if value else f"{DIM}No{RESET}"
            else:
                val_str = str(value)
            
            if unit:
                val_str = f"{val_str} {DIM}{unit}{RESET}"
            
            label_width = 26
            lines.append(f"    {MAGENTA}→{RESET} {label:<{label_width}} {val_str}")
        
        # ===== PATIENT & STUDY =====
        add_section("PATIENT & STUDY", BLUE)
        add_field("Patient ID", self.patient_id)
        add_field("Patient Sex", self._format_sex())
        add_field("Patient Age", self._format_age())
        add_field("Study Date", self._format_date())
        add_field("Study Description", self.study_description)
        
        # ===== SERIES =====
        add_section("SERIES", BLUE)
        add_field("Series UID", self._truncate_uid(self.series_uid))
        add_field("Series Description", self.series_description)
        add_field("Series Number", self.series_number)
        add_field("Modality", self.modality)
        add_field("Body Part", self.body_part_examined)
        add_field("Protocol", self.protocol_name)
        
        # ===== POSITION =====
        add_section("PATIENT POSITION", GREEN)
        add_field("Position Code", self.patient_position, critical=True)
        add_field("Image Comments", self.image_comments)
        add_computed("Is Prone", self.is_prone)
        add_computed("Is Supine", self.is_supine)
        add_computed("Position", self.position_string.upper())
        
        # ===== GEOMETRY (CRITICAL) =====
        add_section("GEOMETRY (CRITICAL)", RED)
        add_field("Dimensions", f"{self.columns} × {self.rows}", "pixels", critical=True)
        add_field("Number of Slices", self.num_slices, "", critical=True)
        add_field("Pixel Spacing", self.pixel_spacing, "mm", critical=True)
        add_field("Slice Thickness", self.slice_thickness, "mm", critical=True)
        add_field("Actual Slice Spacing", self.actual_slice_spacing, "mm", critical=True)
        add_computed("Spacing (Z, Y, X)", self.spacing_3d, "mm")
        add_field("Reconstruction Diameter", self.reconstruction_diameter, "mm")
        add_computed("Field of View", self.field_of_view, "mm")
        
        # ===== ORIENTATION =====
        add_section("ORIENTATION", YELLOW)
        add_field("Image Position", self.image_position, "mm", critical=True)
        add_field("Image Orientation", self._format_orientation(), "", critical=True)
        add_field("Slice Location", self.slice_location, "mm")
        add_computed("Is Standard Axial", self.is_standard_axial)
        add_computed("Row Direction", self.row_direction)
        add_computed("Column Direction", self.column_direction)
        
        # ===== INTENSITY (CRITICAL) =====
        add_section("INTENSITY (CRITICAL)", RED)
        add_field("Rescale Intercept", self.rescale_intercept, "HU", critical=True)
        add_field("Rescale Slope", self.rescale_slope, "", critical=True)
        add_field("Window Center", self.window_center, "HU")
        add_field("Window Width", self.window_width, "HU")
        
        # ===== SCANNER =====
        add_section("SCANNER", MAGENTA)
        add_field("Manufacturer", self.manufacturer)
        add_field("Model", self.manufacturer_model)
        add_field("Convolution Kernel", self.convolution_kernel)
        add_field("kVp", self.kvp, "kV")
        add_field("Source-Patient Distance", self.distance_source_to_patient, "mm")
        
        # Footer
        lines.append("")
        lines.append(f"{CYAN}{'═' * width}{RESET}")
        lines.append(f"  {RED}●{RESET} = Critical field for preprocessing")
        lines.append(f"  {MAGENTA}→{RESET} = Computed property")
        lines.append(f"{CYAN}{'═' * width}{RESET}")
        
        return "\n".join(lines)
    
    def _repr_html_(self) -> str:
        """
        HTML representation for Jupyter notebooks.
        
        Returns nicely formatted HTML table.
        """
        def format_value(value):
            if isinstance(value, float):
                return f"{value:.4f}".rstrip('0').rstrip('.')
            elif isinstance(value, tuple):
                return "(" + ", ".join(f"{v:.3f}" if isinstance(v, float) else str(v) for v in value) + ")"
            elif isinstance(value, bool):
                return "✓ Yes" if value else "✗ No"
            return str(value) if value else "—"
        
        html = """
        <style>
            .dicom-meta { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; }
            .dicom-meta table { border-collapse: collapse; width: 100%; max-width: 700px; }
            .dicom-meta th { background: #2d3748; color: white; padding: 8px 12px; text-align: left; }
            .dicom-meta td { padding: 6px 12px; border-bottom: 1px solid #e2e8f0; }
            .dicom-meta tr:hover { background: #f7fafc; }
            .dicom-meta .section { background: #edf2f7; font-weight: 600; color: #2d3748; }
            .dicom-meta .critical { background: #fff5f5; }
            .dicom-meta .critical td:first-child::before { content: "● "; color: #e53e3e; }
            .dicom-meta .computed { color: #805ad5; font-style: italic; }
            .dicom-meta .computed td:first-child::before { content: "→ "; }
            .dicom-meta .value { font-family: 'Consolas', monospace; }
            .dicom-meta .unit { color: #718096; font-size: 11px; }
            .dicom-meta .bool-yes { color: #38a169; }
            .dicom-meta .bool-no { color: #a0aec0; }
        </style>
        <div class="dicom-meta">
        <table>
        <tr><th colspan="3">📋 DICOM Metadata</th></tr>
        """
        
        sections = [
            ("👤 Patient & Study", [
                ("Patient ID", self.patient_id, ""),
                ("Patient Sex", self._format_sex(), ""),
                ("Patient Age", self._format_age(), ""),
                ("Study Date", self._format_date(), ""),
                ("Study Description", self.study_description, ""),
            ], False),
            
            ("📁 Series", [
                ("Series UID", self._truncate_uid(self.series_uid), ""),
                ("Series Description", self.series_description, ""),
                ("Modality", self.modality, ""),
                ("Body Part", self.body_part_examined, ""),
                ("Protocol", self.protocol_name, ""),
            ], False),
            
            ("🧭 Position", [
                ("Position Code", self.patient_position, "", True),
                ("Is Prone", self.is_prone, "", False, True),
                ("Is Supine", self.is_supine, "", False, True),
                ("Position", self.position_string.upper(), "", False, True),
            ], False),
            
            ("📐 Geometry", [
                ("Dimensions", f"{self.columns} × {self.rows}", "pixels", True),
                ("Number of Slices", self.num_slices, "", True),
                ("Pixel Spacing", format_value(self.pixel_spacing), "mm", True),
                ("Slice Thickness", self.slice_thickness, "mm", True),
                ("Actual Slice Spacing", self.actual_slice_spacing, "mm", True),
                ("Spacing (Z,Y,X)", format_value(self.spacing_3d), "mm", False, True),
                ("Field of View", f"{self.field_of_view:.1f}", "mm", False, True),
            ], False),
            
            ("🔄 Orientation", [
                ("Image Position", format_value(self.image_position), "mm", True),
                ("Image Orientation", self._format_orientation(), "", True),
                ("Is Standard Axial", self.is_standard_axial, "", False, True),
            ], False),
            
            ("💡 Intensity", [
                ("Rescale Intercept", self.rescale_intercept, "HU", True),
                ("Rescale Slope", self.rescale_slope, "", True),
                ("Window Center", self.window_center, "HU"),
                ("Window Width", self.window_width, "HU"),
            ], False),
            
            ("🔬 Scanner", [
                ("Manufacturer", self.manufacturer, ""),
                ("Model", self.manufacturer_model, ""),
                ("Convolution Kernel", self.convolution_kernel, ""),
                ("kVp", self.kvp, "kV"),
            ], False),
        ]
        
        for section_name, fields, _ in sections:
            html += f'<tr class="section"><td colspan="3">{section_name}</td></tr>'
            
            for field in fields:
                label = field[0]
                value = field[1]
                unit = field[2] if len(field) > 2 else ""
                is_critical = field[3] if len(field) > 3 else False
                is_computed = field[4] if len(field) > 4 else False
                
                row_class = []
                if is_critical:
                    row_class.append("critical")
                if is_computed:
                    row_class.append("computed")
                
                class_str = f' class="{" ".join(row_class)}"' if row_class else ""
                
                # Format boolean values
                if isinstance(value, bool):
                    val_html = f'<span class="bool-yes">✓ Yes</span>' if value else f'<span class="bool-no">✗ No</span>'
                else:
                    val_html = f'<span class="value">{format_value(value)}</span>'
                
                unit_html = f' <span class="unit">{unit}</span>' if unit else ""
                
                html += f'<tr{class_str}><td>{label}</td><td>{val_html}{unit_html}</td></tr>'
        
        html += """
        </table>
        <p style="font-size: 11px; color: #718096; margin-top: 8px;">
            <span style="color: #e53e3e;">●</span> Critical field &nbsp;&nbsp;
            <span style="color: #805ad5;">→</span> Computed property
        </p>
        </div>
        """
        
        return html
    
    def _format_sex(self) -> str:
        """Format patient sex for display."""
        sex_map = {'M': 'Male ♂', 'F': 'Female ♀', 'O': 'Other'}
        return sex_map.get(self.patient_sex.upper(), self.patient_sex or "Unknown")
    
    def _format_age(self) -> str:
        """Format patient age for display."""
        if not self.patient_age:
            return "Unknown"
        # DICOM age format: 059Y, 011M, 003W, 001D
        age = self.patient_age.strip()
        if age.endswith('Y'):
            return f"{int(age[:-1])} years"
        elif age.endswith('M'):
            return f"{int(age[:-1])} months"
        elif age.endswith('W'):
            return f"{int(age[:-1])} weeks"
        elif age.endswith('D'):
            return f"{int(age[:-1])} days"
        return age
    
    def _format_date(self) -> str:
        """Format study date for display."""
        if not self.study_date or len(self.study_date) != 8:
            return self.study_date or "Unknown"
        # DICOM date format: YYYYMMDD
        return f"{self.study_date[:4]}-{self.study_date[4:6]}-{self.study_date[6:8]}"
    
    def _format_orientation(self) -> str:
        """Format image orientation for display."""
        if not self.image_orientation:
            return "Unknown"
        row = self.image_orientation[:3]
        col = self.image_orientation[3:6]
        return f"Row:{self._direction_to_axis(row)} Col:{self._direction_to_axis(col)}"
    
    def _direction_to_axis(self, direction: Tuple[float, float, float]) -> str:
        """Convert direction cosine to axis label."""
        tolerance = 0.1
        if abs(direction[0]) > 1 - tolerance:
            return "+X" if direction[0] > 0 else "-X"
        elif abs(direction[1]) > 1 - tolerance:
            return "+Y" if direction[1] > 0 else "-Y"
        elif abs(direction[2]) > 1 - tolerance:
            return "+Z" if direction[2] > 0 else "-Z"
        return f"({direction[0]:.2f},{direction[1]:.2f},{direction[2]:.2f})"
    
    def _truncate_uid(self, uid: str, max_len: int = 40) -> str:
        """Truncate UID for display."""
        if len(uid) <= max_len:
            return uid
        return f"{uid[:15]}...{uid[-15:]}"
    
    def __repr__(self) -> str:
        """Concise string representation."""
        pos = self.position_string
        dims = f"{self.num_slices}×{self.rows}×{self.columns}" if self.num_slices else f"{self.rows}×{self.columns}"
        spacing = f"{self.spacing_3d[0]:.2f}×{self.spacing_3d[1]:.2f}×{self.spacing_3d[2]:.2f}mm"
        return f"DICOMMetadata(id={self.patient_id}, {pos}, {dims}, {spacing})"