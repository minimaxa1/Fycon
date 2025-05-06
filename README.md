# Fycon - Local File Conversion Utility

Fycon is an easy to use gui based tool designed for converting various file formats directly on your local machine. It leverages powerful command-line utilities like FFmpeg, ImageMagick, Pandoc, and LibreOffice to handle a wide range of conversions through a simple drag-and-drop interface.

This project uses a Node.js backend to orchestrate the conversion processes with a minimal HTML/CSS/JavaScript frontend for user interaction.

**(Important Note: This application processes files locally on the machine where the backend server is running. It is primarily intended for local development or personal use on a trusted machine. Do not expose the backend server directly to the internet without proper security considerations.)**

![fycon](https://github.com/user-attachments/assets/6672a79e-5db3-4042-978b-63885bbc0f85)


## Features

*   **Simple Web Interface:** Easy-to-use drag-and-drop or click-to-select for single file uploads.
*   **Wide Format Support (via external tools):**
    *   **Images:** PNG, JPG, WEBP, GIF, BMP, TIFF, ICO (and PDF output from images)
    *   **Audio:** MP3, WAV, OGG, M4A, AAC, FLAC, AIFF, WMA
    *   **Video:** MP4, MKV, MOV, AVI, WEBM (outputs), Animated GIF (output), MP3 Extraction (output)
    *   **Documents:** Handles DOCX, ODT, RTF, TXT, MD inputs. Outputs PDF, TXT, HTML, Markdown, EPUB.
    *   **Archives (Creation):** ZIP, TAR.GZ, TAR.BZ2, TAR, 7Z (from single input file)
*   **Local Processing:** Conversions happen on the machine running the Node.js server.
*   **Visual Feedback:** Displays selected file info, status messages (converting, success, error), and provides a download button.
*   **Dynamic Background:** Includes an animated particle background.

## Tech Stack

*   **Frontend:** HTML5, CSS3, Vanilla JavaScript (Fetch API, HTML5 Drag & Drop)
*   **Backend:** Node.js, Express.js
*   **File Uploads:** Multer
*   **File Type Detection:** `mime-types` (fallback), (`file-type` v5+ optional)
*   **Scheduling:** `node-cron` (for cleanup)
*   **Core Conversion Engines (External Tools - Required - See Prerequisites):**
    *   FFmpeg
    *   ImageMagick (v7+ recommended)
    *   Pandoc (requires LaTeX for PDF output by default)
    *   LibreOffice (for Office document conversions)
    *   7-Zip (or p7zip)
    *   Poppler Utilities (specifically `pdftotext`)
    *   Tar / Zip (usually system default)
    *   LaTeX Distribution (e.g., MiKTeX, TeX Live - needed by Pandoc for PDF)

## Prerequisites

Before you can run Fycon, you **MUST** have the following installed on the machine where you intend to run the backend (`server.js`):

1.  **Node.js and npm:** Download from [https://nodejs.org/](https://nodejs.org/) (LTS version recommended). npm is included with Node.js.
2.  **Git:** (Optional, but needed for cloning the repository). Download from [https://git-scm.com/](https://git-scm.com/).
3.  **External Conversion Tools:** These are essential for the actual file conversions. They **must be installed AND accessible via the system's PATH environment variable**.
    *   **FFmpeg:** For all audio/video operations. ([Download](https://ffmpeg.org/download.html))
    *   **ImageMagick (v7+ recommended):** For image operations. Use the `magick` command. ([Download](https://imagemagick.org/script/download.php))
    *   **Pandoc:** For document/markup conversions. ([Download](https://pandoc.org/installing.html))
    *   **LaTeX Distribution (for Pandoc PDF output):** Required by Pandoc's default PDF engine.
        *   Windows: [MiKTeX](https://miktex.org/download)
        *   macOS: [MacTeX](https://tug.org/mactex/)
        *   Linux: [TeX Live](https://tug.org/texlive/) (e.g., `sudo apt-get install texlive-latex-base texlive-latex-extra`)
    *   **LibreOffice:** For robust Office document handling. ([Download](https://www.libreoffice.org/download/download-libreoffice/))
    *   **7-Zip:** For `.7z` archive creation.
        *   Windows: [7-Zip](https://www.7-zip.org/)
        *   Linux: `p7zip` or `p7zip-full` (e.g., `sudo apt-get install p7zip-full`)
        *   macOS: `p7zip` (e.g., `brew install p7zip`)
    *   **Poppler Utilities (for `pdftotext`):** Needed for PDF -> TXT conversion.
        *   Windows: Can be tricky. Often installed via Chocolatey (`choco install poppler`) or downloaded from specific builds.
        *   Linux: `poppler-utils` (e.g., `sudo apt-get install poppler-utils`)
        *   macOS: `poppler` (e.g., `brew install poppler`)
    *   **Tar / Zip:** Usually pre-installed on Linux/macOS. Included with Git for Windows.

## Installation & Setup

1.  **Clone the Repository (if applicable):**
    ```bash
    git clone <your-repository-url>
    cd fycon-backend # Or your project directory name
    ```

2.  **Install Node.js Dependencies:**
    Navigate to the backend project directory in your terminal and run:
    ```bash
    npm install
    ```
    *(This installs Express, Multer, CORS, node-cron, mime-types etc. listed in `package.json`)*

3.  **Install External Conversion Tools (Crucial):**
    You **must** install the tools listed in the Prerequisites section. You can install them manually from their websites OR use package managers. Basic scripts are provided below as a starting point, but **verify each installation afterwards**.

    **a) For Linux (Debian/Ubuntu) / macOS (with Homebrew) / Git Bash:**

    *   Save the following code as `install_deps.sh`:
        ```bash
        #!/bin/bash

        echo "Attempting to install Fycon dependencies..."
        echo "Requires sudo/admin privileges for package managers."

        # --- Check for Package Managers ---
        HAS_APT=$(command -v apt-get)
        HAS_BREW=$(command -v brew)

        # --- Install Function ---
        install_package() {
          PKG_NAME=$1
          APT_PKG=$2
          BREW_PKG=$3

          echo "--- Checking for $PKG_NAME ---"
          if command -v $PKG_NAME &> /dev/null; then
            echo "$PKG_NAME found."
            return
          fi

          if [ -n "$HAS_APT" ]; then
            echo "Attempting install via apt-get: $APT_PKG"
            sudo apt-get update
            sudo apt-get install -y $APT_PKG
          elif [ -n "$HAS_BREW" ]; then
            echo "Attempting install via Homebrew: $BREW_PKG"
            brew install $BREW_PKG
          else
            echo "Warning: Cannot find apt-get or brew. Please install $PKG_NAME manually."
            return 1
          fi

          # Verify after install attempt
          if ! command -v $PKG_NAME &> /dev/null; then
             echo "Warning: Installation of $PKG_NAME might have failed or it's not in PATH."
          else
             echo "$PKG_NAME installed successfully."
          fi
        }

        # --- Install Packages ---
        # Tool Command | Apt Package(s)            | Brew Package
        #---------------------------------------------------------------
        install_package ffmpeg     ffmpeg                    ffmpeg
        install_package magick     imagemagick               imagemagick
        install_package pandoc     pandoc                    pandoc
        install_package pdflatex   "texlive-latex-base texlive-latex-extra" texlive # Or mactex
        install_package libreoffice libreoffice              libreoffice # May need cask on brew
        install_package 7z         p7zip-full                p7zip
        install_package pdftotext  poppler-utils             poppler
        # Tar/Zip usually present

        echo "--- Dependency installation attempted. ---"
        echo "Please manually verify each tool is runnable (e.g., 'ffmpeg -version', 'magick -version') in a NEW terminal window."
        echo "Ensure LibreOffice and LaTeX installations were fully completed if installed."

        ```
    *   Make it executable: `chmod +x install_deps.sh`
    *   Run it: `./install_deps.sh` (You'll likely need `sudo` for `apt-get`).

    **b) For Windows (using Chocolatey or Winget):**

    *   Save the following code as `install_deps.bat`:
        ```batch
        @echo off
        echo Attempting to install Fycon dependencies using Chocolatey or Winget.
        echo IMPORTANT: This script should ideally be run in an ELEVATED (Administrator) Command Prompt or PowerShell.
        echo.

        REM Check for Chocolatey
        choco /? > nul 2>&1
        if %errorlevel% equ 0 (
            echo Found Chocolatey. Attempting installs...
            choco install ffmpeg-full -y
            choco install imagemagick.app -y --params "'/AddSharedLibraries /AddPATH'"
            choco install pandoc -y
            choco install miktex -y
            choco install libreoffice-fresh -y
            choco install 7zip.install -y
            choco install poppler -y --params="'/UTILS'"
            echo Chocolatey install attempts finished.
        ) else (
            echo Chocolatey not found. Checking for Winget...
            winget --version > nul 2>&1
            if %errorlevel% equ 0 (
                echo Found Winget. Attempting installs...
                echo Make sure you accept any prompts from Winget.
                winget install ffmpeg.ffmpeg
                winget install ImageMagick.ImageMagick
                winget install Pandoc.Pandoc
                echo Winget does not have a simple command for MiKTeX - Please install manually from https://miktex.org/download
                winget install TheDocumentFoundation.LibreOffice
                winget install 7zip.7zip
                echo Winget does not have a simple command for Poppler PDF Utilities - Please install manually or use Chocolatey.
                echo Winget install attempts finished (some may need manual install).
            ) else (
                echo ERROR: Neither Chocolatey nor Winget found in PATH.
                echo Please install dependencies manually from their websites and ensure they are added to your system PATH.
                pause
                exit /b 1
            )
        )

        echo.
        echo --- Dependency installation attempted. ---
        echo Please CLOSE this terminal and OPEN A NEW one.
        echo Then, manually verify each tool is runnable (e.g., 'ffmpeg -version', 'magick -version', 'pdflatex --version').
        echo You may need to restart your computer after installing MiKTeX or LibreOffice.
        pause
        ```
    *   **Run as Administrator:** Right-click `install_deps.bat` and choose "Run as administrator", OR open CMD/PowerShell as Administrator and run the `.bat` file from there.

    **IMPORTANT:** After running *either* script, **close and reopen your terminal** and manually verify each tool works by running its `--version` or `--help` command (e.g., `ffmpeg -version`, `magick -version`, `pandoc --version`, `pdflatex --version`, `libreoffice --version`, `7z --help`, `pdftotext -v`). Ensure they are added to your system PATH.

## Running the Application

1.  **Start the Backend Server:**
    *   Open a terminal/command prompt.
    *   Navigate to the `fycon-backend` directory (or wherever `server.js` is).
    *   Run: `node server.js`
    *   *(Alternatively, for development: `npm run dev` if `nodemon` installed)*
    *   Keep this terminal open. You should see `Fycon backend listening on http://localhost:3000`.

2.  **Serve the Frontend:**
    *   Open a **NEW** terminal window.
    *   Navigate to the directory containing `fycon.html`.
    *   Run a simple HTTP server (install globally first if needed: `npm install --global http-server`):
        ```bash
        http-server -p 3001 -c-1
        ```
    *   Keep this second terminal open.

3.  **Access Fycon:**
    *   Open your web browser and go to `http://localhost:3001`.

## Usage

1.  Drag and drop a single file onto the designated area, or click the area to select a file.
2.  The selected file's name and size will appear.
3.  Click one of the conversion format buttons.
4.  The status area shows feedback ("Converting...", "Success", or "Error"). Check the backend terminal for detailed logs.
5.  **On Success:** The status area shows "Conversion successful!" and a "Download File" button appears below it.
6.  **On Failure:** The status area shows an error message. Check the backend terminal logs for details from the conversion tool.

## Configuration

*   **Supported Formats & Tools:** Modify the `CONVERSION_RULES` object in `server.js` to add/change formats, tools, or command-line arguments.
*   **Cleanup Schedule:** Adjust the `node-cron` schedule near the bottom of `server.js`.
*   **Ports:** Update the `PORT` constant in `server.js` and the `fetch` URL in `fycon.html` if needed.

## Limitations / Important Notes

*   **Local Processing Only:** Performance depends on the server machine.
*   **Single File Only (Currently):** Multi-file uploads require modification.
*   **Security:** Designed for local use. Review security if exposing publicly. External tools may have their own vulnerabilities.
*   **External Tool Dependency:** Functionality relies on correct installation and PATH configuration of prerequisite tools.
*   **Resource Intensive:** Conversions can use significant CPU/RAM.

## Troubleshooting

*   **`500 Internal Server Error` / `Failed to start conversion tool ('...')`:** Tool not installed or not in PATH. Verify with `<tool> --version` in a new terminal.
*   **`400 Bad Request` / `Conversion from '...' to '...' is not supported`:** Conversion path not defined in `CONVERSION_RULES` in `server.js`.
*   **Conversion Fails with Tool Error:** Check backend terminal `stderr` output for messages from FFmpeg, ImageMagick, etc. Consult tool documentation.
*   **Download Button Doesn't Appear / UI Issues:** Check browser's Developer Console (F12) for JavaScript errors in `fycon.html`.
*   **`EADDRINUSE` Error:** Port already in use. Stop the conflicting process or choose a different port.

## License

This project is licensed under the GNU General Public License v3.0.

Enjoy your safe Local file conversion!

Bohemai
