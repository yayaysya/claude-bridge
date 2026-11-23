# ClaudeBridge · 渡桥 — 纯 Windows 本地一键初始化脚本（PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File .\setup-local.ps1 -ProjectRoot "D:\projects"

param(
    [string]$ProjectRoot = "$HOME\projects",
    [int]$LocalPort = 7676
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ProjectRoot)) {
    New-Item -ItemType Directory -Path $ProjectRoot -Force | Out-Null
}
$ResolvedRoot = (Resolve-Path $ProjectRoot).Path

Write-Host "============================================"
Write-Host " ClaudeBridge · 渡桥 — Windows 本地初始化"
Write-Host " 授权目录: $ResolvedRoot"
Write-Host " 监听地址: http://127.0.0.1:$LocalPort/mcp (仅本机)"
Write-Host "============================================"

Write-Host "[1/4] 检查 Node.js 与 Git Bash..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "未检测到 Node.js，请先安装 Node.js 24 LTS (>=22.19 <27): https://nodejs.org/"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Warning "未检测到 Git（DevSpace 在 Windows 上需要 Git Bash），请安装: https://git-scm.com/download/win"
}
Write-Host ("当前 Node.js: " + (node -v))

Write-Host "[2/4] 安装 @waishnav/devspace..."
npm install -g @waishnav/devspace

Write-Host "[3/4] 初始化 DevSpace 配置..."
devspace init --yes --public-url "http://127.0.0.1:$LocalPort" --roots "$ResolvedRoot"

Write-Host "[4/4] 安全加固：关闭本地 subagents，延长 OAuth 有效期至 365 天..."
$ConfigPath = Join-Path $HOME ".devspace\config.jsonc"
$AuthPath = Join-Path $HOME ".devspace\auth.json"

$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.server.host = "127.0.0.1"
$cfg.server.port = $LocalPort
$cfg.server.publicBaseUrl = "http://127.0.0.1:$LocalPort"
$cfg.oauth.refreshTokenTtlSeconds = 31536000
$cfg.oauth.refreshTokenGraceSeconds = 30
if ($null -eq $cfg.subagents) {
    $cfg | Add-Member -NotePropertyName "subagents" -NotePropertyValue @{ enabled = $false; instructions = "on-demand"; providers = @() }
} else {
    $cfg.subagents.enabled = $false
}
$cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Encoding UTF8

$ownerToken = ""
if (Test-Path $AuthPath) {
    $auth = Get-Content $AuthPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ownerToken = $auth.ownerToken
}

Write-Host ""
Write-Host "============================================"
Write-Host " Windows 本地初始化完成！"
Write-Host " 你的 DevSpace Owner Password（首次 /mcp 授权时使用，请妥善保管）："
Write-Host "   $ownerToken"
Write-Host " 配置文件位置: $ConfigPath"
Write-Host "============================================"
