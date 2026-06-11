import { env } from '$env/dynamic/private';
import { defaultRecordingsRoot } from './paths';

/** The only recording module allowed to import $env — routes call this and
 * pass the resolved root into the pure modules. */
export function resolvedRecordingsRoot(): string {
  return env.BOOTH_RECORDINGS_PATH || defaultRecordingsRoot();
}
