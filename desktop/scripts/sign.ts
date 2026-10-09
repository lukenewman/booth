/**
 * Re-sign booth.app as a whole bundle. Runs twice per build:
 *
 * - postBuild, on the full app before it's packed into the update archive.
 *   That copy is what actually runs once installed. Signed only binary by
 *   binary, its identity is its executable's name, so macOS privacy prompts
 *   say "launcher" wants access instead of "booth".
 * - postWrap, on the self-extracting wrapper that goes into the DMG. Its
 *   signature comes out invalid ("code has no resources but signature
 *   indicates they must be present"), which risks macOS calling the download
 *   "damaged" with no way through, rather than offering "Open Anyway".
 *
 * With booth's signing certificate it signs with that; without it, ad hoc.
 * The certificate is self-made (no Apple Developer account), so it does
 * nothing for Gatekeeper. What it buys is a stable identity: an ad-hoc
 * signature's identity is a hash of the exact build, so macOS treats every
 * update as a new app and asks for Music-folder access again. Signed with the
 * same certificate each time, privacy grants survive updates.
 *
 * The certificate is a .p12 at BOOTH_SIGNING_P12 with its password in
 * BOOTH_SIGNING_PASSWORD (the release workflow sets both from secrets), or
 * by default ~/.booth-signing/booth.p12 and ~/.booth-signing/password. It is
 * loaded into a throwaway keychain for the one codesign call, so nothing is
 * left in the login keychain and codesign never asks for keychain access.
 * codesign only finds identities in keychains on the search list (its
 * --keychain flag alone says "no identity found"), so the throwaway one is
 * put on the list for the call and the list restored after.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function builtApp(): string {
	const dir = process.env.ELECTROBUN_BUILD_DIR!;
	// "booth.app" for stable, "booth-dev.app" for dev.
	const apps = readdirSync(dir).filter((name) => name.endsWith(".app"));
	if (apps.length !== 1) throw new Error(`sign: expected one .app in ${dir}, found ${apps.join(", ") || "none"}`);
	return join(dir, apps[0]!);
}

function run(cmd: string[], what: string): string {
	const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "inherit" });
	if (result.exitCode !== 0) throw new Error(`sign: ${what} failed`);
	return result.stdout.toString();
}

/** The signing certificate's .p12 and password, or null to sign ad hoc. */
function certificate(): { p12: string; password: string } | null {
	const dir = join(homedir(), ".booth-signing");
	const p12 = process.env.BOOTH_SIGNING_P12 || join(dir, "booth.p12");
	if (!existsSync(p12)) return null;
	const password = process.env.BOOTH_SIGNING_PASSWORD ?? readFileSync(join(dir, "password"), "utf8").trim();
	return { p12, password };
}

function codesign(app: string, identity: string) {
	run(
		["codesign", "--force", "--deep", "--sign", identity, "--preserve-metadata=entitlements", app],
		`codesign on ${app}`,
	);
}

function searchList(): string[] {
	return run(["security", "list-keychains", "-d", "user"], "reading the keychain search list")
		.split("\n")
		.map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
		.filter(Boolean);
}

const app = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ?? builtApp();
const cert = certificate();

if (!cert) {
	codesign(app, "-");
	console.log(`sign: ${app} (ad hoc, no signing certificate)`);
} else {
	const dir = mkdtempSync(join(tmpdir(), "booth-sign-"));
	const keychain = join(dir, "sign.keychain-db");
	const kcPassword = crypto.randomUUID();
	const originalSearchList = searchList();
	try {
		run(["security", "create-keychain", "-p", kcPassword, keychain], "creating the keychain");
		run(["security", "unlock-keychain", "-p", kcPassword, keychain], "unlocking the keychain");
		run(
			["security", "list-keychains", "-d", "user", "-s", keychain, ...originalSearchList],
			"adding the keychain to the search list",
		);
		run(
			["security", "import", cert.p12, "-k", keychain, "-P", cert.password, "-T", "/usr/bin/codesign"],
			"importing the certificate",
		);
		// Lets codesign use the key without a "codesign wants to access" dialog.
		run(
			["security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", kcPassword, keychain],
			"allowing codesign to use the key",
		);
		// The certificate is self-made, so macOS doesn't trust it and `-v`
		// (valid identities only) would hide it; codesign signs with it anyway.
		const hash = run(["security", "find-identity", "-p", "codesigning", keychain], "finding the identity")
			.match(/\b([0-9A-F]{40})\b/)?.[1];
		if (!hash) throw new Error("sign: no code-signing identity in the certificate");
		codesign(app, hash);
		console.log(`sign: ${app} (booth signing certificate)`);
	} finally {
		Bun.spawnSync(["security", "list-keychains", "-d", "user", "-s", ...originalSearchList]);
		Bun.spawnSync(["security", "delete-keychain", keychain]);
		rmSync(dir, { recursive: true, force: true });
	}
}

run(["codesign", "--verify", "--deep", "--strict", app], `verifying ${app}`);
