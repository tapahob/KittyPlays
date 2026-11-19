param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [Parameter(Mandatory)]
    [string]$SdkBin
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$install = Join-Path $project 'tools/vfg'
New-Item -ItemType Directory -Force -Path $install | Out-Null

$SdkBin = (Resolve-Path -LiteralPath $SdkBin).Path
foreach ($dll in @('NVVideoEffects.dll', 'NVCVImage.dll', 'nvVFXVideoFrameGeneration.dll')) {
    if (!(Test-Path -LiteralPath (Join-Path $SdkBin $dll) -PathType Leaf)) {
        throw "Missing $dll. Select the NVIDIA Maxine VFX SDK binary directory with VFG installed."
    }
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
$compiler = if ($cargo) { $cargo.Source } else { Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe' }
$build = Join-Path $project 'target/vfg-build'
& $compiler build --release --locked --bin kittyplays-vfg --manifest-path (Join-Path $project 'Cargo.toml') --target-dir $build
if ($LASTEXITCODE) { throw 'Could not compile the Rust native messaging host.' }
$binary = Join-Path $build 'release/kittyplays-vfg.exe'
$revision = (Get-FileHash $binary).Hash.Substring(0, 16)
$runtime = Join-Path $install $revision
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$launcher = Join-Path $runtime 'kittyplays-vfg.exe'
if (!(Test-Path -LiteralPath $launcher)) {
    Copy-Item -LiteralPath $binary -Destination $launcher
}
[IO.File]::WriteAllText((Join-Path $runtime 'sdk-path.txt'), $SdkBin)

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
