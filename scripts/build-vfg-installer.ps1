param([string]$Output)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
if (!$Output) { $Output = Join-Path $project 'target/Install-KittyPlays-NVIDIA.cmd' }
$Output = [IO.Path]::GetFullPath($Output)
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
$compiler = if ($cargo) { $cargo.Source } else { Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe' }
$build = Join-Path $project 'target/vfg-installer-build'
& $compiler build --release --locked --target x86_64-pc-windows-msvc --bin kittyplays-vfg --manifest-path (Join-Path $project 'Cargo.toml') --target-dir $build
if ($LASTEXITCODE) { throw 'Could not build the NVIDIA host.' }
$binary = Join-Path $build 'x86_64-pc-windows-msvc/release/kittyplays-vfg.exe'

$bytes = [IO.File]::ReadAllBytes($binary)
$memory = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Compress, $true)
try {
    $gzip.Write($bytes, 0, $bytes.Length)
} finally {
    $gzip.Dispose()
}
try {
    $payload = [Convert]::ToBase64String($memory.ToArray(), [Base64FormattingOptions]::InsertLineBreaks)
} finally {
    $memory.Dispose()
}
$hash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
$body = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'vfg-installer.ps1.in')).Replace('__HOST_HASH__', $hash).Replace('__HOST_PAYLOAD__', $payload)
$header = @'
@echo off
setlocal DisableDelayedExpansion
set "KITTYPLAYS_INSTALLER=%~f0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$source = [IO.File]::ReadAllText($env:KITTYPLAYS_INSTALLER); $marker = [char]35 + ' KittyPlays payload'; $start = $source.LastIndexOf($marker); if ($start -lt 0) { exit 1 }; & ([ScriptBlock]::Create($source.Substring($start)))"
exit /b %errorlevel%
# KittyPlays payload
'@
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
$script = ($header + [Environment]::NewLine + $body) -replace '\r?\n', [Environment]::NewLine
[IO.File]::WriteAllText($Output, $script, [Text.Encoding]::ASCII)
Write-Output $Output
