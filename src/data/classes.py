
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Tuple


class ScanType(Enum):
    """Types of CT scans in the dataset."""
    SCOUT = "scout"          # Low-res planning images (skip for analysis)
    AXIAL_CT = "axial_ct"    # High-res 3D volumes (use for analysis)
    UNKNOWN = "unknown"


class PatientPosition(Enum):
    """Patient position during the scan."""
    PRONE = "prone"          # Face down
    SUPINE = "supine"        # Face up (on back)
    UNKNOWN = "unknown"


class ColonSegment(Enum):
    """Anatomical segments of the colon."""
    RECTUM = 1
    SIGMOID = 2
    DESCENDING = 3
    TRANSVERSE = 4
    ASCENDING = 5
    CECUM = 6


class Histology(Enum):
    """Polyp histology types."""
    ADENOCARCINOMA = 1
    MEDULLARY_CARCINOMA = 2
    MUCINOUS_CARCINOMA = 3
    SIGNET_RING_CELL = 4
    SQUAMOUS_CELL = 5
    ADENOSQUAMOUS = 6
    SMALL_CELL = 7
    UNDIFFERENTIATED = 8
    CARCINOMA_NOS = 9
    HYPERPLASTIC = 10           # Benign
    LIPOMATOUS = 11             # Benign
    ADENOMATOUS = 12            # Pre-cancerous
    TUBULAR_ADENOMA = 13        # Pre-cancerous
    TUBULOVILLOUS_ADENOMA = 14  # Pre-cancerous (higher risk)
    VILLOUS_ADENOMA = 15        # Pre-cancerous (higher risk)
    TUBULOVILLOUS_DYSPLASIA = 16  # Pre-cancerous (high risk)
    NORMAL_MUCOSA = 17          # Benign
    OTHER = 88
    NOT_APPLICABLE = 98


class PolypStatus(Enum):
    """Overall polyp status for a patient."""
    NEGATIVE = "negative"      # No polyps found
    MEDIUM = "6-9mm"          # Small to medium polyps
    LARGE = ">=10mm"          # Large polyps (clinically significant)


@dataclass
class Patient:
    """
    Represents a patient in the CT Colonography study.
    
    Attributes:
        patient_id: Full DICOM patient ID (e.g., "1.3.6.1.4.1.9328.50.4.0040")
        case_number: Extracted case number for matching with polyp spreadsheets
        polyp_status: Whether polyps were found and their size category
    """
    patient_id: str
    case_number: str = ""
    polyp_status: Optional[PolypStatus] = None
    
    def __post_init__(self):
        if not self.case_number:
            self.case_number = self._extract_case_number()
    
    def _extract_case_number(self) -> str:
        """Extract case number from patient ID."""
        if self.patient_id.startswith("CTC-"):
            return self.patient_id
        parts = self.patient_id.split(".")
        if parts:
            return parts[-1].lstrip("0") or "0"
        return self.patient_id

@dataclass
class Study:
    """
    Represents a CT imaging study (one session).
    """
    study_uid: str
    study_date: str
    study_description: str


@dataclass
class CTSeries:
    """
    Represents a series of CT images (one scan type/position).
    
    This is the main unit you'll work with - each series is either
    a scout image (skip) or an axial CT volume (use for segmentation).
    """
    series_uid: str
    series_description: str
    patient_id: str = ""
    manufacturer: str = ""
    model: str = ""
    num_images: int = 0
    file_path: str = ""  # Path to DICOM folder or processed volume
    
    # These are set automatically by ScanTypeClassifier
    scan_type: ScanType = field(default=ScanType.UNKNOWN)
    patient_position: PatientPosition = field(default=PatientPosition.UNKNOWN)
    
    def is_usable_for_analysis(self) -> bool:
        """Check if this series should be used for segmentation."""
        return (self.scan_type == ScanType.AXIAL_CT and 
                self.patient_position != PatientPosition.UNKNOWN)


@dataclass
class PolypAnnotation:
    """
    Represents a polyp/lesion annotation from the clinical study.
    """
    lesion_number: int
    segment: Optional[ColonSegment] = None
    size_mm: Optional[float] = None
    size_source: Optional[int] = None  # 1=Colonoscopy, 2=Pathology
    removed_in_pieces: Optional[bool] = None
    histology: Optional[Histology] = None
    slice_supine: str = ""
    slice_prone: str = ""
    
    @property
    def segment_name(self) -> str:
        return self.segment.name.title() if self.segment else "Unknown"
    
    @property
    def histology_name(self) -> str:
        return self.histology.name.replace("_", " ").title() if self.histology else "Unknown"
    
