/**
 * Which shortcuts survive a focused terminal.
 *
 * The line is worth pinning from both sides: a chord that stops working when
 * you click into a shell is a shortcut people stop trusting, and a chord taken
 * FROM the shell is one a program running in it can no longer receive.
 */
import { assertEquals } from "@std/assert";
import { worksInTerminal } from "../../ui/commands.ts";

const press = (
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyboardEvent =>
  ({
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  }) as KeyboardEvent;

Deno.test("moving around the app works from inside a shell", () => {
  assertEquals(worksInTerminal(press("ArrowDown", { ctrl: true })), true);
  assertEquals(worksInTerminal(press("ArrowUp", { ctrl: true })), true);
  assertEquals(worksInTerminal(press("ArrowRight", { ctrl: true })), true);
  assertEquals(worksInTerminal(press("ArrowLeft", { ctrl: true })), true);
  assertEquals(worksInTerminal(press("ArrowDown", { alt: true })), true);
  assertEquals(worksInTerminal(press("ArrowUp", { alt: true })), true);
  assertEquals(worksInTerminal(press("k", { ctrl: true })), true);
});

Deno.test("the shell keeps what the shell needs", () => {
  // Plain typing, obviously.
  assertEquals(worksInTerminal(press("a")), false);
  assertEquals(worksInTerminal(press("ArrowDown")), false);
  // Escape belongs to whatever is running — `vim` needs it far more than this
  // app does.
  assertEquals(worksInTerminal(press("Escape")), false);
  // And `Ctrl [` IS Escape: the same byte. Taking it for "previous project"
  // would take Escape from `vim` under another name.
  assertEquals(worksInTerminal(press("[", { ctrl: true })), false);
  assertEquals(worksInTerminal(press("]", { ctrl: true })), false);
  // Ctrl+C is the whole reason a terminal has a keyboard.
  assertEquals(worksInTerminal(press("c", { ctrl: true })), false);
});

Deno.test("the modifiers have to match exactly", () => {
  // A chord claimed with one set of modifiers must not answer for another, or
  // the shell loses keys nobody listed.
  assertEquals(worksInTerminal(press("ArrowDown")), false);
  assertEquals(
    worksInTerminal(press("ArrowDown", { ctrl: true, shift: true })),
    false,
  );
  assertEquals(worksInTerminal(press("k")), false);
});
