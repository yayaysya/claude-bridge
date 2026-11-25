#!/usr/bin/env node
/**
 * 一键发版脚本：自动升级版本号 -> 类型检查 -> 提交 -> 打 tag -> 推送触发 GitHub Actions 上架微软插件市场
 * 用法：
 *   npm run release            # 自动把末位版本号 +1（如 0.6.0 -> 0.6.1）并推送发版
 *   npm run release -- minor   # 中间版本号 +1（如 0.6.0 -> 0.7.0）并推送发版
 *   npm run release -- 0.7.0   # 指定版本号并推送发版
 *   npm run release -- same    # 保持当前 package.json 版本号直接打 tag 并推送发版（适合首次发布）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pkgPath = path.join(rootDir, "package.json");

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: rootDir,
    stdio: opts.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
}

function bumpVersion(current, arg) {
  if (arg === "same") {
    return current;
  }
  const parts = current.split(".").map((n) => Number(n));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`无法解析当前版本号: ${current}`);
  }
  if (!arg || arg === "patch") {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
  if (arg === "minor") {
    return `${parts[0]}.${parts[1] + 1}.0`;
  }
  if (arg === "major") {
    return `${parts[0] + 1}.0.0`;
  }
  const clean = arg.replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(clean)) {
    throw new Error(`版本号格式不对: ${arg}（示例：0.6.1、minor、patch 或 same）`);
  }
  return clean;
}

function main() {
  const arg = (process.argv[2] || "").trim();
  const branch = run("git rev-parse --abbrev-ref HEAD", { capture: true }).trim();
  if (branch !== "main") {
    console.error(`当前在分支 ${branch}，请先切到 main 并合并后再发版。`);
    process.exit(1);
  }

  const dirty = run("git status --porcelain", { capture: true }).trim();
  if (dirty) {
    console.error("工作区还有未提交的修改，请先 commit 干净后再运行 npm run release。");
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const oldVer = pkg.version;
  const newVer = bumpVersion(oldVer, arg);
  const tagName = `v${newVer}`;

  const existingTag = run(`git tag -l "${tagName}"`, { capture: true }).trim();
  if (existingTag) {
    console.error(`标签 ${tagName} 已存在，请换一个更高的版本号。`);
    process.exit(1);
  }

  console.log(`\n==> 准备发布 ${tagName}（当前 ${oldVer}）...`);
  run("npm run typecheck");

  if (newVer !== oldVer) {
    pkg.version = newVer;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    run("git add package.json");
    run(`git commit -m "release: ${tagName}"`);
  }

  run(`git tag ${tagName}`);
  run(`git push -u origin main ${tagName}`);

  console.log(`\n✅ 已推送 ${tagName}！`);
  console.log("   打开 https://github.com/yayaysya/claude-bridge/actions 查看自动发布进度，");
  console.log("   绿灯后等 3~5 分钟微软商店即可自动更新。");
}

try {
  main();
} catch (err) {
  console.error(`\n❌ 发版中断：${err.message || err}`);
  process.exit(1);
}
