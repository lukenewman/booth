/**
 * Re-sign Booth.app ad hoc, as a whole bundle. Runs twice per build:
 *
 * - postBuild, on the full app before it's packed into the update archive.
 *   That copy is what actually runs once installed. Signed only binary by
 *   binary, its identity is its executable's name, so macOS privacy prompts
 *   say "launcher" wants access instead of "Booth".
 * - postWrap, on the self-extracting wrapper that goes into the DMG. Its
 *   signature comes out invalid ("code has no resources but signature
 *   indicates they must be present"), which risks macOS calling the download
 *   "damaged" with no way through, rather than offering "Open Anyway".
 *
 * Booth ships unsigned (no Apple Developer account); a valid ad-hoc signature
 * is the best available.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

function builtApp(): string {
	const dir = process.env.ELECTROBUN_BUILD_DIR!;
	// "Booth.app" for stable, "Booth-dev.app" for dev.
	const apps = readdirSync(dir).filter((name) => name.endsWith(".app"));
	if (apps.length !== 1) throw new Error(`adhoc-sign: expected one .app in ${dir}, found ${apps.join(", ") || "none"}`);
	return join(dir, apps[0]!);
}

const app = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ?? builtApp();

for (const args of [
	["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", app],
	["--verify", "--deep", "--strict", app],
]) {
	const result = Bun.spawnSync(["codesign", ...args], { stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`adhoc-sign: codesign ${args[0]} failed on ${app}`);
}
console.log(`adhoc-sign: ${app}`);
