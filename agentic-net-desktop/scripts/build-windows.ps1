# One-command desktop build on Windows — produces an .msi installer (or a plain
# app-image folder when the WiX Toolset is not installed).
#
#   .\scripts\build-windows.ps1 [-Version 2.38.0] [-SkipBuilds]
#
# Requirements:
#   - JDK 21+ with jlink + jpackage on PATH
#   - Node.js 22 + npm
#   - WiX Toolset v3 on PATH for --type msi (optional)
#   The closed-source node/master/gui (governed by ..\PROPRIETARY-EULA.md) are
#   downloaded from the GitHub release assets; Docker Desktop is only needed as
#   a fallback when no release carries them yet.
#
# The official Windows msi is built by GitHub Actions per release
# (.github/workflows/desktop-windows.yml) with this same script in release-assets
# mode. The msi installs per-user (no admin), carries a fixed upgrade UUID so a
# newer msi upgrades in place, and the tray self-update launches it directly.
# Command transitions need a bash on PATH (e.g. Git Bash); MCP-first usage does not.
param(
    [string]$Version = "",
    [switch]$SkipBuilds
)
$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$ModuleDir = Split-Path -Parent $ScriptDir
$NetsDir   = Split-Path -Parent $ModuleDir
$Dist      = Join-Path $ModuleDir "dist"
$Closed    = Join-Path $ModuleDir "closed-artifacts"
$NodeVer   = "22.14.0"
$Maven     = Join-Path $NetsDir "agentic-net-gateway\mvnw.cmd"

if (-not $Version) {
    try { $Version = (git -C $NetsDir describe --tags --abbrev=0).TrimStart("v") } catch { $Version = "0.0.0" }
}
function Log($msg) { Write-Host "`n[desktop-win] $msg" -ForegroundColor Cyan }

# $ErrorActionPreference="Stop" only covers cmdlets — a failing mvnw/npm/jpackage
# is otherwise ignored and the script marches on to a confusing missing-file error.
function Invoke-Checked($what, [scriptblock]$block) {
    & $block
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# ---------------------------------------------------------------------------
# 1. Open components + closed artifacts
# ---------------------------------------------------------------------------
if (-not $SkipBuilds) {
    Log "Building open components"
    # Must stay in lockstep with the launcher's service roster (Main.java) and with the
    # mac/linux list in lib-assemble.sh — a service in the roster but not here ships an
    # installer whose stack cannot start (sa-blobstore was missing in 2.44.0/2.44.1).
    foreach ($svc in "agentic-net-gateway", "agentic-net-vault", "agentic-net-executor", "sa-blobstore") {
        $Pom = Join-Path $NetsDir "$svc\pom.xml"
        Invoke-Checked "maven $svc" { & $Maven -q -f $Pom clean package -DskipTests }
    }
    Invoke-Checked "maven launcher" { & $Maven -q -f (Join-Path $ModuleDir "pom.xml") clean package }
    Push-Location (Join-Path $NetsDir "agentic-net-cli")
    if (-not (Test-Path node_modules)) { Invoke-Checked "npm install (cli)" { npm install } }
    if (-not (Test-Path dist)) { Invoke-Checked "tsup (cli)" { npx tsup } }
    Pop-Location
    Push-Location (Join-Path $NetsDir "agentic-net-mcp")
    if (-not (Test-Path node_modules)) { Invoke-Checked "npm install (mcp)" { npm install } }
    Invoke-Checked "npm build (mcp)" { npm run build }
    Pop-Location

    New-Item -ItemType Directory -Force $Closed | Out-Null
    $ReleaseBase = if ($env:AGENTICOS_RELEASE_BASE) { $env:AGENTICOS_RELEASE_BASE }
                   else { "https://github.com/alexejsailer/agentic-nets/releases/download" }
    $GotRelease = $false
    try {
        Log "Trying GitHub release assets v$Version"
        $SumsFile = Join-Path $Closed "SHA256SUMS.txt"
        Invoke-WebRequest "$ReleaseBase/v$Version/SHA256SUMS.txt" -OutFile $SumsFile
        Invoke-WebRequest "$ReleaseBase/v$Version/SHA256SUMS.txt.sig" -OutFile "$SumsFile.sig"
        # verify the detached Ed25519 signature against the pinned key before trusting checksums
        node -e "const c=require('crypto'),fs=require('fs');const raw=Buffer.from(process.argv[1],'base64');const spki=Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]);const key=c.createPublicKey({key:spki,format:'der',type:'spki'});process.exit(c.verify(null,fs.readFileSync(process.argv[2]),key,Buffer.from(fs.readFileSync(process.argv[3],'utf8').trim(),'base64'))?0:1)" `
            "wJHaHlpGxdtKjeOGVZN5/hfbI1P9Pvjw2xY/UIW6qHw=" $SumsFile "$SumsFile.sig"
        if ($LASTEXITCODE -ne 0) { throw "checksum signature invalid" }
        $Sums = Get-Content $SumsFile -Raw
        foreach ($f in "agentic-net-node-$Version.jar", "agentic-net-master-$Version.jar", "agentic-net-gui-$Version.zip") {
            $dest = Join-Path $Closed $f
            Invoke-WebRequest "$ReleaseBase/v$Version/$f" -OutFile $dest
            $expected = ($Sums -split "`n" | Where-Object { $_ -match [regex]::Escape($f) }) -split "\s+" | Select-Object -First 1
            $actual = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
            if ($expected -ne $actual) { throw "checksum mismatch for $f" }
        }
        Move-Item (Join-Path $Closed "agentic-net-node-$Version.jar")   (Join-Path $Closed "agentic-net-node.jar") -Force
        Move-Item (Join-Path $Closed "agentic-net-master-$Version.jar") (Join-Path $Closed "agentic-net-master.jar") -Force
        if (Test-Path (Join-Path $Closed "gui")) { Remove-Item -Recurse -Force (Join-Path $Closed "gui") }
        Expand-Archive (Join-Path $Closed "agentic-net-gui-$Version.zip") -DestinationPath (Join-Path $Closed "gui")
        Remove-Item (Join-Path $Closed "agentic-net-gui-$Version.zip")
        $GotRelease = $true
    } catch {
        Write-Warning "Release assets unavailable: $_"
        if ($env:GITHUB_ACTIONS -eq "true") {
            throw "Release assets are required in CI (no Docker on Windows runners). Assets must finish uploading before this workflow runs."
        }
        Write-Warning "Falling back to Docker Hub images"
    }
    if (-not $GotRelease) {
        Log "Extracting closed artifacts from Docker Hub images (tag $Version, fallback latest)"
        foreach ($svc in "node", "master") {
            $img = "alexejsailer/agenticnetos-${svc}:$Version"
            docker pull -q $img 2>$null; if ($LASTEXITCODE -ne 0) { $img = "alexejsailer/agenticnetos-${svc}:latest"; docker pull -q $img }
            $cid = docker create $img
            docker cp "${cid}:/app/app.jar" (Join-Path $Closed "agentic-net-$svc.jar")
            docker rm $cid | Out-Null
        }
        $img = "alexejsailer/agenticnetos-gui:$Version"
        docker pull -q $img 2>$null; if ($LASTEXITCODE -ne 0) { $img = "alexejsailer/agenticnetos-gui:latest"; docker pull -q $img }
        $cid = docker create $img
        if (Test-Path (Join-Path $Closed "gui")) { Remove-Item -Recurse -Force (Join-Path $Closed "gui") }
        docker cp "${cid}:/usr/share/nginx/html" (Join-Path $Closed "gui")
        docker rm $cid | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 2. Assemble app dir
# ---------------------------------------------------------------------------
Log "Assembling app dir"
$App = Join-Path $Dist "app"
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
New-Item -ItemType Directory -Force "$App\services", "$App\gui", "$App\mcp\dist\bin", "$App\node-runtime" | Out-Null

Copy-Item (Join-Path $ModuleDir "target\launcher.jar") "$App\launcher.jar"
Copy-Item (Join-Path $Closed "agentic-net-node.jar")   "$App\services\agentic-net-node.jar"
Copy-Item (Join-Path $Closed "agentic-net-master.jar") "$App\services\agentic-net-master.jar"
foreach ($svc in "gateway", "vault", "executor") {
    Copy-Item (Get-Item (Join-Path $NetsDir "agentic-net-$svc\target\agentic-net-$svc-*.jar"))[0] "$App\services\agentic-net-$svc.jar"
}
# sa-blobstore breaks the agentic-net-* naming pattern, so it needs its own line
Copy-Item (Get-Item (Join-Path $NetsDir "sa-blobstore\target\sa-blobstore-*.jar"))[0] "$App\services\sa-blobstore.jar"

# Fail the BUILD, not the user's first launch: every jar the launcher's roster starts must
# be present in the package.
foreach ($jar in "agentic-net-node.jar", "agentic-net-master.jar", "agentic-net-gateway.jar",
                 "agentic-net-vault.jar", "agentic-net-executor.jar", "sa-blobstore.jar") {
    if (-not (Test-Path (Join-Path "$App\services" $jar))) {
        throw "packaging incomplete: services\$jar is missing — the installed stack could not start"
    }
}
Copy-Item -Recurse (Join-Path $Closed "gui\*") "$App\gui\"
Copy-Item (Join-Path $NetsDir "LICENSE.md") "$App\LICENSE.md"
Copy-Item (Join-Path $NetsDir "PROPRIETARY-EULA.md") "$App\EULA.md"

Copy-Item (Join-Path $NetsDir "agentic-net-mcp\dist\bin\agenticnets-mcp.js") "$App\mcp\dist\bin\"
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.writeFileSync(process.argv[2],JSON.stringify({name:p.name,version:p.version,type:p.type,dependencies:p.dependencies},null,2))" `
    (Join-Path $NetsDir "agentic-net-mcp\package.json") "$App\mcp\package.json"
Push-Location "$App\mcp"; npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent; Pop-Location

Log "Fetching Node runtime win-x64"
$NodeZip = Join-Path $Dist "cache\node-v$NodeVer-win-x64.zip"
New-Item -ItemType Directory -Force (Join-Path $Dist "cache") | Out-Null
if (-not (Test-Path $NodeZip)) {
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVer/node-v$NodeVer-win-x64.zip" -OutFile $NodeZip
}
Expand-Archive $NodeZip -DestinationPath (Join-Path $Dist "cache\node-win") -Force
Copy-Item (Join-Path $Dist "cache\node-win\node-v$NodeVer-win-x64\node.exe") "$App\node-runtime\node.exe"

# ---------------------------------------------------------------------------
# 3. jlink + jpackage
# ---------------------------------------------------------------------------
Log "Generating brand icons"
$Icons = Join-Path $Dist "icons"
Invoke-Checked "icon generator" {
    java -cp (Join-Path $ModuleDir "target\launcher.jar") com.sailer.agenticos.desktop.IconGenerator $Icons
}

Log "Building jlink runtime"
$Runtime = Join-Path $Dist "runtime"
if (Test-Path $Runtime) { Remove-Item -Recurse -Force $Runtime }
jlink --add-modules "java.se,jdk.unsupported,jdk.crypto.ec,jdk.crypto.cryptoki,jdk.httpserver,jdk.zipfs,jdk.charsets,jdk.localedata,jdk.management,jdk.security.auth,jdk.naming.dns" `
    --output $Runtime --no-header-files --no-man-pages --compress zip-6

Log "Packaging v$Version"
$Out = Join-Path $Dist "out"
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
$Type = "msi"
if (-not (Get-Command candle.exe -ErrorAction SilentlyContinue)) {
    Write-Warning "WiX Toolset not found - producing an app-image folder instead of an .msi"
    $Type = "app-image"
}
jpackage --type $Type --name "AgenticNetOS" --app-version $Version --vendor "Alexej Sailer" `
    --icon (Join-Path $Icons "AgenticNetOS.ico") --resource-dir $Icons --verbose `
    --input $App --runtime-image $Runtime `
    --main-jar launcher.jar --main-class com.sailer.agenticos.desktop.Main `
    --java-options "-Dagenticos.desktop.version=$Version" `
    $(if ($Type -eq "msi") { "--license-file", (Join-Path $NetsDir "PROPRIETARY-EULA.md"), "--win-menu", "--win-shortcut-prompt", "--win-per-user-install", "--win-upgrade-uuid", "8273CD7A-C745-4694-A039-7C3F143B10FA" }) `
    --dest $Out

if ($Type -eq "msi") {
    $Msi = Get-Item (Join-Path $Out "AgenticNetOS-$Version.msi")
    Rename-Item $Msi "AgenticNetOS-$Version-windows-x64.msi"
    Get-FileHash (Join-Path $Out "AgenticNetOS-$Version-windows-x64.msi") -Algorithm SHA256 |
        ForEach-Object { "$($_.Hash.ToLower())  AgenticNetOS-$Version-windows-x64.msi" } |
        Set-Content (Join-Path $Out "SHA256SUMS.txt")
}
Log "Done: $Out"
Get-ChildItem $Out
