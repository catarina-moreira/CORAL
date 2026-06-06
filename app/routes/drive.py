"""
Google Drive API routes for browsing and downloading files.
Supports both NIfTI files and DICOM folder series (slice-by-slice loading).
"""

from flask import Blueprint, jsonify, Response
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import io
import os
import re

from config import GOOGLE_DRIVE_SCOPES, CREDENTIALS_FILE, ROOT_FOLDER_ID

drive_bp = Blueprint('drive', __name__)

# Google Drive service singleton
_drive_service = None

# Cache for DICOM folder contents (folder_id -> list of files)
_dicom_folder_cache = {}


def get_drive_service():
    """Initialize and return Google Drive service."""
    global _drive_service
    if _drive_service is None:
        if not os.path.exists(CREDENTIALS_FILE):
            raise FileNotFoundError(
                f"Credentials file '{CREDENTIALS_FILE}' not found.\n"
                "Please download the service account JSON key from Google Cloud Console."
            )
        credentials = service_account.Credentials.from_service_account_file(
            CREDENTIALS_FILE, scopes=GOOGLE_DRIVE_SCOPES
        )
        _drive_service = build('drive', 'v3', credentials=credentials)
    return _drive_service


def is_dicom_file(filename):
    """Check if a file is likely a DICOM file."""
    # DICOM files often have .dcm extension or no extension
    lower = filename.lower()
    if lower.endswith('.dcm'):
        return True
    # Check for common DICOM naming patterns (e.g., IM_0001, slice_001)
    if re.match(r'^(im_?\d+|slice_?\d+|\d+)$', lower.replace('.dcm', '')):
        return True
    # Files with numeric names are often DICOM
    if re.match(r'^\d+$', lower):
        return True
    return False


def extract_slice_number(filename):
    """Extract slice/instance number from filename for sorting."""
    # Try to extract numbers from filename
    numbers = re.findall(r'\d+', filename)
    if numbers:
        # Return the last number (often the slice number)
        return int(numbers[-1])
    return 0


@drive_bp.route('/browse')
@drive_bp.route('/browse/<folder_id>')
def browse_drive(folder_id=None):
    """List contents of a Google Drive folder."""
    try:
        service = get_drive_service()
        target_folder = folder_id or ROOT_FOLDER_ID
        
        query = f"'{target_folder}' in parents and trashed = false"
        results = service.files().list(
            q=query,
            fields="files(id, name, mimeType, size, modifiedTime)",
            orderBy="name",
            pageSize=1000
        ).execute()
        
        files = results.get('files', [])
        
        folders = []
        nifti_files = []
        csv_files = []
        dicom_files = []
        other_files = []
        
        for f in files:
            item = {
                'id': f['id'],
                'name': f['name'],
                'mimeType': f['mimeType'],
                'size': int(f.get('size', 0)),
                'modified': f.get('modifiedTime', '')
            }
            
            if f['mimeType'] == 'application/vnd.google-apps.folder':
                folders.append(item)
            elif f['name'].endswith(('.nii', '.nii.gz')):
                nifti_files.append(item)
            elif f['name'].endswith('.csv'):
                csv_files.append(item)
            elif is_dicom_file(f['name']):
                dicom_files.append(item)
            else:
                other_files.append(item)
        
        # Check if this folder contains a DICOM series (multiple .dcm files)
        is_dicom_folder = len(dicom_files) >= 5  # At least 5 DICOM files = likely a series
        
        # Sort DICOM files by extracted slice number
        if dicom_files:
            dicom_files.sort(key=lambda x: extract_slice_number(x['name']))
        
        folder_name = "Dataset Root"
        parent_id = None
        if folder_id and folder_id != ROOT_FOLDER_ID:
            folder_info = service.files().get(
                fileId=folder_id,
                fields="name, parents"
            ).execute()
            folder_name = folder_info.get('name', 'Unknown')
            parents = folder_info.get('parents', [])
            parent_id = parents[0] if parents else ROOT_FOLDER_ID
        
        # Cache DICOM folder contents for faster slice loading
        if is_dicom_folder:
            _dicom_folder_cache[target_folder] = dicom_files
        
        return jsonify({
            'success': True,
            'folderId': target_folder,
            'folderName': folder_name,
            'parentId': parent_id,
            'isRoot': target_folder == ROOT_FOLDER_ID,
            'folders': folders,
            'niftiFiles': nifti_files,
            'csvFiles': csv_files,
            'dicomFiles': dicom_files,
            'isDicomFolder': is_dicom_folder,
            'dicomCount': len(dicom_files),
            'otherFiles': other_files
        })
        
    except FileNotFoundError as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@drive_bp.route('/dicom/<folder_id>/info')
def get_dicom_series_info(folder_id):
    """Get information about a DICOM series folder without downloading files."""
    try:
        service = get_drive_service()
        
        # Check cache first
        if folder_id in _dicom_folder_cache:
            dicom_files = _dicom_folder_cache[folder_id]
        else:
            # Query for DICOM files in folder
            query = f"'{folder_id}' in parents and trashed = false"
            results = service.files().list(
                q=query,
                fields="files(id, name, size)",
                orderBy="name",
                pageSize=1000
            ).execute()
            
            files = results.get('files', [])
            dicom_files = [
                {'id': f['id'], 'name': f['name'], 'size': int(f.get('size', 0))}
                for f in files if is_dicom_file(f['name'])
            ]
            dicom_files.sort(key=lambda x: extract_slice_number(x['name']))
            _dicom_folder_cache[folder_id] = dicom_files
        
        # Get folder name
        folder_info = service.files().get(
            fileId=folder_id,
            fields="name"
        ).execute()
        
        total_size = sum(f['size'] for f in dicom_files)
        
        return jsonify({
            'success': True,
            'folderId': folder_id,
            'folderName': folder_info.get('name', 'Unknown'),
            'sliceCount': len(dicom_files),
            'totalSize': total_size,
            'slices': [
                {
                    'index': i,
                    'id': f['id'],
                    'name': f['name'],
                    'size': f['size']
                }
                for i, f in enumerate(dicom_files)
            ]
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@drive_bp.route('/dicom/<folder_id>/slice/<int:slice_index>')
def get_dicom_slice(folder_id, slice_index):
    """Download a single DICOM slice by index."""
    import time
    max_retries = 3
    
    for attempt in range(max_retries):
        try:
            # Create a fresh service for each request to avoid connection pool issues
            from google.oauth2 import service_account as sa
            from googleapiclient.discovery import build as build_service
            
            if not os.path.exists(CREDENTIALS_FILE):
                raise FileNotFoundError(f"Credentials file not found")
            
            creds = sa.Credentials.from_service_account_file(
                CREDENTIALS_FILE, scopes=GOOGLE_DRIVE_SCOPES
            )
            service = build_service('drive', 'v3', credentials=creds)
            
            # Get cached file list or fetch it
            if folder_id in _dicom_folder_cache:
                dicom_files = _dicom_folder_cache[folder_id]
            else:
                print(f"[DICOM] Fetching file list for folder {folder_id}")
                query = f"'{folder_id}' in parents and trashed = false"
                results = service.files().list(
                    q=query,
                    fields="files(id, name, size)",
                    orderBy="name",
                    pageSize=1000
                ).execute()
                
                files = results.get('files', [])
                dicom_files = [
                    {'id': f['id'], 'name': f['name'], 'size': int(f.get('size', 0))}
                    for f in files if is_dicom_file(f['name'])
                ]
                dicom_files.sort(key=lambda x: extract_slice_number(x['name']))
                _dicom_folder_cache[folder_id] = dicom_files
            
            if slice_index < 0 or slice_index >= len(dicom_files):
                return jsonify({'success': False, 'error': f'Slice index {slice_index} out of range (0-{len(dicom_files)-1})'}), 400
            
            file_info = dicom_files[slice_index]
            file_id = file_info['id']
            file_name = file_info['name']
            
            # Download the file using simple get_media (not chunked for small files)
            request_media = service.files().get_media(fileId=file_id)
            
            # For small files like DICOM slices, execute directly instead of chunked download
            data = request_media.execute()
            
            print(f"[DICOM] Downloaded {len(data)} bytes for slice {slice_index}: {file_name}")
            
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
            error_msg = str(e)
            print(f"[DICOM] Attempt {attempt + 1}/{max_retries} failed for slice {slice_index}: {error_msg}")
            
            if attempt < max_retries - 1:
                # Wait before retry (exponential backoff)
                wait_time = (attempt + 1) * 2
                print(f"[DICOM] Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
            else:
                import traceback
                traceback.print_exc()
                return jsonify({'success': False, 'error': error_msg}), 500


@drive_bp.route('/dicom/<folder_id>/slices')
def get_multiple_dicom_slices(folder_id):
    """Get info for batch downloading multiple slices. 
    Query params: start, count (for range), or indices (comma-separated)."""
    from flask import request
    
    try:
        service = get_drive_service()
        
        # Get cached file list or fetch it
        if folder_id in _dicom_folder_cache:
            dicom_files = _dicom_folder_cache[folder_id]
        else:
            query = f"'{folder_id}' in parents and trashed = false"
            results = service.files().list(
                q=query,
                fields="files(id, name, size)",
                orderBy="name",
                pageSize=1000
            ).execute()
            
            files = results.get('files', [])
            dicom_files = [
                {'id': f['id'], 'name': f['name'], 'size': int(f.get('size', 0))}
                for f in files if is_dicom_file(f['name'])
            ]
            dicom_files.sort(key=lambda x: extract_slice_number(x['name']))
            _dicom_folder_cache[folder_id] = dicom_files
        
        # Parse request parameters
        indices_param = request.args.get('indices')
        start = request.args.get('start', type=int)
        count = request.args.get('count', type=int)
        
        if indices_param:
            # Specific indices requested
            indices = [int(i) for i in indices_param.split(',')]
        elif start is not None and count is not None:
            # Range requested
            indices = list(range(start, min(start + count, len(dicom_files))))
        else:
            # Default: return all
            indices = list(range(len(dicom_files)))
        
        # Filter valid indices
        indices = [i for i in indices if 0 <= i < len(dicom_files)]
        
        return jsonify({
            'success': True,
            'folderId': folder_id,
            'totalSlices': len(dicom_files),
            'requestedSlices': [
                {
                    'index': i,
                    'id': dicom_files[i]['id'],
                    'name': dicom_files[i]['name'],
                    'size': dicom_files[i]['size']
                }
                for i in indices
            ]
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@drive_bp.route('/file/<file_id>')
def stream_file(file_id):
    """Stream a file from Google Drive."""
    try:
        service = get_drive_service()
        
        file_info = service.files().get(
            fileId=file_id,
            fields="name, size, mimeType"
        ).execute()
        
        file_name = file_info.get('name', 'unknown')
        file_size = int(file_info.get('size', 0))
        
        request_media = service.files().get_media(fileId=file_id)
        
        def generate():
            fh = io.BytesIO()
            downloader = MediaIoBaseDownload(fh, request_media, chunksize=1024*1024)
            done = False
            while not done:
                status, done = downloader.next_chunk()
                fh.seek(0)
                data = fh.read()
                if data:
                    yield data
                fh.seek(0)
                fh.truncate()
        
        content_type = 'application/octet-stream'
        if file_name.endswith('.csv'):
            content_type = 'text/csv'
        elif file_name.endswith('.nii') or file_name.endswith('.nii.gz'):
            content_type = 'application/gzip' if file_name.endswith('.gz') else 'application/octet-stream'
        
        response = Response(
            generate(),
            mimetype=content_type,
            headers={
                'Content-Disposition': f'attachment; filename="{file_name}"',
                'Content-Length': str(file_size),
                'X-File-Name': file_name
            }
        )
        return response
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@drive_bp.route('/file/<file_id>/info')
def file_info(file_id):
    """Get file metadata without downloading."""
    try:
        service = get_drive_service()
        file_info = service.files().get(
            fileId=file_id,
            fields="name, size, mimeType, modifiedTime"
        ).execute()
        return jsonify({
            'success': True,
            'name': file_info.get('name'),
            'size': int(file_info.get('size', 0)),
            'mimeType': file_info.get('mimeType'),
            'modified': file_info.get('modifiedTime')
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
