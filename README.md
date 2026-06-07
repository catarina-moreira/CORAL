# CORAL — COlonography Radiology Annotation Lab


A web-based annotation tool and deep-learning pipeline for **CT colonography**. CORAL lets radiologists load CT scans (from a local folder or Google Drive), browse slices, paint segmentation masks (fluid pockets, polyps, lumen), view results in 3D, and export NIfTI masks. It also ships a PyTorch training/inference pipeline for automatic fluid-pocket segmentation.

<p align="center">
  <img src="latex_paper/coral_teaser.png" alt="CORAL overview. (A) Annotation records sidebar. (B) 3D view of lumen and fluid-pocket meshes. (C) Lumen annotation with the edge-aware brush. (D) Fluid-pocket annotation with an HU-windowed brush. (E) On-image distance measurement. (F) Polyp annotation with the slice-level &quot;teach a trainee&quot; rationale panel." width="100%">
</p>

<p align="center">
  <sub><b>Overview of CORAL.</b>
  (A) Annotation records sidebar, synced with the slice viewer.
  (B) 3D view of lumen and fluid-pocket meshes.
  (C) Lumen annotation with the edge-aware brush.
  (D) Fluid-pocket annotation with an HU-windowed brush.
  (E) On-image distance measurement.
  (F) Polyp annotation alongside the slice-level <i>teach a trainee</i> rationale panel.</sub>
</p>

## 🔗 Quick links

- 🚀 **Live demo**: <https://bit.ly/3Sle22X>
- 🎬 **3-min demo video**: <https://youtu.be/hq48kqLNLD0>
- 🎓 **Radiologist training video (30 min)**: <https://youtu.be/NXrOdGIkkpQ> — walkthrough of CORAL used to onboard radiologists for the user study.
- 📄 **User-study task sheet**: [`user_task/annotation_task_instructions.pdf`](user_task/annotation_task_instructions.pdf) — annotation instructions handed to participants.
- 💻 **Source code**: <https://github.com/catarina-moreira/CORAL>

---

## Table of Contents
1. [Features](#features)
2. [Project Structure](#project-structure)
3. [Prerequisites](#prerequisites)
4. [Installation](#installation)
5. [Configuration](#configuration)
   - [Local DICOM Folder](#1-local-dicom-folder-recommended-fastest)
   - [Google Drive](#2-google-drive-optional)
6. [Running the Web App](#running-the-web-app)
7. [Dataset Format](#dataset-format)
8. [Troubleshooting](#troubleshooting)

---

## Features

- DICOM and NIfTI (`.nii`, `.nii.gz`) loading
- Brush, erase, bounding-box and edge-aware annotation tools
- Undo/redo, zoom, pan, window/level controls
- 3D visualization of segmentation masks (Three.js: surface voxels, marching cubes, point cloud)
- Two data sources: **local folder** (instant) and **Google Drive** (cloud)

---

## Project Structure

```
CORAL/
├── app/                      # Flask web application
│   ├── __init__.py           # App factory (registers blueprints)
│   ├── routes/
│   │   ├── main.py           # Serves index.html
│   │   ├── local.py          # Local-folder browsing & DICOM serving
│   │   ├── drive.py          # Google Drive browsing & streaming
│   │   └── mask.py           # Mask upload/download (NIfTI)
│   └── templates/
│       └── index.html        # Main UI
├── static/
│   ├── css/styles.css        # CORAL stylesheet
│   └── js/                   # main.js, dicom.js, nifti.js, refinement.js, visualization3d.js
├── src/
│   ├── preprocessing/        # DICOM loaders
│   ├── utils/                # DICOM/NIfTI utilities
│   ├── data/                 # Metadata & class definitions
│   └── visualization/        # DICOM viewer helpers
├── notebooks/                # Jupyter notebooks (exploration)
├── config.py                 # ⚠️ EDIT THIS — paths & Drive folder ID
├── drive_credentials.json    # ⚠️ ADD THIS — Google service-account key (not in repo)
├── requirements.txt
└── README.md                 # ← you are here
```

---

## Prerequisites

- **Python 3.10 or newer** (tested with 3.11)
- **pip** and **virtualenv** (or `venv`)
- A modern web browser (Chrome, Firefox, Edge)
- *(Optional, for Drive backend)* a Google Cloud project with the Drive API enabled

---

## Installation

### 1. Get the code

Copy the `CORAL/` project folder onto your machine (download it as a zip, copy it over the network, or move it from a USB drive — whatever is most convenient). Then open a terminal **inside that folder**:

**Windows (PowerShell):**
```powershell
cd path\to\CORAL
```

**macOS / Linux:**
```bash
cd /path/to/CORAL
```

### 2. Create and activate a virtual environment

**Windows (PowerShell):**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

**macOS / Linux:**
```bash
python -m venv .venv
source .venv/bin/activate
```

### 3. Install Python dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

This installs Flask, pydicom, nibabel, numpy, scipy, the Google Drive client libraries, and notebook tools.

---

## Configuration

Open `config.py` at the project root. You'll see four settings — only two are likely to need changing:

```python
GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
CREDENTIALS_FILE = 'drive_credentials.json'
ROOT_FOLDER_ID = '<YOUR_GOOGLE_DRIVE_FOLDER_ID>'
LOCAL_DATA_PATH = '<PATH_TO_YOUR_LOCAL_DICOM_DATASET>'
MASKS_DIR = 'received_masks'  # where uploaded masks are saved
```

You can use **either** backend (local or Drive) or both. **The local backend is much faster** and is the recommended starting point.

### 1. Local DICOM folder (recommended — fastest)

1. Place your CT colonography dataset anywhere on disk. The expected layout is documented in [Dataset Format](#dataset-format) below.
2. Edit `config.py` and set `LOCAL_DATA_PATH` to the **absolute path** of the folder that contains your patient/study subfolders.

   **Windows example:**
   ```python
   LOCAL_DATA_PATH = r'C:\Users\<you>\datasets\TCIA_CORAL'
   ```

   **macOS/Linux example:**
   ```python
   LOCAL_DATA_PATH = '/home/<you>/datasets/TCIA_CORAL'
   ```

   > Use a raw string (`r'...'`) on Windows so backslashes are not interpreted as escape sequences. The path must already exist before launching the app.

3. If you do **not** want to use Google Drive at all, leave `drive_credentials.json` absent — the Drive tab in the UI will simply error if you click it, but the local tab will work.

### 2. Google Drive (optional)

The Drive backend uses a **service account** so the server can read files without any per-user OAuth flow. You need to do this once.

#### Step 1 — Create a Google Cloud project and enable the Drive API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or pick an existing one).
3. Under **APIs & Services → Library**, enable the **Google Drive API**.

#### Step 2 — Create a service account and download its JSON key

1. Under **APIs & Services → Credentials**, click **Create Credentials → Service account**.
2. Give it a name (e.g. `coral-drive-reader`), grant it no project roles, and finish.
3. Open the new service account, go to the **Keys** tab, click **Add Key → Create new key → JSON**.
4. A JSON file will download. **Rename it to `drive_credentials.json`** and place it in the project root (next to `config.py`).

   > ⚠️ This file contains a private key. Treat it like a password — do not share it, do not upload it to public storage, and do not include it in any backups or archives you distribute.

#### Step 3 — Share your Drive dataset with the service account

1. In the JSON file, find the `client_email` field — it looks like
   `coral-drive-reader@your-project.iam.gserviceaccount.com`.
2. In Google Drive, locate the folder containing your CT dataset, right-click → **Share**, and add that email with **Viewer** access.

#### Step 4 — Set the root folder ID in `config.py`

1. Open the Drive folder in your browser. The URL looks like:
   `https://drive.google.com/drive/folders/15RQkdAovqox1X2bp30TeO1S2GHI0FQTJ`
   The string after `/folders/` is the **folder ID**.
2. Edit `config.py`:
   ```python
   ROOT_FOLDER_ID = '<paste-your-folder-id-here>'
   ```

That's it — the Drive tab in the UI will now list your dataset.

---

## Running the Web App

The Flask app is built via the factory in `app/__init__.py`. Launch it with the `flask` CLI:

**Windows (PowerShell):**
```powershell
$env:FLASK_APP = "app:create_app"
$env:FLASK_DEBUG = "1"        # optional, enables hot reload
flask run --host 127.0.0.1 --port 5000
```

**macOS / Linux:**
```bash
export FLASK_APP="app:create_app"
export FLASK_DEBUG=1           # optional, enables hot reload
flask run --host 127.0.0.1 --port 5000
```

Then open <http://127.0.0.1:5000> in your browser.

### Using the UI

1. Click **📁 Browse Data** in the sidebar.
2. Choose the **💻 Local Folder** tab (instant) or **☁️ Google Drive** tab.
3. Navigate to a study folder containing DICOMs (or a `.nii` / `.nii.gz` file) and click to load.
4. Annotate using the brush tools in the toolbar; press `[` to toggle the sidebar.
5. Use **Download Mask** to export your segmentation as a NIfTI file.

Uploaded masks are saved to the folder named in `MASKS_DIR` (default: `received_masks/`).

---

## Dataset Format

CORAL is built around the [TCIA CT Colonography](https://www.cancerimagingarchive.net/collection/ct-colonography/) collection but works with any dataset that follows this layout:

```
<LOCAL_DATA_PATH>/
└── <patient_id>/                       e.g. CTC-0001
    └── <series_folder>/                e.g. 2.000000-NA-22118
        ├── dicoms/                     ← raw DICOM slices (.dcm)
        │   ├── 1-001.dcm
        │   ├── 1-002.dcm
        │   └── ...
        ├── lumen.nii.gz                ← optional: lumen segmentation
        └── mask_fluid_pockets.nii.gz   ← optional: fluid-pocket ground truth
```

For the deep-learning pipeline, multiple patients can be placed side-by-side under `<LOCAL_DATA_PATH>/` and `main.py` will auto-discover them with patient-level train/val/test splits to prevent data leakage.

---

## How to Cite

If you use CORAL in academic work, please cite both the **tool** and the **underlying CT colonography dataset**.

### Citing CORAL

**Plain text:**

>  Guanqi Cheng, Zaharudin Bin, Nancy Adams, Ezequiel Zorzal, Francesco Vona, Antoni Jaume-i-Capó, Mukesh Prasad, Monika Sonu, Joaquim Jorge, and Catarina Moreira.
  2026. CORAL: COlonography Radiology Annotation Lab. 2026. Available at: `https://github.com/catarina-moreira/CORAL`.

**BibTeX:**

```bibtex
 @MISC{cheng2026coral,
    author    = {Cheng, Guanqi and Bin, Zaharudin and Adams, Nancy and
                 Zorzal, Ezequiel and Vona, Francesco and
                 Jaume-i-Cap{\'o}, Antoni and Prasad, Mukesh and
                 Sonu, Monika and Jorge, Joaquim and Moreira, Catarina},
    title     = {{CORAL}: {CO}lonography {R}adiology {A}nnotation {L}ab},
    year      = {2026},
    url       = {https://github.com/catarina-moreira/CORAL}
  }
```

### Citing the CT colonography dataset

CORAL is developed and tested on **The Cancer Imaging Archive (TCIA) CT Colonography** collection. If your work uses that data, you must cite both the collection and the TCIA infrastructure:

**Dataset:**

> Smith, K., Clark, K., Bennett, W., Nolan, T., Kirby, J., Wolfsberger, M., Moulton, J., Vendt, B., & Freymann, J. (2015). *Data From CORALOGRAPHY* [Data set]. The Cancer Imaging Archive. https://doi.org/10.7937/K9/TCIA.2015.NWTESAY1

**TCIA:**

> Clark, K., Vendt, B., Smith, K., Freymann, J., Kirby, J., Koppel, P., Moore, S., Phillips, S., Maffitt, D., Pringle, M., Tarbox, L., & Prior, F. (2013). *The Cancer Imaging Archive (TCIA): Maintaining and Operating a Public Information Repository.* Journal of Digital Imaging, 26(6), 1045–1057. https://doi.org/10.1007/s10278-013-9622-7

---

