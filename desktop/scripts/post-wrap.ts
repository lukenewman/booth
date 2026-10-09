/**
 * Re-sign the downloadable app ad hoc before it goes into the DMG.
 *
 * Booth ships unsigned (no Apple Developer account), and Electrobun's wrapper
 * bundle comes out with a signature that doesn't verify ("code has no
 * resources but signature indicates they must be present"). An invalid
 * signature risks macOS calling the download "damaged", which offers no way
 * through; a valid ad-hoc one gets the normal "Open Anyway" path instead.
 */
const app = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
if (!app) throw new Error("post-wrap: ELECTROBUN_WRAPPER_BUNDLE_PATH not set");

for (const args of [
	["--force", "--deep", "--sign", "-", app],
	["--verify", "--deep", "--strict", app],
]) {
	const result = Bun.spawnSync(["codesign", ...args], { stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`post-wrap: codesign ${args[0]} failed`);
}
console.log(`post-wrap: ad-hoc signed ${app}`);
