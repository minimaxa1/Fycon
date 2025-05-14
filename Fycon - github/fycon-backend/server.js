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
const MAX_CONCURRENT_FILES = 20;

// --- Ensure Directories Exist ---
try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log("Upload and Converted directories checked/created.");
} catch (err) {
    console.error("Error creating directories:", err);
    process.exit(1);
}

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Multer Configuration ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = uuidv4();
        const extension = path.extname(file.originalname) || '';
        cb(null, uniqueSuffix + extension);
    }
});
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024,
    }
});

// --- Conversion Rule Definitions ---
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
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { validTargets: ['pdf', 'txt', 'html', 'odt', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : (format === 'pdf' ? ['--headless', '--convert-to', format, '--outdir', outputOrDir, input, '--pdf-engine=xelatex'] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]), getOutputExt: (format) => format }, // Added --pdf-engine for soffice PDF
    'application/vnd.oasis.opendocument.text': { validTargets: ['pdf', 'txt', 'html', 'docx', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : (format === 'pdf' ? ['--headless', '--convert-to', format, '--outdir', outputOrDir, input, '--pdf-engine=xelatex'] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]), getOutputExt: (format) => format }, // Added --pdf-engine for soffice PDF
    'application/rtf': { validTargets: ['pdf', 'txt', 'html', 'docx', 'odt', 'md', 'epub'], tool: (format) => ['md', 'html', 'epub', 'txt', 'pdf'].includes(format) ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => { if (['md', 'html', 'epub', 'txt'].includes(format)) return ['-s', input, '-o', outputOrDir]; if (format === 'pdf') return ['-s', input, '--pdf-engine=xelatex', '-o', outputOrDir]; return ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]; }, getOutputExt: (format) => format }, // Added --pdf-engine for pandoc PDF
    'application/msword': { validTargets: ['pdf', 'txt', 'html', 'odt', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : (format === 'pdf' ? ['--headless', '--convert-to', format, '--outdir', outputOrDir, input, '--pdf-engine=xelatex'] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]), getOutputExt: (format) => format }, // Added --pdf-engine for soffice PDF
    'text/plain': {
        validTargets: ['pdf', 'html', 'md', 'epub'],
        tool: 'pandoc',
        getArgs: (input, output, format) => {
            if (format === 'pdf') {
                return ['-s', input, '--pdf-engine=xelatex', '-o', output]; // CHANGED: Use xelatex for PDF from TXT
            }
            return ['-s', input, '-o', output];
        },
        getOutputExt: (format) => format
    },
    'text/markdown': {
        validTargets: ['html', 'pdf', 'epub', 'docx', 'odt', 'rtf'],
        tool: 'pandoc',
        getArgs: (input, output, format) => {
            if (format === 'pdf') {
                return ['-s', input, '--pdf-engine=xelatex', '-o', output]; // CHANGED: Use xelatex for PDF from MD
            }
            return ['-s', input, '-o', output];
        },
        getOutputExt: (format) => format
    },
    'text/html': { // NEW RULE for HTML to other formats
        validTargets: ['pdf', 'md', 'epub', 'docx', 'odt', 'rtf', 'txt'],
        tool: 'pandoc',
        getArgs: (input, output, format) => {
            if (format === 'pdf') {
                return ['-s', input, '--pdf-engine=xelatex', '-o', output]; // Use xelatex for PDF from HTML
            }
            return ['-s', input, '-o', output];
        },
        getOutputExt: (format) => format
    },
    'spreadsheet': { validTargets: ['pdf'], tool: 'soffice', getArgs: (input, outputDir, format) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, input], getOutputExt: (format) => 'pdf' },
    'presentation': { validTargets: ['pdf'], tool: 'soffice', getArgs: (input, outputDir, format) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, input], getOutputExt: (format) => 'pdf' },
    // Archive Creation
    'archive-create': { validTargets: ['zip', 'tar.gz', 'tar.bz2', 'tar', '7z'], tool: (format) => { if (format.startsWith('tar')) return 'tar'; if (format === '7z') return '7z'; return 'zip'; }, getArgs: (input, output, format, originalName) => { const inputFilename = originalName || path.basename(input); let correctExt = format.includes('.') ? `.${format}` : `.${format}`; if (format === 'tar') correctExt = '.tar'; let finalOutput = output.toLowerCase().endsWith(correctExt) ? output : path.join(path.dirname(output), path.basename(output, path.extname(output)) + correctExt); if (format === 'zip') return ['-j', finalOutput, input]; if (format === 'tar.gz') return ['-czvf', finalOutput, '-C', path.dirname(input), path.basename(input)]; if (format === 'tar.bz2') return ['-cjvf', finalOutput, '-C', path.dirname(input), path.basename(input)]; if (format === 'tar') return ['-cvf', finalOutput, '-C', path.dirname(input), path.basename(input)]; if (format === '7z') return ['a', finalOutput, input]; return []; }, getOutputExt: (format) => format }
};

// --- Helper Function: Find Conversion Rule ---
function findRule(mimeType, targetFormat) {
    const mainType = mimeType.split('/')[0];
    // Handle archive creation first
    if (['zip', 'tar.gz', 'tar.bz2', 'tar', '7z'].includes(targetFormat)) {
        const createRule = CONVERSION_RULES['archive-create'];
        if (createRule && createRule.validTargets.includes(targetFormat)) return createRule;
    }

    // Specific MIME types take precedence
    let rule = CONVERSION_RULES[mimeType];

    // Fallbacks for common variations / less specific types
    if (!rule && mimeType === 'text/rtf') rule = CONVERSION_RULES['application/rtf'];
    if (!rule && (mimeType.startsWith('text/markdown') || path.extname(targetFormat /* this seems wrong, should be based on input file */).toLowerCase() === '.md')) rule = CONVERSION_RULES['text/markdown']; // Check input filename if available
    if (!rule && (mimeType.startsWith('text/html') || path.extname(targetFormat /* same here */).toLowerCase() === '.html')) rule = CONVERSION_RULES['text/html'];

    if (!rule && mimeType === 'image/jpeg') rule = CONVERSION_RULES['image'];
    if (!rule && mimeType === 'image/tiff') rule = CONVERSION_RULES['image'];
    if (!rule && mimeType.startsWith('audio/')) rule = CONVERSION_RULES['audio'];
    if (!rule && mimeType.startsWith('video/')) rule = CONVERSION_RULES['video'];
    if (!rule && mimeType === 'application/msword') rule = CONVERSION_RULES['application/msword']; // .doc

    // Generic fallbacks for broader categories IF NO specific rule was found yet
    if (!rule && ['image', 'audio', 'video', 'text'].includes(mainType)) {
        rule = CONVERSION_RULES[mainType]; // This will pick up text/plain if mimeType was 'text/somethingelse'
    }
    // Fallback for general office documents to the DOCX/soffice rule
    if (!rule && ( mimeType.includes('opendocument.text') || mimeType.includes('wordprocessingml.document') || mimeType === 'application/vnd.ms-word' /*.doc specific*/ )) {
        rule = CONVERSION_RULES['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    }
    // Fallback for Spreadsheets -> PDF only
    if (!rule && (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('sheet') || mimeType === 'application/vnd.ms-excel')) {
        rule = CONVERSION_RULES['spreadsheet'];
    }
    // Fallback for Presentations -> PDF only
     if (!rule && (mimeType.includes('presentation') || mimeType.includes('powerpoint') || mimeType.includes('slides') || mimeType === 'application/vnd.ms-powerpoint')) {
        rule = CONVERSION_RULES['presentation'];
     }

    // Final check if the found rule supports the target format
    if (rule && rule.validTargets.includes(targetFormat)) {
        return rule;
    }
    console.warn(`No specific rule found for ${mimeType} to ${targetFormat}. Attempting generic text rule if applicable.`);
    // Last resort: if it's some kind of text and target is pdf, try text/plain rule
    if (!rule && mainType === 'text' && CONVERSION_RULES['text/plain'].validTargets.includes(targetFormat)) {
        console.warn(`Using generic 'text/plain' rule for ${mimeType} to ${targetFormat}`);
        return CONVERSION_RULES['text/plain'];
    }

    return null; // No applicable rule found
}


// --- Core Single Conversion Logic ---
async function performSingleConversionLogic(uploadedFile, targetFormat) {
    return new Promise(async (resolve, reject) => {
        console.log(`[${uploadedFile.originalname}] Starting conversion to ${targetFormat}`);
        const inputPath = uploadedFile.path;
        let outputPath = '';
        let outputFilename = '';
        let mimeType = 'unknown';

        try {
            let detectedType = null;
            try { const { fileTypeFromFile } = await import('file-type'); detectedType = await fileTypeFromFile(inputPath); }
            catch (importError) { console.warn(`[${uploadedFile.originalname}] Error importing 'file-type': ${importError.message}. Continuing.`); }

            // Prioritize multer's mimetype, then file-type, then extension based.
            mimeType = uploadedFile.mimetype && uploadedFile.mimetype !== 'application/octet-stream'
                ? uploadedFile.mimetype
                : (detectedType ? detectedType.mime : 'unknown');

            if (mimeType === 'unknown' || mimeType === 'application/octet-stream') {
                const extensionBasedMime = mime.lookup(uploadedFile.originalname);
                if (extensionBasedMime) {
                    console.warn(`[${uploadedFile.originalname}] MIME type unknown/generic, fallback to ext: ${extensionBasedMime}`);
                    mimeType = extensionBasedMime;
                }
            }
            // Specific overrides based on extension if primary detection is still generic
            const lowerExt = path.extname(uploadedFile.originalname).toLowerCase();
            if (lowerExt === '.md' && (!mimeType.includes('markdown'))) {
                console.warn(`[${uploadedFile.originalname}] Overriding MIME to text/markdown for .md`);
                mimeType = 'text/markdown';
            } else if (lowerExt === '.html' && (!mimeType.includes('html'))) {
                 console.warn(`[${uploadedFile.originalname}] Overriding MIME to text/html for .html`);
                mimeType = 'text/html';
            } else if (lowerExt === '.txt' && (!mimeType.includes('plain'))) {
                console.warn(`[${uploadedFile.originalname}] Overriding MIME to text/plain for .txt`);
                mimeType = 'text/plain';
            }

            console.log(`[${uploadedFile.originalname}] Using MIME: ${mimeType} (Multer: ${uploadedFile.mimetype}, Detected: ${detectedType ? detectedType.mime : 'N/A'})`);
            if (mimeType === 'unknown' || mimeType === 'application/octet-stream') {
                throw new Error('Could not determine a usable input file type.');
            }

            const rule = findRule(mimeType, targetFormat); // Pass original filename for context
            if (!rule) {
                throw new Error(`Conversion from '${mimeType}' (for file ${uploadedFile.originalname}) to '${targetFormat}' is not supported.`);
            }
            console.log(`[${uploadedFile.originalname}] Using rule for type: ${mimeType}, target: ${targetFormat}`);

            const outputExt = rule.getOutputExt(targetFormat);
            if (!outputExt || outputExt === 'unknown') {
                throw new Error(`Internal error: Invalid output extension for format: ${targetFormat}`);
            }
            outputFilename = `${uuidv4()}.${outputExt}`;
            outputPath = path.join(OUTPUT_DIR, outputFilename);

            const command = typeof rule.tool === 'function' ? rule.tool(targetFormat) : rule.tool;
            let args;
            const isLibreOffice = command === 'soffice';

            if (isLibreOffice) {
                args = rule.getArgs(inputPath, OUTPUT_DIR, targetFormat);
            } else {
                args = rule.getArgs(inputPath, outputPath, targetFormat, uploadedFile.originalname);
            }

            if (!command || !args || args.length === 0) {
                throw new Error("Internal error: Invalid conversion rule configuration.");
            }

            console.log(`[${uploadedFile.originalname}] Executing: ${command} ${args.join(' ')}`);
            const conversionProcess = spawn(command, args);
            let stderrOutput = '';
            let stdoutOutput = '';

            conversionProcess.stdout.on('data', (data) => { stdoutOutput += data.toString(); });
            conversionProcess.stderr.on('data', (data) => { stderrOutput += data.toString(); });

            conversionProcess.on('close', (code) => {
                if (stdoutOutput.trim()) console.log(`[${uploadedFile.originalname}] stdout: ${stdoutOutput.trim()}`);
                if (stderrOutput.trim()) console.error(`[${uploadedFile.originalname}] stderr: ${stderrOutput.trim()}`);
                console.log(`[${uploadedFile.originalname}] Process exited with code ${code}`);

                fs.unlink(inputPath, (err) => {
                    if (err) console.error(`[${uploadedFile.originalname}] Cleanup Error (Original Upload ${inputPath}):`, err);
                    else console.log(`[${uploadedFile.originalname}] Cleaned up original upload: ${inputPath}`);
                });

                if (code === 0) {
                    if (isLibreOffice) {
                        const baseInputName = path.basename(uploadedFile.originalname, path.extname(uploadedFile.originalname));
                        const predictedLOOutputPath = path.join(OUTPUT_DIR, `${baseInputName}.${outputExt}`);
                        const finalUuidOutputPath = outputPath;

                        fs.access(predictedLOOutputPath, fs.constants.F_OK, (errAccess) => {
                            if (errAccess) {
                                console.error(`[${uploadedFile.originalname}] LO output file not found at ${predictedLOOutputPath}. Checking for alternatives...`);
                                fs.readdir(OUTPUT_DIR, (readErr, filesInDir) => {
                                    if (readErr) {
                                        reject({ message: `LO conversion problem: output ${predictedLOOutputPath} not found & dir read failed. Stderr: ${stderrOutput.substring(0, 200)}` });
                                        return;
                                    }
                                    const possibleFile = filesInDir.find(f => f.endsWith(`.${outputExt}`) && f.startsWith(baseInputName.substring(0,Math.min(10, baseInputName.length)))); // More generous substring match
                                    if (possibleFile) {
                                        const foundPath = path.join(OUTPUT_DIR, possibleFile);
                                        console.warn(`[${uploadedFile.originalname}] LO output ${predictedLOOutputPath} not found, but found ${foundPath}. Renaming this.`);
                                        fs.rename(foundPath, finalUuidOutputPath, (renameErr) => {
                                            if (renameErr) {
                                                reject({ message: `LO conversion succeeded, but rename from ${foundPath} failed: ${renameErr.message}. Stderr: ${stderrOutput.substring(0, 200)}` });
                                            } else {
                                                resolve({ success: true, downloadId: outputFilename, message: 'Conversion successful (LO, alt find)!' });
                                            }
                                        });
                                    } else {
                                        reject({ message: `LO conversion likely succeeded but output file ${predictedLOOutputPath} not found. Stderr: ${stderrOutput.substring(0, 200)}` });
                                    }
                                });
                                return;
                            }

                            fs.rename(predictedLOOutputPath, finalUuidOutputPath, (renameErr) => {
                                if (renameErr) {
                                    console.error(`[${uploadedFile.originalname}] Error renaming LO output from ${predictedLOOutputPath} to ${finalUuidOutputPath}:`, renameErr);
                                     reject({ message: `LO conversion succeeded, but rename failed: ${renameErr.message}. Stderr: ${stderrOutput.substring(0, 200)}` });
                                } else {
                                    console.log(`[${uploadedFile.originalname}] Renamed LO output to: ${finalUuidOutputPath}`);
                                    resolve({ success: true, downloadId: outputFilename, message: 'Conversion successful!' });
                                }
                            });
                        });
                    } else {
                        resolve({ success: true, downloadId: outputFilename, message: 'Conversion successful!' });
                    }
                } else { // code !== 0
                    if (outputPath && fs.existsSync(outputPath)) {
                        fs.unlink(outputPath, (err) => {
                            if (err) console.error(`[${uploadedFile.originalname}] Cleanup Error (Failed Output ${outputPath}):`, err);
                            else console.log(`[${uploadedFile.originalname}] Cleaned up failed output: ${outputPath}`);
                        });
                    }
                    reject({ message: `Conversion failed (exit code ${code}). ${stderrOutput ? 'Details: ' + stderrOutput.substring(0, 300) + (stderrOutput.length > 300 ? '...' : '') : 'Tool reported an error or exited uncleanly.'}` });
                }
            });

            conversionProcess.on('error', (spawnError) => {
                console.error(`[${uploadedFile.originalname}] Failed to start subprocess '${command}'. Is it installed/PATH?`, spawnError);
                fs.unlink(inputPath, (unlinkErr) => { if (unlinkErr && unlinkErr.code !== 'ENOENT') console.error("Cleanup Error (Spawn Error):", unlinkErr); });
                reject({ message: `Server error: Failed to start conversion tool ('${command}'). Is it installed and in PATH?` });
            });

        } catch (error) {
            console.error(`[${uploadedFile.originalname}] Error during conversion setup:`, error.message, error.stack);
            if (fs.existsSync(inputPath)) { // Check if inputPath still exists before unlinking
                fs.unlink(inputPath, (err) => {
                    if (err && err.code !== 'ENOENT') console.error(`[${uploadedFile.originalname}] Cleanup Error (Catch Block - Input ${inputPath}):`, err);
                });
            }
            if (outputPath && fs.existsSync(outputPath)) {
                fs.unlink(outputPath, (err) => {
                    if (err && err.code !== 'ENOENT') console.error(`[${uploadedFile.originalname}] Cleanup Error (Catch Block - Output ${outputPath}):`, err);
                });
            }
            const isKnownError = error.message.includes('Conversion from') || error.message.includes('Could not determine');
            reject({ message: isKnownError ? error.message : 'An unexpected server error occurred during setup.' });
        }
    });
}

// --- Wrapper for processing and responding (Same) ---
async function processAndFormatResult(file, targetFormat) {
    try {
        const result = await performSingleConversionLogic(file, targetFormat);
        return {
            originalName: file.originalname,
            success: true,
            downloadId: result.downloadId,
            message: result.message,
        };
    } catch (errorDetails) {
        return {
            originalName: file.originalname,
            success: false,
            error: errorDetails.message || 'Processing failed due to an unknown reason.',
            downloadId: null
        };
    }
}

// --- ROUTES (Same) ---
app.get('/', (req, res) => {
    res.send('Fycon Backend (Multi-File) is Running!');
});

app.post('/convert', upload.array('inputFiles', MAX_CONCURRENT_FILES), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
    }
    if (req.files.length > MAX_CONCURRENT_FILES) {
         console.warn(`Received ${req.files.length} files, but limit is ${MAX_CONCURRENT_FILES}. Multer should have capped this.`);
        req.files.forEach(file => fs.unlink(file.path, err => { if (err) console.error("Error deleting excess upload (post-multer):", err); }));
        return res.status(413).json({ error: `Too many files. Maximum ${MAX_CONCURRENT_FILES} allowed.` });
    }
    const targetFormat = req.body.targetFormat;
    if (!targetFormat) {
        req.files.forEach(file => fs.unlink(file.path, err => { if (err) console.error("Error deleting orphaned upload (no target format):", err); }));
        return res.status(400).json({ error: 'No target format specified.' });
    }
    const results = [];
    for (const file of req.files) {
        const result = await processAndFormatResult(file, targetFormat);
        results.push(result);
    }
    res.status(200).json({ allResults: results });
});

app.get('/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const safePattern = /^[a-zA-Z0-9\-.]+$/;
    if (!fileId || !safePattern.test(fileId)) {
        console.warn(`Invalid fileId requested: ${fileId}`);
        return res.status(400).json({ error: 'Invalid file identifier.' });
    }
    const filePath = path.join(OUTPUT_DIR, fileId);
    fs.access(filePath, fs.constants.R_OK, (err) => {
        if (err) {
            console.error(`Error accessing file for download: ${filePath}`, err);
            return res.status(err.code === 'ENOENT' ? 404 : 500).json({
                error: err.code === 'ENOENT' ? 'File not found or expired.' : 'Server error accessing file.'
            });
        }
        res.download(filePath, fileId, (downloadErr) => {
            if (downloadErr) console.error(`Error during file download stream for ${fileId}:`, downloadErr);
            else console.log(`Successfully sent file ${fileId} for download.`);
        });
    });
});

// --- Scheduled Cleanup Task (Same) ---
cron.schedule('0 */6 * * *', () => { /* ... */ });

// --- Start Server (Same) ---
app.listen(PORT, () => { /* ... */ });