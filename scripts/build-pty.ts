/**
 * Build the terminal host, and put it where the app looks for it.
 *
 * `native/pty` is a Rust program with no dependencies, so this is one `cargo
 * build` and a copy. It runs before every build and every compile, because the
 * binary is embedded in the shipped app (`deno.json` → `compile.include`) and
 * a compile that embedded a stale one would ship a terminal that does not match
 * the protocol talking to it.
 *
 * Skipped, loudly, when cargo is missing: everything else in this app builds
 * without a Rust toolchain, and a contributor who is not touching the terminal
 * should not be stopped by one. The committed binary in `native/pty/bin` is
 * what gets shipped in that case, which is also what makes a clean checkout
 * build.
 */
const root = new URL("..", import.meta.url).pathname;
const crate = `${root}native/pty`;
const out = `${crate}/bin/cc-pty`;

async function main() {
  const cargo = await new Deno.Command("cargo", { args: ["--version"] })
    .output().catch(() => null);
  if (!cargo?.success) {
    const existing = await Deno.stat(out).catch(() => null);
    if (existing?.isFile) {
      console.log("cc-pty: cargo not found — keeping the committed binary");
      return;
    }
    console.error(
      "cc-pty: cargo not found and no committed binary — the Console will not start.\n" +
        "        Install Rust (https://rustup.rs) and run `deno task pty`.",
    );
    Deno.exit(1);
  }

  const build = await new Deno.Command("cargo", {
    args: ["build", "--release"],
    cwd: crate,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!build.success) Deno.exit(build.code);

  await Deno.mkdir(`${crate}/bin`, { recursive: true });
  await Deno.copyFile(`${crate}/target/release/cc-pty`, out);
  // The mode matters: this file is copied out of the app at runtime and run.
  await Deno.chmod(out, 0o755);
  const size = (await Deno.stat(out)).size;
  console.log(`cc-pty: built (${(size / 1024).toFixed(0)} KB)`);
}

await main();
