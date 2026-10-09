// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/**
	 * Set by the desktop app's main process, which runs this server in-process
	 * (desktop/src/main.ts). Absent under `bun dev` and the plain server.
	 */
	var __boothDesktop:
		| {
				/** A downloaded update waiting for a restart, or null. */
				pendingUpdate(): { version: string } | null;
				/** Install it and relaunch. */
				restartToUpdate(): void;
				/** Do what a native title bar does on double-click (System Settings decides). */
				titlebarDoubleClick(): void;
		  }
		| undefined;
}

export {};
