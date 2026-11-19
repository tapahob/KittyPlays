# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
# Installs pinned portable Windows builds under the checkout's tools directory.
$ErrorActionPreference = 'Stop'

$architecture = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
} else {
    $env:PROCESSOR_ARCHITECTURE
}

$mpvTag = '20261111'
$mpvRevision = 'bcde6b93cc'
$ytDlpTag = '2026.10.26'
$denoTag = 'v2.9.8'

switch ($architecture) {
    'AMD64' {
        $mpvArch = 'x86_64'
        $ytDlpAsset = 'yt-dlp.exe'
        $mpvHash = 'f259b5fd4b5c395617c948a4fadcdf55bba1c5282fb7c13e88626b3f71072baf'
        $ytDlpHash = 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d'
        $denoHash = 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf'
    }
    'ARM64' {
        $mpvArch = 'aarch64'
        $ytDlpAsset = 'yt-dlp_arm64.exe'
        $mpvHash = 'ac8c700814499c13418caa1803061e2c109d7fe0eda0033314cd2960eb878d4c'
        $ytDlpHash = '0066dbac3c124028e2dcae2a197fccee33cd91f456313d24f7af89fd54590e98'
        $denoHash = 'b413b92b735b50c198e8fe3b85af1aa50e29d5f72e229aab701d132286e14cef'
    }
    default { throw "Unsupported architecture: $architecture. Use 64-bit Windows (x64 or ARM64)." }
}

function Save-ReleaseAsset($Url, $Destination, $Hash) {
    Write-Host "Downloading $([IO.Path]::GetFileName($Destination))"
    # Retry with TLS 1.2 if Schannel fails to negotiate with the release CDN.
    & curl.exe --fail --location --connect-timeout 20 --silent --show-error --output $Destination $Url
    if ($LASTEXITCODE -ne 0) {
        & curl.exe --fail --location --connect-timeout 20 --retry 2 --tls-max 1.2 --silent --show-error --output $Destination $Url
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed for $Url (curl exit code $LASTEXITCODE)."
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Hash) {
        throw "SHA-256 verification failed for $Url."
    }
}

function Expand-ReleaseAsset($Archive, $Destination, [string[]]$Files) {
    & tar.exe -xf $Archive -C $Destination @Files
    if ($LASTEXITCODE -ne 0) {
        throw "Could not extract $Archive (tar exit code $LASTEXITCODE)."
    }
}

function Show-InstalledVersion($Executable) {
    & $Executable --version
    if ($LASTEXITCODE -ne 0) {
        throw "Version check failed for $Executable (exit code $LASTEXITCODE)."
    }
}

$project = Split-Path -Parent $PSScriptRoot
$tools = (New-Item -Path (Join-Path $project 'tools') -ItemType Directory -Force).FullName
$stage = (New-Item -Path (Join-Path $tools ('.setup-' + [guid]::NewGuid())) -ItemType Directory).FullName

try {
    $mpvAsset = "mpv-$mpvArch-$mpvTag-git-$mpvRevision.7z"
    $denoAsset = "deno-$mpvArch-pc-windows-msvc.zip"
    $mpvArchive = Join-Path $stage $mpvAsset
    $denoArchive = Join-Path $stage $denoAsset

    # mpv.io lists shinchiro's Windows builds. Official yt-dlp executables
    # bundle the YouTube EJS scripts and find Deno beside yt-dlp.exe on Windows.
    Save-ReleaseAsset "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$mpvTag/$mpvAsset" $mpvArchive $mpvHash
    Save-ReleaseAsset "https://github.com/yt-dlp/yt-dlp/releases/download/$ytDlpTag/$ytDlpAsset" (Join-Path $stage 'yt-dlp.exe') $ytDlpHash
    Save-ReleaseAsset "https://github.com/denoland/deno/releases/download/$denoTag/$denoAsset" $denoArchive $denoHash

    Expand-ReleaseAsset $mpvArchive $stage @('mpv.exe', 'mpv.com')
    Expand-ReleaseAsset $denoArchive $stage @('deno.exe')

    foreach ($name in 'mpv.exe', 'mpv.com', 'deno.exe', 'yt-dlp.exe') {
        Move-Item -LiteralPath (Join-Path $stage $name) -Destination (Join-Path $tools $name) -Force
    }

    # mpv.com is the Windows console launcher for the adjacent mpv.exe.
    Show-InstalledVersion (Join-Path $tools 'mpv.com')
    Show-InstalledVersion (Join-Path $tools 'yt-dlp.exe')
    Show-InstalledVersion (Join-Path $tools 'deno.exe')
} finally {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).ProviderPath
    $resolvedTools = (Resolve-Path -LiteralPath $tools).ProviderPath
    if ((Split-Path -Parent $resolvedStage) -eq $resolvedTools) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
