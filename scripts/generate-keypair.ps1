#Requires -Version 7.0
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../secrets'))
$ErrorActionPreference = 'Stop'
$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$privatePath = Join-Path $destination 'calendar-private.pem'
if (Test-Path -LiteralPath $privatePath) { throw 'Private key already exists; choose a new output directory for rotation.' }
$rsa = [Security.Cryptography.RSA]::Create(4096)
try {
    $private = $rsa.ExportPkcs8PrivateKeyPem()
    [IO.File]::WriteAllText($privatePath, $private, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $destination 'calendar-private.base64'), [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($private)))
    [IO.File]::WriteAllText((Join-Path $destination 'calendar-public.pem'), $rsa.ExportSubjectPublicKeyInfoPem())
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        foreach ($file in @('calendar-private.pem', 'calendar-private.base64')) {
            & icacls (Join-Path $destination $file) /inheritance:r /grant:r ($identity + ':(F)') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not restrict key file permissions.' }
        }
    } else {
        & chmod 600 $privatePath (Join-Path $destination 'calendar-private.base64')
        if ($LASTEXITCODE -ne 0) { throw 'Could not restrict key file permissions.' }
    }
    Write-Output "Generated RSA-4096 key files in $destination. Private key contents were not printed."
} finally { $rsa.Dispose(); $private = $null }
