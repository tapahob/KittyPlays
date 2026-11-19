param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$SdkBin,
    [string]$FrucBin
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$install = Join-Path $project 'tools/vfg'
New-Item -ItemType Directory -Force -Path $install | Out-Null

if (!$SdkBin -and !$FrucBin) {
    throw 'Supply -SdkBin for Maxine VFG, -FrucBin for Optical Flow SDK 5, or both.'
}
if ($SdkBin) {
    $SdkBin = (Resolve-Path -LiteralPath $SdkBin).Path
    foreach ($dll in @('NVVideoEffects.dll', 'NVCVImage.dll', 'nvVFXVideoFrameGeneration.dll')) {
        if (!(Test-Path -LiteralPath (Join-Path $SdkBin $dll) -PathType Leaf)) {
            throw "Missing $dll. Select the NVIDIA Maxine VFX SDK binary directory with VFG installed."
        }
    }
}
if ($FrucBin) {
    $FrucBin = (Resolve-Path -LiteralPath $FrucBin).Path
    foreach ($dll in @('NvOFFRUC.dll', 'cudart64_110.dll')) {
        if (!(Test-Path -LiteralPath (Join-Path $FrucBin $dll) -PathType Leaf)) {
            throw "Missing $dll. Select the Optical Flow SDK 5 x64 binary directory containing NvOFFRUC."
        }
    }
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
$compiler = if ($cargo) { $cargo.Source } else { Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe' }
$build = Join-Path $project 'target/vfg-build'
& $compiler build --release --locked --bin kittyplays-vfg --manifest-path (Join-Path $project 'Cargo.toml') --target-dir $build
if ($LASTEXITCODE) { throw 'Could not compile the Rust native messaging host.' }
$binary = Join-Path $build 'release/kittyplays-vfg.exe'
$config = [Text.Encoding]::UTF8.GetBytes("$((Get-FileHash $binary).Hash)`n$SdkBin`n$FrucBin")
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $revision = [BitConverter]::ToString($sha.ComputeHash($config)).Replace('-', '').Substring(0, 16)
} finally {
    $sha.Dispose()
}
$runtime = Join-Path $install $revision
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$launcher = Join-Path $runtime 'kittyplays-vfg.exe'
if (!(Test-Path -LiteralPath $launcher)) {
    Copy-Item -LiteralPath $binary -Destination $launcher
}
if ($SdkBin) { [IO.File]::WriteAllText((Join-Path $runtime 'sdk-path.txt'), $SdkBin) }
if ($FrucBin) { [IO.File]::WriteAllText((Join-Path $runtime 'fruc-path.txt'), $FrucBin) }

$hostName = 'com.kittyplays.vfg'
$manifest = Join-Path $install "$hostName.json"
[IO.File]::WriteAllText($manifest, (@{
    name = $hostName
    description = 'KittyPlays local NVIDIA frame generation'
    path = $launcher
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json))
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifest
Write-Output "Installed $hostName for Chrome extension $ExtensionId."
