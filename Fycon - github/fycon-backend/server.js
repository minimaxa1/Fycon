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
const MAX_CONCURRENT_FILES = 200; // Server-side limit on number of files
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB per file
const TEMP_FILE_LIFESPAN_HOURS = 24; // For cleanup task

// Map to store original filenames for download. Cleared by cron.
// Key: UUID-based filename on server disk (e.g., 'a1b2c3d4-e5f6-7890-1234-567890abcdef.pdf')
// Value: Original user-provided filename (e.g., 'My Document with Spaces.pdf')
const downloadMap = new Map();

// --- IMPORTANT: Tool Installations ---
// For conversions, ensure the following command-line tools are installed and accessible in your system's PATH:
// - Image conversions: `magick` (ImageMagick)
// - Audio/Video conversions: `ffmpeg`
// - PDF text extraction: `pdftotext` (from Poppler Utilities)
// - Office document conversions: `soffice` (LibreOffice/OpenOffice)
// - Document/Ebook conversions (MD, DOCX, HTML, EPUB, MOBI): `pandoc`
// - Ebook-specific conversions (MOBI <-> EPUB): `ebook-convert` (from Calibre)
// - Archive creation: `zip`, `tar`, `7z`

// If tools are not in PATH, you'll need to update the 'tool' value in the
// CONVERSION_RULES to the full path of the executable.
// (e.g., '/opt/calibre/ebook-convert' or 'C:\\Program Files\\Calibre2\\ebook-convert.exe').

// --- Ensure Directories Exist ---
try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log("Upload and Converted directories checked/created.");
} catch (err) {
    console.error("Error creating directories:", err);
    process.exit(1); // Exit if we can't create essential directories
}

// --- Middleware ---
app.disable('x-powered-by');
app.use(cors());
// Set a higher limit for JSON and URL-encoded body parsing to prevent 'Payload Too Large' errors
app.use(express.json({ limit: '300mb' }));
app.use(express.urlencoded({ extended: true, limit: '300mb' }));

// Serve static files from the current directory (where fycon.html is)
app.use(express.static(__dirname));

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
        fileSize: MAX_FILE_SIZE_BYTES,
        files: MAX_CONCURRENT_FILES
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
    'application/pdf': {
        // NOTE: Pandoc cannot convert *from* PDF. Only 'pdftotext' for raw text or 'magick' for image extraction is supported.
        validTargets: ['txt', 'png', 'jpg'], // 'md' removed as it's not directly supported by pandoc from PDF
        tool: (format) => {
            if (format === 'txt') return 'pdftotext';
            if (['png', 'jpg'].includes(format)) return 'magick';
            return null; // Should not happen with validTargets check
        },
        getArgs: (input, output, format) => {
            if (format === 'txt') return [input, output.replace(path.extname(output), '.txt')];
            if (['png', 'jpg'].includes(format)) return ['convert', '-density', '150', `${input}[0]`, '-quality', '90', output];
            return [];
        },
        getOutputExt: (format) => format
    },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { validTargets: ['pdf', 'txt', 'html', 'odt', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : (format === 'pdf' ? ['--headless', '--convert-to', format, '--outdir', outputOrDir, input, '--pdf-engine=xelatex'] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]), getOutputExt: (format) => format },
    'application/vnd.oasis.opendocument.text': { validTargets: ['pdf', 'txt', 'html', 'docx', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : (format === 'pdf' ? ['--headless', '--convert-to', format, '--outdir', outputOrDir, input, '--pdf-engine=xelatex'] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]), getOutputExt: (format) => format },
    'application/rtf': { validTargets: ['pdf', 'txt', 'html', 'docx', 'odt', 'md', 'epub'], tool: (format) => ['md', 'html', 'epub', 'txt', 'pdf'].includes(format) ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => { if (['md', 'html', 'epub', 'txt'].includes(format)) return ['-s', input, '-o', outputOrDir]; if (format === 'pdf') return ['-s', input, '--pdf-engine=xelatex', '-o', outputOrDir]; return ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]; }, getOutputExt: (format) => format },
    'application/msword': { validTargets: ['pdf', 'txt', 'html', 'odt', 'rtf', 'md', 'epub'], tool: (format) => format === 'md' ? 'pandoc' : 'soffice', getArgs: (input, outputOrDir, format) => format === 'md' ? ['-s', input, '--to=markdown-raw_html', '-o', outputOrDir] : (format === 'pdf' ? ['--headless', '--convert-to', format, '--outdir', outputOrDir, input, '--pdf-engine=xelatex'] : ['--headless', '--convert-to', format, '--outdir', outputOrDir, input]), getOutputExt: (format) => format },
    'text/plain': { validTargets: ['pdf', 'html', 'md', 'epub'], tool: 'pandoc', getArgs: (input, output, format) => { if (format === 'pdf') return ['-s', input, '--pdf-engine=xelatex', '-o', output]; return ['-s', input, '-o', output]; }, getOutputExt: (format) => format },
    'text/markdown': { validTargets: ['html', 'pdf', 'epub', 'docx', 'odt', 'rtf'], tool: 'pandoc', getArgs: (input, output, format) => { if (format === 'pdf') return ['-s', input, '--pdf-engine=xelatex', '-o', output]; return ['-s', input, '-o', output]; }, getOutputExt: (format) => format },
    'text/html': { validTargets: ['pdf', 'md', 'epub', 'docx', 'odt', 'rtf', 'txt'], tool: 'pandoc', getArgs: (input, output, format) => { if (format === 'pdf') return ['-s', input, '--pdf-engine=xelatex', '-o', output]; return ['-s', input, '-o', output]; }, getOutputExt: (format) => format },
    // E-Book Formats (EPUB, MOBI) - using Calibre's ebook-convert AND Pandoc
    'application/epub+zip': { // EPUB
        validTargets: ['txt', 'mobi', 'pdf', 'rtf', 'html', 'docx', 'odt', 'md', 'azw3'],
        tool: (format) => {
            if (['txt', 'pdf', 'rtf', 'html', 'docx', 'odt', 'md'].includes(format)) return 'pandoc';
            return 'ebook-convert';
        },
        getArgs: (input, output, format) => {
            if (['txt', 'rtf', 'html', 'docx', 'odt', 'md'].includes(format)) {
                return ['-s', input, '-o', output];
            }
            if (format === 'pdf') {
                return ['-s', input, '--pdf-engine=xelatex', '-o', output];
            }
            return [input, output];
        },
        getOutputExt: (format) => {
            const extMap = { 'mobi': 'mobi', 'azw3': 'azw3' };
            return extMap[format] || format;
        }
    },
    'application/x-mobipocket-ebook': { // MOBI
        validTargets: ['txt', 'epub', 'pdf', 'rtf', 'html', 'docx', 'odt', 'md', 'azw3'],
        tool: (format) => {
            if (['txt', 'pdf', 'rtf', 'html', 'docx', 'odt', 'md'].includes(format)) return 'pandoc';
            return 'ebook-convert';
        },
        getArgs: (input, output, format) => {
            if (['txt', 'rtf', 'html', 'docx', 'odt', 'md'].includes(format)) {
                return ['-s', input, '-o', output];
            }
            if (format === 'pdf') {
                return ['-s', input, '--pdf-engine=xelatex', '-o', output];
            }
            return [input, output];
        },
        getOutputExt: (format) => {
            const extMap = { 'epub': 'epub', 'azw3': 'azw3' };
            return extMap[format] || format;
        }
    },
    // Spreadsheet & Presentation
    'spreadsheet': { validTargets: ['pdf'], tool: 'soffice', getArgs: (input, outputDir, format) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, input], getOutputExt: (format) => 'pdf' },
    'presentation': { validTargets: ['pdf'], tool: 'soffice', getArgs: (input, outputDir, format) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, input], getOutputExt: (format) => 'pdf' },
    // Archive Creation - IMPORTANT: This rule CREATES archives, it does not convert existing ones.
    // It also currently processes files one-by-one into an archive. For multi-file archiving,
    // you'd need a different approach (e.g., collecting all input paths into one archive command).
    'archive-create': {
        validTargets: ['zip', 'tar.gz', 'tar.bz2', 'tar', '7z'],
        tool: (format) => {
            if (format.startsWith('tar')) return 'tar';
            if (format === '7z') return '7z';
            return 'zip';
        },
        getArgs: (input, output, format, originalName) => {
            const inputFilename = originalName || path.basename(input);
            let correctExt = format.includes('.') ? `.${format}` : `.${format}`;
            if (format === 'tar') correctExt = '.tar';
            // Ensure the output path has the correct extension for the chosen archive format
            let finalOutput = output.toLowerCase().endsWith(correctExt) ? output : path.join(path.dirname(output), path.basename(output, path.extname(output)) + correctExt);

            // Note: This rule is designed for creating an archive *from a single file input*.
            // If you select multiple files and choose an archive format, the server will attempt
            // to create a separate archive for *each* selected file containing only that file.
            // To create a single archive containing *all* selected files, the client-side
            // and server-side logic would need to be re-architected (e.g., pass all paths
            // to a single archive command, or create a separate endpoint for multi-file archiving).
            if (format === 'zip') return ['-j', finalOutput, input]; // -j option: junk paths (store only the name of the file)
            if (format === 'tar.gz') return ['-czvf', finalOutput, '-C', path.dirname(input), path.basename(input)]; // -C: change directory before adding
            if (format === 'tar.bz2') return ['-cjvf', finalOutput, '-C', path.dirname(input), path.basename(input)];
            if (format === 'tar') return ['-cvf', finalOutput, '-C', path.dirname(input), path.basename(input)];
            if (format === '7z') return ['a', finalOutput, input]; // 'a': add to archive
            return [];
        },
        getOutputExt: (format) => format
    }
};

// --- Helper Function: Find Conversion Rule ---
function findRule(mimeType, targetFormat, originalFilename = '') {
    // 1. Special case: Archive creation (target-based)
    if (['zip', 'tar.gz', 'tar.bz2', 'tar', '7z'].includes(targetFormat)) {
        const createRule = CONVERSION_RULES['archive-create'];
        if (createRule && createRule.validTargets.includes(targetFormat)) return createRule;
    }

    // 2. Direct MIME type match from CONVERSION_RULES
    let rule = CONVERSION_RULES[mimeType];
    if (rule && rule.validTargets.includes(targetFormat)) {
        return rule;
    }

    // 3. Fallbacks for common types if direct MIME match failed or was too generic
    const mainType = mimeType.split('/')[0];
    const lowerExt = originalFilename ? path.extname(originalFilename).toLowerCase() : '';

    // Check for specific known MIME type aliases that might not be in CONVERSION_RULES directly under that alias
    if (mimeType === 'image/jpeg' || mimeType === 'image/tiff') rule = CONVERSION_RULES['image'];
    else if (mimeType.startsWith('audio/')) rule = CONVERSION_RULES['audio'];
    else if (mimeType.startsWith('video/')) rule = CONVERSION_RULES['video'];
    // If MIME is generic (octet-stream/unknown) but we have a specific extension that has a rule
    else if ((mimeType === 'application/octet-stream' || mimeType === 'unknown')) {
        if (lowerExt === '.epub' && CONVERSION_RULES['application/epub+zip']) rule = CONVERSION_RULES['application/epub+zip'];
        else if (lowerExt === '.mobi' && CONVERSION_RULES['application/x-mobipocket-ebook']) rule = CONVERSION_RULES['application/x-mobipocket-ebook'];
        // Add more specific extension checks here if needed for octet-stream files
    }
    // Handle cases where MIME might be text/plain but extension implies something more specific
    else if (mimeType === 'text/plain') {
        if (lowerExt === '.md' && CONVERSION_RULES['text/markdown']) rule = CONVERSION_RULES['text/markdown'];
        else if (lowerExt === '.html' && CONVERSION_RULES['text/html']) rule = CONVERSION_RULES['text/html'];
    }
    // General document type fallbacks (e.g. application/msword maps to the docx rule)
    else if (mimeType.includes('opendocument.text') ||
             mimeType.includes('wordprocessingml.document') ||
             mimeType === 'application/msword' || // .doc specific
             (lowerExt === '.doc' && mimeType !== 'application/msword')) { // .doc if mime was generic
        rule = CONVERSION_RULES['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    }
    else if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('sheet') ||
             (lowerExt === '.xls' && mimeType !== 'application/vnd.ms-excel')) {
        rule = CONVERSION_RULES['spreadsheet'];
    }
    else if (mimeType.includes('presentation') || mimeType.includes('powerpoint') || mimeType.includes('slides') ||
             (lowerExt === '.ppt' && mimeType !== 'application/vnd.ms-powerpoint')) {
        rule = CONVERSION_RULES['presentation'];
    }


    if (rule && rule.validTargets.includes(targetFormat)) {
        return rule;
    }

    // 4. Fallback to main type rule (e.g. 'image' for 'image/png' if 'image/png' wasn't defined as a key)
    if (CONVERSION_RULES[mainType] && CONVERSION_RULES[mainType].validTargets.includes(targetFormat)) {
        console.warn(`[${originalFilename}] Using main type rule '${mainType}' for ${mimeType} to ${targetFormat}`);
        return CONVERSION_RULES[mainType];
    }

    // 5. Last resort: if it's some text type and text/plain rule can handle the target format
    if (mainType === 'text' && CONVERSION_RULES['text/plain'] && CONVERSION_RULES['text/plain'].validTargets.includes(targetFormat)) {
        console.warn(`[${originalFilename}] Using generic 'text/plain' rule for ${mimeType} to ${targetFormat}`);
        return CONVERSION_RULES['text/plain'];
    }

    console.warn(`No rule found for MIME: ${mimeType}, Ext: ${lowerExt}, File: ${originalFilename} to target: ${targetFormat}.`);
    return null;
}


// --- Core Single Conversion Logic ---
async function performSingleConversionLogic(uploadedFile, targetFormat) {
    return new Promise(async (resolve, reject) => {
        console.log(`[${uploadedFile.originalname}] Starting conversion to ${targetFormat}`);
        const inputPath = uploadedFile.path;
        let outputPath = '';
        let outputFilenameUUID = ''; // This will be the UUID.ext name for the file on disk and downloadId
        let mimeType = 'unknown'; // Initialize mimeType

        try {
            // 1. Determine MIME Type
            let detectedType = null;
            try {
                // FIX: Adjust dynamic import for 'file-type' to ensure fileTypeFromFile is correctly accessed
                const fileTypeModule = await import('file-type');
                const fileTypeFromFile = fileTypeModule.fileTypeFromFile; // Access the named export directly

                if (typeof fileTypeFromFile === 'function') {
                    detectedType = await fileTypeFromFile(inputPath);
                } else {
                    throw new Error("fileTypeFromFile function not found in 'file-type' module.");
                }
            } catch (importError) {
                console.warn(`[${uploadedFile.originalname}] Error importing/using 'file-type': ${importError.message}. Continuing.`);
            }

            mimeType = uploadedFile.mimetype && uploadedFile.mimetype !== 'application/octet-stream'
                ? uploadedFile.mimetype
                : (detectedType ? detectedType.mime : 'unknown');

            if (mimeType === 'unknown' || mimeType === 'application/octet-stream') {
                const extensionBasedMime = mime.lookup(uploadedFile.originalname);
                if (extensionBasedMime) {
                    console.warn(`[${uploadedFile.originalname}] MIME type unknown/generic, using extension-based: ${extensionBasedMime}`);
                    mimeType = extensionBasedMime;
                }
            }

            // 2. Specific extension-based overrides for common misdetections or generic mimetypes
            const lowerExt = path.extname(uploadedFile.originalname).toLowerCase();
            if (lowerExt === '.md' && mimeType !== 'text/markdown') { console.warn(`[${uploadedFile.originalname}] Overriding MIME to text/markdown for .md`); mimeType = 'text/markdown'; }
            else if (lowerExt === '.html' && mimeType !== 'text/html') { console.warn(`[${uploadedFile.originalname}] Overriding MIME to text/html for .html`); mimeType = 'text/html'; }
            else if (lowerExt === '.txt' && mimeType !== 'text/plain') { console.warn(`[${uploadedFile.originalname}] Overriding MIME to text/plain for .txt`); mimeType = 'text/plain'; }
            else if (lowerExt === '.epub' && mimeType !== 'application/epub+zip') { console.warn(`[${uploadedFile.originalname}] Overriding MIME to application/epub+zip for .epub`); mimeType = 'application/epub+zip'; }
            else if (lowerExt === '.mobi' && mimeType !== 'application/x-mobipocket-ebook') { console.warn(`[${uploadedFile.originalname}] Overriding MIME to application/x-mobipocket-ebook for .mobi`); mimeType = 'application/x-mobipocket-ebook'; }
            // Ensure common office types get a more specific MIME if detected generically before findRule
            else if (lowerExt === '.docx' && mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';}
            else if (lowerExt === '.doc' && mimeType !== 'application/msword') { mimeType = 'application/msword';}
            else if (lowerExt === '.odt' && mimeType !== 'application/vnd.oasis.opendocument.text') { mimeType = 'application/vnd.oasis.opendocument.text';}


            console.log(`[${uploadedFile.originalname}] Using MIME: ${mimeType} (Multer: ${uploadedFile.mimetype}, Detected: ${detectedType ? detectedType.mime : 'N/A'}, Ext: ${lowerExt})`);
            // Allow octet-stream if it's an .epub or .mobi because findRule can handle it based on extension
            const isSpecialOctetStream = mimeType === 'application/octet-stream' && (lowerExt === '.epub' || lowerExt === '.mobi');
            if (mimeType === 'unknown' || (mimeType === 'application/octet-stream' && !isSpecialOctetStream) ) {
                 throw new Error('Could not determine a usable input file type.');
            }

            // 3. Find Conversion Rule
            const rule = findRule(mimeType, targetFormat, uploadedFile.originalname);
            if (!rule) throw new Error(`Conversion from '${mimeType}' (for file ${uploadedFile.originalname}) to '${targetFormat}' is not supported.`);
            console.log(`[${uploadedFile.originalname}] Using rule for type: ${mimeType}, target: ${targetFormat}`);

            const outputExt = rule.getOutputExt(targetFormat);
            if (!outputExt || outputExt === 'unknown') throw new Error(`Internal error: Invalid output extension for format: ${targetFormat}`);

            // Generate a UUID-based filename for storage on disk
            outputFilenameUUID = `${uuidv4()}.${outputExt}`;
            outputPath = path.join(OUTPUT_DIR, outputFilenameUUID);

            // 4. Get Command and Arguments
            const command = typeof rule.tool === 'function' ? rule.tool(targetFormat) : rule.tool;
            let args;
            const isLibreOffice = command === 'soffice';

            if (isLibreOffice) args = rule.getArgs(inputPath, OUTPUT_DIR, targetFormat);
            else args = rule.getArgs(inputPath, outputPath, targetFormat, uploadedFile.originalname);

            if (!command || !args || args.length === 0) throw new Error("Internal error: Invalid conversion rule configuration.");

            // 5. Execute Conversion
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

                fs.unlink(inputPath, (err) => { // Clean up original uploaded file
                    if (err) console.error(`[${uploadedFile.originalname}] Cleanup Error (Original Upload ${inputPath}):`, err);
                    else console.log(`[${uploadedFile.originalname}] Cleaned up original upload: ${inputPath}`);
                });

                if (code === 0) {
                    if (isLibreOffice) {
                        const baseInputName = path.basename(uploadedFile.originalname, path.extname(uploadedFile.originalname));
                        const predictedLOOutputPath = path.join(OUTPUT_DIR, `${baseInputName}.${outputExt}`);
                        const finalUuidOutputPath = outputPath; // The path with UUID we want to rename to

                        fs.access(predictedLOOutputPath, fs.constants.F_OK, (errAccess) => {
                            if (errAccess) {
                                console.error(`[${uploadedFile.originalname}] LO output file not found at ${predictedLOOutputPath}. Checking for alternatives...`);
                                fs.readdir(OUTPUT_DIR, (readErr, filesInDir) => {
                                    if (readErr) {
                                        reject({ message: `LO conversion problem: output ${predictedLOOutputPath} not found & dir read failed. Stderr: ${stderrOutput.substring(0, 200)}` });
                                        return;
                                    }
                                    const possibleFile = filesInDir.find(f => f.endsWith(`.${outputExt}`) && f.startsWith(baseInputName.substring(0,Math.min(10, baseInputName.length))));
                                    if (possibleFile) {
                                        const foundPath = path.join(OUTPUT_DIR, possibleFile);
                                        console.warn(`[${uploadedFile.originalname}] LO output ${predictedLOOutputPath} not found, but found ${foundPath}. Renaming this.`);
                                        fs.rename(foundPath, finalUuidOutputPath, (renameErr) => {
                                            if (renameErr) reject({ message: `LO conversion succeeded, but rename from ${foundPath} failed: ${renameErr.message}. Stderr: ${stderrOutput.substring(0, 200)}` });
                                            else {
                                                // Store original name in map
                                                downloadMap.set(outputFilenameUUID, uploadedFile.originalname);
                                                resolve({ success: true, downloadId: outputFilenameUUID, message: 'Conversion successful (LO, alt find)!' });
                                            }
                                        });
                                    } else {
                                        reject({ message: `LO conversion likely succeeded but output file ${predictedLOOutputPath} not found. Stderr: ${stderrOutput.substring(0, 200)}` });
                                    }
                                });
                                return;
                            }
                            // If predictedLOOutputPath exists, rename it to the UUID-based path
                            fs.rename(predictedLOOutputPath, finalUuidOutputPath, (renameErr) => {
                                if (renameErr) {
                                    console.error(`[${uploadedFile.originalname}] Error renaming LO output from ${predictedLOOutputPath} to ${finalUuidOutputPath}:`, renameErr);
                                    reject({ message: `LO conversion succeeded, but rename failed: ${renameErr.message}. Stderr: ${stderrOutput.substring(0, 200)}` });
                                } else {
                                    console.log(`[${uploadedFile.originalname}] Renamed LO output to: ${finalUuidOutputPath}`);
                                    // Store original name in map
                                    downloadMap.set(outputFilenameUUID, uploadedFile.originalname);
                                    resolve({ success: true, downloadId: outputFilenameUUID, message: 'Conversion successful!' });
                                }
                            });
                        });
                    } else { // For non-LibreOffice tools (like ebook-convert, pandoc direct output, etc.)
                        // Store original name in map
                        downloadMap.set(outputFilenameUUID, uploadedFile.originalname);
                        resolve({ success: true, downloadId: outputFilenameUUID, message: 'Conversion successful!' });
                    }
                } else { // Conversion process failed (exit code !== 0)
                    if (outputPath && fs.existsSync(outputPath)) { // Clean up partially created/failed output file
                        fs.unlink(outputPath, (err) => {
                            if (err) console.error(`[${uploadedFile.originalname}] Cleanup Error (Failed Output ${outputPath}):`, err);
                            else console.log(`[${uploadedFile.originalname}] Cleaned up failed output: ${outputPath}`);
                        });
                    }
                    let errorMessage = `Conversion failed (exit code ${code}).`;
                    if (stderrOutput) {
                        errorMessage += ` Details: ${stderrOutput.substring(0, 300)}${stderrOutput.length > 300 ? '...' : ''}`;
                        if (stderrOutput.toLowerCase().includes('drm')) {
                            errorMessage = `Conversion failed: File may be DRM-protected. (${stderrOutput.substring(0,100)})`;
                        }
                    } else {
                        errorMessage += ' Tool reported an error or exited uncleanly.';
                    }
                    reject({ message: errorMessage });
                }
            });

            conversionProcess.on('error', (spawnError) => { // Failed to start the process itself
                console.error(`[${uploadedFile.originalname}] Failed to start subprocess '${command}'. Is it installed/PATH?`, spawnError);
                fs.unlink(inputPath, (unlinkErr) => { if (unlinkErr && unlinkErr.code !== 'ENOENT') console.error("Cleanup Error (Spawn Error Input):", unlinkErr); });
                reject({ message: `Server error: Failed to start conversion tool ('${command}'). Ensure it's installed and in system PATH.` });
            });

        } catch (error) { // Catch errors from setup (MIME detection, rule finding, etc.)
            console.error(`[${uploadedFile.originalname}] Error during conversion setup:`, error.message, error.stack);
            if (inputPath && fs.existsSync(inputPath)) fs.unlink(inputPath, (err) => { if (err && err.code !== 'ENOENT') console.error(`[${uploadedFile.originalname}] Cleanup Error (Catch Block - Input ${inputPath}):`, err); });
            if (outputPath && fs.existsSync(outputPath)) fs.unlink(outputPath, (err) => { if (err && err.code !== 'ENOENT') console.error(`[${uploadedFile.originalname}] Cleanup Error (Catch Block - Output ${outputPath}):`, err); });
            const isKnownError = error.message.includes('Conversion from') || error.message.includes('Could not determine');
            reject({ message: isKnownError ? error.message : 'An unexpected server error occurred during conversion setup.' });
        }
    });
}

// --- Wrapper for processing and formatting result ---
async function processAndFormatResult(file, targetFormat) {
    try {
        const result = await performSingleConversionLogic(file, targetFormat);
        return {
            originalName: file.originalname,
            success: true,
            downloadId: result.downloadId, // This is the UUID.ext
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

// --- ROUTES ---
// Change the root route to serve your HTML file directly
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'fycon.html'));
});

// Added explicit Multer error handling
app.post('/convert', (req, res) => {
    upload.array('inputFiles', MAX_CONCURRENT_FILES)(req, res, async (err) => {
        if (err) {
            // Check for Multer-specific errors
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({
                        error: `One or more files exceed the maximum size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`,
                        code: err.code
                    });
                }
                if (err.code === 'LIMIT_FILE_COUNT') {
                    return res.status(413).json({
                        error: `Too many files. Maximum ${MAX_CONCURRENT_FILES} files allowed per request.`,
                        code: err.code
                    });
                }
                if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                    return res.status(400).json({
                        error: `Unexpected field: ${err.field}. Please ensure file input name is 'inputFiles'.`,
                        code: err.code
                    });
                }
                // Generic Multer error that might not be one of the common codes
                console.error("Multer Error (generic):", err.message, err.code, err.stack);
                return res.status(400).json({ error: `File upload error: ${err.message}.`, code: err.code || 'MULTER_GENERIC_ERROR' });
            }
            // Other non-Multer errors that might occur during the upload stream processing
            console.error("An unexpected error occurred during file upload processing:", err.stack || err);
            return res.status(500).json({ error: 'An unexpected server error occurred during file upload.' });
        }

        // --- Original file processing logic starts here, only executed if upload was successful ---
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded.' });
        }

        const targetFormat = req.body.targetFormat;
        if (!targetFormat) {
            // If target format is missing, clean up the uploaded files
            req.files.forEach(file => fs.unlink(file.path, unlinkErr => {
                if (unlinkErr) console.error("Error deleting orphaned upload (no target):", unlinkErr);
            }));
            return res.status(400).json({ error: 'No target format specified.' });
        }

        const results = [];
        // Process files sequentially. If parallel processing is desired, use Promise.all
        // This is kept sequential as per original implementation, which is often safer
        // for resource-intensive conversions or for ensuring orderly logs.
        for (const file of req.files) {
            const result = await processAndFormatResult(file, targetFormat);
            results.push(result);
        }
        res.status(200).json({ allResults: results });
    });
});

app.get('/download/:fileId', (req, res) => {
    const fileId = req.params.fileId; // This is the UUID.ext name saved on disk
    const originalFilename = downloadMap.get(fileId); // Look up the original name

    if (!originalFilename) {
        console.warn(`Download request for unknown or expired fileId: ${fileId}`);
        return res.status(404).json({ error: 'File not found or expired. It might have been automatically cleaned up.' });
    }

    // Basic sanitization for fileId, though it should be UUID.ext
    const safePattern = /^[a-zA-Z0-9\-\.]+$/;
    if (!fileId || !safePattern.test(fileId)) {
        console.warn(`Invalid fileId format requested: ${fileId}`);
        return res.status(400).json({ error: 'Invalid file identifier format.' });
    }

    const filePath = path.join(OUTPUT_DIR, fileId); // Use the UUID.ext filename for disk access

    fs.access(filePath, fs.constants.R_OK, (err) => {
        if (err) {
            // If file is missing from disk but still in map, remove it from map
            if (err.code === 'ENOENT') {
                downloadMap.delete(fileId);
                console.warn(`File ${fileId} not found on disk, removed from downloadMap.`);
                return res.status(404).json({ error: 'File not found or expired. It might have been automatically cleaned up.' });
            }
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Server error accessing file.'
                });
            }
            return;
        }
        // Use res.download(filePath, downloadName) to provide the original filename to the user
        res.download(filePath, originalFilename, (downloadErr) => {
            if (downloadErr) {
                console.error(`Error during file download stream for ${fileId} (original: ${originalFilename}):`, downloadErr);
                // Note: Headers might already be sent, so res.status/json might not work here.
            } else {
                console.log(`Successfully sent file ${fileId} (original: ${originalFilename}) for download.`);
            }
        });
    });
});

// --- Scheduled Cleanup Task ---
cron.schedule('0 */6 * * *', () => {
    console.log(`[CRON] Running scheduled cleanup task for files older than ${TEMP_FILE_LIFESPAN_HOURS} hours...`);
    const now = Date.now();
    const cutoff = now - (TEMP_FILE_LIFESPAN_HOURS * 60 * 60 * 1000);
    const cleanupDirectory = (dirPath) => {
        fs.readdir(dirPath, (err, files) => {
            if (err) { console.error(`[CRON] Error reading directory ${dirPath}:`, err); return; }
            files.forEach(file => {
                const filePath = path.join(dirPath, file);
                fs.stat(filePath, (statErr, stats) => {
                    if (statErr) { console.error(`[CRON] Error getting stats for ${filePath}:`, statErr); return; }
                    if (stats.isFile() && stats.mtimeMs < cutoff) {
                        fs.unlink(filePath, unlinkErr => {
                            if (unlinkErr) { console.error(`[CRON] Error deleting old file ${filePath}:`, unlinkErr); }
                            else {
                                console.log(`[CRON] Deleted old file: ${filePath}`);
                                // Remove from downloadMap when deleting from disk
                                const filename = path.basename(filePath);
                                if (downloadMap.has(filename)) {
                                    downloadMap.delete(filename);
                                    console.log(`[CRON] Removed ${filename} from downloadMap.`);
                                }
                            }
                        });
                    }
                });
            });
        });
    };
    cleanupDirectory(UPLOAD_DIR);
    cleanupDirectory(OUTPUT_DIR);
    console.log('[CRON] Cleanup task finished.');
});

// --- Global Error Handler ---
// This handler will catch any errors not explicitly handled by other middleware/routes.
app.use((err, req, res, next) => {
    console.error("Global Error Handler Caught:", err.stack || err);
    if (!res.headersSent) {
        res.status(err.status || 500).json({
            error: 'An unexpected server error occurred.'
        });
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Fycon server listening on port ${PORT}`);
    console.log(`Upload directory: ${UPLOAD_DIR}`);
    console.log(`Converted files directory: ${OUTPUT_DIR}`);
    console.log("Ensure Calibre's 'ebook-convert' is installed and in system PATH for EPUB/MOBI conversions.");
});