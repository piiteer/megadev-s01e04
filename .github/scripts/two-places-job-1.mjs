import { createPublicKey, publicEncrypt, randomBytes, createCipheriv } from "node:crypto";
import { appendFile } from "node:fs/promises";

const jobUrl = process.env.MEGA_JOB_1_URL;
if (!jobUrl) throw new Error("Missing Actions secret MEGA_JOB_1_URL");
if (/[\r\n]/.test(jobUrl)) throw new Error("Invalid job MCP URL");
let endpoint;
try { endpoint = new URL(jobUrl); } catch { throw new Error("Invalid job MCP URL"); }
if (endpoint.protocol !== "https:" || endpoint.hostname !== "hq.mega.dev" || !endpoint.pathname.startsWith("/mcp/job/")) {
  throw new Error("Job MCP URL must use the course job endpoint");
}

// Prevent accidental logging by GitHub Actions and never include tool payloads in logs.
console.log(`::add-mask::${jobUrl}`);

const publicKey = createPublicKey(`-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA36uhUwxeMMKUBBaX2pDL
nNTk+dB0lCGvViVieh7XaSS9yHuay2BEYDi0e7ghWv47YuE0Pggr1Tt6G+7kWGEA
x/ltKW2Akrs4tg2rEmA2fSh91+F9+oLeEuzhqkRz/y+0GFFTzHq+jefyj4bBTGLr
nt8r35YigSxRS7LWwjyrUIltEzvj2uaTC16rY0B79ltZKxW1eRDdMgl3B9WKOdOr
IQD3eualT7/gLOFtyL4CKbpszlkd+leKgyZeaj71vES5pntruHfoaEdqhyfBjMmk
4d3pW/yBI6+I6HvKFtn0SLkvSn0XUc7o09vSFGlcXQTIdjdx4hacxsPwQlXmlLEd
T5zY/ZGNPDjnU/jyEPavuHYsi3l4ug3/Tep3FaOGYoutf/TkpS3jNT8qFtWtmfmD
WEVwT6urSAOX9TrRrzlwex/0Dd5uJhgxSNTG3ROLdRtStS2eR1if5Ohmy09Khq3M
0f7id++LwV/AzwQgedtWMJBJVk8VzrI19qXK5dPEcRRpAgMBAAE=
-----END PUBLIC KEY-----`);

let requestId = 0;
let sessionId;
let protocolVersion = "2025-03-26";

async function rpc(method, params = {}, notification = false) {
  const id = notification ? undefined : ++requestId;
  const body = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;

  let response;
  try {
    response = await fetch(jobUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    throw new Error("Could not reach the job MCP server");
  }

  if (!response.ok) throw new Error(`Job MCP server returned HTTP ${response.status}`);
  if (notification || response.status === 202 || response.status === 204) return undefined;

  sessionId ??= response.headers.get("mcp-session-id") ?? undefined;
  const contentType = response.headers.get("content-type") ?? "";
  let message;
  if (contentType.includes("text/event-stream")) {
    const stream = await response.text();
    const events = stream.split(/\r?\n\r?\n/);
    const candidates = events.flatMap((event) => {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    message = candidates.findLast((candidate) => candidate.id === id);
  } else {
    try { message = await response.json(); } catch { /* handled below */ }
  }

  if (!message || message.error) throw new Error(`Job MCP request failed: ${method}`);
  return message.result;
}

async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result?.isError) throw new Error(`Job tool failed: ${name}`);
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const texts = (result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text);
  if (texts.length === 1) {
    try { return JSON.parse(texts[0]); } catch { return texts[0]; }
  }
  return texts;
}

function objectValues(value) {
  if (Array.isArray(value)) return value.flatMap(objectValues);
  if (value && typeof value === "object") return [value, ...Object.values(value).flatMap(objectValues)];
  return [];
}

function toolProperty(tool, names, fallback) {
  const properties = tool.inputSchema?.properties ?? {};
  return names.find((name) => Object.hasOwn(properties, name)) ?? fallback;
}

function recordId(entry, readTool) {
  const properties = readTool.inputSchema?.properties ?? {};
  const accepted = Object.keys(properties).filter((key) => /(^id$|record.*id|incident.*id|entry.*id)/i.test(key));
  for (const key of accepted) {
    if (entry[key] !== undefined && ["string", "number"].includes(typeof entry[key])) return [key, entry[key]];
  }
  for (const [key, value] of Object.entries(entry)) {
    if (accepted.includes(key) && ["string", "number"].includes(typeof value)) return [key, value];
  }
  throw new Error("The tram-3 search result did not include a usable record identifier");
}

function textFrom(value) {
  if (typeof value === "string") return value;
  const objects = objectValues(value);
  for (const key of ["redacted", "redactedText", "text"]) {
    for (const object of objects) {
      if (typeof object[key] === "string") return object[key];
    }
  }
  throw new Error("The redact tool did not return redacted text");
}

async function encryptAndPublish(payload) {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    version: 1,
    key: publicEncrypt({ key: publicKey, oaepHash: "sha256" }, aesKey).toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) throw new Error("GitHub step summary is unavailable");
  await appendFile(summaryPath,
    "## Job 1 encrypted result\n\nOnly the matching local private key can decrypt this payload.\n\n```text\n" +
    JSON.stringify(envelope) + "\n```\n");
}

try {
  const initialized = await rpc("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "mega-two-places-job-1", version: "1.0.0" },
  });
  if (initialized?.protocolVersion) protocolVersion = initialized.protocolVersion;
  await rpc("notifications/initialized", {}, true);

  const listed = await rpc("tools/list");
  const tools = listed?.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const required of ["search", "read", "redact", "submit"]) {
    if (!byName.has(required)) throw new Error(`Required job tool is unavailable: ${required}`);
  }

  const searchTool = byName.get("search");
  const searchScopeKey = toolProperty(searchTool, ["scope"], "scope");
  const found = await callTool("search", { [searchScopeKey]: "ops/live" });
  const entries = objectValues(found);
  const tram = entries.find((entry) => Object.values(entry).some((value) =>
    typeof value === "string" && /\btram-3\b/i.test(value)));
  if (!tram) throw new Error("No tram-3 incident was found in the live scope");

  const readTool = byName.get("read");
  const [idKey, idValue] = recordId(tram, readTool);
  const fieldsKey = toolProperty(readTool, ["fields"], "fields");
  const fields = ["date", "time", "clock", "line", "cause"];
  const readValue = await callTool("read", { [idKey]: idValue, [fieldsKey]: fields });

  const dataObject = objectValues(readValue).find((entry) => fields.every((field) => Object.hasOwn(entry, field)));
  if (!dataObject) throw new Error("The incident read did not return all required fields");
  const record = Object.fromEntries(fields.map((field) => [field, dataObject[field]]));
  const draft = fields.map((field) => `${field}: ${record[field]}`).join("\n");

  const redactedValue = await callTool("redact", { text: draft });
  const redactedText = textFrom(redactedValue);
  const submitValue = await callTool("submit", { text: redactedText, skillVersion: "1" });

  await encryptAndPublish({
    record,
    redactedText,
    submit: submitValue,
    submittedAt: new Date().toISOString(),
  });
} catch (error) {
  // Error messages are deliberately generic; never expose the bearer URL or source record in logs.
  console.error(error instanceof Error ? error.message : "Job 1 worker failed");
  process.exitCode = 1;
}
