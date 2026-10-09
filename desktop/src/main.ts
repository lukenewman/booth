/**
 * Booth's desktop shell. Booth's own server (the SvelteKit production build)
 * runs inside this Bun process; the window is a Chromium view of it.
 */
import { ApplicationMenu, BrowserWindow, BuildConfig, PATHS, Updater, Utils } from "electrobun/main";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const boothDir = join(PATHS.RESOURCES_FOLDER, "app", "booth");
const testDataDir = BuildConfig.getSync().runtime?.["testDataDir"];
const dataDir = typeof testDataDir === "string" ? testDataDir : join(homedir(), ".booth");
const settingsPath = join(dataDir, "settings.env");

if (dataDir !== join(homedir(), ".booth")) {
	// Booth's defaults all hang off ~/.booth (cover art aside, which only the
	// Music.app import writes).
	process.env.BOOTH_DB_PATH = join(dataDir, "booth.db");
	process.env.BOOTH_BACKUP_PATH = join(dataDir, "backups");
	process.env.BOOTH_RECORDINGS_PATH = join(dataDir, "recordings");
	process.env.BOOTH_INBOX_PATH = join(dataDir, "inbox");
	process.env.BOOTH_LIBRARY_PATH = join(dataDir, "library");
}

// --- Settings ---------------------------------------------------------------
// The packaged app has no repo .env; its config lives beside the database.

mkdirSync(dataDir, { recursive: true });
if (!existsSync(settingsPath)) {
	copyFileSync(join(boothDir, "settings.env.example"), settingsPath);
}

for (const line of readFileSync(settingsPath, "utf8").split("\n")) {
	const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
	if (!match) continue;
	const value = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
	// Empty means "not set": an empty ITUNES_XML_PATH must not count as configured.
	if (value) process.env[match[1]!] ??= value;
}

if (!process.env.DISCOGS_TOKEN) {
	Bun.spawn(["open", "-e", settingsPath]);
}

// --- Server -----------------------------------------------------------------

/** Booth's usual port, or the next free one if something else holds it. */
async function pickPort(preferred: number): Promise<number> {
	for (let port = preferred; port < preferred + 20; port++) {
		const free = await new Promise<boolean>((resolve) => {
			const probe = createServer()
				.once("error", () => resolve(false))
				.once("listening", () => probe.close(() => resolve(true)))
				.listen(port, "127.0.0.1");
		});
		if (free) return port;
	}
	throw new Error(`no free port in ${preferred}–${preferred + 19}`);
}

const port = await pickPort(Number(process.env.BOOTH_PORT ?? 4747));
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.BOOTH_MIGRATIONS_DIR = join(boothDir, "migrations");

// The page asks the server about updates; the server asks us through this.
let pendingUpdate: { version: string } | null = null;
(globalThis as { __boothDesktop?: unknown }).__boothDesktop = { // shape: src/app.d.ts
	pendingUpdate: () => pendingUpdate,
	restartToUpdate: () => void Updater.applyUpdate(),
	titlebarDoubleClick: () => {
		// System Settings → Desktop & Dock → "Double-click a window's title bar to".
		const pref = Bun.spawnSync(["defaults", "read", "-g", "AppleActionOnDoubleClick"]).stdout.toString().trim();
		if (pref === "Minimize") win.minimize();
		else if (pref === "None" || pref === "Do Nothing") return;
		else if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	},
};

await import(join(boothDir, "build", "index.js"));

// --- Window -----------------------------------------------------------------

ApplicationMenu.setApplicationMenu([
	{
		submenu: [
			{ role: "about" },
			{ label: "Check for Updates…", action: "check-updates" },
			{ label: "Open Settings File", action: "open-settings" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	},
	{
		label: "View",
		submenu: [
			{ label: "Reload", action: "reload", accelerator: "CommandOrControl+R" },
			{ role: "toggleFullScreen" },
		],
	},
	{
		label: "Window",
		submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
	},
]);

const url = `http://127.0.0.1:${port}/`;
const win = new BrowserWindow({
	title: "booth",
	url,
	frame: { width: 1280, height: 820 },
	// Booth draws its own title bar, which carries the update callout.
	titleBarStyle: "hiddenInset",
});

// Booth opens Discogs and YouTube links in a new tab; send those to the
// person's own browser rather than a bare Chromium window with no chrome.
// (The event fires at runtime but is missing from Electrobun's typed names.)
win.webview.on("new-window-open" as "dom-ready", (event) => {
	const detail = (event as { data?: { detail?: string | { url?: string } } }).data?.detail;
	const target = typeof detail === "string" ? detail : detail?.url;
	if (target && /^https?:\/\//.test(target)) Utils.openExternal(target);
});

ApplicationMenu.on("application-menu-clicked", (event) => {
	const action = (event as { data?: { action?: string } }).data?.action;
	if (action === "reload") win.webview.loadURL(url);
	if (action === "open-settings") Bun.spawn(["open", "-e", settingsPath]);
	if (action === "check-updates") void checkForUpdate(true);
});

// --- Updates ----------------------------------------------------------------
// Each release publishes update archives next to the installers. A newer one
// downloads in the background, then the page's title bar offers "Restart to
// Update"; nothing interrupts. Unapplied, it's offered again next launch.

let checking = false;

async function checkForUpdate(fromMenu = false): Promise<void> {
	if (checking) return;
	checking = true;
	try {
		const local = await Updater.getLocalInfo();
		if (local.channel === "dev") {
			if (fromMenu) await message("Updates are off in development builds.");
			return;
		}
		if (!pendingUpdate) {
			const check = await Updater.checkForUpdate();
			if (check.error) throw new Error(check.error);
			if (!check.updateAvailable) {
				if (fromMenu) await message(`booth ${local.version} is the latest version.`);
				return;
			}
			await Updater.downloadUpdate();
			const info = Updater.updateInfo();
			if (!info.updateReady) throw new Error(info.error || "the download didn't finish");
			pendingUpdate = { version: info.version };
		}
		if (fromMenu) {
			await message(`booth ${pendingUpdate.version} has downloaded. Use Restart to Update at the top of the window.`);
		}
	} catch (error) {
		console.error("[update]", error);
		if (fromMenu) await message(`Couldn't check for updates: ${(error as Error).message}`);
	} finally {
		checking = false;
	}
}

function message(text: string) {
	return Utils.showMessageBox({ type: "info", title: "booth", message: text, buttons: ["OK"] });
}

setTimeout(() => void checkForUpdate(), 10_000);
setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000);
