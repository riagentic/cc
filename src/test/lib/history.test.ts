import { assert, assertEquals } from "@std/assert";
import {
  type HistRow,
  mergeRows,
  queryTerms,
  readHistoryRow,
  searchHistory,
} from "../../lib/history.ts";

const row = (
  conv: string,
  id: string,
  role: HistRow["role"],
  text: string,
  at: number,
  extra: Partial<HistRow> = {},
): HistRow => ({ conv, id, role, text, at, ...extra });

const ROWS: HistRow[] = [
  row("aaaaaaaa-1", "u1", "user", "set up the pomodoro timer", 1_000),
  row("aaaaaaaa-1", "t1", "tool", "error: port 8080 already in use", 2_000, {
    toolName: "sh",
  }),
  row(
    "aaaaaaaa-1",
    "a1",
    "assistant",
    "Moved the dev server to port 8081.",
    3_000,
  ),
  row("bbbbbbbb-2", "u2", "user", "why does the build fail?", 4_000),
  row(
    "bbbbbbbb-2",
    "a2",
    "assistant",
    "The build fails on a missing import.",
    5_000,
  ),
];
const OPTS = { self: "bbbbbbbb-2", budget: 4_000 };

Deno.test("query terms: phrases stay whole, noise goes", () => {
  assertEquals(queryTerms('"port 8080" Error a'), ["port 8080", "error"]);
  assertEquals(queryTerms("   "), []);
});

Deno.test("a row saved twice keeps its longest copy", () => {
  const merged = mergeRows([
    row("c", "x", "tool", "head … tail", 1),
    row("c", "x", "tool", "head and the whole middle and tail", 1),
  ]);
  assertEquals(merged.length, 1);
  assert(merged[0].text.includes("whole middle"));
});

Deno.test("every term found ranks first, tagged with where and who", () => {
  const out = searchHistory(ROWS, "port 8081", OPTS);
  const first = out.split("\n")[1];
  assert(first.includes("id a1"), out);
  assert(first.includes("[aaaaaaaa ·"), out);
  assert(first.includes("assistant"), out);
});

Deno.test("the conversation the model is in is called 'this'", () => {
  const out = searchHistory(ROWS, "build", OPTS);
  assert(out.includes("[this ·"), out);
});

Deno.test("no query lists the conversations, named by their first request", () => {
  const out = searchHistory(ROWS, "", OPTS);
  assert(out.includes('"set up the pomodoro timer"'), out);
  assert(out.includes("this ·"), out);
  assert(out.includes("3 messages"), out);
});

Deno.test("one conversation, by tag", () => {
  const out = searchHistory(ROWS, "8080", {
    ...OPTS,
    conversation: "bbbbbbbb",
  });
  assert(out.startsWith("Nothing"), out);
  const mine = searchHistory(ROWS, "build", { ...OPTS, conversation: "this" });
  assert(mine.includes("id a2"), mine);
});

Deno.test("a whole word beats a piece of one", () => {
  const out = searchHistory(ROWS, "port", OPTS);
  // "port 8080" and "port 8081" before "import".
  assert(!out.split("\n")[1].includes("import"), out);
  assert(out.split("\n").at(-1)!.includes("import"), out);
});

Deno.test("no match says so, and suggests what to do", () => {
  const out = searchHistory(ROWS, "kubernetes", OPTS);
  assert(out.startsWith("Nothing"), out);
  assert(out.includes("different words"), out);
});

Deno.test("an id opens one message whole; an unknown one is an error", () => {
  const out = readHistoryRow(ROWS, "t1", OPTS);
  assert(out.includes("sh result"), out);
  assert(out.includes("port 8080 already in use"), out);
  assert(readHistoryRow(ROWS, "nope", OPTS).startsWith("Error:"));
});

Deno.test("results stay inside the budget", () => {
  const many = Array.from(
    { length: 200 },
    (_, i) => row("c", `r${i}`, "tool", `needle ${"x".repeat(2_000)}`, i),
  );
  const out = searchHistory(many, "needle", { self: "c", budget: 1_500 });
  assert(out.length <= 1_600, String(out.length));
});

Deno.test("a nonsense time read from disk does not break the search", () => {
  const odd = [row("c", "z", "user", "needle here", 1e300)];
  const out = searchHistory(odd, "needle", { self: "c", budget: 2_000 });
  assert(out.includes("id z"), out);
  assert(out.includes("· ? ·"), out);
});

Deno.test("times are the user's own clock, not UTC", () => {
  // A result that says 08:37 while the app's own clock says 10:37 has the
  // model reasoning about "earlier today" from the wrong hour.
  const at = Date.UTC(2026, 8, 12, 8, 37);
  const out = searchHistory(
    [row("c", "z", "user", "needle here", at)],
    "needle",
    { self: "c", budget: 2_000 },
  );
  const want = new Date(at).toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  assert(out.includes(want), `${out}\nwanted ${want}`);
});
