"""
Configuration settings for CORAL.
"""

import os

# Google Drive Configuration
GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
CREDENTIALS_FILE = 'drive_credentials.json'
ROOT_FOLDER_ID = 'folder_id'  # Your google drive dataset folder

# Local Folder Configuration
# Set this to your local DICOM data directory
LOCAL_DATA_PATH = 'local_folder'

# Output directories
MASKS_DIR = 'received_masks'

# Ensure output directories exist
os.makedirs(MASKS_DIR, exist_ok=True)
