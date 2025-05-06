// --- Core Modules ---
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const mime = require('mime-types');
const cron = require('node-cron');

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'converted');

// --- Ensure Directories Exist ---
// These operations are synchronous, which is acceptable at startup.
try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log("Upload and Converted directories checked/created.");
} catch (err) {
    console.error("Error creating directories:", err);
    process.exit(1); // Exit if we can't create essential folders
}


// --- Middleware ---
app.use(cors()); // Allows requests from frontend origins
app.use(express.json()); // Parses JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parses URL-encoded request bodies

// --- Multer Configuration (File Uploads) ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR); // Save uploads to the 'uploads' directory
    },
    filename: function (req, file, cb) {
        // Generate unique filename, keeping original extension
        const uniqueSuffix = uuidv4();
        const extension = path.extname(file.originalname) || '';
        cb(null, uniqueSuffix + extension);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB file size limit
});

// --- Conversion Rule Definitions (EXPANDED & Checked) ---
const CONVERSION_RULES = {
    // Images
    'image': { validTargets: ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'], tool: 'magick', getArgs: (input, output, format) => ['convert', input, output], getOutputExt: (format) => format },
    'image/svg+xml': { validTargets: ['png', 'jpg', 'webp', 'pdf'], tool: 'magick', getArgs: (input, output, format) => ['convert', '-density', '150', input, output], getOutputExt: (format) => format },
    // Audio
    'audio': { validTargets: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'aiff'], tool: 'ffmpeg', getArgs: (input, output, format) => ['-i', input, '-vn', '-ar', '44100', '-ac', '2', output], getOutputExt: (format) => format },
    // Video
    'video': { validTargets: ['gif-anim', 'mp3-extract', 'mp4-basic', 'mkv', 'mov', 'avi', 'webm'], tool: 'ffmpeg', getArgs: (input, output, format) => { if (format === 'gif-anim') return ['-i', input, '-vf', 'fps=15,scale=480:-1:flags=lanczos', '-loop', '0', output]; if (format === 'mp3-extract') return ['-i', input, '-vn', '-q:a', '0', '-map', 'a', output]; if (format === 'mp4-basic') return ['-i', input, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output]; if (format === 'mkv') return ['-i', input, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', output]; if (format === 'mov') return ['-i', input, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output]; if (format === 'avi') return ['-i', input, '-c:v', 'libxvid', '-q:v', '4', '-c:a', 'libmp3lame', '-q:a', '4', output]; if (format === 'webm') return ['-i', input, '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k', output]; return []; }, getOutputExt: (format) => { const extMap = { 'gif-anim': 'gif', 'mp3-extract': 'mp3', 'mp4-basic': 'mp4' }; return extMap[format] || format; } },
    // Documents
    'application/pdf': { validTargets: ['txt', 'png', 'jpg'], tool: (format) => format === 'txt' ? 'pdftotext' : 'magick', getArgs: (input, output, format) => { if (format === 'txt') return [input, output.replace(path.extname(output), '.txt')]; if (['png', 'jpg'].includes(format)) return ['convert', '-density', '150', `${input}[0]`, '-quality', '90', output]; return []; }, getOutputExt: (format) => format },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { validTargets: ['pdf', 'txt', 'html', 'odt', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input], getOutputExt: (format) => format },
    'application/vnd.oasis.opendocument.text': { validTargets: ['pdf', 'txt', 'html', 'docx', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input], getOutputExt: (format) => format },
    'application/rtf': { validTargets: ['pdf', 'txt', 'html', 'docx', 'odt', 'md', 'epub'], tool: (format) => ['md', 'html', 'epub', 'txt'].includes(format) ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => ['md', 'html', 'epub', 'txt'].includes(format) ? ['-s', input, '-o', outputOrDir] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input], getOutputExt: (format) => format },
    'application/msword': { validTargets: ['pdf', 'txt', 'html', 'odt', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input], getOutputExt: (format) => format },
    'text/plain': { validTargets: ['pdf', 'html', 'md', 'epub'], tool: 'pandoc', getArgs: (input, output, format) => ['-s', input, '-o', output], getOutputExt: (format) => format },
    'text/markdown': { validTargets: ['html', 'pdf', 'epub', 'docx', 'odt', 'rtf'], tool: 'pandoc', getArgs: (input, output, format) => ['-s', input, '-o', output], getOutputExt: (format) => format },
    'spreadsheet': { validTargets: ['pdf'], tool: 'soffice', getArgs: (input, outputDir, format) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, input], getOutputExt: (format) => 'pdf' },
    'presentation': { validTargets: ['pdf'], tool: 'soffice', getArgs: (input, outputDir, format) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, input], getOutputExt: (format) => 'pdf' },
    // Archive Creation
    'archive-create': { validTargets: ['zip', 'tar.gz', 'tar.bz2', 'tar', '7z'], tool: (format) => { if (format.startsWith('tar')) return 'tar'; if (format === '7z') return '7z'; return 'zip'; }, getArgs: (input, output, format, originalName) => { const inputFilename = originalName || path.basename(input); let correctExt = format.includes('.') ? `.${format}` : `.${format}`; if (format === 'tar') correctExt = '.tar'; let finalOutput = output.toLowerCase().endsWith(correctExt) ? output : path.join(path.dirname(output), path.basename(output, path.extname(output)) + correctExt); if (format === 'zip') return ['-j', finalOutput, input]; if (format === 'tar.gz') return ['-czvf', finalOutput, '-C', path.dirname(input), path.basename(input)]; if (format === 'tar.bz2') return ['-cjvf', finalOutput, '-C', path.dirname(input), path.basename(input)]; if (format === 'tar') return ['-cvf', finalOutput, '-C', path.dirname(input), path.basename(input)]; if (format === '7z') return ['a', finalOutput, input]; return []; }, getOutputExt: (format) => format }
}; // End CONVERSION_RULES

// --- Helper Function: Find Conversion Rule (Checked) ---
function findRule(mimeType, targetFormat) {
    const mainType = mimeType.split('/')[0];
    // Handle archive creation first
    if (['zip', 'tar.gz', 'tar.bz2', 'tar', '7z'].includes(targetFormat)) { const createRule = CONVERSION_RULES['archive-create']; if (createRule && createRule.validTargets.includes(targetFormat)) return createRule; }
    // Specific MIME types take precedence
    let rule = CONVERSION_RULES[mimeType];
    // Fallbacks for common variations / less specific types
    if (!rule && mimeType === 'text/rtf') rule = CONVERSION_RULES['application/rtf'];
    if (!rule && mimeType.startsWith('text/markdown')) rule = CONVERSION_RULES['text/markdown'];
    if (!rule && mimeType === 'image/jpeg') rule = CONVERSION_RULES['image'];
    if (!rule && mimeType === 'image/tiff') rule = CONVERSION_RULES['image'];
    if (!rule && mimeType.startsWith('audio/')) rule = CONVERSION_RULES['audio'];
    if (!rule && mimeType.startsWith('video/')) rule = CONVERSION_RULES['video'];
    if (!rule && mimeType === 'application/msword') rule = CONVERSION_RULES['application/msword'];
    // Generic fallbacks for broader categories IF NO specific rule was found yet
    if (!rule && ['image', 'audio', 'video', 'text'].includes(mainType)) { rule = CONVERSION_RULES[mainType]; }
    // Fallback for general office documents to the DOCX/soffice rule
    if (!rule && ( mimeType.includes('opendocument.text') || mimeType.includes('wordprocessingml.document') || mimeType === 'application/msword' )) { rule = CONVERSION_RULES['application/vnd.openxmlformats-officedocument.wordprocessingml.document']; }
    // Fallback for Spreadsheets -> PDF only
    if (!rule && (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('sheet'))) { rule = CONVERSION_RULES['spreadsheet']; }
    // Fallback for Presentations -> PDF only
     if (!rule && (mimeType.includes('presentation') || mimeType.includes('powerpoint') || mimeType.includes('slides'))) { rule = CONVERSION_RULES['presentation']; }
    // Final check if the found rule supports the target format
    if (rule && rule.validTargets.includes(targetFormat)) { return rule; }
    return null; // No applicable rule found
} // End findRule

// --- Helper Function: Handle Process Completion (Checked) ---
function handleProcessCompletion(code, outputFilename, stderrOutput, res, outputPathForCleanup = null) {
    if (code === 0) {
        console.log(`Conversion successful: ${outputFilename}`);
        if (!res.headersSent) {
            const fullSavedPath = path.join(OUTPUT_DIR, outputFilename);
            console.log(`Reporting success, file at: ${fullSavedPath}`);
            res.status(200).json({ message: 'Conversion successful!', downloadId: outputFilename, savedPath: fullSavedPath });
        }
    } else {
        console.error(`Conversion failed with code ${code}. Stderr: ${stderrOutput}`);
        if (outputPathForCleanup) {
             fs.unlink(outputPathForCleanup, (err) => { if (err && err.code !== 'ENOENT') console.error("Error deleting failed output file:", err); else if (!err) console.log("Cleaned up failed output file:", outputPathForCleanup); });
        }
        if (!res.headersSent) {
            res.status(500).json({ error: 'Conversion failed.', details: stderrOutput ? 'Tool reported an error.' : `Process exited with code ${code}. Check server logs.` });
        }
    }
} // End handleProcessCompletion

// --- Main Conversion Function (Checked) ---
async function processConversion(uploadedFile, targetFormat, res) {
    console.log(`Starting conversion for ${uploadedFile.originalname} to ${targetFormat}`);
    const inputPath = uploadedFile.path;
    let outputPath = ''; let outputFilename = ''; let mimeType = 'unknown';
    try {
        // 1. Detect Input Type
        let detectedType = null;
        try { const { fileTypeFromFile } = await import('file-type'); detectedType = await fileTypeFromFile(inputPath); }
        catch (importError) { console.error("Error dynamically importing 'file-type', continuing without it:", importError.message); }
        mimeType = detectedType ? detectedType.mime : (uploadedFile.mimetype || 'unknown');
        if (mimeType === 'unknown' || mimeType === 'application/octet-stream') { const extensionBasedMime = mime.lookup(uploadedFile.originalname); if (extensionBasedMime) { console.warn(`MIME type detection was generic/unknown (${mimeType}), falling back to type based on extension: ${extensionBasedMime}`); mimeType = extensionBasedMime; } if (path.extname(uploadedFile.originalname).toLowerCase() === '.md' && mimeType !== 'text/markdown') { console.warn(`Overriding MIME type to text/markdown based on .md extension.`); mimeType = 'text/markdown'; } }
        console.log(`Using MIME: ${mimeType} (Detected: ${detectedType?.mime}, Original Upload Mime: ${uploadedFile.mimetype})`);
        if (mimeType === 'unknown' || mimeType === 'application/octet-stream') { throw new Error('Could not determine a usable input file type.'); }

        // 2. Find/Validate Rule
        const rule = findRule(mimeType, targetFormat);
        if (!rule) throw new Error(`Conversion from '${mimeType}' to '${targetFormat}' is not supported.`);
        console.log(`Using rule for type: ${mimeType}`);

        // 3. Determine Tool, Args, Output
        const outputExt = rule.getOutputExt(targetFormat);
        if (!outputExt || outputExt === 'unknown') throw new Error(`Internal error: Invalid output extension for format: ${targetFormat}`);
        outputFilename = `${uuidv4()}.${outputExt}`;
        outputPath = path.join(OUTPUT_DIR, outputFilename);
        const command = typeof rule.tool === 'function' ? rule.tool(targetFormat) : rule.tool;
        let args; let isLibreOffice = command === 'soffice';
        if (isLibreOffice) args = rule.getArgs(inputPath, OUTPUT_DIR, targetFormat);
        else args = rule.getArgs(inputPath, outputPath, targetFormat, uploadedFile.originalname);
        if (!command || !args || args.length === 0) throw new Error("Internal error: Invalid conversion rule configuration.");

        // 4. Execute Command
        console.log(`Executing: ${command} ${args.join(' ')}`);
        const conversionProcess = spawn(command, args);
        let stderrOutput = ''; let stdoutOutput = '';
        conversionProcess.stdout.on('data', (data) => { stdoutOutput += data.toString(); });
        conversionProcess.stderr.on('data', (data) => { stderrOutput += data.toString(); });

        // 5. Handle Process Exit (Promisified)
        await new Promise((resolve, reject) => {
             conversionProcess.on('close', (code) => {
                console.log(`stdout: ${stdoutOutput}`); console.error(`stderr: ${stderrOutput}`);
                console.log(`Conversion process exited with code ${code}`);
                fs.unlink(inputPath, (err) => { if (err) console.error("Cleanup Error (Original Upload):", err); else console.log("Cleaned up original upload:", inputPath); });

                if (isLibreOffice && code === 0) {
                    const baseInputName = path.basename(inputPath, path.extname(inputPath));
                    const predictedOutputPath = path.join(OUTPUT_DIR, `${baseInputName}.${outputExt}`);
                    const finalUuidPath = outputPath; // Path with our desired UUID name
                    fs.rename(predictedOutputPath, finalUuidPath, (renameErr) => {
                        if (renameErr) { console.error(`Error renaming LO output from ${predictedOutputPath} to ${finalUuidPath}:`, renameErr); handleProcessCompletion(code, outputFilename, `Rename Warning: ${renameErr.message}. ${stderrOutput}`, res); }
                        else { console.log("Renamed LO output to:", finalUuidPath); handleProcessCompletion(code, outputFilename, stderrOutput, res); }
                        resolve(); // Resolve after rename attempt
                    });
                } else {
                    handleProcessCompletion(code, outputFilename, stderrOutput, res, code !== 0 ? outputPath : null); // Cleanup output only on failure
                    resolve(); // Resolve after handling
                }
             }); // End 'close' listener

             conversionProcess.on('error', (spawnError) => {
                 console.error(`Failed to start subprocess '${command}'. Is it installed/PATH?`, spawnError);
                 fs.unlink(inputPath, (unlinkErr) => { if (unlinkErr) console.error("Cleanup Error (Spawn Error):", unlinkErr); });
                 if (!res.headersSent) { res.status(500).json({ error: `Server error: Failed to start conversion tool ('${command}').` }); }
                 reject(spawnError); // Reject promise
             }); // End 'error' listener
         }); // End Promise

    } catch (error) { // Catch sync errors/validation failures
        console.error("Error during conversion process:", error.message);
        fs.unlink(inputPath, (err) => { if (err) console.error("Cleanup Error (Catch Block - Input):", err); });
        if (outputPath) { fs.unlink(outputPath, (err) => { if (err && err.code !== 'ENOENT') console.error("Cleanup Error (Catch Block - Output):", err); }); }
        if (!res.headersSent) { const isKnownError = error.message.includes('Conversion from') || error.message.includes('Could not determine'); res.status(isKnownError ? 400 : 500).json({ error: isKnownError ? error.message : 'An unexpected server error occurred.' }); }
    }
} // End processConversion

// --- ROUTES (Checked) ---
app.get('/', (req, res) => {
    res.send('Fycon Backend is Running!');
});

app.post('/convert', upload.single('inputFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const targetFormat = req.body.targetFormat;
    if (!targetFormat) { fs.unlink(req.file.path, (err) => { if (err) console.error("Error deleting orphaned upload:", err);}); return res.status(400).json({ error: 'No target format specified.' }); }
    // Call async conversion function - response is handled within it or its helpers
    processConversion(req.file, targetFormat, res);
});

app.get('/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    console.log(`Download request received for fileId: ${fileId}`);
    const safePattern = /^[a-zA-Z0-9\-.]+$/;
    if (!fileId || !safePattern.test(fileId)) { console.warn(`Invalid fileId requested: ${fileId}`); return res.status(400).json({ error: 'Invalid file identifier.' }); }
    const filePath = path.join(OUTPUT_DIR, fileId);
    console.log(`Attempting to serve file from path: ${filePath}`);
    fs.access(filePath, fs.constants.R_OK, (err) => {
        if (err) { console.error(`Error accessing file for download: ${filePath}`, err); return res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.code === 'ENOENT' ? 'File not found or expired.' : 'Server error accessing file.' }); }
        res.download(filePath, fileId, (downloadErr) => {
            if (downloadErr) { console.error(`Error during file download stream for ${fileId}:`, downloadErr); }
             else { console.log(`Successfully sent file ${fileId} for download.`); }
            // Immediate deletion after download is commented out - rely on cron
        });
    });
}); // End /download route

// --- Scheduled Cleanup Task (Checked) ---
cron.schedule('0 */6 * * *', () => {
    console.log('[Cron] Running scheduled cleanup task...');
    const now = Date.now(); const maxAge = 6 * 60 * 60 * 1000; // 6 hours
    const cleanupDirectory = (directory) => {
        fs.readdir(directory, { withFileTypes: true }, (err, files) => {
            if (err) { console.error(`[Cron] Error reading directory: ${directory}`, err); return; }
            files.forEach(file => {
                if (!file.isFile()) return; // Skip directories
                const filePath = path.join(directory, file.name);
                fs.stat(filePath, (statErr, stats) => {
                    if (statErr) { if(statErr.code !== 'ENOENT') console.error(`[Cron] Error getting stats: ${filePath}`, statErr); return; }
                    if (now - stats.mtimeMs > maxAge) {
                        console.log(`[Cron] Deleting old file: ${filePath}`);
                        fs.unlink(filePath, (unlinkErr) => { if (unlinkErr && unlinkErr.code !== 'ENOENT') console.error(`[Cron] Error deleting: ${filePath}`, unlinkErr); });
                    }
                });
            });
        });
    };
    cleanupDirectory(UPLOAD_DIR);
    cleanupDirectory(OUTPUT_DIR);
}); // End cron schedule

// --- Start Server (Checked) ---
app.listen(PORT, () => {
    console.log(`Fycon backend listening on http://localhost:${PORT}`);
    console.log(`Uploads directory: ${UPLOAD_DIR}`);
    console.log(`Converted files directory: ${OUTPUT_DIR}`);
}); // End app.listen