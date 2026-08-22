# Deploy seguro de Pages para OmniCloud (omnicloud-4u).
# Codifica las reglas de las Sesiones 8/12/25: CWD correcto, preservar
# wrangler.toml y _headers, exigir "Uploading Functions bundle" en el output.
#
# Uso:  powershell -File scripts\deploy-pages.ps1
# Ejecutar desde la raiz del repo.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pagesDir = Join-Path $repoRoot 'pages'
$distDir = Join-Path $repoRoot 'frontend\dist'
$functionsDir = Join-Path $repoRoot 'functions'
$wrangler = Join-Path $repoRoot 'worker\node_modules\.bin\wrangler.cmd'

foreach ($dir in @($pagesDir, $distDir, $functionsDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { throw "Falta directorio requerido: $dir" }
}
if (-not (Test-Path -LiteralPath $wrangler)) { throw "No se encontro wrangler: $wrangler" }

Write-Host '[1/5] Limpiando pages/ (preservando wrangler.toml y _headers)...' -ForegroundColor Cyan
Get-ChildItem -LiteralPath $pagesDir -Force |
    Where-Object { $_.Name -notin @('wrangler.toml', '_headers') } |
    Remove-Item -Recurse -Force

Write-Host '[2/5] Copiando frontend/dist -> pages/ ...' -ForegroundColor Cyan
Copy-Item -Path (Join-Path $distDir '*') -Destination $pagesDir -Recurse -Force

Write-Host '[3/5] Copiando functions -> pages/functions ...' -ForegroundColor Cyan
Copy-Item -Path $functionsDir -Destination (Join-Path $pagesDir 'functions') -Recurse -Force

Write-Host '[4/5] Desplegando (CWD = pages/) ...' -ForegroundColor Cyan
Push-Location $pagesDir
try {
    # cmd /c fusiona stdout+stderr como texto: evita que PowerShell 5.1 trate el
    # WARNING de wrangler (uncommitted changes) como NativeCommandError terminal.
    $output = cmd /c "`"$wrangler`" pages deploy . --project-name omnicloud-4u --branch cloudflare-test 2>&1"
    $output | ForEach-Object { Write-Host $_ }
    $text = $output -join "`n"
    if ($text -notmatch 'Uploading Functions bundle') {
        throw 'DEPLOY SOSPECHOSO: el output no incluye "Uploading Functions bundle". NO asumir exito (ver Sesiones 8/25).'
    }
} finally {
    Pop-Location
}

Write-Host '[5/5] Smoke de verificacion...' -ForegroundColor Cyan
$newBundle = (Get-ChildItem -LiteralPath (Join-Path $pagesDir 'assets') -Filter 'index-*.js' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name
Start-Sleep -Seconds 20
# node fetch en vez de Invoke-WebRequest: esta maquina no tiene salida directa
# para PowerShell/curl (Sesion 1); node si.
$check = node -e "const b=process.argv[1];fetch('https://omnicloud-4u.pages.dev/?t='+Date.now()).then(r=>r.text()).then(t=>{console.log(t.includes(b)?'OK':'MISS:'+b)}).catch(e=>console.log('ERR:'+e.message))" $newBundle
if ("$check".Trim() -ne 'OK') {
    throw "SMOKE FALLO ($check): el canonico no sirve el bundle $newBundle (posible propagacion CDN; reintentar en 60s)."
}
Write-Host "OK: produccion sirviendo $newBundle" -ForegroundColor Green
