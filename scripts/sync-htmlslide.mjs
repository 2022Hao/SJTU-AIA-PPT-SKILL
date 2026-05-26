#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const DEFAULT_APP_BASE = "https://html.inherit-ai.top";
const DEFAULT_API_BASE = `${DEFAULT_APP_BASE}/api`;
const SIDECAR_NAME = ".htmlslide-sync.json";
const CONFIG_DIR = join(homedir(), ".htmlslide-agent");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const parsed = parseArgs(process.argv.slice(2));
const command = parsed.command || "push";

if (command === "status") {
  await status(parsed).catch(fail);
} else if (command === "login") {
  await login(parsed).catch(fail);
} else if (command === "list") {
  await listProjects(parsed).catch(fail);
} else if (command === "pull") {
  await pullProject(parsed).catch(fail);
} else if (command === "push") {
  await pushProject(parsed).catch(fail);
} else {
  usage(`Unknown command: ${command}`);
}

async function login(args) {
  const config = readConfig();
  const apiBase = resolveApiBase(args, config);
  const appBase = resolveAppBase(args, config);
  const deviceName = args.deviceName || `${process.env.COMPUTERNAME || process.env.HOSTNAME || "Local"} Agent`;

  if (args.finish) {
    await finishLogin({ ...args, apiBase, appBase, config });
    return;
  }

  console.log(`HTMLSlide API: ${apiBase}`);
  const start = await apiJson(`${apiBase}/agent/oauth/start`, {
    method: "POST",
    body: { deviceName }
  });

  const url = `${appBase}${start.verificationUriComplete || `/agent/authorize?code=${encodeURIComponent(start.userCode)}`}`;
  const pending = {
    deviceCode: start.deviceCode,
    userCode: start.userCode,
    apiBase,
    appBase,
    verificationUrl: url,
    expiresAt: new Date(Date.now() + start.expiresIn * 1000).toISOString(),
    createdAt: new Date().toISOString()
  };
  writeConfig({ ...config, apiBase, appBase, pendingLogin: pending, updatedAt: new Date().toISOString() });

  console.log("Open this URL in HTMLSlide while logged in:");
  console.log(url);
  console.log(`Authorization code: ${start.userCode}`);
  console.log(`Then run: node scripts/sync-htmlslide.mjs login --finish`);
  if (args.startOnly) return;

  console.log("Waiting for approval...");
  await finishLogin({ ...args, apiBase, appBase, config: readConfig(), start });
}

async function finishLogin(args) {
  const config = args.config || readConfig();
  const pending = args.start
    ? {
        deviceCode: args.start.deviceCode,
        userCode: args.start.userCode,
        expiresAt: new Date(Date.now() + args.start.expiresIn * 1000).toISOString()
      }
    : config.pendingLogin;
  if (!pending?.deviceCode) {
    throw new Error("No pending login found. Run: node scripts/sync-htmlslide.mjs login --start-only");
  }

  const apiBase = normalizeBase(args.apiBase || pending.apiBase || config.apiBase || DEFAULT_API_BASE);
  const deadline = Math.min(
    Date.parse(pending.expiresAt || "") || Date.now() + 60_000,
    Date.now() + Number(args.timeout || 90) * 1000
  );
  while (Date.now() < deadline) {
    const tokenRes = await apiJson(
      `${apiBase}/agent/oauth/token`,
      {
        method: "POST",
        body: { deviceCode: pending.deviceCode },
        soft: true
      },
      { retries: 2 }
    ).catch((err) => ({ ok: false, transientError: err.message }));
    if (tokenRes.ok === false) {
      await sleep(2000);
      continue;
    }
    const nextConfig = {
      ...config,
      apiBase,
      appBase: normalizeBase(args.appBase || pending.appBase || config.appBase || DEFAULT_APP_BASE),
      accessToken: tokenRes.accessToken,
      userId: tokenRes.userId,
      tokenType: tokenRes.tokenType || "Bearer",
      pendingLogin: undefined,
      updatedAt: new Date().toISOString()
    };
    writeConfig(nextConfig);
    console.log(`HTMLSlide agent login complete. Bound user: ${tokenRes.userId}`);
    return;
  }

  throw new Error("Authorization not completed yet. Ask the user to confirm the browser page, then run login --finish again.");
}

async function status(args) {
  const config = readConfig();
  const apiBase = resolveApiBase(args, config);
  const appBase = resolveAppBase(args, config);
  console.log(`HTMLSlide app: ${appBase}`);
  console.log(`HTMLSlide API: ${apiBase}`);
  console.log(`Config: ${CONFIG_PATH}`);
  if (config.accessToken) {
    console.log(`Logged in: yes`);
    console.log(`Bound user: ${config.userId || "(unknown)"}`);
    return;
  }
  console.log(`Logged in: no`);
  if (config.pendingLogin?.verificationUrl) {
    console.log(`Pending authorization URL: ${config.pendingLogin.verificationUrl}`);
    console.log(`Finish with: node scripts/sync-htmlslide.mjs login --finish`);
  } else {
    console.log(`Start with: node scripts/sync-htmlslide.mjs login --start-only`);
  }
}

async function listProjects(args) {
  const client = authedClient(args);
  const projects = await client.get("/projects");
  projects.forEach((project) => {
    console.log(`${project.id}\t${project.kind || "slides"}\t${project.title}\t${project.updatedAt || ""}`);
  });
}

async function pullProject(args) {
  const outPath = args.out ? resolve(args.out) : resolve("ppt", "index.html");
  const client = authedClient(args);
  const project = await resolveProject(client, args);
  if (project.kind !== "html" || !project.html) {
    throw new Error(`Project "${project.title}" is not an HTML PPT project.`);
  }

  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, project.html, "utf8");
  writeSidecar(join(outDir, SIDECAR_NAME), {
    apiBase: client.apiBase,
    projectId: project.id,
    title: project.title,
    originalFileName: project.originalFileName || "index.html",
    pulledAt: new Date().toISOString()
  });

  console.log(`[htmlslide-sync] pulled "${project.title}" -> ${outPath}`);
}

async function pushProject(args) {
  const htmlFile = args.file ? resolve(args.file) : null;
  if (!htmlFile) usage("Missing HTML file. Example: node sync-htmlslide.mjs push path/to/ppt/index.html");
  if (!existsSync(htmlFile)) throw new Error(`HTML file not found: ${htmlFile}`);

  const deckDir = dirname(htmlFile);
  const sidecarPath = join(deckDir, SIDECAR_NAME);
  let sidecar = readJson(sidecarPath, {});
  const client = authedClient({ ...sidecar, ...args });
  const watchMode = Boolean(args.watch);

  let syncing = false;
  let pending = false;

  async function syncOnce() {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    try {
      const { html, assets, title } = buildHtmlPayload(htmlFile, args.title || sidecar.title);
      const htmlSha256 = sha256(html);
      const result = await client.post("/agent/projects/html", {
        projectId: args.projectId || sidecar.projectId,
        title,
        html,
        assets,
        originalFileName: basename(htmlFile),
        source: "SJTU-AIA-ppt-skill 同步",
        author: "本地 Agent"
      });
      const verifiedProject = await client.get(`/projects/${encodeURIComponent(result.project.id)}`);
      const verifiedSha256 = sha256(verifiedProject.html || "");
      if (verifiedSha256 !== htmlSha256) {
        throw new Error(`Push verification failed for ${result.project.id}. Website copy does not match local HTML.`);
      }

      sidecar = {
        ...sidecar,
        apiBase: client.apiBase,
        projectId: result.project.id,
        title: result.project.title,
        originalFileName: basename(htmlFile),
        updatedAt: result.project.updatedAt,
        verifiedAt: new Date().toISOString(),
        htmlSha256
      };
      writeSidecar(sidecarPath, sidecar);
      console.log(`[htmlslide-sync] pushed and verified "${result.project.title}" -> ${result.project.id}`);
    } finally {
      syncing = false;
      if (pending) {
        pending = false;
        await syncOnce();
      }
    }
  }

  await syncOnce();

  if (watchMode) {
    console.log(`[htmlslide-sync] watching ${deckDir}`);
    let timer = null;
    watch(deckDir, { recursive: true }, (_event, changed) => {
      if (!changed || String(changed).endsWith(SIDECAR_NAME)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        syncOnce().catch((err) => console.error(`[htmlslide-sync] ${err.message}`));
      }, 450);
    });
  }
}

async function resolveProject(client, args) {
  if (args.projectId) return client.get(`/projects/${encodeURIComponent(args.projectId)}`);
  if (!args.title) throw new Error("Pass --project-id <id> or --title <title>.");
  const projects = await client.get("/projects");
  const exact = projects.filter((project) => project.title === args.title);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Multiple projects named "${args.title}". Use --project-id.`);
  const fuzzy = projects.filter((project) => project.title.includes(args.title));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`Multiple projects match "${args.title}": ${fuzzy.map((project) => project.title).join(", ")}. Use --project-id.`);
  }
  throw new Error(`Project not found: ${args.title}`);
}

function authedClient(args) {
  const config = readConfig();
  const apiBase = resolveApiBase(args, config);
  const accessToken = args.token || process.env.HTMLSLIDE_AGENT_TOKEN || config.accessToken;
  if (!accessToken) {
    throw new Error("Not logged in. Run: node scripts/sync-htmlslide.mjs login");
  }
  return {
    apiBase,
    get: (path) => apiJson(`${apiBase}${path}`, { token: accessToken }),
    post: (path, body) => apiJson(`${apiBase}${path}`, { method: "POST", token: accessToken, body })
  };
}

function buildHtmlPayload(htmlPath, titleOverride) {
  const rawHtml = readFileSync(htmlPath, "utf8");
  const assets = {};
  const html = inlineLocalAssets(rawHtml, htmlPath, assets);
  return {
    html,
    assets,
    title: titleOverride || titleFromHtml(rawHtml) || basename(htmlPath).replace(/\.html?$/i, "")
  };
}

function inlineLocalAssets(html, htmlPath, assets) {
  const root = dirname(htmlPath);
  let next = html;

  next = next.replace(/\b(src|href)=["']([^"']+)["']/gi, (match, attr, ref) => {
    const dataUrl = localRefToDataUrl(ref, root, assets);
    return dataUrl ? `${attr}="${dataUrl}"` : match;
  });

  next = next.replace(/url\((["']?)([^"')]+)\1\)/gi, (match, _quote, ref) => {
    const dataUrl = localRefToDataUrl(ref, root, assets);
    return dataUrl ? `url("${dataUrl}")` : match;
  });

  return next;
}

function localRefToDataUrl(ref, root, assets) {
  if (!ref || ref.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return "";
  const cleanRef = decodeURIComponent(ref.split("#")[0].split("?")[0]);
  const filePath = resolve(root, cleanRef);
  if (!isInside(root, filePath) || !existsSync(filePath)) return "";
  const ext = extname(filePath).toLowerCase();
  if (!isEmbeddable(ext)) return "";

  const rel = normalize(relative(root, filePath)).split(sep).join("/");
  const mime = mimeFromExt(ext);
  const base64 = readFileSync(filePath).toString("base64");
  const dataUrl = `data:${mime};base64,${base64}`;
  assets[rel] = dataUrl;
  return dataUrl;
}

async function apiJson(url, options = {}, retryOptions = {}) {
  const retries = retryOptions.retries || 0;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: options.method || "GET",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) {
        if (options.soft) return { ok: false, status: res.status, ...body };
        throw new Error(body.error || `HTMLSlide API ${res.status}`);
      }
      return body;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

function readConfig() {
  return readJson(CONFIG_PATH, {});
}

function writeConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch {
    return fallback;
  }
}

function writeSidecar(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function isInside(root, filePath) {
  const rel = relative(root, filePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function isEmbeddable(ext) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf"].includes(ext);
}

function mimeFromExt(ext) {
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf"
  }[ext] || "application/octet-stream";
}

function titleFromHtml(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/\s+/g, " ").trim()) : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeBase(value) {
  return stripTrailingSlash(String(value || "").replace("https://html.inherit-ai.top:8085", "https://html.inherit-ai.top"));
}

function resolveAppBase(args, config) {
  return normalizeBase(args.appBase || process.env.HTMLSLIDE_APP_BASE || config.appBase || DEFAULT_APP_BASE);
}

function resolveApiBase(args, config) {
  const explicit = args.apiBase || process.env.HTMLSLIDE_API_BASE || config.apiBase;
  if (explicit) return normalizeBase(explicit);
  return `${resolveAppBase(args, config)}/api`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseArgs(argv) {
  const result = {};
  const commands = new Set(["status", "login", "list", "pull", "push"]);
  if (commands.has(argv[0])) result.command = argv.shift();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--watch") result.watch = true;
    else if (arg === "--start-only") result.startOnly = true;
    else if (arg === "--finish") result.finish = true;
    else if (arg === "--timeout") result.timeout = argv[++i];
    else if (arg === "--api-base") result.apiBase = argv[++i];
    else if (arg === "--app-base") result.appBase = argv[++i];
    else if (arg === "--device-name") result.deviceName = argv[++i];
    else if (arg === "--token") result.token = argv[++i];
    else if (arg === "--title") result.title = argv[++i];
    else if (arg === "--project-id") result.projectId = argv[++i];
    else if (arg === "--out") result.out = argv[++i];
    else if (!result.file && result.command !== "list" && result.command !== "login") result.file = arg;
    else usage(`Unknown argument: ${arg}`);
  }

  if (!result.command && result.file) result.command = "push";
  return result;
}

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  node scripts/sync-htmlslide.mjs status
  node scripts/sync-htmlslide.mjs login [--api-base https://html.inherit-ai.top/api] [--app-base https://html.inherit-ai.top]
  node scripts/sync-htmlslide.mjs login --start-only
  node scripts/sync-htmlslide.mjs login --finish [--timeout 90]
  node scripts/sync-htmlslide.mjs list
  node scripts/sync-htmlslide.mjs pull --title "Project title" --out path/to/ppt/index.html
  node scripts/sync-htmlslide.mjs pull --project-id <id> --out path/to/ppt/index.html
  node scripts/sync-htmlslide.mjs push path/to/ppt/index.html [--title "Project title"] [--project-id <id>] [--watch]`);
  process.exit(2);
}

function fail(err) {
  console.error(`[htmlslide-sync] ${err.message}`);
  process.exit(1);
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

