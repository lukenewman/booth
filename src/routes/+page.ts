// Shell choice depends on viewport, which the server cannot know — with SSR on
// the server renders one shell and the client hydrates into the other.
//
// Verified 2026-08-18: src/routes/ holds only +layout.svelte and +page.svelte,
// with no load functions anywhere and all data arriving via client-side /api
// fetches. SSR was already rendering data-less markup, so turning it off costs
// one blank frame on cold load and nothing else. It does not affect the boot
// sync hook, which fires on API requests too. Reversible.
export const ssr = false;
