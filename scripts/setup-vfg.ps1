param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$Python
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$install = Join-Path $project 'tools/vfg'
New-Item -ItemType Directory -Force -Path $install | Out-Null

if (!$Python) {
    $venv = Join-Path $install '.venv'
    python -m venv $venv
    if ($LASTEXITCODE) { throw 'Could not create the VFG Python environment.' }
    $Python = Join-Path $venv 'Scripts/python.exe'
}
$Python = (Resolve-Path -LiteralPath $Python).Path
& $Python -m pip install --disable-pip-version-check --extra-index-url https://download.pytorch.org/whl/cu128 'torch==2.11.0+cu128' 'nvidia-vfx==0.2.0.0' 'numpy==2.5.5' 'websockets==15.0.1'
if ($LASTEXITCODE) { throw 'Could not install NVIDIA VFG dependencies.' }

$rustc = Get-Command rustc -ErrorAction SilentlyContinue
$compiler = if ($rustc) { $rustc.Source } else { Join-Path $env:USERPROFILE '.cargo/bin/rustc.exe' }
$launcherSource = Join-Path $PSScriptRoot 'vfg-launcher.rs'
$hostSource = Join-Path $PSScriptRoot 'vfg-host.py'
$revision = (Get-FileHash $launcherSource).Hash.Substring(0, 12) + '-' + (Get-FileHash $hostSource).Hash.Substring(0, 12)
$runtime = Join-Path $install $revision
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$launcher = Join-Path $runtime 'kittyplays-vfg.exe'
if (!(Test-Path -LiteralPath $launcher)) {
    & $compiler -O $launcherSource -o $launcher
    if ($LASTEXITCODE) { throw 'Could not compile the native messaging launcher.' }
}
Copy-Item -LiteralPath $hostSource -Destination $runtime -Force
[IO.File]::WriteAllText((Join-Path $runtime 'python-path.txt'), $Python)

$hostName = 'com.kittyplays.vfg'
$manifest = Join-Path $install "$hostName.json"
[IO.File]::WriteAllText($manifest, (@{
    name = $hostName
    description = 'KittyPlays local NVIDIA VFG'
    path = $launcher
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json))
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifest
Write-Output "Installed $hostName for Chrome extension $ExtensionId."
