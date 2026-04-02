/**
 * Atomic File Writes
 * Writes to a .tmp file then renames, preventing corruption on crash.
 * Also provides debounced writes for high-frequency updates.
 */
const fs = require('fs');
const path = require('path');
let _writeSeq = 0;

/**
 * Write data to a file atomically.
 * Writes to a temp file first, then renames (atomic on same filesystem).
 * @param {string} filePath - Target file path
 * @param {string} content - Content to write
 * @param {string} encoding - File encoding (default 'utf8')
 */
function atomicWriteSync(filePath, content, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Write to temp file in same directory (same filesystem = atomic rename)
  const tmpFile = filePath + '.tmp.' + process.pid + '.' + (++_writeSeq);
  try {
    fs.writeFileSync(tmpFile, content, encoding);
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    throw err;
  }
}

/**
 * Async version of atomicWrite.
 */
async function atomicWriteAsync(filePath, content, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpFile = filePath + '.tmp.' + process.pid + '.' + (++_writeSeq);
  try {
    await fs.promises.writeFile(tmpFile, content, encoding);
    await fs.promises.rename(tmpFile, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpFile); } catch (_) {}
    throw err;
  }
}

/**
 * Create a debounced writer that coalesces rapid writes.
 * @param {number} delayMs - Debounce delay (default 2000ms)
 * @returns {function} - debouncedWrite(filePath, content)
 */
function createDebouncedWriter(delayMs = 2000) {
  const pending = new Map(); // filePath -> { content, timer }

  return function debouncedWrite(filePath, content) {
    const existing = pending.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      pending.delete(filePath);
      try {
        atomicWriteSync(filePath, content);
      } catch (err) {
        console.error(`Debounced write failed for ${filePath}:`, err.message);
      }
    }, delayMs);

    pending.set(filePath, { content, timer });
  };
}

module.exports = { atomicWriteSync, atomicWriteAsync, createDebouncedWriter };
