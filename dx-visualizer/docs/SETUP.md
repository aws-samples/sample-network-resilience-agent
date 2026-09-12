# Network Resilience Agent - Setup Guide

---

## 1. Prerequisites

- **Node.js** v20.19+ or v22.12+ (required by Vite 8) — [Download](https://nodejs.org/)
- **npm** (comes bundled with Node.js)
- **AWS SAM CLI** (required for the recommended SSO backend — see [Section 5](#5-deploy-the-sso-backend-optional)) — [Install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

Verify your installation:

```bash
node -v   # should print v20.19+ or v22.12+
npm -v    # should print 10.x or higher
```

---

## 2. Getting Started

> **Deployment scope of this guide**: These instructions set the app up to run **locally on `localhost`** (the Vite dev server on `:5173`, or a local `npm run preview`). That's the fastest way to evaluate it, and everything works from a laptop because the SPA calls AWS APIs directly from the browser — there is no application server to host.
>
> The frontend is a **static bundle** (`npm run build` → `dist/`), so you are free to host it however you like — an S3 + CloudFront distribution, an nginx container on EKS/ECS, GitHub Pages, or any static web server. Hosting it elsewhere only changes *where the files are served from*; the credential model, IAM policy, and AWS API calls are identical. A hosted origin needs three things: serve over HTTPS, set your production URL as `AllowedOrigins` when deploying the optional SSO backend (see [Section 5](#5-deploy-the-sso-backend-optional)), and emit security response headers from the static host (`frame-ancestors` cannot come from the SPA itself). See [Section 7](#7-building-for-production) for the production build and the header details.

### 2.1 Extract the zip

```bash
unzip dx-visualizer.zip
cd dx-visualizer
```

### 2.2 Install dependencies

```bash
npm install
```

This will download all required packages (~200 MB). Takes 1-2 minutes depending on your network.

### 2.3 Start the development server

```bash
npm run dev
```

You should see output like:

```
VITE v8.x.x  ready in xxx ms

➜  Local:   http://localhost:5173/
```

### 2.4 Open in browser

Navigate to **http://localhost:5173/** in your browser.

On first load the canvas is empty behind a welcome card. Click **Use demo data** to load a mock scenario (no AWS credentials required) or **Connect AWS** to enter credentials and discover live topology. Once a topology is loaded the welcome card can be dismissed and the **Scenario** picker in the top bar appears for switching between the bundled mock scenarios.

---

## 3. Using Live AWS Data

To visualize your actual AWS Direct Connect topology, you need valid AWS credentials.

### 3.1 Recommended: IAM Identity Center SSO (per-user, short-lived)

The recommended authentication method is **AWS IAM Identity Center (SSO)**. This provides:

- Per-user CloudTrail attribution
- Short-lived credentials (1 hour) that auto-expire
- Independent rotation and revocation per user
- No long-lived secrets to manage or share

Click **Connect AWS → SSO** in the app and complete the OIDC device authorization flow. This requires the SSO backend — see [Section 5](#5-deploy-the-sso-backend-optional) for deployment instructions.

### 3.2 Alternative: Temporary Credentials

If the SSO backend is not yet deployed, you can paste **temporary credentials** into the app. The app prompts for:

- **Access Key ID**
- **Secret Access Key**
- **Session Token**
- **Region** (e.g. `ap-southeast-1`)

These must be short-lived temporary credentials obtained via one of:

- **SSO CLI** (one-time setup then repeat login):
  ```bash
  # One-time: configure an SSO profile
  aws configure sso --profile dx-viz
  # Each session: login and export credentials
  aws sso login --profile dx-viz
  aws configure export-credentials --profile dx-viz
  ```
- **AssumeRole**: Use `aws sts assume-role` and copy the returned credentials
- **GetSessionToken**: Use `aws sts get-session-token` for MFA-protected sessions

All credentials stay in your browser and are never sent to any external server. The AWS SDK calls are made directly from your browser to the AWS APIs.

### 3.3 Connect to AWS

In the app, click **Connect AWS** in the top bar. Choose **SSO** for the recommended flow or **Temporary Credentials** to paste short-lived credentials. The connected badge replaces the button on success. To return to mock mode, click the connected badge → **Sign Out** — the app reverts to whichever mock scenario was last loaded.

> **Partner-hosted VIF accounts**: If your account uses hosted virtual interfaces from an AWS Direct Connect partner, the underlying physical connection is owned by the partner and is not returned by `DescribeConnections` in your account. The app detects this and infers a connection object from the VIF data so the Partner / AWS-device path still renders. Inferred connections are labeled *"hosted VIF on external cable"* on the canvas.

---

## 4. IAM Setup (Networking Account)

Grant the networking team read-only access using **IAM Identity Center permission sets** (recommended) or temporary credentials via AssumeRole. All API calls are read-only — no resources are created, modified, or deleted.

### 4.1 IAM policy overview

A ready-to-use IAM policy is provided at [`docs/iam-policy.json`](./iam-policy.json). It contains seven statements:

| Statement | Purpose | Required? |
|-----------|---------|-----------|
| `DxVisualizerCore` | DX, EC2 networking, Cloud WAN topology discovery, CloudWatch metrics, caller identity | Yes |
| `DxVisualizerMaintenanceEvents` | Upcoming Direct Connect maintenance calendar (AWS Health) — requires Business/Enterprise support plan | Optional |
| `DxVisualizerCostAndPricing` | Cost analysis and pricing estimates in chat | Optional |
| `DxVisualizerAIChat` | AI chat via Amazon Bedrock | Optional |
| `DxVisualizerAccountName` | Resolve a friendly name for the caller's account (Organizations → IAM alias fallback) | Optional |
| `DxVisualizerCrossAccount` | Assume role into spoke accounts for VPC enrichment | Optional |
| `DxVisualizerRegionNames` | Resolve friendly names for region panels via SSM public parameters (e.g. `ap-northeast-3` → "Osaka") | Optional |

Remove any optional statements you don't need before creating the policy.

> **The shipped policy contains placeholders and will not work until you edit them.** The `DxVisualizerCrossAccount` statement lists `arn:aws:iam::REPLACE_WITH_SPOKE_ACCOUNT_ID_1:role/NetworkReadOnlyRole` and `…_2`. Either:
>
> - replace each `REPLACE_WITH_SPOKE_ACCOUNT_ID_N` with a real 12-digit spoke account ID, adding or removing `Resource` entries so the list names exactly the spoke accounts you want to enrich; **or**
> - delete the whole `DxVisualizerCrossAccount` statement if you are not using cross-account VPC enrichment ([Section 6](#6-cross-account-vpc-enrichment-optional)).
>
> Do **not** substitute an account wildcard (`arn:aws:iam::*:role/NetworkReadOnlyRole`) — see [Section 6, Step 3](#step-3-grant-the-networking-account-assumerole-permission) for why. The placeholders are not valid account IDs, so IAM rejects the policy until you edit it. That is deliberate: the example fails closed rather than shipping an over-broad grant.

### 4.2 Required IAM permissions

The full list of required permissions is defined in [`docs/iam-policy.json`](./iam-policy.json). In summary, the app needs read-only access to:

- **Direct Connect** — connections, VIFs, DX gateways, associations, association proposals, gateway attachments, locations, LAGs, plus two `List*` actions that the `Describe*` wildcard does **not** cover: `ListVirtualInterfaceRoutes` (BGP route panels and the route-diff / prefix-consistency findings) and `ListVirtualInterfaceTestHistory` (failover-test evidence)
- **EC2** — `DescribeRegions` (drives automatic region discovery — without it the sweep silently falls back to only the regions named on DX gateway and Cloud WAN attachments), VPCs, VPN gateways, VPN connections, customer gateways, Transit Gateways, TGW attachments, TGW peering attachments, TGW route tables and routes, TGW route table propagations (`GetTransitGatewayRouteTablePropagations` — a `Get*` action, also not covered by `ec2:Describe*`), VPC route tables
- **Network Manager** — core networks, attachments, peerings, segment routes (Cloud WAN)
- **CloudWatch** — `GetMetricData` and `ListMetrics` for live BGP prefix counters (fetched with the topology) and on-demand VIF/connection utilization (fetched only when the user toggles **Show utilization** in the Live overlay)
- **STS** — `GetCallerIdentity` to stamp cost-explorer responses with the account ID
- **Health** (optional) — `DescribeEvents`, `DescribeEventDetails`, `DescribeAffectedEntities` for the upcoming maintenance calendar. The Health API requires a Business, Enterprise On-Ramp, or Enterprise Support plan; without it the calendar simply stays hidden
- **Cost Explorer** (optional) — cost queries are made against `us-east-1` regardless of your selected region
- **Pricing** (optional) — DX, TGW, VPN pricing estimates
- **Bedrock** (optional) — model access for AI chat in your region
- **Organizations / IAM** (optional) — `organizations:DescribeAccount` and `iam:ListAccountAliases` to show a friendly account name in the header; both are wrapped in try/catch and fall through silently if denied
- **STS AssumeRole** (optional) — for cross-account VPC enrichment, scoped to the specific spoke-account role ARNs you enumerate (see [Section 6, Step 3](#step-3-grant-the-networking-account-assumerole-permission))
- **SSM** (optional) — `ssm:GetParameters` scoped to `arn:aws:ssm:*::parameter/aws/service/global-infrastructure/*` to resolve region codes (e.g. `ap-northeast-3`) to friendly names (e.g. "Osaka") for region panel labels. This path is AWS's world-readable public-parameter namespace, not customer data. Without this permission the call is caught silently and region panels fall back to a built-in map

> ### ⚠️ `ReadOnlyAccess` is not enough for the BGP route features
>
> Three actions the app uses are **`List*` / `Get*`, not `Describe*`**, so a policy built around `directconnect:Describe*` silently omits them:
>
> | Action | Powers | In AWS managed `ReadOnlyAccess`? |
> |---|---|---|
> | `directconnect:ListVirtualInterfaceRoutes` | **VIF Routes** panel, **DXGW Route diff** panel, and the `⚠ N` failover-gap count on DX Gateway nodes | ❌ No — `ReadOnlyAccess` grants only `directconnect:Describe*` |
> | `directconnect:ListVirtualInterfaceTestHistory` | **History** button on a VIF edge label (past failover tests) | ❌ No |
> | `ec2:GetTransitGatewayRouteTablePropagations` | TGW propagation check behind the DXGW propagation rule | ✅ Yes — via `ec2:Get*` |
>
> Verified against `arn:aws:iam::aws:policy/ReadOnlyAccess` (v188) with `iam:simulate-principal-policy`. If you attach `ReadOnlyAccess` instead of [`docs/iam-policy.json`](./iam-policy.json), add the two Direct Connect actions in an inline policy, or the route panels stay empty and the gap count never appears:
>
> ```json
> {
>   "Version": "2012-10-17",
>   "Statement": [{
>     "Effect": "Allow",
>     "Action": [
>       "directconnect:ListVirtualInterfaceRoutes",
>       "directconnect:ListVirtualInterfaceTestHistory"
>     ],
>     "Resource": "*"
>   }]
> }
> ```
>
> Both are read-only. Their mutating siblings `StartBgpFailoverTest` / `StopBgpFailoverTest` force a production BGP peer down and are deliberately **not** used by this app — do not grant them.
>
> When `ListVirtualInterfaceRoutes` is denied, the **Routes** and **Route diff** buttons turn red/amber and their tooltip carries the reason rather than opening an empty panel; the failure costs one burst of `AccessDenied` per topology, not one per Live toggle.

### 4.3 Option A: IAM Identity Center (Recommended)

Create a **permission set** in IAM Identity Center that grants the policy to team members:

1. Sign in to the **management account** or the **delegated admin** for IAM Identity Center
2. Go to **IAM Identity Center > Permission sets > Create permission set**
3. Choose **Custom permission set**
4. Under **Inline policy**, paste the contents of [`docs/iam-policy.json`](./iam-policy.json)
5. Remove any optional statements you don't need (cost, chat, cross-account)
6. If you kept `DxVisualizerCrossAccount`, replace every `REPLACE_WITH_SPOKE_ACCOUNT_ID_N` placeholder in its `Resource` list with a real 12-digit spoke account ID — one entry per spoke account, adding or removing entries as needed. IAM rejects the placeholders as malformed ARNs, so the permission set cannot be created until you do. If you are not using cross-account VPC enrichment, delete that statement instead
7. Name it `DxVisualizerReadOnly`, then **Create**
8. Go to **AWS accounts**, select the **networking account**
9. Click **Assign users or groups**, select the networking team group, and assign the `DxVisualizerReadOnly` permission set

Each team member authenticates individually via SSO — short-lived credentials, full CloudTrail attribution per user, and independent revocation when someone leaves.

### 4.4 Option B: IAM Policy via Console or CLI

If IAM Identity Center is not available, create the IAM policy directly in the networking account:

**Console:**
1. Sign in to the **networking account**
2. Go to **IAM > Policies > Create policy**
3. Click the **JSON** tab
4. Paste the contents of [`docs/iam-policy.json`](./iam-policy.json)
5. Remove any optional statements you don't need (cost, chat, cross-account)
6. If you kept `DxVisualizerCrossAccount`, replace every `REPLACE_WITH_SPOKE_ACCOUNT_ID_N` placeholder in its `Resource` list with a real 12-digit spoke account ID — one entry per spoke account, adding or removing entries as needed. IAM rejects the placeholders as malformed ARNs, so the policy cannot be created until you do. If you are not using cross-account VPC enrichment, delete that statement instead
7. Click **Next**, name the policy `DxVisualizerReadOnly`, then **Create policy**
8. Attach this policy to the IAM role that team members assume via `aws sts assume-role`

**CLI:**

**Edit `docs/iam-policy.json` before running the commands below.** As shipped, its `DxVisualizerCrossAccount` statement holds `REPLACE_WITH_SPOKE_ACCOUNT_ID_1` / `_2` placeholders, and `aws iam create-policy` will fail with `MalformedPolicyDocument` on them. That is intended, not a broken quickstart — the alternative would be shipping an account wildcard that lets this principal assume `NetworkReadOnlyRole` in *any* account that trusts it back, so the example fails closed and forces the edit.

```bash
# 0. Edit docs/iam-policy.json first — pick one:
#      * replace each REPLACE_WITH_SPOKE_ACCOUNT_ID_N with a real 12-digit spoke
#        account ID (one "Resource" entry per spoke account), or
#      * delete the DxVisualizerCrossAccount statement if you are not using
#        cross-account VPC enrichment
#    Then run:

# 1. Create the IAM policy
aws iam create-policy \
  --policy-name DxVisualizerReadOnly \
  --policy-document file://docs/iam-policy.json

# 2. Attach to an existing role (replace with your role name and account ID)
aws iam attach-role-policy \
  --role-name NetworkingTeamRole \
  --policy-arn arn:aws:iam::123456789012:policy/DxVisualizerReadOnly
```

Team members obtain temporary credentials via `aws sts assume-role` and paste them into the app's **Temporary Credentials** modal.

### 4.5 Static IAM access keys (demo / lab use only)

> **DEMO / LAB USE ONLY**
>
> The static-key approach below is provided for quick local evaluation. It is **not**
> appropriate for production:
> - Shared keys destroy per-user audit trail in CloudTrail
> - Long-lived credentials cannot be independently rotated or revoked per user
> - When a team member leaves, you must rotate the key for everyone
>
> For any production deployment, use IAM Identity Center SSO (§4.3) or AssumeRole (§4.4) instead.

```bash
aws iam create-user --user-name dx-visualizer-demo
aws iam attach-user-policy \
  --user-name dx-visualizer-demo \
  --policy-arn arn:aws:iam::123456789012:policy/DxVisualizerReadOnly
aws iam create-access-key --user-name dx-visualizer-demo
```

### 4.6 Enable Bedrock model access (required for AI chat)

The `DxVisualizerAIChat` IAM statement only grants the *permission* to invoke Bedrock — it does not enable the underlying model in your account. Bedrock requires a separate per-account model-access enrollment.

1. Sign in to the AWS Console **in the region you plan to use** for the visualizer
2. Open the **Amazon Bedrock** service
3. In the left nav, choose **Model access**
4. Click **Enable specific models** (or **Modify model access**)
5. Tick the model family (the visualizer defaults to Claude Opus 5 — see `VITE_BEDROCK_MODEL_ID` in `.env`)
6. Submit the request

**Cross-region inference profiles**: if the model ID already carries a `global.`, `us.`, `eu.`, or `apac.` prefix, the app uses it verbatim; otherwise it auto-prepends a regional prefix (`us.`, `eu.`, `apac.`) based on your selected region. Either way, calls route through a Bedrock cross-region inference profile, which spreads load across the regions in the profile's geo. The shipped default (`global.anthropic.claude-opus-5`) uses the **global** inference profile. Model access only needs to be enabled in your home region; the inference profile handles the rest.

If chat returns "model access denied" or simply errors silently, this step is the most common cause.

---

## 5. Deploy the SSO Backend (Optional)

This section is required for the recommended **IAM Identity Center (SSO)** authentication flow. Skip only if your users will exclusively paste temporary credentials from the CLI into the app.

The SSO backend is a small Lambda + HTTP API that handles the OIDC device-authorization flow on the SPA's behalf. The source lives in [`backend/`](../../backend/) and ships as an AWS SAM template.

> Can't install the AWS SAM CLI? You can deploy through the AWS CloudFormation console instead (you still build the Lambda artifact locally with npm). Jump to [Section 5.5](#55-alternative-deploy-via-the-aws-console-no-sam-cli).

### 5.1 Prerequisites

- AWS SAM CLI installed (see [Section 1](#1-prerequisites))
- Admin (or equivalent CloudFormation/Lambda/API Gateway) credentials for the AWS account you want to deploy into. This can be the networking account or any account you control — the backend does not need to live in the networking account.
- The exact origin where you will host the SPA, e.g. `http://localhost:5173` for local dev or `https://app.example.com` for a hosted build. The backend rejects wildcard CORS origins by design.

### 5.2 Build and deploy

From the repo root:

```bash
cd backend
npm install
npm run build                    # esbuild bundles src/lambda.ts → dist/
sam deploy --guided \
  --stack-name resilience-agent-sso \
  --parameter-overrides AllowedOrigins=https://your-spa-origin.example.com
```

`sam deploy --guided` will prompt for region, confirmation of IAM resource creation, and save your choices to `samconfig.toml`. Subsequent deploys can use plain `sam deploy`.

For multiple SPA origins (e.g. a local dev build *and* a hosted build), pass a comma-separated list:

```bash
--parameter-overrides AllowedOrigins=http://localhost:5173,https://app.example.com
```

### 5.3 Wire the API URL into the SPA

When the deploy completes, the stack outputs an `ApiUrl` of the form `https://<api-id>.execute-api.<region>.amazonaws.com`.

There are two ways to give this URL to the SPA:

- **Build-time**: set `VITE_SSO_BACKEND_URL` in `dx-visualizer/.env` before running `npm run build` or `npm run dev`. This bakes the URL into the bundle.
- **Runtime**: leave `.env` empty and have each user paste the URL into **Settings → SSO Backend URL** the first time they sign in. The value is stored in browser localStorage.

Build-time is more convenient for a single hosted SPA; runtime is better if you want one build to work against multiple backends.

### 5.4 Customer prerequisites for SSO sign-in

The customer also needs:

- An **AWS IAM Identity Center** instance in their organization
- A **start URL** (e.g. `https://d-1234567890.awsapps.com/start`) and the SSO region — both shown on the Identity Center settings page
- Their user must have at least one **permission set** assigned to the networking account that grants the IAM permissions in [`docs/iam-policy.json`](./iam-policy.json)

Once deployed, the customer enters the SSO start URL, region, and (optionally) the backend URL in the app's Connect AWS dialog. The backend handles the OIDC device flow and returns short-lived credentials.

### 5.5 Alternative: Deploy via the AWS Console (no SAM CLI)

If you can't install the SAM CLI, deploy through the AWS CloudFormation console instead using the [`backend/console-deployment/`](../../backend/console-deployment/) folder.

1. **Build `lambda.zip`.** From the `backend/` directory (pure Node.js — works on Windows, macOS, and Linux; needs only Node ≥ 22 and npm):

   ```bash
   cd backend
   node console-deployment/build-lambda-zip.mjs
   ```

2. **Create/pick an S3 bucket** in the same region you'll deploy into, and **upload `lambda.zip`**. Note the bucket name and object key.
3. **Create a CloudFormation stack** from `template-console.yaml` (Console → CloudFormation → Create stack → Upload a template file), with three parameters:
   - `ArtifactBucket` — the bucket from step 2
   - `ArtifactKey` — `lambda.zip` (or your key if renamed)
   - `AllowedOrigins` — your exact SPA origin, e.g. `http://localhost:4173`, with **no trailing slash** and no wildcards
   Acknowledge the IAM-resource-creation checkbox before submitting.
4. **Read the `ApiUrl` output** once the stack reaches `CREATE_COMPLETE`, then wire it into the SPA exactly as in [Section 5.3](#53-wire-the-api-url-into-the-spa).
5. **Smoke test** with `curl https://<api-id>.execute-api.<region>.amazonaws.com/health` — expect `{"status":"ok"}`.

See [`console-deployment/README.md`](../../backend/console-deployment/README.md) for the full walkthrough.

---

## 6. Cross-Account VPC Enrichment (Optional)

The app uses a **single set of credentials** from the **networking account**. From these credentials, the app can already discover TGWs, VGWs, and their owner account IDs via `DescribeDirectConnectGatewayAssociations`. However, to enrich the topology with VPC names and details from **spoke accounts**, the app can assume a role into each spoke account.

This requires a trust relationship between the networking account and each spoke account.

### Step 1: Create the IAM policy in the spoke account

1. Sign in to the **spoke account** in the AWS Console
2. Go to **IAM > Policies > Create policy**
3. Click the **JSON** tab and paste only the `DxVisualizerCore` statement from [`docs/iam-policy.json`](./iam-policy.json):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DxVisualizerCore",
      "Effect": "Allow",
      "Action": [
        "directconnect:DescribeConnections",
        "directconnect:DescribeVirtualInterfaces",
        "directconnect:DescribeDirectConnectGateways",
        "directconnect:DescribeDirectConnectGatewayAssociations",
        "directconnect:DescribeDirectConnectGatewayAssociationProposals",
        "directconnect:DescribeDirectConnectGatewayAttachments",
        "directconnect:DescribeLocations",
        "directconnect:DescribeLags",
        "directconnect:ListVirtualInterfaceRoutes",
        "directconnect:ListVirtualInterfaceTestHistory",
        "ec2:DescribeRegions",
        "ec2:DescribeVpcs",
        "ec2:DescribeVpnGateways",
        "ec2:DescribeTransitGateways",
        "ec2:DescribeTransitGatewayAttachments",
        "ec2:DescribeTransitGatewayPeeringAttachments",
        "ec2:DescribeVpcPeeringConnections",
        "ec2:DescribeCustomerGateways",
        "ec2:DescribeVpnConnections",
        "ec2:DescribeTransitGatewayRouteTables",
        "ec2:SearchTransitGatewayRoutes",
        "ec2:GetTransitGatewayRouteTablePropagations",
        "ec2:DescribeRouteTables",
        "networkmanager:ListCoreNetworks",
        "networkmanager:GetCoreNetwork",
        "networkmanager:ListAttachments",
        "networkmanager:ListPeerings",
        "networkmanager:GetNetworkRoutes",
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

4. Click **Next**, name the policy `DxVisualizerReadOnly`, then **Create policy**

### Step 2: Create a cross-account role in the spoke account

1. Still in the **spoke account**, go to **IAM > Roles > Create role**
2. Select **AWS account** as the trusted entity type
3. Choose **Another AWS account**
4. Enter your **networking account ID** (the account where your visualizer credentials live)
5. Click **Next**
6. Search for and attach the `DxVisualizerReadOnly` policy you just created
7. Click **Next**, name the role `NetworkReadOnlyRole`, then **Create role**

The trust policy on this role will look like:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<NETWORKING_ACCOUNT_ID>:root"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### Step 3: Grant the networking account AssumeRole permission

Steps 1-2 set up the spoke side. But the **networking account** IAM user also needs permission to *call* `sts:AssumeRole` — otherwise AWS will deny the request even though the spoke trusts it.

That is what the `DxVisualizerCrossAccount` statement does, and its `Resource` list must **name each spoke account explicitly**:

```json
{
  "Sid": "DxVisualizerCrossAccount",
  "Effect": "Allow",
  "Action": [
    "sts:AssumeRole"
  ],
  "Resource": [
    "arn:aws:iam::<SPOKE_ACCOUNT_ID_1>:role/NetworkReadOnlyRole",
    "arn:aws:iam::<SPOKE_ACCOUNT_ID_2>:role/NetworkReadOnlyRole"
  ]
}
```

One `Resource` entry per spoke account — add a line for every account you set up in Steps 1-2, using its real 12-digit ID.

> **Do not use an account wildcard** (`"Resource": "arn:aws:iam::*:role/NetworkReadOnlyRole"`). It lets this principal assume *any* role named `NetworkReadOnlyRole` in *any* AWS account that trusts it back — including an account someone else controls. A third party can create that trust unilaterally, so all they then need is for an operator to add their account ID to the app's **Spoke account IDs** field, and the app starts making API calls inside their account. Enumerating the account IDs closes that path, and costs you one line per spoke account.

**Whichever way you set up Section 4, you have something to do here:**

- **If you kept the full `iam-policy.json`** ([Section 4](#4-iam-setup-networking-account)), the `DxVisualizerCrossAccount` statement is already in your policy, listing whichever accounts you substituted for the shipped `REPLACE_WITH_SPOKE_ACCOUNT_ID_N` placeholders in §4.3 / §4.4. (It cannot still hold the placeholders — IAM would have refused to create the policy.) **Check that list now:** it must name every spoke account you set up in Steps 1-2, and nothing else. There is no "nothing to do" case — enrichment silently fails for any spoke account missing from the list.
- **If you removed the `DxVisualizerCrossAccount` statement** during initial setup (because it was marked optional), add it back in the form shown above.

Either way:

1. Go to the **networking account** AWS Console
2. Go to **IAM > Policies** and find `DxVisualizerReadOnly`
3. Click **Edit**, switch to the **JSON** tab
4. Add or update the `DxVisualizerCrossAccount` statement so its `Resource` list contains one `arn:aws:iam::<ACCOUNT_ID>:role/NetworkReadOnlyRole` entry per spoke account, with real 12-digit account IDs and no `REPLACE_WITH_…` placeholders left
5. Click **Next > Save changes**

### Step 4: Repeat for each spoke account

Repeat Steps 1-2 in every spoke account that you want the visualizer to enrich with VPC details, and add one more `Resource` entry to the networking account's `DxVisualizerCrossAccount` statement (Step 3) for each account you add. Adding spoke accounts later means editing that list again — that is the intended cost of not using a wildcard.

### How it works

When the app discovers a TGW attachment owned by a different account, it automatically attempts to assume the `NetworkReadOnlyRole` in that account to fetch VPC names and details. If the role doesn't exist or the trust isn't configured, the app gracefully falls back to showing the VPC ID without enrichment.

---

## 7. Building for Production

The steps above run the app on `localhost`, which is all you need to evaluate it. For a shared or long-lived deployment, produce a static build and host it wherever suits your environment.

```bash
npm run build
```

The output is a static bundle in the `dist/` folder — plain HTML, JS, and CSS with no application server. `npm run preview` serves it locally for a quick check:

```bash
npm run preview
```

Because it's just static files, you can host `dist/` on any static-capable target, for example:

- **Amazon S3 + CloudFront** — upload `dist/` to a bucket and front it with a CloudFront distribution (HTTPS, CDN caching)
- **A container on EKS / ECS** — copy `dist/` into an nginx (or similar) image and serve it behind an ALB
- **Any static web server** — nginx, Apache, Caddy, GitHub Pages, etc.

Hosting elsewhere doesn't change how the app works: AWS SDK calls still run **directly from the user's browser** with their own credentials, and the IAM policy in [Section 4](#4-iam-setup-networking-account) is unchanged. Three things to set up for a hosted origin:

- **HTTPS** — serve the SPA over TLS (SSO device-flow and clipboard/credential handling expect a secure context).
- **SSO backend CORS** — if you use the SSO flow, add your production origin to the backend's `AllowedOrigins` (see [Section 5.2](#52-build-and-deploy)); the backend rejects wildcard origins by design.
- **Security response headers** — configure your static host to emit `Content-Security-Policy: frame-ancestors 'none'`, or at minimum `X-Frame-Options: DENY`. This has to come from the host: the SPA ships a CSP in a `<meta http-equiv>` tag, and **`frame-ancestors` is ignored in a meta tag** — browsers honour it only as a real HTTP response header. Without it the app can be framed by any origin, which matters here because it handles AWS credentials in browser memory. Also recommended, and set by the same mechanism: `Strict-Transport-Security` (`max-age=31536000; includeSubDomains`), `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Content-Type-Options: nosniff`. For an S3 + CloudFront origin, [`docs/cloudfront-response-headers-policy.yaml`](./cloudfront-response-headers-policy.yaml) is a copyable `AWS::CloudFront::ResponseHeadersPolicy` with all of the above; on nginx, Apache, or Caddy set the equivalent headers in your server config.

Choosing and operating a specific hosting target (bucket policies, CloudFront behaviors, Kubernetes manifests, TLS certificates) is up to you — this guide doesn't prescribe one.

---

## 8. Configuration

All configuration is via environment variables (see [`.env.example`](../.env.example)). Set them in `dx-visualizer/.env` before `npm run build` or `npm run dev` — Vite bakes them into the bundle at build time. The app starts with the defaults below, so none are needed to evaluate it locally; the two Guardrail variables are **required for any production deployment** (see [Section 8.1](#81-bedrock-guardrails)).

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_BEDROCK_MODEL_ID` | `global.anthropic.claude-opus-5` | Bedrock model ID (cross-region prefix auto-added) |
| `VITE_DEFAULT_REGION` | `us-east-1` | Fallback AWS region (regions are auto-discovered from DX/Cloud WAN data) |
| `VITE_MAX_TOOL_ROUNDS` | `5` | Max tool-use rounds per chat turn |
| `VITE_DEFAULT_SCENARIO` | `noResiliency` | Default mock scenario |
| `VITE_APP_TITLE` | `Network Resilience Agent` | App title in the top bar |
| `VITE_SSO_BACKEND_URL` | _(unset)_ | SSO backend URL (from CloudFormation stack output, or `http://localhost:3001` for dev) |
| `VITE_BEDROCK_GUARDRAIL_ID` | _(unset — local dev only)_ | Bedrock Guardrail identifier (content filtering and prompt attack detection). **Required in production** — see [Section 8.1](#81-bedrock-guardrails) |
| `VITE_BEDROCK_GUARDRAIL_VERSION` | `DRAFT` | Bedrock Guardrail version (`1`, `2`, ... or `DRAFT`). Pin a numbered version in production rather than `DRAFT` |

### 8.1 Bedrock Guardrails

[Amazon Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) add server-side content filtering and prompt attack detection to the chat agent. When configured, every Bedrock ConverseStream request is evaluated against your guardrail policy — both user input and model output are filtered in real time.

**A Guardrail is a required step for any production deployment of this app.** The app still runs without one, but only as a local-development convenience — do not ship it that way.

1. Open the [Bedrock console](https://console.aws.amazon.com/bedrock/home#/guardrails) and create a guardrail with:
   - **Prompt attack detection** set to **High** — blocks jailbreak and injection attempts
   - **Sensitive information filters** — detects/redacts PII, credentials, account IDs
   - **Content filters** — blocks toxic or harmful content
   - **Denied topics** for anything outside the app's scope that you don't want the agent discussing
2. Note the guardrail ID and version from the console
3. Set in your `.env`:
   ```
   VITE_BEDROCK_GUARDRAIL_ID=your-guardrail-id
   VITE_BEDROCK_GUARDRAIL_VERSION=1
   ```
4. Rebuild (`npm run build`) — Vite bakes these in at build time

**Why this is not optional.** The chat agent's system prompt embeds your live topology, including **resource names, tags, and descriptions** ([Section 6.3 of the README](../../README.md#63-topology-context-passed-to-the-model)). With cross-account VPC enrichment enabled ([Section 6](#6-cross-account-vpc-enrichment-optional)), some of that text comes from **spoke accounts** you assume a role into. Anyone who can set a tag in a spoke account — a spoke administrator, or anything automated that writes tags there — can therefore place natural-language text of their choosing into the model's context. A `Tags.Name` value reading *"ignore previous instructions and …"* is a prompt-injection payload delivered through an entirely legitimate data path.

The app hardens the prompt itself: untrusted values are XML-escaped and fenced inside delimited data blocks carrying an explicit treat-as-data instruction. But textual hardening is inherently probabilistic — it makes injection harder, not impossible. `PROMPT_ATTACK` at **High** is the deterministic backstop, because Bedrock evaluates it server-side, outside the prompt text an attacker can influence.

A **production build now emits a `console.warn` when `VITE_BEDROCK_GUARDRAIL_ID` is unset**, pointing back at this section. If you see that warning in a deployed environment, the deployment is not finished.

---

## 9. Troubleshooting

| Issue | Solution |
|-------|----------|
| `npm install` fails | Ensure Node.js v20.19+ or v22.12+ is installed (Vite 8 requirement). Try deleting `node_modules` and running `npm install` again |
| Port 5173 already in use | Stop the other process, or Vite will auto-pick the next available port |
| Blank screen in browser | Open browser dev tools (F12) and check the Console tab for errors |
| Connected but canvas is empty | The canvas shows an in-canvas banner when a connected account has no Direct Connect resources. Verify your credentials, the selected region, and that the account actually owns DX connections / VIFs / DXGWs |
| Chat not responding | Ensure you have the Bedrock model access enabled in your AWS region (see [Section 4.6](#46-enable-bedrock-model-access-required-for-ai-chat)) |
| Chat can't fetch costs | Ensure your credentials have `ce:GetCostAndUsage` permission. Cost Explorer must be enabled in the account |
| Chat gives wrong date range | The chat agent is date-aware. If costs seem off, specify the exact month (e.g., "costs for February 2026") |
| Maintenance calendar never shows up | The calendar hides itself when there are no upcoming AWS Health events. It also stays hidden on accounts without a Business, Enterprise On-Ramp, or Enterprise Support plan (the Health API returns `SubscriptionRequiredException`) |
