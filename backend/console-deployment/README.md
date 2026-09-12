# Console Deployment — Resilience Agent SSO Backend (no SAM CLI)

This folder lets you deploy the SSO backend through the **AWS CloudFormation console**, for customers who cannot install the AWS SAM CLI.

The model is **build-it-yourself**: you run a script that builds the Lambda artifact (`lambda.zip`) locally from source, then you upload that zip to S3 and deploy the CloudFormation template from the console. The only thing skipped versus the official SAM flow (see the repo's main README, Section 5) is the SAM CLI itself.

## Files in this folder

| File | Description |
|------|-------------|
| `build-lambda-zip.mjs` | Builds `lambda.zip` locally. Pure Node.js — runs on **Windows, macOS, and Linux** with no `bash` and no `zip` binary. Runs `npm ci` → `npm audit` (**security gate**) → `npm run build` → zip. Requires only Node ≥ 22 + npm (already project prerequisites). Zero external dependencies. No SAM CLI. |
| `template-console.yaml` | CloudFormation template that reads the Lambda code from **your** S3 bucket. Parameters: `ArtifactBucket`, `ArtifactKey`, `AllowedOrigins`. |
| `README.md` | This file. |
| `lambda.zip` | **NOT shipped — you generate it.** Produced by the build script. Intentionally **not** committed to the repo (see below). |

### Why `lambda.zip` is not committed

Committing a prebuilt bundle would (a) put a binary in git and (b) hide its bundled dependencies from CVE scanners — `npm audit`, Dependabot, and CI all read `package-lock.json`, **not** the bundle. Building it locally from the current lockfile keeps the deployed code scannable and in sync.

## Why build locally instead of shipping a prebuilt zip

esbuild inlines every dependency into a single `lambda.js`. If that bundle were committed, a vulnerable transitive dependency baked inside it would be invisible to every scanner you have, and it would drift from `package-lock.json` over time.

Building at deploy time from `package-lock.json` means:

- the artifact always matches the dependency tree scanners actually check, and
- the build script's audit step refuses to produce a zip if a vulnerability at/above the threshold is present.

---

## Step 1 — Build `lambda.zip`

From the `backend/` directory:

```bash
node console-deployment/build-lambda-zip.mjs
```

Pure Node.js — no `bash`, no `zip` binary, no extra dependencies. Works on
**Windows** (CMD, PowerShell, Git Bash, or WSL), **macOS**, and **Linux**. The
only prerequisites are Node ≥ 22 + npm, which the project already requires.

It does four steps, in order:

| Step | Command | Purpose |
|------|---------|---------|
| 1/4 | `npm ci` | reproducible install from `package-lock.json` |
| 2/4 | `npm audit` | **security gate** (default threshold: `moderate`) |
| 3/4 | `npm run build` | esbuild bundles `src/lambda.ts` → `dist/lambda.js` |
| 4/4 | zip | `dist/lambda.js` + `package.json {"type":"module"}` → `lambda.zip` |

Everything is also written to a timestamped log: `console-deployment/build-<TS>.log`

**Audit threshold (optional):** set `AUDIT_LEVEL` to `low` | `moderate` | `high` | `critical`.

```bash
AUDIT_LEVEL=high node console-deployment/build-lambda-zip.mjs
```

### If the audit gate blocks the build

The script stops, prints the advisory (package, severity, GHSA links), and produces **no** zip. It then tells you exactly how to fix it. Two cases:

**a) Safe fix available (most common):**

```bash
cd backend
npm audit fix          # updates package-lock.json locally
node console-deployment/build-lambda-zip.mjs   # re-run
```

This applies the fix on **this machine**, which is all that's needed to build a clean `lambda.zip` here.

**b) Fix needs `--force` (may upgrade major versions / break the app):**

The script will **not** tell you to blindly `--force`. Review manually:

```bash
npm audit
npm audit fix --dry-run   # preview what --force would change
```

Decide per-package, test the app, then re-run the build script.

> The script only **verifies**; it never modifies your lockfile. That is deliberate: a build-time auto-fix would patch only your local copy and mask the fact that the dependency tree is still vulnerable.

---

## Step 2 — Upload `lambda.zip` to S3 (same region as the stack)

**Console:** S3 → Create bucket (or reuse one) in your target region → open it → Upload → add `console-deployment/lambda.zip` → Upload.

Note the **bucket name** and the **object key** (`lambda.zip` unless you renamed it). The bucket **must** be in the same region you deploy the stack into.

**CLI equivalent** (us-east-1 shown):

```bash
aws s3api create-bucket --bucket YOUR-BUCKET --region us-east-1
aws s3 cp console-deployment/lambda.zip s3://YOUR-BUCKET/lambda.zip --region us-east-1
```

---

## Step 3 — Deploy `template-console.yaml` via the console

1. CloudFormation → **Create stack** → With new resources (standard)
2. Prepare template → Choose an existing template → **Upload a template file** → select `console-deployment/template-console.yaml` → Next
3. **Stack name:** `resilience-agent-sso` (or any unused name)
4. **Parameters:**
   - `ArtifactBucket` = the bucket from Step 2
   - `ArtifactKey` = `lambda.zip` (or your key if renamed)
   - `AllowedOrigins` = your SPA origin, e.g. `http://localhost:4173`

> ⚠️ **NO TRAILING SLASH.** The backend matches the browser `Origin` header **exactly**. Browsers send `http://localhost:4173` (no slash), so `http://localhost:4173/` silently breaks CORS. For a hosted SPA use its exact origin; comma-separate multiple. Wildcards are rejected.
>
> ⚠️ The origin must match where the SPA is actually served. `npm run preview` uses port **4173**; `npm run dev` uses **5173**.

5. Next → (stack options: defaults fine) → Next
6. **Review page:** tick **"I acknowledge that AWS CloudFormation might create IAM resources."** (The stack creates the Lambda execution role. The console also applies `CAPABILITY_AUTO_EXPAND` automatically for the SAM transform.)
7. **Create stack.**

**CLI equivalent:**

```bash
aws cloudformation create-stack \
  --stack-name resilience-agent-sso \
  --template-body file://console-deployment/template-console.yaml \
  --parameters \
      ParameterKey=ArtifactBucket,ParameterValue=YOUR-BUCKET \
      ParameterKey=ArtifactKey,ParameterValue=lambda.zip \
      ParameterKey=AllowedOrigins,ParameterValue=http://localhost:4173 \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --region us-east-1
```

---

## Step 4 — Get the API URL and wire it into the SPA

When the stack reaches `CREATE_COMPLETE`, open the **Outputs** tab and copy the `ApiUrl` value:

```
https://<api-id>.execute-api.<region>.amazonaws.com
```

Give it to the SPA one of two ways:

- **Build-time:** set `VITE_SSO_BACKEND_URL` in `dx-visualizer/.env` before `npm run build` / `npm run dev` (baked into the bundle).
- **Runtime:** leave `.env` empty; paste the URL into the app's **Settings → SSO Backend URL** on first sign-in (stored in browser `localStorage`).

---

## Step 5 — Smoke test

```bash
curl https://<api-id>.execute-api.<region>.amazonaws.com/health
# expected: {"status":"ok"}
```

> **Note:** `GET /` and unknown paths return HTTP 500 — **expected**. The app only defines `/health` and `/auth/sso/*`; there is no root route or 404 handler, so `serverless-express` returns 500 for unmatched paths. A `200` on `/health` confirms the deployment is healthy.

Verify CORS matches your SPA origin (should echo your origin, no slash):

```bash
curl -s -i -X OPTIONS https://<api-id>.execute-api.<region>.amazonaws.com/auth/sso/start \
  -H "Origin: http://localhost:4173" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,x-requested-by" \
  | grep -i access-control-allow-origin
```

---

## Teardown

```bash
aws cloudformation delete-stack --stack-name resilience-agent-sso --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name resilience-agent-sso --region us-east-1
aws s3 rm s3://YOUR-BUCKET/lambda.zip --region us-east-1
aws s3api delete-bucket --bucket YOUR-BUCKET --region us-east-1
```

Or via the console: CloudFormation → select the stack → **Delete**; then S3 → empty and delete the bucket.

---

## Notes

- **No AWS access keys are needed at runtime.** The backend authorizes via the end user's browser SSO login (device authorization flow) and creates its SSO clients with empty credentials. Credentials are only needed by whoever **deploys** the stack (and uploads the zip).
- The Lambda runs on `nodejs22.x` / `arm64`, 30s timeout, 128 MB, 7-day logs.
- `lambda.zip` and `build-*.log` are local build outputs; do not commit them.
