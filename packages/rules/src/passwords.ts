/** Management passwords (brief section 9: secure authentication). */
export const MIN_PASSWORD_LENGTH = 12;

/** Why a new password is not acceptable, or null if it is. Length matters more than symbols. */
export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short sentence is easy to remember.`;
  if (new Set(password.toLowerCase()).size < 5) return 'Use more different characters.';
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && password.toLowerCase().includes(local)) return 'Do not use your email address in your password.';
  if (/^(password|onpar|security|welcome|qwerty|123456)/i.test(password)) return 'That password is too easy to guess.';
  return null;
}
