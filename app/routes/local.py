"""
Local folder routes for browsing and serving DICOM files from disk.
Much faster than cloud storage!
"""

from flask import Blueprint, jsonify, Response, send_file
import os
import re

from config import LOCAL_DATA_PATH

local_bp = Blueprint('local', __name__)


def is_dicom_file(filename):
    """Check if a file is likely a DICOM file."""
    lower = filename.lower()
    if lower.endswith('.dcm'):
        return True
    # Check for common DICOM naming patterns
    if re.match(r'^(im_?\d+|slice_?\d+|\d+)$', lower.replace('.dcm', '')):
        return True
    if re.match(r'^\d+$', lower):
        return True
    return False


def extract_slice_number(filename):
    """Extract slice/instance number from filename for sorting."""
    numbers = re.findall(r'\d+', filename)
    if numbers:
        return int(numbers[-1])
    return 0


def get_safe_path(relative_path):
    """Ensure the path is within LOCAL_DATA_PATH (security check)."""
    if not LOCAL_DATA_PATH or not os.path.isdir(LOCAL_DATA_PATH):
        return None
    
    # Normalize and join paths
    base = os.path.normpath(os.path.abspath(LOCAL_DATA_PATH))
    if relative_path:
        target = os.path.normpath(os.path.abspath(os.path.join(base, relative_path)))
    else:
        target = base
    
    # Security check: ensure target is within base
    if not target.startswith(base):
        return None
    
    return target


@local_bp.route('/status')
def local_status():
    """Check if local folder is configured and accessible."""
    if not LOCAL_DATA_PATH:
        return jsonify({
            'success': False,
            'configured': False,
            'error': 'LOCAL_DATA_PATH not set in config.py'
        })
    
    if not os.path.isdir(LOCAL_DATA_PATH):
        return jsonify({
            'success': False,
            'configured': True,
            'path': LOCAL_DATA_PATH,
            'error': f'Folder does not exist: {LOCAL_DATA_PATH}'
        })
    
    return jsonify({
        'success': True,
        'configured': True,
        'path': LOCAL_DATA_PATH
    })


@local_bp.route('/browse')
@local_bp.route('/browse/<path:folder_path>')
def browse_local(folder_path=''):
    """List contents of a local folder."""
    from urllib.parse import unquote
    
    # URL decode the path (Flask should do this, but be safe)
    folder_path = unquote(folder_path)
    print(f"[LOCAL] Browsing: '{folder_path}'")
    
    try:
        target = get_safe_path(folder_path)
        if not target:
            return jsonify({
                'success': False,
                'error': 'Invalid path or LOCAL_DATA_PATH not configured'
            }), 400
        
        if not os.path.isdir(target):
            return jsonify({
                'success': False,
                'error': f'Not a directory: {folder_path}'
            }), 404
        
        folders = []
        nifti_files = []
        dicom_files = []
        csv_files = []
        other_files = []
        
        for entry in os.scandir(target):
            if entry.name.startswith('.'):
                continue  # Skip hidden files
            
            if entry.is_dir():
                folders.append({
                    'name': entry.name,
                    'path': os.path.join(folder_path, entry.name) if folder_path else entry.name
                })
            elif entry.is_file():
                stat = entry.stat()
                item = {
                    'name': entry.name,
                    'path': os.path.join(folder_path, entry.name) if folder_path else entry.name,
                    'size': stat.st_size
                }
                
                if entry.name.lower().endswith(('.nii', '.nii.gz')):
                    nifti_files.append(item)
                elif entry.name.lower().endswith('.csv'):
                    csv_files.append(item)
                elif is_dicom_file(entry.name):
                    dicom_files.append(item)
                else:
                    other_files.append(item)
        
        # Sort
        folders.sort(key=lambda x: x['name'].lower())
        dicom_files.sort(key=lambda x: extract_slice_number(x['name']))
        csv_files.sort(key=lambda x: x['name'].lower())
        nifti_files.sort(key=lambda x: x['name'].lower())
        
        # Check if this is a DICOM folder
        is_dicom_folder = len(dicom_files) >= 5
        
        # Get parent path
        parent_path = os.path.dirname(folder_path) if folder_path else None
        
        return jsonify({
            'success': True,
            'folderPath': folder_path,
            'folderName': os.path.basename(target) if folder_path else 'Local Data',
            'parentPath': parent_path,
            'isRoot': folder_path == '',
            'folders': folders,
            'niftiFiles': nifti_files,
            'csvFiles': csv_files,
            'dicomFiles': dicom_files,
            'isDicomFolder': is_dicom_folder,
            'dicomCount': len(dicom_files),
            'otherFiles': other_files
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@local_bp.route('/dicom/<path:folder_path>/info')
def get_local_dicom_info(folder_path):
    """Get information about a local DICOM series folder."""
    from urllib.parse import unquote
    folder_path = unquote(folder_path)
    
    try:
        target = get_safe_path(folder_path)
        if not target or not os.path.isdir(target):
            return jsonify({'success': False, 'error': 'Invalid folder path'}), 400
        
        # Get DICOM files
        dicom_files = []
        for entry in os.scandir(target):
            if entry.is_file() and is_dicom_file(entry.name):
                stat = entry.stat()
                dicom_files.append({
                    'name': entry.name,
                    'path': os.path.join(folder_path, entry.name),
                    'size': stat.st_size
                })
        
        dicom_files.sort(key=lambda x: extract_slice_number(x['name']))
        
        total_size = sum(f['size'] for f in dicom_files)
        
        return jsonify({
            'success': True,
            'folderPath': folder_path,
            'folderName': os.path.basename(target),
            'sliceCount': len(dicom_files),
            'totalSize': total_size,
            'slices': [
                {
                    'index': i,
                    'name': f['name'],
                    'path': f['path'],
                    'size': f['size']
                }
                for i, f in enumerate(dicom_files)
            ]
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@local_bp.route('/dicom/<path:folder_path>/slice/<int:slice_index>')
def get_local_dicom_slice(folder_path, slice_index):
    """Serve a single DICOM slice from local disk - FAST!"""
    from urllib.parse import unquote
    folder_path = unquote(folder_path)
    
    try:
        target = get_safe_path(folder_path)
        if not target or not os.path.isdir(target):
            return jsonify({'success': False, 'error': 'Invalid folder path'}), 400
        
        # Get sorted DICOM files
        dicom_files = []
        for entry in os.scandir(target):
            if entry.is_file() and is_dicom_file(entry.name):
                dicom_files.append(entry.name)
        
        dicom_files.sort(key=extract_slice_number)
        
        if slice_index < 0 or slice_index >= len(dicom_files):
            return jsonify({
                'success': False,
                'error': f'Slice index {slice_index} out of range (0-{len(dicom_files)-1})'
            }), 400
        
        file_name = dicom_files[slice_index]
        file_path = os.path.join(target, file_name)
        
        # Read and return the file directly - super fast!
        with open(file_path, 'rb') as f:
            data = f.read()
        
        return Response(
            data,
            mimetype='application/dicom',
            headers={
                'Content-Disposition': f'attachment; filename="{file_name}"',
                'Content-Length': str(len(data)),
                'X-Slice-Index': str(slice_index),
                'X-File-Name': file_name
            }
        )
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@local_bp.route('/file/<path:file_path>')
def serve_local_file(file_path):
    """Serve any file from local data folder (for NIfTI files)."""
    from urllib.parse import unquote
    file_path = unquote(file_path)
    print(f"[LOCAL] Serving file: '{file_path}'")
    
    try:
        target = get_safe_path(file_path)
        if not target or not os.path.isfile(target):
            return jsonify({'success': False, 'error': 'File not found'}), 404
        
        return send_file(target, as_attachment=True)
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
