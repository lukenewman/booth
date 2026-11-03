/** Ask the server to open the Mac's folder chooser. `{ path: null }` when cancelled. */
export async function chooseFolder(prompt: string, startIn?: string): Promise<{ path: string | null; error?: string }> {
  try {
    const res = await fetch('/api/pick-folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, startIn }) });
    const body = await res.json();
    return res.ok ? { path: body.path } : { path: null, error: body.error ?? 'Couldn’t open the folder chooser.' };
  } catch {
    return { path: null, error: 'Couldn’t reach Booth.' };
  }
}
