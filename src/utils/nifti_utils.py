"""
NIfTI Utilities
===============

Utility functions for working with NIfTI files.

Functions:
    - nii_to_nii_gz: Convert .nii to .nii.gz (compress)
    - nii_gz_to_nii: Convert .nii.gz to .nii (decompress)
    - convert_nifti_folder: Batch convert all NIfTI files in a folder
"""

import os
import nibabel as nib
from pathlib import Path
from typing import Optional, List
from tqdm import tqdm


def nii_to_nii_gz(
    input_path: str,
    output_path: Optional[str] = None,
    remove_original: bool = False
) -> str:
    """
    Convert a .nii file to .nii.gz (compressed).
    
    Args:
        input_path: Path to input .nii file
        output_path: Path for output .nii.gz file. If None, uses same name with .nii.gz extension
        remove_original: If True, delete the original .nii file after conversion
        
    Returns:
        Path to the output .nii.gz file
        
    Example:
        # Convert single file
        nii_to_nii_gz('volume.nii')  # Creates volume.nii.gz
        
        # Convert with custom output path
        nii_to_nii_gz('volume.nii', 'compressed/volume.nii.gz')
        
        # Convert and remove original
        nii_to_nii_gz('volume.nii', remove_original=True)
    """
    input_path = Path(input_path)
    
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    
    if not str(input_path).endswith('.nii'):
        raise ValueError(f"Input file must be .nii, got: {input_path}")
    
    # Determine output path
    if output_path is None:
        output_path = str(input_path) + '.gz'
    output_path = Path(output_path)
    
    # Create output directory if needed
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Load and save with compression
    img = nib.load(str(input_path))
    nib.save(img, str(output_path))
    
    print(f"Converted: {input_path.name} -> {output_path.name}")
    
    # Remove original if requested
    if remove_original:
        os.remove(input_path)
        print(f"Removed original: {input_path.name}")
    
    return str(output_path)


def nii_gz_to_nii(
    input_path: str,
    output_path: Optional[str] = None,
    remove_original: bool = False
) -> str:
    """
    Convert a .nii.gz file to .nii (decompressed).
    
    Args:
        input_path: Path to input .nii.gz file
        output_path: Path for output .nii file. If None, uses same name without .gz extension
        remove_original: If True, delete the original .nii.gz file after conversion
        
    Returns:
        Path to the output .nii file
        
    Example:
        # Decompress single file
        nii_gz_to_nii('volume.nii.gz')  # Creates volume.nii
        
        # Decompress with custom output path
        nii_gz_to_nii('volume.nii.gz', 'uncompressed/volume.nii')
    """
    input_path = Path(input_path)
    
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    
    if not str(input_path).endswith('.nii.gz'):
        raise ValueError(f"Input file must be .nii.gz, got: {input_path}")
    
    # Determine output path
    if output_path is None:
        output_path = str(input_path)[:-3]  # Remove .gz
    output_path = Path(output_path)
    
    # Create output directory if needed
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Load and save without compression
    img = nib.load(str(input_path))
    nib.save(img, str(output_path))
    
    print(f"Converted: {input_path.name} -> {output_path.name}")
    
    # Remove original if requested
    if remove_original:
        os.remove(input_path)
        print(f"Removed original: {input_path.name}")
    
    return str(output_path)


def convert_nifti_folder(
    input_folder: str,
    output_folder: Optional[str] = None,
    compress: bool = True,
    remove_original: bool = False,
    recursive: bool = False
) -> List[str]:
    """
    Batch convert all NIfTI files in a folder.
    
    Args:
        input_folder: Folder containing NIfTI files
        output_folder: Output folder. If None, converts in place
        compress: If True, convert .nii to .nii.gz. If False, convert .nii.gz to .nii
        remove_original: If True, delete original files after conversion
        recursive: If True, search subfolders recursively
        
    Returns:
        List of paths to converted files
        
    Example:
        # Compress all .nii files in folder
        convert_nifti_folder('data/', compress=True)
        
        # Decompress all .nii.gz files to a new folder
        convert_nifti_folder('compressed/', 'uncompressed/', compress=False)
        
        # Compress recursively and remove originals
        convert_nifti_folder('data/', compress=True, remove_original=True, recursive=True)
    """
    input_folder = Path(input_folder)
    
    if not input_folder.exists():
        raise FileNotFoundError(f"Input folder not found: {input_folder}")
    
    if output_folder is None:
        output_folder = input_folder
    output_folder = Path(output_folder)
    output_folder.mkdir(parents=True, exist_ok=True)
    
    # Find files to convert
    if compress:
        pattern = '**/*.nii' if recursive else '*.nii'
        # Exclude .nii.gz files
        files = [f for f in input_folder.glob(pattern) if not str(f).endswith('.nii.gz')]
    else:
        pattern = '**/*.nii.gz' if recursive else '*.nii.gz'
        files = list(input_folder.glob(pattern))
    
    if not files:
        print(f"No {'*.nii' if compress else '*.nii.gz'} files found in {input_folder}")
        return []
    
    print(f"Found {len(files)} files to convert")
    
    converted = []
    for file_path in tqdm(files, desc="Converting"):
        # Determine relative path for output
        rel_path = file_path.relative_to(input_folder)
        
        if compress:
            out_path = output_folder / (str(rel_path) + '.gz')
        else:
            out_path = output_folder / str(rel_path)[:-3]  # Remove .gz
        
        try:
            if compress:
                nii_to_nii_gz(str(file_path), str(out_path), remove_original)
            else:
                nii_gz_to_nii(str(file_path), str(out_path), remove_original)
            converted.append(str(out_path))
        except Exception as e:
            print(f"Error converting {file_path}: {e}")
    
    print(f"\nConverted {len(converted)} files")
    return converted


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Convert NIfTI files between .nii and .nii.gz')
    parser.add_argument('input', type=str, help='Input file or folder')
    parser.add_argument('--output', '-o', type=str, default=None, help='Output file or folder')
    parser.add_argument('--decompress', '-d', action='store_true', help='Decompress .nii.gz to .nii (default is compress)')
    parser.add_argument('--remove', '-r', action='store_true', help='Remove original files after conversion')
    parser.add_argument('--recursive', action='store_true', help='Process subfolders recursively')
    
    args = parser.parse_args()
    
    input_path = Path(args.input)
    
    if input_path.is_file():
        # Single file conversion
        if args.decompress:
            nii_gz_to_nii(str(input_path), args.output, args.remove)
        else:
            nii_to_nii_gz(str(input_path), args.output, args.remove)
    else:
        # Folder conversion
        convert_nifti_folder(
            str(input_path),
            args.output,
            compress=not args.decompress,
            remove_original=args.remove,
            recursive=args.recursive
        )
