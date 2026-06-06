import numpy as np

from data.metadata import DICOMMetadata

def slice_to_position(slice_idx: int, metadata: DICOMMetadata) -> float:
    """Convert slice index to physical Z position in mm."""
    z_start = metadata.image_position[2]
    spacing = metadata.actual_slice_spacing or metadata.slice_thickness
    return np.round(z_start + (slice_idx * spacing), 4)

def position_to_slice(z_position: float, metadata: DICOMMetadata) -> int:
    """Convert physical Z position (mm) to nearest slice index."""
    z_start = metadata.image_position[2]
    spacing = metadata.actual_slice_spacing or metadata.slice_thickness
    return round((z_position - z_start) / spacing)
