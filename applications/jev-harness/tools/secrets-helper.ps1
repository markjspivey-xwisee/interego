# jev-harness — keys and secrets helper (Windows).
# A small window: paste the TypeSafe API key and, optionally, an Interego relay bearer.
# Saves them as user-scope environment variables and, when the GitHub CLI is signed in,
# sets them as GitHub Actions secrets on the repository. Values are never printed.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ghAvailable = $false
$ghNote = 'GitHub CLI (gh) not found — secrets will be saved locally only.'
try {
  $null = Get-Command gh -ErrorAction Stop
  $status = & gh auth status 2>&1 | Out-String
  if ($status -match 'Logged in') { $ghAvailable = $true; $ghNote = 'GitHub CLI is signed in; secrets can be set on the repository.' }
  else { $ghNote = 'GitHub CLI found but not signed in. Run "gh auth login" in a terminal, or save locally only.' }
} catch {}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'jev-harness — keys and secrets'
$form.Size = New-Object System.Drawing.Size(680, 520)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Font = $font

function Add-Label($text, $x, $y, $w, $h) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Size = New-Object System.Drawing.Size($w, $h)
  $form.Controls.Add($l); return $l
}
function Add-Box($x, $y, $w, $masked, $value) {
  $t = New-Object System.Windows.Forms.TextBox
  $t.Location = New-Object System.Drawing.Point($x, $y); $t.Size = New-Object System.Drawing.Size($w, 28)
  if ($masked) { $t.UseSystemPasswordChar = $true }
  if ($value) { $t.Text = $value }
  $form.Controls.Add($t); return $t
}

$y = 16
Add-Label 'TypeSafe API key  (TYPESAFE_API_KEY)' 20 $y 620 22 | Out-Null
$y += 24
$keyBox = Add-Box 20 $y 520 $true ([Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User'))
$showKey = New-Object System.Windows.Forms.CheckBox
$showKey.Text = 'show'; $showKey.Location = New-Object System.Drawing.Point(550, $y); $showKey.Size = New-Object System.Drawing.Size(80, 28)
$showKey.Add_CheckedChanged({ $keyBox.UseSystemPasswordChar = -not $showKey.Checked })
$form.Controls.Add($showKey)
$y += 32
Add-Label 'From https://console.typesafe.ai. Used by the bridge and by CI to call Jev.' 20 $y 620 20 | Out-Null
$y += 32

Add-Label 'Interego relay bearer  (INTEREGO_BEARER) — optional' 20 $y 620 22 | Out-Null
$y += 24
$bearerBox = Add-Box 20 $y 520 $true ([Environment]::GetEnvironmentVariable('INTEREGO_BEARER', 'User'))
$showBearer = New-Object System.Windows.Forms.CheckBox
$showBearer.Text = 'show'; $showBearer.Location = New-Object System.Drawing.Point(550, $y); $showBearer.Size = New-Object System.Drawing.Size(80, 28)
$showBearer.Add_CheckedChanged({ $bearerBox.UseSystemPasswordChar = -not $showBearer.Checked })
$form.Controls.Add($showBearer)
$y += 32
Add-Label 'A session token for relay.interego.xwisee.com/mcp. Only needed for the bridge or CI to publish judgments to the pod. Leave blank to skip.' 20 $y 620 40 | Out-Null
$y += 44

Add-Label 'GitHub repository for Actions secrets' 20 $y 620 22 | Out-Null
$y += 24
$repoBox = Add-Box 20 $y 520 $false 'markjspivey-xwisee/interego'
$y += 36

$saveLocal = New-Object System.Windows.Forms.CheckBox
$saveLocal.Text = 'Save as Windows user environment variables (this machine)'
$saveLocal.Checked = $true
$saveLocal.Location = New-Object System.Drawing.Point(20, $y); $saveLocal.Size = New-Object System.Drawing.Size(620, 26)
$form.Controls.Add($saveLocal)
$y += 28
$saveGh = New-Object System.Windows.Forms.CheckBox
$saveGh.Text = 'Set as GitHub Actions secrets on the repository (gh secret set)'
$saveGh.Checked = $ghAvailable
$saveGh.Enabled = $ghAvailable
$saveGh.Location = New-Object System.Drawing.Point(20, $y); $saveGh.Size = New-Object System.Drawing.Size(620, 26)
$form.Controls.Add($saveGh)
$y += 26
$ghLabel = Add-Label $ghNote 40 $y 600 22
$ghLabel.ForeColor = if ($ghAvailable) { [System.Drawing.Color]::DarkGreen } else { [System.Drawing.Color]::DarkOrange }
$y += 34

$status = Add-Label '' 20 $y 620 60
$status.ForeColor = [System.Drawing.Color]::DarkSlateGray

$testBtn = New-Object System.Windows.Forms.Button
$testBtn.Text = 'Test TypeSafe key'; $testBtn.Location = New-Object System.Drawing.Point(20, 430); $testBtn.Size = New-Object System.Drawing.Size(160, 34)
$testBtn.Add_Click({
  $k = $keyBox.Text.Trim()
  if (-not $k) { $status.Text = 'Paste the TypeSafe key first.'; return }
  try {
    $r = Invoke-RestMethod -Method Get -Uri 'https://api.typesafe.ai/v1/models' -Headers @{ Authorization = "Bearer $k" } -TimeoutSec 20
    $names = @($r.data | ForEach-Object { $_.id }) -join ', '
    if (-not $names) { $names = ($r | ConvertTo-Json -Depth 3).Substring(0, 80) }
    $status.Text = "TypeSafe accepted the key. Models: $names"
  } catch {
    $status.Text = "TypeSafe rejected the key or is unreachable: $($_.Exception.Message)"
  }
})
$form.Controls.Add($testBtn)

$saveBtn = New-Object System.Windows.Forms.Button
$saveBtn.Text = 'Save'; $saveBtn.Location = New-Object System.Drawing.Point(420, 430); $saveBtn.Size = New-Object System.Drawing.Size(110, 34)
$saveBtn.Add_Click({
  $lines = @()
  $pairs = @(@('TYPESAFE_API_KEY', $keyBox.Text.Trim()), @('INTEREGO_BEARER', $bearerBox.Text.Trim()))
  foreach ($p in $pairs) {
    $name = $p[0]; $value = $p[1]
    if (-not $value) { $lines += "${name}: left blank, unchanged"; continue }
    if ($saveLocal.Checked) {
      try { [Environment]::SetEnvironmentVariable($name, $value, 'User'); $lines += "${name}: saved as a user variable" }
      catch { $lines += "${name}: could not save locally ($($_.Exception.Message))" }
    }
    if ($saveGh.Checked -and $ghAvailable) {
      $repo = $repoBox.Text.Trim()
      try {
        $out = ($value | & gh secret set $name --repo $repo 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) { $lines += "${name}: set as an Actions secret on $repo" } else { $lines += "${name}: gh failed: $out" }
      } catch { $lines += "${name}: gh failed ($($_.Exception.Message))" }
    }
  }
  $status.Text = ($lines -join "`n")
})
$form.Controls.Add($saveBtn)

$closeBtn = New-Object System.Windows.Forms.Button
$closeBtn.Text = 'Close'; $closeBtn.Location = New-Object System.Drawing.Point(540, 430); $closeBtn.Size = New-Object System.Drawing.Size(100, 34)
$closeBtn.Add_Click({ $form.Close() })
$form.Controls.Add($closeBtn)

[void]$form.ShowDialog()
