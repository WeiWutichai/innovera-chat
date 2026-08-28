/** Minimal stand-ins for Next server APIs that require a request context. */

export function revalidatePath() {
  /* no-op outside a Next request scope */
}

export function redirect(to: string): never {
  const error = new Error(`NEXT_REDIRECT:${to}`) as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;${to}`;
  throw error;
}
