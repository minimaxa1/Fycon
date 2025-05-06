#!/bin/bash

# Navigate to the backend directory relative to the script location
# This makes it work even if run from the root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
BACKEND_DIR="$SCRIPT_DIR/Orbe-backend" # Ensure this matches your backend folder name

if [ ! -d "$BACKEND_DIR" ]; then
    echo "Error: Could not find Orbe-backend directory relative to the script."
    echo "Please ensure this script is in the main project folder (e.g., Orbe v1.2)."
    read -p "Press Enter to exit..." # Pause for user to see error
    exit 1
fi

echo "Navigating to $BACKEND_DIR..."
cd "$BACKEND_DIR" || exit 1

echo "Installing backend dependencies using npm..."
npm install
INSTALL_EXIT_CODE=$? # Capture npm install exit code

if [ $INSTALL_EXIT_CODE -ne 0 ]; then
    echo "Error: npm install failed. Is Node.js and npm installed and in PATH?"
    read -p "Press Enter to exit..." # Pause
    exit 1
fi

echo "Backend dependencies installed successfully."
echo "You can now proceed to run the indexer (if needed) and the server."
read -p "Press Enter to close this window..." # Pause
# Optionally navigate back to the original directory if needed
# cd "$SCRIPT_DIR" || exit 1
exit 0