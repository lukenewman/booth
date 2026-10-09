import type { ElectrobunConfig } from "electrobun";

// BOOTH_VERSION comes from the release tag (v0.1.0 → 0.1.0); local builds are 0.0.0.
const version = (process.env.BOOTH_VERSION ?? "0.0.0").replace(/^v/, "");

export default {
	app: {
		name: "booth",
		identifier: "com.lukenewman.booth",
		version,
	},
	build: {
		// Bun, not Electrobun's default runtime: Booth's server needs bun:sqlite
		// and runs inside this process.
		mainProcess: "bun",
		bun: { entrypoint: "src/main.ts" },
		copy: { booth: "booth" },
		mac: {
			// Chromium, not the system WebView: WKWebView never resolves
			// getUserMedia here, which kills recording and the barcode scanner.
			bundleCEF: true,
			defaultRenderer: "cef",
			codesign: false,
			icons: "icon.iconset",
			entitlements: {
				"com.apple.security.device.camera": "booth uses the camera to scan record barcodes.",
				"com.apple.security.device.audio-input": "booth records vinyl from your audio interface.",
			},
		},
	},
	scripts: {
		postBuild: "scripts/sign.ts",
		postWrap: "scripts/sign.ts",
	},
	runtime: {
		exitOnLastWindowClosed: true,
		// Test builds only: pins all of Booth's data to this folder. It has to be
		// baked in, because the relaunch after a self-update drops the environment.
		...(process.env.BOOTH_TEST_DATA_DIR ? { testDataDir: process.env.BOOTH_TEST_DATA_DIR } : {}),
	},
	release: {
		// The updater fetches <baseUrl>/<flat artifact name>, which is exactly
		// how GitHub serves the newest release's assets.
		baseUrl: process.env.BOOTH_RELEASE_BASE_URL ?? "https://github.com/lukenewman/booth/releases/latest/download",
		generatePatch: false,
	},
} satisfies ElectrobunConfig;
