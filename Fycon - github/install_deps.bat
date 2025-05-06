@echo off
echo Navigating to backend directory...

:: Navigate relative to the batch script's location
cd "%~dp0Orbe-backend"  :: Ensure this matches your backend folder name
if %errorlevel% neq 0 (
    echo Error: Could not find Orbe-backend directory relative to this script.
    echo Make sure this script is in the main project folder (e.g., Orbe v1.2).
    pause
    exit /b 1
)

echo Installing backend dependencies using npm...
npm install
if %errorlevel% neq 0 (
    echo Error: npm install failed. Is Node.js and npm installed and added to your system PATH?
    pause
    exit /b 1
)

echo Backend dependencies installed successfully.
echo You can now proceed to run the indexer (if needed) and the server.
pause
exit /b 0