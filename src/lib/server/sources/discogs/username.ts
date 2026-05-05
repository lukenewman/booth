import { discogsFetch } from './api';

let cached: string | null = null;

interface IdentityResponse {
  username: string;
}

export async function getUsername(): Promise<string> {
  if (cached) return cached;
  const data = (await discogsFetch('/oauth/identity')) as IdentityResponse;
  cached = data.username;
  return cached;
}
