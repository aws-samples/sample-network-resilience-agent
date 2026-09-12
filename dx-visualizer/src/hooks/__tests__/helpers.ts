/**
 * Strip HTML tags from a fragment of the generated report, leaving its text.
 *
 * Repeats the replacement until the string stops changing, which is CodeQL's
 * prescribed remediation for `js/incomplete-multi-character-sanitization` — the
 * rule that flagged the single-pass form these test files used.
 *
 * Be clear about what this did and did not fix. The rule's general concern is
 * real: a one-pass replace can leave text that reassembles into the very thing
 * it removed. But for THIS pattern it cannot. `<[^>]+>` always matches from a
 * `<` to the first following `>`, so every match consumes its own opening
 * bracket and no residue is left in a position to form a new tag. A brute-force
 * search over 488,280 strings (alphabet `< > a s /`, lengths 1-8, both
 * replacements) found zero inputs where one pass and this loop disagree.
 *
 * So this is a true positive in shape and a false positive in effect, kept
 * because the loop costs nothing, makes the idempotence explicit instead of
 * relying on a non-obvious property of the regex, and stops the alert recurring
 * on every promotion to the public mirror — where the scan is configured in repo
 * settings and cannot be tuned from this repo.
 *
 * These helpers are assertion plumbing, not a security boundary: the input is
 * the report this repo just generated, never attacker input. The reason to share
 * one helper rather than fix each call site is drift — the single-pass idiom was
 * duplicated across two test files, so a fix applied to one would have missed
 * the other.
 *
 * `replacement` defaults to `''`. Pass `' '` when the caller goes on to collapse
 * whitespace and needs adjacent elements to stay word-separated, rather than
 * having their text run together.
 */
export function stripTags(html: string, replacement = ''): string {
  let out = html;
  for (;;) {
    const next = out.replace(/<[^>]+>/g, replacement);
    if (next === out) return out;
    out = next;
  }
}
