# popup.ps1 <reportFile>  — shows a topmost MessageBox with a report. Pure ASCII source.
param([string]$ReportFile)
$text = if ($ReportFile -and (Test-Path $ReportFile)) {
  [System.IO.File]::ReadAllText($ReportFile, [System.Text.Encoding]::UTF8)
} else { 'No report file.' }
Add-Type -AssemblyName System.Windows.Forms
$top = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
$null = $top.Show()
[void][System.Windows.Forms.MessageBox]::Show($top, $text, 'BOSS Autoply Report', 'OK', 'Information')
$top.Close()
