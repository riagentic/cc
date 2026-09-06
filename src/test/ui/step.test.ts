/**
 * Stepping a list with the arrow keys.
 *
 * Small enough to look obvious, and wrong in two ways before it was written
 * down: it stopped at the ends, and pressing "previous" from no selection went
 * forwards.
 */
import { assertEquals } from "@std/assert";
import { from } from "../../ui/commands.ts";

const list = ["a", "b", "c"];

Deno.test("stepping wraps in both directions", () => {
  assertEquals(from(list, 0, 1), "b");
  assertEquals(from(list, 2, 1), "a", "off the end, back to the start");
  assertEquals(from(list, 0, -1), "c", "off the start, round to the end");
  assertEquals(from(list, 1, -1), "a");
});

Deno.test("with nothing selected, each key points where it points", () => {
  // "Next" steps onto the front of the ring, "previous" onto the back. Taking
  // "nothing selected" to mean index 0 gave the first item for both, so up and
  // down did the same thing.
  assertEquals(from(list, -1, 1), "a");
  assertEquals(from(list, -1, -1), "c");
});

Deno.test("one item is its own neighbour, and none is nothing", () => {
  // A single project must still be reachable — the guard that used to require
  // two items meant a one-project dock could not be walked at all.
  assertEquals(from(["only"], 0, 1), "only");
  assertEquals(from(["only"], -1, -1), "only");
  assertEquals(from([], 0, 1), undefined);
  assertEquals(from([], -1, 1), undefined);
});
