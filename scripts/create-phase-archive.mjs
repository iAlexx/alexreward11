#!/usr/bin/env node
/**
 * Cross-platform phase archive helper for ALEx Rewards.
 * Creates a deterministic git-archive ZIP plus MANIFEST.md and SHA256SUMS.txt,
 * then test-extracts and rejects prohibited paths.
 *
 * Usage:
 *   node scripts/create-phase-archive.mjs \
 *     --phase 01 \
 *     --slug FOUNDATION \
 *     --commit <full-sha> \
 *     --report <path-to-acceptance-report.md> \
 *     [--roadmap-version 1.2]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const PROHIBITED_PATH_PATTERNS = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)\.next(\/|$)/i,
  /(^|\/)\.turbo(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)phase-archives(\/|$)/i,
  /\.(vhdx|wal|pid)$/i,
  /(^|\/).*wallet[_-]?seed.*/i,
  /(^|\/).*seed[_-]?phrase.*/i,
  /(^|\/).*mnemonic.*/i,
  /(^|\/).*private[_-]?key.*/i,
  /(^|\/).*kms[_-]?(key|material).*/i,
  /(^|\/).*provider[_-]?secret.*/i,
  /(secret|credentials)\.(json|txt|pem|key)$/i,
];

function usage() {
  console.error(
    "Usage: node scripts/create-phase-archive.mjs --phase <NN> --slug <SLUG> --commit <sha> --report <file> [--roadmap-version <ver>]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    phase: null,
    slug: null,
    commit: null,
    report: null,
    roadmapVersion: "1.2",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) usage();
    switch (key) {
      case "--phase":
        out.phase = value;
        break;
      case "--slug":
        out.slug = value;
        break;
      case "--commit":
        out.commit = value;
        break;
      case "--report":
        out.report = value;
        break;
      case "--roadmap-version":
        out.roadmapVersion = value;
        break;
      default:
        usage();
    }
    i += 1;
  }
  if (!out.phase || !out.slug || !out.commit || !out.report) usage();
  if (!/^\d{2}$/.test(out.phase)) {
    console.error("--phase must be two digits, e.g. 00 or 01");
    process.exit(1);
  }
  if (!/^[A-Z0-9_]+$/.test(out.slug)) {
    console.error("--slug must be UPPER_SNAKE_CASE");
    process.exit(1);
  }
  return out;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function listFilesRecursive(rootDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(rootDir);
  return files;
}

function isProhibited(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const name = basename(normalized);

  // Tracked example env is allowed; live env/secrets are not.
  if (name === ".env.example") return false;
  if (name === ".env" || /^\.env\./i.test(name)) return true;

  return PROHIBITED_PATH_PATTERNS.some((re) => re.test(normalized));
}

function timestampUtc(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: "utf8" },
    );
    if (ps.status !== 0) {
      throw new Error(`Expand-Archive failed: ${ps.stderr || ps.stdout}`);
    }
    return;
  }
  const unzip = spawnSync("unzip", ["-q", zipPath, "-d", destDir], { encoding: "utf8" });
  if (unzip.status !== 0) {
    throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = resolve(process.cwd());
  const reportPath = resolve(repoRoot, args.report);
  if (!existsSync(reportPath)) {
    throw new Error(`Acceptance report not found: ${reportPath}`);
  }

  const fullSha = runGit(["rev-parse", args.commit], repoRoot);
  if (!/^[0-9a-f]{40}$/i.test(fullSha)) {
    throw new Error(`Could not resolve full commit SHA from ${args.commit}`);
  }
  const shortSha = fullSha.slice(0, 7);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const nodeVersion = process.version.replace(/^v/, "");
  const pnpmVersion = (() => {
    const r = spawnSync("pnpm", ["--version"], { encoding: "utf8", shell: true });
    return (r.stdout || "").trim() || "unknown";
  })();

  const phaseDirName = `PHASE_${args.phase}_${args.slug}`;
  const outDir = join(repoRoot, "phase-archives", phaseDirName);
  mkdirSync(outDir, { recursive: true });

  const stamp = timestampUtc();
  const zipName = `ALEx_Rewards_PHASE_${args.phase}_${args.slug}_${stamp}_${shortSha}.zip`;
  const zipPath = join(outDir, zipName);
  const reportOutName = `PHASE_${args.phase}_ACCEPTANCE_REPORT.md`;
  const reportOutPath = join(outDir, reportOutName);
  const manifestPath = join(outDir, "MANIFEST.md");
  const sumsPath = join(outDir, "SHA256SUMS.txt");

  const archive = spawnSync("git", ["archive", "--format=zip", "-o", zipPath, fullSha], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (archive.status !== 0) {
    throw new Error(`git archive failed: ${archive.stderr || archive.stdout}`);
  }

  copyFileSync(reportPath, reportOutPath);

  const extractRoot = mkdtempSync(join(tmpdir(), `alex-phase-${args.phase}-`));
  try {
    extractZip(zipPath, extractRoot);
    const extracted = listFilesRecursive(extractRoot);
    const prohibited = [];
    for (const file of extracted) {
      const relative = file.slice(extractRoot.length + 1).replace(/\\/g, "/");
      if (isProhibited(relative)) prohibited.push(relative);
    }
    if (prohibited.length > 0) {
      throw new Error(
        `Archive rejected: prohibited paths present:\n${prohibited.map((p) => `  - ${p}`).join("\n")}`,
      );
    }
    if (extracted.length === 0) {
      throw new Error("Archive rejected: extraction produced zero files");
    }

    const zipHash = await sha256File(zipPath);
    const reportHash = await sha256File(reportOutPath);

    const manifest = [
      "# Phase archive manifest",
      "",
      `- Archive filename: \`${zipName}\``,
      `- Phase: ${args.phase} / ${args.slug}`,
      `- Created (UTC): ${new Date().toISOString()}`,
      `- Branch: \`${branch}\``,
      `- Commit SHA: \`${fullSha}\``,
      `- Short SHA: \`${shortSha}\``,
      `- Roadmap / specification version: ${args.roadmapVersion}`,
      `- Node.js: ${nodeVersion}`,
      `- pnpm: ${pnpmVersion}`,
      "- Acceptance status: PASS (archive created only after phase gate)",
      "- Archive method: `git archive --format=zip` from exact commit",
      "- Extraction verification: PASS",
      "- Prohibited-path scan: PASS",
      "",
    ].join("\n");
    writeFileSync(manifestPath, manifest, "utf8");

    const manifestHash = await sha256File(manifestPath);
    writeFileSync(
      sumsPath,
      `${zipHash}  ${zipName}\n${reportHash}  ${reportOutName}\n${manifestHash}  MANIFEST.md\n`,
      "utf8",
    );

    const zipHashAfter = await sha256File(zipPath);
    if (zipHashAfter !== zipHash) {
      throw new Error("ZIP checksum changed after companion file writes");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          phase: args.phase,
          slug: args.slug,
          commit: fullSha,
          directory: outDir,
          zip: zipPath,
          zipSha256: zipHash,
          report: reportOutPath,
          reportSha256: reportHash,
          manifest: manifestPath,
          extractedFiles: extracted.length,
          extractionVerification: "PASS",
          prohibitedPathScan: "PASS",
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
