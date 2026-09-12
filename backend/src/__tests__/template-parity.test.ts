import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The backend has TWO deployment templates for the same application:
 *
 *   template.yaml                          — SAM CLI builds the code (CodeUri: dist/)
 *   console-deployment/template-console.yaml — reads a prebuilt zip from S3
 *
 * They differ only in how the Lambda code is sourced. Everything else is meant
 * to be identical, and a security control present in one but not the other is
 * worse than one missing from both: the finding gets closed against the
 * template a reviewer happens to open, while stacks deployed the other way
 * silently run without it.
 *
 * That is not hypothetical. The console template was added as a copy of
 * template.yaml and immediately lacked the API Gateway access logging and stage
 * throttling that had just been added to the original, so a console-deployed
 * backend issued temporary IAM credentials with no access log at all.
 *
 * These are substring checks rather than a YAML deep-diff on purpose. A deep
 * diff would have to encode every legitimate difference (CodeUri, the Metadata
 * build block, the two extra parameters) and would fail on cosmetic edits,
 * which is how a guard ends up disabled. Asserting that each named control
 * appears in both files is coarse but hard to argue with, and the failure
 * message points straight at what is missing.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${here}`), 'utf8');

const SAM_TEMPLATE = read('../../template.yaml');
const CONSOLE_TEMPLATE = read('../../console-deployment/template-console.yaml');

/**
 * Controls that MUST exist in both templates. Add to this list in the same
 * commit that adds the control — that is the whole point of the guard.
 */
const REQUIRED_IN_BOTH: { control: string; needles: string[] }[] = [
  {
    control: 'API Gateway access logging on the credential-returning SsoApi (Talos d4fd28a6)',
    needles: ['AccessLogSettings', 'SsoApiAccessLogGroup', '$context.identity.sourceIp'],
  },
  {
    control: 'Global stage throttling — the only deployment-wide request ceiling (Talos ecb2bc44)',
    needles: ['DefaultRouteSettings', 'ThrottlingBurstLimit', 'ThrottlingRateLimit'],
  },
  {
    control: 'CORS origin allowlist with wildcards rejected by the parameter pattern',
    needles: ['AllowedOrigins', 'AllowedPattern', 'X-Requested-By'],
  },
  {
    control: 'Lambda log group with an explicit retention period',
    needles: ['SsoFunctionLogGroup', 'RetentionInDays'],
  },
];

describe('template.yaml and template-console.yaml stay in step', () => {
  it.each(REQUIRED_IN_BOTH)('$control', ({ needles }) => {
    for (const needle of needles) {
      expect(SAM_TEMPLATE, `template.yaml is missing ${needle}`).toContain(needle);
      expect(
        CONSOLE_TEMPLATE,
        `console-deployment/template-console.yaml is missing ${needle} — a console-deployed stack would run without this control`,
      ).toContain(needle);
    }
  });

  it('keeps the console template on the S3 code source and the SAM one on a local build', () => {
    // Guards the one difference that is supposed to exist, so a careless
    // copy-paste in either direction is caught too.
    expect(SAM_TEMPLATE).toContain('CodeUri: dist/');
    expect(CONSOLE_TEMPLATE).toContain('Bucket: !Ref ArtifactBucket');
    expect(CONSOLE_TEMPLATE).not.toContain('CodeUri: dist/');
  });
});
