"""
DICOM Viewer
============

Comprehensive visualization tools for CT volumes with proper windowing,
orientation labels, and metadata overlay.

Classes:
    DICOMViewer: Main viewer class for CT volume visualization

Usage:
    from src.visualization import DICOMViewer
    from src.preprocessing import DICOMProcessor
    
    # Load volume
    processor = DICOMProcessor("path/to/dicom")
    volume, metadata = processor.load_volume()
    
    # Create viewer
    viewer = DICOMViewer(volume, metadata)
    
    # Visualize
    viewer.show_slice(100)
    viewer.show_orthogonal()
    viewer.show_montage(num_slices=16)
    viewer.browse()  # Interactive browser
"""

import numpy as np
from typing import Tuple, Optional, Union, List, Dict
from dataclasses import dataclass

import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyBboxPatch
from matplotlib.gridspec import GridSpec
from matplotlib.widgets import Slider, Button, RadioButtons
from ipywidgets import interact, IntSlider, Dropdown, FloatSlider
from matplotlib.colors import Normalize

from IPython.display import display, HTML
from ipywidgets import interact, IntSlider, Dropdown, FloatSlider, HBox, VBox, Output

from data.metadata import DICOMMetadata

# =============================================================================
# WINDOW PRESETS
# =============================================================================

WINDOW_PRESETS = {
    # (window_center, window_width)
    "soft_tissue": (40, 400),
    "lung": (-600, 1500),
    "bone": (400, 1800),
    "brain": (40, 80),
    "liver": (60, 150),
    "abdomen": (40, 350),
    "colon": (-400, 1500),      # Good for colon/air visualization
    "colon_soft": (50, 350),    # Colon soft tissue
    "mediastinum": (40, 400),
    "air": (-1000, 200),        # Air regions only
    "full_range": (-1024, 3071), # Full CT range
    "default": (40, 400),
}


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def apply_window(
    data: np.ndarray,
    window_center: float,
    window_width: float,
) -> np.ndarray:
    """
    Apply HU windowing to image data.
    
    Args:
        data: Image data in Hounsfield Units
        window_center: Center of window
        window_width: Width of window
        
    Returns:
        Windowed data scaled to [0, 1]
    """
    lower = window_center - window_width / 2
    upper = window_center + window_width / 2
    
    windowed = np.clip(data, lower, upper)
    normalized = (windowed - lower) / (upper - lower)
    
    return normalized.astype(np.float32)


def get_aspect_ratio(
    axis: int,
    spacing: Tuple[float, float, float],
) -> float:
    """
    Calculate aspect ratio for proper display.
    
    Args:
        axis: View axis (0=axial, 1=coronal, 2=sagittal)
        spacing: (z, y, x) spacing in mm
        
    Returns:
        Aspect ratio for imshow
    """
    sz, sy, sx = spacing
    
    if axis == 0:  # Axial (z): viewing y vs x
        return sy / sx
    elif axis == 1:  # Coronal (y): viewing z vs x
        return sz / sx
    else:  # Sagittal (x): viewing z vs y
        return sz / sy


# =============================================================================
# MAIN VIEWER CLASS
# =============================================================================

class DICOMViewer:
    """
    Comprehensive DICOM/CT volume viewer.
    
    Features:
        - HU windowing with presets
        - Orthogonal views (axial, coronal, sagittal)
        - Montage display
        - Interactive slice browser
        - Metadata overlay
        - Proper aspect ratio handling
    
    Example:
        viewer = DICOMViewer(volume, metadata)
        viewer.show_slice(100)
        viewer.show_orthogonal()
        viewer.browse()
    """
    
    def __init__(
        self,
        volume: np.ndarray,
        metadata: DICOMMetadata = None,
        spacing: Tuple[float, float, float] = None,
    ):
        """
        Initialize viewer.
        
        Args:
            volume: 3D numpy array (z, y, x) in Hounsfield Units
            metadata: DICOMMetadata object (optional)
            spacing: Manual spacing (z, y, x) in mm if no metadata
        """
 
        self.volume = volume
        self.metadata = metadata
        
        # Get spacing
        if metadata is not None:
            self.spacing = metadata.spacing_3d
            self.window_center = metadata.window_center
            self.window_width = metadata.window_width
        else:
            self.spacing = spacing or (1.0, 1.0, 1.0)
            self.window_center = 40
            self.window_width = 400
        
        # Volume info
        self.shape = volume.shape
        self.hu_min = float(volume.min())
        self.hu_max = float(volume.max())
        
        # Current window settings
        self._wc = self.window_center
        self._ww = self.window_width
    
    # =========================================================================
    # WINDOWING
    # =========================================================================
    
    def set_window(
        self,
        center: float = None,
        width: float = None,
        preset: str = None,
    ):
        """
        Set window level.
        
        Args:
            center: Window center (HU)
            width: Window width (HU)
            preset: Preset name (e.g., "lung", "bone", "colon")
        """
        if preset and preset in WINDOW_PRESETS:
            self._wc, self._ww = WINDOW_PRESETS[preset]
        else:
            if center is not None:
                self._wc = center
            if width is not None:
                self._ww = width
    
    def get_windowed(self, data: np.ndarray = None) -> np.ndarray:
        """Apply current window to data."""
        if data is None:
            data = self.volume
        return apply_window(data, self._wc, self._ww)
    
    @property
    def window_info(self) -> str:
        """Current window as string."""
        return f"W:{self._ww:.0f} L:{self._wc:.0f}"
    
    # =========================================================================
    # SLICE EXTRACTION
    # =========================================================================
    
    def get_slice(
        self,
        index: int,
        axis: int = 0,
        windowed: bool = True,
    ) -> np.ndarray:
        """
        Extract a slice from the volume.
        
        Args:
            index: Slice index
            axis: 0=axial, 1=coronal, 2=sagittal
            windowed: Apply HU windowing
            
        Returns:
            2D slice array
        """
        index = np.clip(index, 0, self.shape[axis] - 1)
        
        if axis == 0:
            slice_data = self.volume[index, :, :]
        elif axis == 1:
            slice_data = self.volume[:, index, :]
        else:
            slice_data = self.volume[:, :, index]
        
        if windowed:
            slice_data = apply_window(slice_data, self._wc, self._ww)
        
        return slice_data
    
    # =========================================================================
    # SINGLE SLICE DISPLAY
    # =========================================================================
    
    def show_slice(
        self,
        index: int = None,
        axis: int = 0,
        preset: str = None,
        cmap: str = "gray",
        title: str = None,
        show_info: bool = True,
        show_colorbar: bool = False,
        figsize: Tuple[int, int] = (8, 8),
        ax: plt.Axes = None,
        return_fig: bool = False,
    ):
        """
        Display a single slice.
        
        Args:
            index: Slice index (default: middle)
            axis: 0=axial, 1=coronal, 2=sagittal
            preset: Window preset
            cmap: Colormap
            title: Custom title
            show_info: Show metadata overlay
            show_colorbar: Show HU colorbar
            figsize: Figure size
            ax: Existing axes
            return_fig: Return figure instead of showing
            
        Returns:
            Figure if return_fig=True
        """
        # Set window preset if provided
        if preset:
            self.set_window(preset=preset)
        
        # Default to middle slice
        if index is None:
            index = self.shape[axis] // 2
        
        # Get slice
        slice_data = self.get_slice(index, axis, windowed=True)
        
        # Get view name and aspect
        view_names = ["Axial", "Coronal", "Sagittal"]
        view_name = view_names[axis]
        aspect = get_aspect_ratio(axis, self.spacing)
        
        # Create figure if needed
        if ax is None:
            fig, ax = plt.subplots(figsize=figsize)
        else:
            fig = ax.figure
        
        # Display slice
        im = ax.imshow(slice_data, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
        
        # Title
        if title:
            ax.set_title(title, fontsize=12, fontweight='bold')
        else:
            ax.set_title(f"{view_name} - Slice {index}/{self.shape[axis]-1}", 
                        fontsize=12, fontweight='bold')
        
        ax.axis('off')
        
        # Colorbar
        if show_colorbar:
            cbar = plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
            # Show HU values on colorbar
            lower = self._wc - self._ww / 2
            upper = self._wc + self._ww / 2
            cbar.set_ticks([0, 0.5, 1])
            cbar.set_ticklabels([f"{lower:.0f}", f"{self._wc:.0f}", f"{upper:.0f}"])
            cbar.set_label("HU", rotation=0)
        
        # Info overlay
        if show_info:
            self._add_info_overlay(ax, index, axis)
        
        # Orientation labels
        self._add_orientation_labels(ax, axis)
        
        plt.tight_layout()
        
        if return_fig:
            return fig
        else:
            plt.show()
    
    def _add_info_overlay(self, ax: plt.Axes, slice_idx: int, axis: int):
        """Add metadata info overlay to axes."""
        # Build info text
        info_lines = []
        
        if self.metadata:
            if self.metadata.patient_id:
                info_lines.append(f"ID: {self.metadata.patient_id}")
            if self.metadata.position_string != "unknown":
                info_lines.append(f"Position: {self.metadata.position_string.upper()}")
        
        info_lines.append(f"Slice: {slice_idx}/{self.shape[axis]-1}")
        info_lines.append(f"Size: {self.shape[2]}×{self.shape[1]}")
        info_lines.append(f"Spacing: {self.spacing[0]:.2f}×{self.spacing[1]:.2f}×{self.spacing[2]:.2f} mm")
        info_lines.append(f"Window: L={self._wc:.0f} W={self._ww:.0f}")
        
        info_text = "\n".join(info_lines)
        
        # Add text box
        props = dict(boxstyle='round,pad=0.3', facecolor='black', alpha=0.7)
        ax.text(0.02, 0.98, info_text, transform=ax.transAxes, fontsize=9,
                verticalalignment='top', fontfamily='monospace',
                color='white', bbox=props)
    
    def _add_orientation_labels(self, ax: plt.Axes, axis: int):
        """Add anatomical orientation labels."""
        # Orientation labels based on view
        # Assuming standard axial orientation
        if axis == 0:  # Axial
            labels = {'top': 'A', 'bottom': 'P', 'left': 'R', 'right': 'L'}
        elif axis == 1:  # Coronal
            labels = {'top': 'S', 'bottom': 'I', 'left': 'R', 'right': 'L'}
        else:  # Sagittal
            labels = {'top': 'S', 'bottom': 'I', 'left': 'A', 'right': 'P'}
        
        # Flip if prone
        if self.metadata and self.metadata.is_prone:
            if axis == 0:  # Axial - flip A/P
                labels = {'top': 'P', 'bottom': 'A', 'left': 'R', 'right': 'L'}
        
        fontdict = {'fontsize': 12, 'fontweight': 'bold', 'color': 'yellow'}
        
        ax.text(0.5, 0.99, labels['top'], transform=ax.transAxes, 
                ha='center', va='top', **fontdict)
        ax.text(0.5, 0.01, labels['bottom'], transform=ax.transAxes,
                ha='center', va='bottom', **fontdict)
        ax.text(0.01, 0.5, labels['left'], transform=ax.transAxes,
                ha='left', va='center', **fontdict)
        ax.text(0.99, 0.5, labels['right'], transform=ax.transAxes,
                ha='right', va='center', **fontdict)
    
    # =========================================================================
    # ORTHOGONAL VIEWS
    # =========================================================================
    
    def show_orthogonal(
        self,
        axial_idx: int = None,
        coronal_idx: int = None,
        sagittal_idx: int = None,
        preset: str = None,
        cmap: str = "gray",
        figsize: Tuple[int, int] = (15, 5),
        show_crosshairs: bool = True,
        return_fig: bool = False,
    ):
        """
        Display orthogonal views (axial, coronal, sagittal).
        
        Args:
            axial_idx: Axial slice index
            coronal_idx: Coronal slice index
            sagittal_idx: Sagittal slice index
            preset: Window preset
            cmap: Colormap
            figsize: Figure size
            show_crosshairs: Show position crosshairs
            return_fig: Return figure instead of showing
        """
        if preset:
            self.set_window(preset=preset)
        
        # Default to center
        if axial_idx is None:
            axial_idx = self.shape[0] // 2
        if coronal_idx is None:
            coronal_idx = self.shape[1] // 2
        if sagittal_idx is None:
            sagittal_idx = self.shape[2] // 2
        
        # Create figure
        fig, axes = plt.subplots(1, 3, figsize=figsize)
        
        views = [
            (0, axial_idx, "Axial"),
            (1, coronal_idx, "Coronal"),
            (2, sagittal_idx, "Sagittal"),
        ]
        
        for ax, (axis, idx, name) in zip(axes, views):
            slice_data = self.get_slice(idx, axis)
            aspect = get_aspect_ratio(axis, self.spacing)
            
            ax.imshow(slice_data, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
            ax.set_title(f"{name} [{idx}]", fontsize=11, fontweight='bold')
            ax.axis('off')
            
            self._add_orientation_labels(ax, axis)
            
            # Add crosshairs
            if show_crosshairs:
                h, w = slice_data.shape
                
                if axis == 0:  # Axial: show coronal and sagittal positions
                    ax.axhline(y=coronal_idx, color='cyan', linewidth=0.5, alpha=0.7)
                    ax.axvline(x=sagittal_idx, color='yellow', linewidth=0.5, alpha=0.7)
                elif axis == 1:  # Coronal: show axial and sagittal positions
                    ax.axhline(y=axial_idx, color='lime', linewidth=0.5, alpha=0.7)
                    ax.axvline(x=sagittal_idx, color='yellow', linewidth=0.5, alpha=0.7)
                else:  # Sagittal: show axial and coronal positions
                    ax.axhline(y=axial_idx, color='lime', linewidth=0.5, alpha=0.7)
                    ax.axvline(x=coronal_idx, color='cyan', linewidth=0.5, alpha=0.7)
        
        # Add info
        info = f"{self.window_info}  |  Shape: {self.shape}  |  Spacing: {self.spacing[0]:.2f}×{self.spacing[1]:.2f}×{self.spacing[2]:.2f} mm"
        if self.metadata and self.metadata.position_string != "unknown":
            info = f"{self.metadata.position_string.upper()}  |  " + info
        
        fig.suptitle(info, fontsize=10, y=0.02)
        plt.tight_layout()
        
        if return_fig:
            return fig
        else:
            plt.show()
    
    # =========================================================================
    # MONTAGE DISPLAY
    # =========================================================================
    
    def show_montage(
        self,
        num_slices: int = 16,
        axis: int = 0,
        start: int = None,
        end: int = None,
        preset: str = None,
        cmap: str = "gray",
        figsize: Tuple[int, int] = (16, 16),
        return_fig: bool = False,
    ):
        """
        Display a montage of slices.
        
        Args:
            num_slices: Number of slices to show
            axis: Axis to slice along
            start: Start slice index
            end: End slice index
            preset: Window preset
            cmap: Colormap
            figsize: Figure size
            return_fig: Return figure instead of showing
        """
        if preset:
            self.set_window(preset=preset)
        
        # Calculate grid
        cols = int(np.ceil(np.sqrt(num_slices)))
        rows = int(np.ceil(num_slices / cols))
        
        # Determine slice indices
        if start is None:
            start = 0
        if end is None:
            end = self.shape[axis] - 1
        
        indices = np.linspace(start, end, num_slices, dtype=int)
        
        # Create figure
        fig, axes = plt.subplots(rows, cols, figsize=figsize)
        axes = axes.flatten() if num_slices > 1 else [axes]
        
        aspect = get_aspect_ratio(axis, self.spacing)
        
        for i, (ax, idx) in enumerate(zip(axes, indices)):
            slice_data = self.get_slice(idx, axis)
            ax.imshow(slice_data, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
            ax.set_title(f"{idx}", fontsize=9)
            ax.axis('off')
        
        # Hide unused axes
        for ax in axes[len(indices):]:
            ax.axis('off')
        
        view_names = ["Axial", "Coronal", "Sagittal"]
        fig.suptitle(f"{view_names[axis]} Montage  |  {self.window_info}", fontsize=12)
        plt.tight_layout()
        
        if return_fig:
            return fig
        else:
            plt.show()
    
    # =========================================================================
    # HISTOGRAM
    # =========================================================================
    
    def show_histogram(
        self,
        bins: int = 100,
        show_window: bool = True,
        figsize: Tuple[int, int] = (10, 4),
        return_fig: bool = False,
    ):
        """
        Show HU histogram with current window overlay.
        
        Args:
            bins: Number of histogram bins
            show_window: Show current window range
            figsize: Figure size
            return_fig: Return figure
        """
        fig, ax = plt.subplots(figsize=figsize)
        
        # Flatten and sample if large
        data = self.volume.flatten()
        if len(data) > 1_000_000:
            data = np.random.choice(data, 1_000_000, replace=False)
        
        # Plot histogram
        ax.hist(data, bins=bins, color='steelblue', alpha=0.7, edgecolor='none')
        
        ax.set_xlabel("Hounsfield Units (HU)", fontsize=11)
        ax.set_ylabel("Frequency", fontsize=11)
        ax.set_title("HU Distribution", fontsize=12, fontweight='bold')
        
        # Mark common HU ranges
        markers = [
            (-1000, "Air"),
            (-50, "Fat"),
            (0, "Water"),
            (40, "Soft Tissue"),
            (400, "Bone"),
        ]
        
        for hu, label in markers:
            if self.hu_min <= hu <= self.hu_max:
                ax.axvline(x=hu, color='gray', linestyle='--', alpha=0.5, linewidth=1)
                ax.text(hu, ax.get_ylim()[1] * 0.95, label, rotation=90, 
                       va='top', ha='right', fontsize=8, color='gray')
        
        # Show current window
        if show_window:
            lower = self._wc - self._ww / 2
            upper = self._wc + self._ww / 2
            ax.axvspan(lower, upper, alpha=0.2, color='orange', 
                      label=f'Window: L={self._wc:.0f} W={self._ww:.0f}')
            ax.axvline(x=self._wc, color='orange', linewidth=2, label='Center')
            ax.legend(loc='upper right')
        
        ax.set_xlim(self.hu_min, self.hu_max)
        plt.tight_layout()
        
        if return_fig:
            return fig
        else:
            plt.show()
    
    # =========================================================================
    # MAXIMUM INTENSITY PROJECTION (MIP)
    # =========================================================================
    
    def show_mip(
        self,
        axis: int = 0,
        preset: str = None,
        cmap: str = "gray",
        figsize: Tuple[int, int] = (8, 8),
        return_fig: bool = False,
    ):
        """
        Show Maximum Intensity Projection (MIP).
        
        Args:
            axis: Projection axis (0=axial MIP, 1=coronal MIP, 2=sagittal MIP)
            preset: Window preset
            cmap: Colormap
            figsize: Figure size
            return_fig: Return figure
        """
        if preset:
            self.set_window(preset=preset)
        
        # Compute MIP
        mip = np.max(self.volume, axis=axis)
        mip_windowed = apply_window(mip, self._wc, self._ww)
        
        # Get aspect ratio for remaining dimensions
        if axis == 0:
            aspect = self.spacing[1] / self.spacing[2]
            title = "Axial MIP (top view)"
        elif axis == 1:
            aspect = self.spacing[0] / self.spacing[2]
            title = "Coronal MIP (front view)"
        else:
            aspect = self.spacing[0] / self.spacing[1]
            title = "Sagittal MIP (side view)"
        
        fig, ax = plt.subplots(figsize=figsize)
        ax.imshow(mip_windowed, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
        ax.set_title(f"{title}  |  {self.window_info}", fontsize=11, fontweight='bold')
        ax.axis('off')
        
        plt.tight_layout()
        
        if return_fig:
            return fig
        else:
            plt.show()

    def show_window_presets(
        self,
        slice_idx: int = None,
        axis: int = 0,
        presets: List[str] = None,
        cmap: str = "gray",
        figsize: Tuple[int, int] = (16, 10),
        return_fig: bool = False,
    ):
        """
        Show the same slice with different window presets for comparison.
        
        Args:
            slice_idx: Slice index (default: middle)
            axis: 0=axial, 1=coronal, 2=sagittal
            presets: List of preset names (default: common presets)
            cmap: Colormap
            figsize: Figure size
            return_fig: Return figure instead of showing
            
        Example:
            viewer.show_window_presets(200)
            viewer.show_window_presets(200, presets=['soft_tissue', 'lung', 'bone'])
        """
        if slice_idx is None:
            slice_idx = self.shape[axis] // 2
        
        if presets is None:
            presets = ["soft_tissue", "lung", "bone", "colon", "abdomen", "full_range"]
        
        # Get raw slice
        slice_idx = np.clip(slice_idx, 0, self.shape[axis] - 1)
        if axis == 0:
            raw_slice = self.volume[slice_idx, :, :]
        elif axis == 1:
            raw_slice = self.volume[:, slice_idx, :]
        else:
            raw_slice = self.volume[:, :, slice_idx]
        
        # Calculate grid
        n = len(presets)
        cols = min(3, n)
        rows = int(np.ceil(n / cols))
        
        fig, axes = plt.subplots(rows, cols, figsize=figsize)
        axes = axes.flatten() if n > 1 else [axes]
        
        aspect = get_aspect_ratio(axis, self.spacing)
        
        for ax, preset in zip(axes, presets):
            wc, ww = WINDOW_PRESETS.get(preset, (40, 400))
            windowed = apply_window(raw_slice, wc, ww)
            
            ax.imshow(windowed, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
            
            # Show range
            lower = wc - ww / 2
            upper = wc + ww / 2
            ax.set_title(f"{preset}\nL:{wc} W:{ww}\n[{lower:.0f} to {upper:.0f} HU]", fontsize=10)
            ax.axis('off')
        
        # Hide unused axes
        for ax in axes[n:]:
            ax.axis('off')
        
        view_names = ["Axial", "Coronal", "Sagittal"]
        fig.suptitle(f"{view_names[axis]} Slice {slice_idx} - Window Presets Comparison", 
                    fontsize=12, fontweight='bold')
        plt.tight_layout()
        
        if return_fig:
            return fig
        else:
            plt.show()

    # =========================================================================
    # INTERACTIVE BROWSER
    # =========================================================================
    
    def browse(
        self,
        axis: int = 0,
        preset: str = None,
        cmap: str = "gray",
        figsize: Tuple[int, int] = (10, 10),
    ):
        """
        Interactive slice browser with matplotlib widgets.
        
        Args:
            axis: Initial axis
            preset: Initial window preset
            cmap: Colormap
            figsize: Figure size
            
        Note:
            For Jupyter notebooks, you need to use an interactive backend:
                %matplotlib widget
            or
                %matplotlib notebook
            
            Alternatively, use browse_jupyter() which uses ipywidgets.
        """
        if preset:
            self.set_window(preset=preset)
        
        fig, ax = plt.subplots(figsize=figsize)
        plt.subplots_adjust(bottom=0.25, left=0.15)
        
        slice_idx = self.shape[axis] // 2
        slice_data = self.get_slice(slice_idx, axis)
        aspect = get_aspect_ratio(axis, self.spacing)
        
        im = ax.imshow(slice_data, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
        ax.axis('off')
        title = ax.set_title(f"Slice {slice_idx}/{self.shape[axis]-1}  |  {self.window_info}")
        
        # Sliders
        ax_slice = plt.axes([0.25, 0.15, 0.55, 0.03])
        slider_slice = Slider(ax_slice, 'Slice', 0, self.shape[axis]-1, 
                             valinit=slice_idx, valstep=1)
        
        ax_wc = plt.axes([0.25, 0.10, 0.55, 0.03])
        slider_wc = Slider(ax_wc, 'Level', -1024, 1000, valinit=self._wc)
        
        ax_ww = plt.axes([0.25, 0.05, 0.55, 0.03])
        slider_ww = Slider(ax_ww, 'Width', 1, 4000, valinit=self._ww)
        
        # Store reference for closure
        viewer = self
        
        def update(val):
            idx = int(slider_slice.val)
            viewer._wc = slider_wc.val
            viewer._ww = slider_ww.val
            
            slice_data = viewer.get_slice(idx, axis)
            im.set_data(slice_data)
            title.set_text(f"Slice {idx}/{viewer.shape[axis]-1}  |  {viewer.window_info}")
            fig.canvas.draw_idle()
        
        slider_slice.on_changed(update)
        slider_wc.on_changed(update)
        slider_ww.on_changed(update)
        
        # Preset radio buttons
        ax_preset = plt.axes([0.02, 0.35, 0.12, 0.5])
        preset_names = list(WINDOW_PRESETS.keys())[:10]
        radio = RadioButtons(ax_preset, preset_names, active=0)
        
        def set_preset(label):
            viewer.set_window(preset=label)
            slider_wc.set_val(viewer._wc)
            slider_ww.set_val(viewer._ww)
        
        radio.on_clicked(set_preset)
        
        plt.show()
    
    # =========================================================================
    # INTERACTIVE BROWSER (JUPYTER)
    # =========================================================================
    
    def browse_jupyter(
        self,
        axis: int = 0,
        preset: str = "soft_tissue",
        cmap: str = "gray",
        figsize: Tuple[int, int] = (8, 8),
    ):
        """
        Interactive browser for Jupyter notebooks using ipywidgets.
        
        Args:
            axis: Initial axis (0=axial, 1=coronal, 2=sagittal)
            preset: Initial window preset
            cmap: Colormap
            figsize: Figure size
        """
        try:
            import ipywidgets as widgets
            from IPython.display import display, clear_output
        except ImportError:
            print("ipywidgets not available. Install with: pip install ipywidgets")
            return
        
        self.set_window(preset=preset)
        
        view_names = ["Axial", "Coronal", "Sagittal"]
        viewer = self
        current_axis = [axis]
        
        # Add "custom" option to presets for manual Level/Width control
        preset_options = ["custom"] + list(WINDOW_PRESETS.keys())
        
        # Create widgets
        slice_slider = widgets.IntSlider(
            value=self.shape[axis] // 2,
            min=0,
            max=self.shape[axis] - 1,
            step=1,
            description='Slice:',
            continuous_update=False,
            layout=widgets.Layout(width='400px')
        )
        
        preset_dropdown = widgets.Dropdown(
            options=preset_options,
            value=preset,
            description='Preset:',
        )
        
        level_slider = widgets.IntSlider(
            value=int(self._wc),
            min=-1024,
            max=1000,
            step=10,
            description='Level:',
            continuous_update=False,
            layout=widgets.Layout(width='400px')
        )
        
        width_slider = widgets.IntSlider(
            value=int(self._ww),
            min=1,
            max=4000,
            step=10,
            description='Width:',
            continuous_update=False,
            layout=widgets.Layout(width='400px')
        )
        
        view_dropdown = widgets.Dropdown(
            options=[('Axial', 0), ('Coronal', 1), ('Sagittal', 2)],
            value=axis,
            description='View:',
        )
        
        output = widgets.Output()
        
        # Flag to prevent circular updates
        updating = [False]
        
        def update_plot(*args):
            if updating[0]:
                return
                
            view_axis = view_dropdown.value
            slice_idx = slice_slider.value
            
            # Update slice slider if axis changed
            if view_axis != current_axis[0]:
                current_axis[0] = view_axis
                slice_slider.max = viewer.shape[view_axis] - 1
                slice_slider.value = min(slice_idx, viewer.shape[view_axis] - 1)
                slice_idx = slice_slider.value
            
            # Use slider values directly (they're updated when preset changes)
            wc = level_slider.value
            ww = width_slider.value
            viewer._wc = wc
            viewer._ww = ww
            
            # Get slice
            slice_data = viewer.get_slice(slice_idx, view_axis, windowed=True)
            aspect = get_aspect_ratio(view_axis, viewer.spacing)
            
            # Get preset name for title
            preset_name = preset_dropdown.value
            
            # Compute HU range
            hu_lower = wc - ww / 2
            hu_upper = wc + ww / 2
            
            # Clear and redraw
            with output:
                clear_output(wait=True)
                
                fig, ax = plt.subplots(figsize=figsize)
                ax.imshow(slice_data, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
                ax.set_title(
                    f"{view_names[view_axis]} - Slice {slice_idx}/{viewer.shape[view_axis]-1}  |  "
                    f"L:{wc} W:{ww}  |  [{hu_lower:.0f} to {hu_upper:.0f} HU]  |  {preset_name}",
                    fontsize=11
                )
                ax.axis('off')
                viewer._add_orientation_labels(ax, view_axis)
                plt.tight_layout()
                display(fig)
                plt.close(fig)
        
        def on_preset_change(change):
            """When preset changes, update Level/Width sliders."""
            if updating[0]:
                return
            
            preset_name = change['new']
            if preset_name != "custom" and preset_name in WINDOW_PRESETS:
                updating[0] = True
                wc, ww = WINDOW_PRESETS[preset_name]
                level_slider.value = int(wc)
                width_slider.value = int(ww)
                updating[0] = False
            
            update_plot()
        
        def on_slider_change(change):
            """When Level/Width sliders change manually, switch to custom preset."""
            if updating[0]:
                return
            
            # If user manually adjusts sliders, switch to "custom"
            current_preset = preset_dropdown.value
            if current_preset != "custom":
                # Check if values differ from preset
                if current_preset in WINDOW_PRESETS:
                    preset_wc, preset_ww = WINDOW_PRESETS[current_preset]
                    if level_slider.value != preset_wc or width_slider.value != preset_ww:
                        updating[0] = True
                        preset_dropdown.value = "custom"
                        updating[0] = False
            
            update_plot()
        
        # Connect widgets
        slice_slider.observe(update_plot, names='value')
        view_dropdown.observe(update_plot, names='value')
        preset_dropdown.observe(on_preset_change, names='value')
        level_slider.observe(on_slider_change, names='value')
        width_slider.observe(on_slider_change, names='value')
        
        # Layout
        controls = widgets.VBox([
            widgets.HBox([view_dropdown, preset_dropdown]),
            slice_slider,
            widgets.HBox([level_slider, width_slider]),
        ])
        
        display(controls)
        display(output)
        
        # Initial plot
        update_plot()
    
    def browse_simple(
        self,
        axis: int = 0,
        preset: str = "soft_tissue", 
        cmap: str = "gray",
        figsize: Tuple[int, int] = (8, 8),
    ):
        """
        Simple interactive browser - just a slice slider.
        
        Args:
            axis: View axis (0=axial, 1=coronal, 2=sagittal)
            preset: Window preset
            cmap: Colormap
            figsize: Figure size
        """
        try:
            import ipywidgets as widgets
            from IPython.display import display, clear_output
        except ImportError:
            print("ipywidgets not available. Install with: pip install ipywidgets")
            return
        
        self.set_window(preset=preset)
        view_names = ["Axial", "Coronal", "Sagittal"]
        viewer = self
        
        slider = widgets.IntSlider(
            value=self.shape[axis] // 2,
            min=0,
            max=self.shape[axis] - 1,
            step=1,
            description=f'{view_names[axis]}:',
            continuous_update=False,
            layout=widgets.Layout(width='500px')
        )
        
        output = widgets.Output()
        
        def update(change):
            slice_idx = change['new']
            slice_data = viewer.get_slice(slice_idx, axis, windowed=True)
            aspect = get_aspect_ratio(axis, viewer.spacing)
            
            # Compute HU range
            hu_lower = viewer._wc - viewer._ww / 2
            hu_upper = viewer._wc + viewer._ww / 2
            
            with output:
                clear_output(wait=True)
                
                fig, ax = plt.subplots(figsize=figsize)
                ax.imshow(slice_data, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
                ax.set_title(
                    f"{view_names[axis]} - Slice {slice_idx}  |  {viewer.window_info}  |  "
                    f"[{hu_lower:.0f} to {hu_upper:.0f} HU]  |  {preset}"
                )
                ax.axis('off')
                viewer._add_orientation_labels(ax, axis)
                plt.tight_layout()
                
                # Use display instead of plt.show()
                display(fig)
                plt.close(fig)
        
        slider.observe(update, names='value')
        
        display(slider)
        display(output)
        
        # Initial display
        update({'new': slider.value})
    
    def browse_interact(
        self,
        axis: int = 0,
        preset: str = "soft_tissue",
        cmap: str = "gray",
        figsize: Tuple[int, int] = (8, 8),
    ):
        """
        Interactive browser using @interact decorator.
        
        This is often the most reliable method for Jupyter.
        
        Args:
            axis: View axis (0=axial, 1=coronal, 2=sagittal)
            preset: Window preset
            cmap: Colormap  
            figsize: Figure size
        """
        try:
            from ipywidgets import interact, IntSlider, Dropdown
        except ImportError:
            print("ipywidgets not available. Install with: pip install ipywidgets")
            return
        
        self.set_window(preset=preset)
        view_names = ["Axial", "Coronal", "Sagittal"]
        viewer = self
        
        @interact(
            slice_idx=IntSlider(
                value=self.shape[axis] // 2,
                min=0,
                max=self.shape[axis] - 1,
                step=1,
                description='Slice:',
                continuous_update=False,
            ),
            preset_name=Dropdown(
                options=list(WINDOW_PRESETS.keys()),
                value=preset,
                description='Preset:',
            ),
        )
        def show(slice_idx, preset_name):
            wc, ww = WINDOW_PRESETS[preset_name]
            viewer._wc, viewer._ww = wc, ww
            
            # Compute HU range
            hu_lower = wc - ww / 2
            hu_upper = wc + ww / 2
            
            slice_data = viewer.get_slice(slice_idx, axis, windowed=True)
            aspect = get_aspect_ratio(axis, viewer.spacing)
            
            fig, ax = plt.subplots(figsize=figsize)
            ax.imshow(slice_data, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
            ax.set_title(f"{view_names[axis]} - Slice {slice_idx}  |  L:{wc} W:{ww}  |  [{hu_lower:.0f} to {hu_upper:.0f} HU]")
            ax.axis('off')
            viewer._add_orientation_labels(ax, axis)
            plt.tight_layout()
            plt.show()
    
    # =========================================================================
    # COMPARE WINDOW PRESETS
    # =========================================================================
    
    def show_window_presets(
        self,
        slice_idx: int = None,
        axis: int = 0,
        presets: List[str] = None,
        cmap: str = "gray",
        figsize: Tuple[int, int] = (16, 10),
        return_fig: bool = False,
    ):
        """
        Show the same slice with different window presets for comparison.
        
        Args:
            slice_idx: Slice index (default: middle)
            axis: 0=axial, 1=coronal, 2=sagittal
            presets: List of preset names (default: common presets)
            cmap: Colormap
            figsize: Figure size
            return_fig: Return figure instead of showing
            
        Example:
            viewer.show_window_presets(200)
            viewer.show_window_presets(200, presets=['soft_tissue', 'lung', 'bone'])
        """
        if slice_idx is None:
            slice_idx = self.shape[axis] // 2
        
        if presets is None:
            presets = ["soft_tissue", "lung", "bone", "colon", "abdomen", "full_range"]
        
        # Get raw slice
        slice_idx = np.clip(slice_idx, 0, self.shape[axis] - 1)
        if axis == 0:
            raw_slice = self.volume[slice_idx, :, :]
        elif axis == 1:
            raw_slice = self.volume[:, slice_idx, :]
        else:
            raw_slice = self.volume[:, :, slice_idx]
        
        aspect = get_aspect_ratio(axis, self.spacing)
        
        # Calculate grid
        n = len(presets)
        cols = min(3, n)
        rows = int(np.ceil(n / cols))
        
        fig, axes = plt.subplots(rows, cols, figsize=figsize)
        axes = axes.flatten() if n > 1 else [axes]
        
        for ax, preset in zip(axes, presets):
            wc, ww = WINDOW_PRESETS.get(preset, (40, 400))
            windowed = apply_window(raw_slice, wc, ww)
            
            ax.imshow(windowed, cmap=cmap, aspect=aspect, vmin=0, vmax=1)
            
            # Calculate range
            lower = wc - ww / 2
            upper = wc + ww / 2
            ax.set_title(f"{preset}\nL:{wc} W:{ww}\n[{lower:.0f} to {upper:.0f} HU]", fontsize=10)
            ax.axis('off')
        
        # Hide unused axes
        for ax in axes[n:]:
            ax.axis('off')
        
        view_names = ["Axial", "Coronal", "Sagittal"]
        fig.suptitle(f"{view_names[axis]} Slice {slice_idx} - Window Presets Comparison", 
                    fontsize=12, fontweight='bold')
        plt.tight_layout()
        
        if return_fig:
            return fig
        else:
            plt.show()
    
    # =========================================================================
    # UTILITY METHODS
    # =========================================================================
    
    def __repr__(self) -> str:
        pos = ""
        if self.metadata and self.metadata.position_string != "unknown":
            pos = f", {self.metadata.position_string}"
        return f"DICOMViewer(shape={self.shape}, spacing={self.spacing}{pos})"
    
    def print_presets(self):
        """Print available window presets."""
        print("Available Window Presets:")
        print("-" * 40)
        for name, (center, width) in WINDOW_PRESETS.items():
            lower = center - width / 2
            upper = center + width / 2
            print(f"  {name:<15} L:{center:>6.0f}  W:{width:>5.0f}  [{lower:.0f} to {upper:.0f}]")
        print("-" * 40)


# =============================================================================
# CONVENIENCE FUNCTION
# =============================================================================

def quick_view(
    volume: np.ndarray,
    slice_idx: int = None,
    preset: str = "soft_tissue",
    metadata = None,
    spacing: Tuple[float, float, float] = None,
):
    """
    Quick visualization of a CT volume.
    
    Args:
        volume: 3D numpy array
        slice_idx: Slice to show (default: middle)
        preset: Window preset
        metadata: Optional DICOMMetadata
        spacing: Optional spacing (z, y, x) in mm
        
    Example:
        quick_view(volume, preset='colon')
        quick_view(volume, slice_idx=100, preset='lung')
    """
    viewer = DICOMViewer(volume, metadata, spacing)
    viewer.show_slice(slice_idx, preset=preset)