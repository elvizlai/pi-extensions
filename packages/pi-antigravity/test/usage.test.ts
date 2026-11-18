import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAgyUsageArgs,
  fetchAgyUsage,
  formatAgyUsageReport,
  formatAgyUsageShort,
  formatReset,
  parseAgyUsageJson,
  remainingPercent,
  usageBar,
  usageWindowLabel,
  type FetchAgyUsageOptions,
} from "../lib/usage.ts";

const USAGE_JSON = `{
  "conversation_id": "",
  "status": "SUCCESS",
  "response": "Gemini Models\\tWeekly Limit Remaining\\t97%\\t2026-09-04T01:10:30Z\\n",
  "duration_seconds": 0,
  "num_turns": 0,
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
  "command": {
    "name": "usage",
    "data": {
      "description": "Within each group, models share a weekly limit and a 5-hour limit.",
      "groups": [
        {
          "name": "Gemini Models",
          "description": "Models within this group: Gemini Flash, Gemini Pro",
          "buckets": [
            {
              "id": "gemini-weekly",
              "name": "Weekly Limit Remaining",
              "window": "weekly",
              "remaining_fraction": 0.9719216227531433,
              "reset_time": "2026-09-04T01:10:30Z"
            },
            {
              "id": "gemini-5h",
              "name": "Five Hour Limit Remaining",
              "window": "5h",
              "remaining_fraction": 0.9795392751693726,
              "reset_time": "2026-08-28T11:53:42Z"
            }
          ]
        },
        {
          "name": "Claude and GPT models",
          "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          "buckets": [
            {
              "id": "3p-weekly",
              "name": "Weekly Limit Remaining",
              "window": "weekly",
              "remaining_fraction": 1,
              "reset_time": "2026-09-04T07:08:42Z"
            },
            {
              "id": "3p-5h",
              "name": "Five Hour Limit Remaining",
              "window": "5h",
              "remaining_fraction": 1,
              "reset_time": "2026-08-28T12:08:42Z"
            }
          ]
        }
      ]
    }
  }
}`;

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function fakeExec(
  impl: (file: string, args: readonly string[], cb: ExecCallback) => void,
): NonNullable<FetchAgyUsageOptions["execFileOverride"]> {
  return (file, args, _opts, cb) => {
    impl(file, args, cb);
  };
}

test("buildAgyUsageArgs expands /usage in print mode without disabling slash commands", () => {
  const args = buildAgyUsageArgs(30_000);
  assert.deepEqual(args, [
    "--print",
    "/usage",
    "--output-format",
    "json",
    "--print-timeout",
    "30s",
  ]);
  assert.ok(!args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--conversation"));
});

test("parseAgyUsageJson reads groups and remaining fractions from command.data", () => {
  const report = parseAgyUsageJson(USAGE_JSON);
  assert.equal(report.groups.length, 2);
  assert.equal(report.groups[0].name, "Gemini Models");
  assert.equal(report.groups[0].buckets[0].id, "gemini-weekly");
  assert.equal(report.groups[0].buckets[0].remainingFraction, 0.9719216227531433);
  assert.equal(report.groups[1].buckets[1].remainingFraction, 1);
  assert.match(report.description ?? "", /weekly limit/);
});

test("parseAgyUsageJson unwraps a stream-json result envelope", () => {
  const report = parseAgyUsageJson(
    JSON.stringify({ event: "result", result: JSON.parse(USAGE_JSON) }),
  );
  assert.equal(report.groups[0].name, "Gemini Models");
});

test("parseAgyUsageJson rejects invalid JSON, failed status, and empty groups", () => {
  assert.throws(() => parseAgyUsageJson("not-json"), /not valid JSON/);
  assert.throws(
    () => parseAgyUsageJson(JSON.stringify({ status: "ERROR", error: "not logged in" })),
    /not logged in/,
  );
  assert.throws(
    () => parseAgyUsageJson(JSON.stringify({ status: "SUCCESS", command: { name: "tasks" } })),
    /expected usage command/,
  );
  assert.throws(
    () =>
      parseAgyUsageJson(
        JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } }),
      ),
    /no quota groups/,
  );
});

test("remainingPercent and usageBar clamp and round", () => {
  assert.equal(remainingPercent(0.9719216227531433), 97);
  assert.equal(remainingPercent(1), 100);
  assert.equal(remainingPercent(0), 0);
  assert.equal(remainingPercent(1.5), 100);
  assert.equal(remainingPercent(-0.2), 0);
  assert.equal(usageBar(1, 4), "[████]");
  assert.equal(usageBar(0, 4), "[░░░░]");
  assert.equal(usageBar(0.5, 4), "[██░░]");
});

test("usageWindowLabel matches /usage window names", () => {
  assert.equal(
    usageWindowLabel({
      id: "gemini-weekly",
      name: "Weekly Limit Remaining",
      window: "weekly",
      remainingFraction: 1,
    }),
    "Weekly limit",
  );
  assert.equal(
    usageWindowLabel({
      id: "gemini-5h",
      name: "Five Hour Limit Remaining",
      window: "5h",
      remainingFraction: 1,
    }),
    "5h limit",
  );
});

test("formatReset uses local clock time like /usage", () => {
  const now = new Date(2026, 7, 28, 12, 0, 0);
  const laterToday = new Date(2026, 7, 28, 19, 53, 0);
  const nextWeek = new Date(2026, 8, 4, 9, 10, 0);
  assert.equal(formatReset(laterToday.toISOString(), now), "19:53");
  assert.equal(formatReset(nextWeek.toISOString(), now), "09:10 on 4 Sep");
  assert.equal(formatReset("not-a-date", now), undefined);
});

test("formatAgyUsageReport matches the /usage layout", () => {
  const report = parseAgyUsageJson(USAGE_JSON);
  const now = new Date("2026-08-28T07:08:42Z");
  const lines = formatAgyUsageReport(report, now).split("\n");
  assert.equal(lines[0], "Gemini Models");
  assert.match(lines[1], /^ {2}5h limit:\s+\[█+░*\] 98% left · resets /);
  assert.equal(lines[2], "");
  assert.match(lines[3], /^ {2}Weekly limit:\s+\[█+░*\] 97% left · resets /);
  assert.equal(lines[4], "");
  assert.equal(lines[5], "Claude and GPT models");
  assert.match(lines[6], /^ {2}5h limit:\s+\[█{20}\] 100% left · resets /);
  assert.equal(lines[7], "");
  assert.match(lines[8], /^ {2}Weekly limit:\s+\[█{20}\] 100% left · resets /);
  assert.equal(lines[1].indexOf("5h limit:"), 2);
  assert.equal(lines[1].indexOf("["), 20);
});

test("formatAgyUsageShort matches the active model group and falls back to worst-per-window", () => {
  const report = parseAgyUsageJson(USAGE_JSON);
  // Gemini resets in 2h15m / 6d15h32m, Claude and GPT in 2h30m / 6d21h30m.
  const now = new Date("2026-08-28T09:38:42Z");
  assert.equal(formatAgyUsageShort(report, undefined, now), "2h:98% · 7d:97%");
  assert.equal(formatAgyUsageShort(report, "gemini-3.8-flash", now), "2h:98% · 7d:97%");
  assert.equal(formatAgyUsageShort(report, "claude-opus-4-6-thinking", now), "3h:100% · 7d:100%");
  assert.equal(formatAgyUsageShort(report, "gpt-oss-120b", now), "3h:100% · 7d:100%");
  assert.equal(formatAgyUsageShort(report, "unknown-model", now), "2h:98% · 7d:97%");
  // Unknown windows (rank 2) never beat 5h/weekly for the two footer slots.
  const custom: typeof report = {
    groups: [
      {
        name: "Custom",
        buckets: [{ id: "c1", name: "Custom limit", window: "monthly", remainingFraction: 0.1 }],
      },
    ],
  };
  assert.equal(formatAgyUsageShort(custom), "monthly 10%");
  assert.equal(formatAgyUsageShort({ groups: [{ name: "Empty", buckets: [] }] }), "");
});

test("formatAgyUsageShort keys windows by time left and paints by pace", () => {
  const now = new Date("2026-08-28T00:00:00Z");
  const paint = (level: string, text: string) => `<${level}>${text}>`;
  const short = (fiveHour: [number, string?], weekly: [number, string?]) =>
    formatAgyUsageShort(
      {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "5h",
                name: "5h",
                window: "5h",
                remainingFraction: fiveHour[0],
                resetTime: fiveHour[1],
              },
              {
                id: "wk",
                name: "Weekly",
                window: "weekly",
                remainingFraction: weekly[0],
                resetTime: weekly[1],
              },
            ],
          },
        ],
      },
      undefined,
      now,
      paint,
    );
  // 96% with 2h of 5h left is on pace; 38% with 5d of 7d left runs out early.
  assert.equal(
    short([0.96, "2026-08-28T02:00:00Z"], [0.38, "2026-09-02T00:00:00Z"]),
    "2h:96% · <warning>5d:38%>",
  );
  // One rounded unit; the same 38% with a day left lasts until the reset.
  assert.equal(
    short([0.96, "2026-08-28T00:59:40Z"], [0.38, "2026-08-28T23:40:00Z"]),
    "1h:96% · 1d:38%",
  );
  // Nearly exhausted is an error whatever the pace.
  assert.equal(
    short([0.05, "2026-08-28T00:05:00Z"], [0.38, "2026-08-28T18:00:00Z"]),
    "<error>5m:5%> · 18h:38%",
  );
  // Missing, invalid, or already-past reset times keep the window name.
  assert.equal(short([0.96], [0.38, "not-a-date"]), "5h 96% · weekly 38%");
  assert.equal(short([0.96, "2026-08-27T23:00:00Z"], [0.38]), "5h 96% · weekly 38%");
});

test("fetchAgyUsage parses stdout from the injected exec", async () => {
  const captured: { file: string; args: readonly string[] } = { file: "", args: [] };
  const report = await fetchAgyUsage({
    binary: "agy-test",
    execFileOverride: fakeExec((file, args, cb) => {
      captured.file = file;
      captured.args = args;
      queueMicrotask(() => cb(null, USAGE_JSON, ""));
    }),
  });
  assert.equal(captured.file, "agy-test");
  assert.equal(captured.args[1], "/usage");
  assert.ok(!captured.args.includes("--disable-slash-commands"));
  assert.equal(report.groups.length, 2);
});

test("fetchAgyUsage surfaces stderr when the process fails", async () => {
  await assert.rejects(
    () =>
      fetchAgyUsage({
        execFileOverride: fakeExec((_file, _args, cb) => {
          queueMicrotask(() =>
            cb(Object.assign(new Error("spawn failed"), { code: 1 }), "", "not logged in\n"),
          );
        }),
      }),
    /not logged in/,
  );
});

test("fetchAgyUsage preserves AbortError when the caller cancels", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    () =>
      fetchAgyUsage({
        signal,
        execFileOverride: fakeExec((_file, _args, cb) => {
          const err = Object.assign(new Error("aborted"), { name: "AbortError" });
          queueMicrotask(() => cb(err, "", ""));
        }),
      }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
