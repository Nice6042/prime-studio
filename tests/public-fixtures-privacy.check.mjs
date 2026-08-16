import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const SYNTHETIC_FIXTURE = "prime-studio-synthetic";
const SYNTHETIC_API = "synthetic-api";
const SYNTHETIC_PROVIDER = "synthetic-provider";
const SYNTHETIC_MODEL = "synthetic-model";
const SYNTHETIC_TOOL_ID = "tool-synthetic-1";
const SYNTHETIC_TOOL_CODE =
  'from pathlib import Path\np = Path("fixture.txt")\np.write_text("OK\\n")\nprint(p.exists(), repr(p.read_text()))';
const SYNTHETIC_TOOL_OUTPUT = "True 'OK\\n'\n";
const RAW_DESCRIPTION = "Synthetic-only deterministic reducer replay input.";
const SHAPE_DESCRIPTION = "Synthetic-only deterministic reducer replay shape.";

const TEXT_EXTENSIONS = new Set([
  ".bat",
  ".cjs",
  ".cmd",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".lock",
  ".log",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".rs",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

// This generated, application-owned upstream bundle is validated separately by
// exact resource pins and legal/dependency checks. Its public API routes and
// example home-directory strings are upstream code, not project data.
const TEXT_SCAN_EXCLUDED_FILES = new Set([
  "app/harness-sidecar/vendor/prime-daemon-adapter-v0.7.1.mjs",
  "app/harness-sidecar/vendor/v0.7.2/prime-daemon-adapter.mjs",
]);

const captureResidue = new RegExp(
  [
    ["captured", "prime(?:-agent)?", "stream"].join("\\s+"),
    ["capturing", "machine"].join("\\s+"),
    ["captured", "session", "data"].join("\\s+"),
    ["real", "line", "captured"].join("\\s+"),
    String.raw`rpc_probe\.txt`,
  ].join("|"),
  "iu",
);

const privateHistoryIds = [
  ["090d", "527f"],
  ["9ce5", "66a"],
  ["fddf", "7c31"],
  ["d216", "b1ab"],
  ["61f4", "d2b9"],
  ["02b4", "3cb5"],
  ["e96f", "1383"],
].map((parts) => parts.join(""));

const forbiddenTextPatterns = [
  {
    name: "a personal developer path",
    pattern:
      /(?:\b[A-Z]:[\\/]{1,2}dev[\\/]{1,2}studio(?:[\\/]{1,2}[^\s"'`<>]*)?|\b[A-Z]:[\\/]{1,2}Users[\\/]{1,2}(?!(?:operator|synthetic|[a-z])(?:[\\/]|$))[^\\/\s"'`<>]+(?:[\\/]{1,2}[^\s"'`<>]*)?|\/(?:Users|home)\/(?!\$\{)(?!(?:operator|synthetic|[a-z])(?:\/|$))[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?)/iu,
  },
  {
    name: "a private Codex task/thread ID",
    pattern: /\b019[0-9a-f]{5}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
  },
  {
    name: "an absolute developer worktree path",
    pattern:
      /(?:\b[A-Z]:[\\/]{1,2}[^\r\n"'`<>]*?[\\/]{1,2}\.worktrees[\\/]{1,2}[^\s"'`<>]+|\/(?!workspace(?:\/|$))[^\r\n"'`<>]*?\/\.worktrees\/[^\s"'`<>]+)/iu,
  },
  {
    name: "a private development-history identifier",
    pattern: new RegExp(privateHistoryIds.join("|"), "iu"),
  },
  {
    name: "an internal branch, worktree, or agent route",
    pattern: /(?:(?<!openai-)(?<!\.)\bcodex\/(?!responses\b)[a-z0-9._/-]+|(?:^|[\s`])\/root\/[a-z0-9._/-]+|(?:^|[\s`])\.worktrees[\\/][^\s`]+)/imu,
  },
  {
    name: "a local audit snapshot identifier",
    pattern: new RegExp(`${["prime", "studio", "oss", "audit"].join("-")}-[a-z0-9-]+`, "iu"),
  },
  {
    name: "account token-scope prose",
    pattern: new RegExp(
      `(?:${["token", "has"].join(" ")}|${["token", "lacks"].join(" ")}|${["token", "scopes?"].join(" ")})[^\\n]{0,100}(?:read:org|workflow|user scope)`,
      "iu",
    ),
  },
  {
    name: "an account-like provider alias",
    pattern:
      /(?<![A-Z0-9._%+-])(?!synthetic(?:[._+-][A-Z0-9]+)*@)[A-Z0-9][A-Z0-9._%+-]*@(?:anthropic|openai-codex|prime-inference)\b/iu,
  },
  {
    name: "an account quota display",
    pattern:
      /(?:\b(?:anthropic|openai-codex|prime-inference)(?:\s+\d{1,3}[dhm])?\s+\d{1,3}%(?!\d)|\b\d{1,3}[dhm]\s+\d{1,3}%(?!\d)|\bChatGPT\s+\d{1,3}%\s+of\s+\d{1,3}[dhm]\b)/iu,
  },
  {
    name: "an account spend display",
    pattern: new RegExp(
      `(?:${["SPEND", "TODAY"].join("\\s+")}|\\$(?!0+(?:\\.0+)?\\s+today\\b)\\d+(?:\\.\\d+)?\\s+today\\b)`,
      "iu",
    ),
  },
  { name: "live-capture residue", pattern: captureResidue },
];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function parseJsonLines(relativePath) {
  return read(relativePath)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${relativePath}:${index + 1} is not valid JSON: ${error.message}`);
      }
    });
}

function assertSyntheticMessage(message, expectedTimestamp) {
  assert.equal(message.role, "assistant");
  assert.equal(message.api, SYNTHETIC_API);
  assert.equal(message.provider, SYNTHETIC_PROVIDER);
  assert.equal(message.model, SYNTHETIC_MODEL);
  assert.equal(message.timestamp, expectedTimestamp);
}

function findTextViolations(files) {
  const violations = [];
  for (const relativePath of files) {
    const contents = read(relativePath);
    for (const { name, pattern } of forbiddenTextPatterns) {
      const match = contents.match(pattern);
      if (match) violations.push(`${relativePath}: ${name} (${JSON.stringify(match[0])})`);
    }
  }
  return violations;
}

test("the complete synthetic RPC stream is deterministic and internally coherent", () => {
  const raw = read("dev/rpc-raw.log");
  const events = parseJsonLines("dev/rpc-raw.log");

  assert.deepEqual(
    events.map(({ type }) => type),
    [
      "fixture_meta",
      "agent_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_update",
      "message_end",
    ],
  );
  assert.deepEqual(
    events.map((event) => Object.keys(event).sort()),
    [
      ["description", "fixture", "type"],
      ["type"],
      ["message", "type"],
      ["message", "type"],
      ["message", "type"],
      ["message", "type"],
      ["args", "toolCallId", "toolName", "type"],
      ["args", "partialResult", "toolCallId", "toolName", "type"],
      ["isError", "result", "toolCallId", "toolName", "type"],
      ["message", "type"],
      ["message", "type"],
      ["message", "type"],
    ],
  );
  assert.deepEqual(events[0], {
    type: "fixture_meta",
    fixture: SYNTHETIC_FIXTURE,
    description: RAW_DESCRIPTION,
  });
  assert.deepEqual(events[1], { type: "agent_start" });

  const messageEvents = events.filter(({ message }) => message);
  assert.deepEqual(
    messageEvents.map(({ message }) => Object.keys(message).sort()),
    [
      ["api", "content", "model", "provider", "role", "timestamp"],
      ["api", "content", "model", "provider", "role", "timestamp"],
      ["api", "content", "model", "provider", "role", "timestamp"],
      [
        "api",
        "content",
        "model",
        "provider",
        "responseId",
        "role",
        "stopReason",
        "timestamp",
        "usage",
      ],
      ["api", "content", "model", "provider", "role", "timestamp"],
      ["api", "content", "model", "provider", "role", "timestamp"],
      [
        "api",
        "content",
        "model",
        "provider",
        "responseId",
        "role",
        "stopReason",
        "timestamp",
        "usage",
      ],
    ],
  );
  assert.deepEqual(
    messageEvents.map(({ message }) => message.timestamp),
    [946684800000, 946684800001, 946684800002, 946684800003, 946684800004, 946684800005, 946684800006],
  );
  messageEvents.forEach(({ message }, index) => assertSyntheticMessage(message, 946684800000 + index));

  assert.deepEqual(events[2].message.content, []);
  assert.deepEqual(events[3].message.content, [
    { type: "text", text: "I'll create the file.", index: 0 },
  ]);
  assert.deepEqual(events[4].message.content, [
    { type: "text", text: "I'll create the file.", index: 0 },
    {
      type: "toolCall",
      id: SYNTHETIC_TOOL_ID,
      name: "ipython",
      arguments: { code: SYNTHETIC_TOOL_CODE },
      index: 1,
    },
  ]);

  assert.deepEqual(events[5].message.content, [
    { type: "text", text: "I'll create the file." },
    {
      type: "toolCall",
      id: SYNTHETIC_TOOL_ID,
      name: "ipython",
      arguments: { code: SYNTHETIC_TOOL_CODE },
    },
  ]);
  assert.deepEqual(events.slice(6, 9).map(({ toolCallId }) => toolCallId), [
    SYNTHETIC_TOOL_ID,
    SYNTHETIC_TOOL_ID,
    SYNTHETIC_TOOL_ID,
  ]);
  assert.deepEqual(events.slice(6, 9).map(({ toolName }) => toolName), ["ipython", "ipython", "ipython"]);
  assert.deepEqual(events[6].args, { code: SYNTHETIC_TOOL_CODE });
  assert.deepEqual(events[7].args, { code: SYNTHETIC_TOOL_CODE });
  assert.deepEqual(events[7].partialResult, {
    content: [{ type: "text", text: "Starting synthetic kernel..." }],
    details: { status: "starting" },
  });
  assert.deepEqual(events[8], {
    type: "tool_execution_end",
    toolCallId: SYNTHETIC_TOOL_ID,
    toolName: "ipython",
    result: {
      content: [{ type: "text", text: SYNTHETIC_TOOL_OUTPUT }],
      details: {
        durationMs: 1,
        status: "ok",
        stdout: SYNTHETIC_TOOL_OUTPUT,
        stderr: "",
        kernelRestarted: false,
      },
    },
    isError: false,
  });
  assert.deepEqual(events[5].message.usage, {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  });
  assert.equal(events[5].message.stopReason, "toolUse");
  assert.equal(events[5].message.responseId, "message-synthetic-1");
  assert.deepEqual(events[9].message.content, []);
  assert.deepEqual(events[10].message.content, [
    {
      type: "text",
      text: "Created the synthetic fixture file containing `OK`.\n\ndone",
      index: 0,
    },
  ]);
  assert.deepEqual(events[11].message.content, [
    { type: "text", text: "Created the synthetic fixture file containing `OK`.\n\ndone" },
  ]);
  assert.deepEqual(events[11].message.usage, {
    input: 5,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0.0005, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
  });
  assert.equal(events[11].message.stopReason, "stop");
  assert.equal(events[11].message.responseId, "message-synthetic-2");
  assert.deepEqual(findTextViolations(["dev/rpc-raw.log"]), []);
  assert.ok(Buffer.byteLength(raw) < 10_000, "synthetic RPC stream should stay minimal");
});

test("the synthetic shape fixture exactly summarizes the RPC stream", () => {
  const events = parseJsonLines("dev/rpc-raw.log");
  const shapes = JSON.parse(read("dev/rpc-shapes.json"));

  assert.deepEqual(Object.keys(shapes).sort(), ["agent_end", "description", "fixture"]);
  assert.equal(shapes.fixture, SYNTHETIC_FIXTURE);
  assert.equal(shapes.description, SHAPE_DESCRIPTION);
  assert.equal(shapes.agent_end.type, "agent_end");
  assert.deepEqual(shapes.agent_end.messages.map(({ role }) => role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);

  const [user, assistant, toolResult, finalAssistant] = shapes.agent_end.messages;
  assert.deepEqual(user, {
    role: "user",
    content: [{ type: "text", text: "Create a file fixture.txt containing OK, then say done." }],
    timestamp: 946684800000,
  });
  assert.deepEqual(assistant, events[5].message);
  assert.deepEqual(toolResult, {
    role: "toolResult",
    toolCallId: SYNTHETIC_TOOL_ID,
    toolName: "ipython",
    content: [{ type: "text", text: SYNTHETIC_TOOL_OUTPUT }],
    details: {
      durationMs: 1,
      status: "ok",
      stdout: SYNTHETIC_TOOL_OUTPUT,
      stderr: "",
      kernelRestarted: false,
    },
    isError: false,
    timestamp: 946684800004,
  });
  assert.deepEqual(finalAssistant, events[11].message);
  assert.deepEqual(findTextViolations(["dev/rpc-shapes.json"]), []);
  assert.ok(
    Buffer.byteLength(JSON.stringify(shapes)) < 10_000,
    "synthetic shape fixture should stay minimal",
  );
});

test("Codex examples use neutral deterministic values", () => {
  const rust = read("app/src-tauri/src/lib.rs");
  const match = rust.match(/const CODEX_LINE: &str = r#"([^\n]+)"#;/u);
  assert.ok(match, "CODEX_LINE fixture must remain a one-line JSON record");

  const record = JSON.parse(match[1]);
  assert.equal(record.timestamp, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(record.payload.info.total_token_usage, {
    input_tokens: 10,
    total_tokens: 12,
  });
  assert.equal(record.payload.info.model_context_window, 1000);
  assert.deepEqual(record.payload.rate_limits.primary, {
    used_percent: 25,
    window_minutes: 60,
    resets_at: 946684800,
  });

  const protocol = read("PROTOCOL.md");
  assert.match(protocol, /Synthetic deterministic example/u);
  assert.match(
    protocol,
    /"tokens":\{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"total":100\}/u,
  );
});

test("privacy patterns catch reviewed account telemetry without flagging neutral examples", () => {
  const matchingPatternNames = (contents) =>
    forbiddenTextPatterns
      .filter(({ pattern }) => pattern.test(contents))
      .map(({ name }) => name);

  const residues = [
    [["research", "anthropic"].join("@"), ["an account-like provider alias"]],
    [["prime", "prime-inference"].join("@"), ["an account-like provider alias"]],
    [["7d", "84%"].join(" "), ["an account quota display"]],
    [["ChatGPT", "63%", "of", "5h"].join(" "), ["an account quota display"]],
    [["$9.04", "today"].join(" "), ["an account spend display"]],
    [["SPEND", "TODAY"].join(" "), ["an account spend display"]],
  ];
  for (const [contents, expected] of residues) {
    assert.deepEqual(matchingPatternNames(contents), expected, contents);
  }

  const neutralExamples = [
    "synthetic@anthropic",
    "synthetic-fixture@openai-codex",
    "team@example.com",
    "84% test coverage over 7 days",
    "$0.00 today in the deterministic example",
  ];
  for (const contents of neutralExamples) {
    assert.deepEqual(matchingPatternNames(contents), [], contents);
  }
});

test("publishable tracked text excludes personal, account, quota, and capture residue", () => {
  const files = trackedFiles().filter((relativePath) => {
    const basename = path.basename(relativePath);
    return !TEXT_SCAN_EXCLUDED_FILES.has(relativePath)
      && (basename.startsWith(".") || TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase()));
  });

  assert.deepEqual(findTextViolations(files), []);
});

test("the unresolved Prime Studio design handoff is absent from the public tree", () => {
  const handoff = "design/mockups/design_handoff_prime_studio";
  const trackedHandoffFiles = trackedFiles().filter(
    (relativePath) => relativePath === handoff || relativePath.startsWith(`${handoff}/`),
  );

  assert.deepEqual(trackedHandoffFiles, []);
  assert.equal(fs.existsSync(path.join(repoRoot, handoff)), false);
});
