// apps-com.js — headless Office automation via COM (no UIA, no window).
//
// Why this exists:
//   Office apps (Word, Excel, PowerPoint, Outlook) use custom DirectWrite
//   canvases for their main editing surfaces. Their cells, paragraphs, and
//   slides are NOT exposed via UIA's standard ValuePattern / Edit hierarchy
//   (Excel cells in particular are a notorious dead-end for accessibility
//   tools). The agent's UIA-based input path simply cannot drive them.
//
//   But Office DOES expose a fully scriptable Component Object Model:
//   `Word.Application`, `Excel.Application`, etc. We can spin up the app
//   with `Visible = $false` (no window painted at all — even more "stealth"
//   than off-screen positioning), drive it deterministically, save the
//   document, and quit. No UIA, no clicks, no keystroke synthesis.
//
//   This module exposes that as a clean primitive callable from agents and
//   recipes. Two operations covered today: Word document creation, Excel
//   workbook population. PowerPoint and Outlook follow the same pattern if
//   ever needed.
//
// Limitations:
//   - Requires Office installed locally (already true if the user opens
//     Word/Excel from the Apps tab).
//   - Doesn't help apps that lack a public COM surface (Spotify, Slack,
//     Discord, browsers).
//   - File path the operation writes to must be absolute.

const path = require('path');
const driver = require('./apps-driver');

function _runPs(script, opts) { return driver._runPs(script, opts); }

// Word: write a plain-text document to a target path. Creates a new doc,
// inserts content (paragraph by paragraph if the input has \n), saves as
// .docx, quits without prompting.
async function wordWrite({ filePath, content }) {
  if (!filePath) throw new Error('wordWrite requires filePath');
  const safePath = String(filePath).replace(/'/g, "''");
  // Encode content via base64 so we don't have to escape quotes or newlines
  // through the PowerShell parser. PS decodes back to Unicode.
  const b64 = Buffer.from(String(content == null ? '' : content), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$content = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0  # wdAlertsNone
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection
  $sel.TypeText($content)
  # SaveAs: 16 = wdFormatXMLDocument (.docx). Force overwrite.
  $doc.SaveAs2('${safePath}', 16)
  $doc.Close($false)
  [PSCustomObject]@{ ok = $true; path = '${safePath}'; words = $doc.Words.Count } | ConvertTo-Json -Compress
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
`;
  const raw = await _runPs(script, { timeoutMs: 60000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { return { ok: false, error: 'non-JSON: ' + line.slice(0, 200) }; }
  return parsed;
}

// Excel: populate a worksheet with a 2D array of values, save to file.
// `values` is a JSON array of rows, each row an array of cells. Strings
// stay as strings; numbers stay as numbers. Cell A1 is values[0][0].
// Final cell can be a string starting with `=` to drop in a formula.
async function excelWrite({ filePath, values, sheetName = 'Sheet1', autoFit = true }) {
  if (!filePath) throw new Error('excelWrite requires filePath');
  if (!Array.isArray(values)) throw new Error('excelWrite requires values: 2D array');
  const safePath = String(filePath).replace(/'/g, "''");
  const safeSheet = String(sheetName).replace(/'/g, "''");
  // Encode the 2D array as JSON inside a wrapper object — PowerShell 5.1's
  // ConvertFrom-Json silently flattens top-level arrays of arrays, but
  // preserves nested arrays inside an object property.
  const b64 = Buffer.from(JSON.stringify({ rows: values }), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$parsed = $json | ConvertFrom-Json
$rows = @($parsed.rows)
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

# Excel column-letter helper (1 -> A, 27 -> AA, etc).
function ColLetter([int]$n) {
  $s = ''
  while ($n -gt 0) {
    $rem = ($n - 1) % 26
    $s = ([char](65 + $rem)).ToString() + $s
    $n = [int](($n - 1) / 26)
  }
  return $s
}

try {
  $wb = $excel.Workbooks.Add()
  $sheet = $wb.Worksheets.Item(1)
  $sheet.Name = '${safeSheet}'
  $rowIdx = 0
  foreach ($row in $rows) {
    $rowIdx++
    $cells = @($row)
    $colIdx = 0
    foreach ($cell in $cells) {
      $colIdx++
      if ($cell -eq $null) { continue }
      $addr = (ColLetter $colIdx) + [string]$rowIdx
      $rng = $sheet.Range($addr)
      # Formula starts with '='; everything else is a literal value.
      # PS5.1 deserializes JSON ints as Int64; Excel.Range.Value2's COM
      # dispatcher rejects that with InvalidCastException — coerce numerics
      # to [double] which the dispatcher always accepts.
      if ($cell -is [string] -and $cell.StartsWith('=')) {
        $rng.Formula = $cell
      } elseif ($cell -is [int] -or $cell -is [long] -or $cell -is [int64]) {
        $rng.Value2 = [double]$cell
      } else {
        $rng.Value2 = $cell
      }
    }
  }
  ${autoFit ? '$sheet.UsedRange.Columns.AutoFit() | Out-Null' : ''}
  # SaveAs: 51 = xlOpenXMLWorkbook (.xlsx). Force overwrite.
  $wb.SaveAs('${safePath}', 51)
  $wb.Close($false)
  [PSCustomObject]@{ ok = $true; path = '${safePath}'; rows = $rows.Count; sheet = '${safeSheet}' } | ConvertTo-Json -Compress
} finally {
  $excel.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
`;
  const raw = await _runPs(script, { timeoutMs: 60000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { return { ok: false, error: 'non-JSON: ' + line.slice(0, 200) }; }
  return parsed;
}

// Read the plain-text body of an existing .docx via Word COM. Useful for
// agents that need to inspect content they (or a previous run) wrote.
async function wordRead({ filePath }) {
  if (!filePath) throw new Error('wordRead requires filePath');
  const safePath = String(filePath).replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Open('${safePath}', $false, $true)  # ConfirmConversions=false, ReadOnly=true
  $text = $doc.Content.Text
  $doc.Close($false)
  [PSCustomObject]@{ ok = $true; text = $text; chars = $text.Length } | ConvertTo-Json -Compress
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
`;
  const raw = await _runPs(script, { timeoutMs: 30000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { return { ok: false, error: 'non-JSON: ' + line.slice(0, 200) }; }
  return parsed;
}

// Read the values from a sheet of an existing .xlsx as a 2D array.
async function excelRead({ filePath, sheetName = null, maxRows = 200, maxCols = 50 }) {
  if (!filePath) throw new Error('excelRead requires filePath');
  const safePath = String(filePath).replace(/'/g, "''");
  const safeSheet = sheetName ? String(sheetName).replace(/'/g, "''") : '';
  const script = `
$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $wb = $excel.Workbooks.Open('${safePath}', $false, $true)  # ReadOnly=true
  $sheet = $null
  if ('${safeSheet}') { $sheet = $wb.Worksheets.Item('${safeSheet}') }
  else { $sheet = $wb.Worksheets.Item(1) }
  $used = $sheet.UsedRange
  $rowCount = [Math]::Min($used.Rows.Count, ${Number(maxRows) | 0})
  $colCount = [Math]::Min($used.Columns.Count, ${Number(maxCols) | 0})
  $out = New-Object 'System.Collections.Generic.List[object]'
  for ($r = 1; $r -le $rowCount; $r++) {
    $row = New-Object 'System.Collections.Generic.List[object]'
    for ($c = 1; $c -le $colCount; $c++) {
      $val = $sheet.Cells.Item($r, $c).Value2
      [void]$row.Add($val)
    }
    [void]$out.Add($row)
  }
  $wb.Close($false)
  [PSCustomObject]@{ ok = $true; rows = $out; sheet = $sheet.Name; rowCount = $rowCount; colCount = $colCount } | ConvertTo-Json -Compress -Depth 5
} finally {
  $excel.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
`;
  const raw = await _runPs(script, { timeoutMs: 30000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { return { ok: false, error: 'non-JSON: ' + line.slice(0, 200) }; }
  return parsed;
}

module.exports = {
  wordWrite,
  wordRead,
  excelWrite,
  excelRead,
};
