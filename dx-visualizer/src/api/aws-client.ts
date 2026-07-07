import { DirectConnectClient } from '@aws-sdk/client-direct-connect';
import { EC2Client } from '@aws-sdk/client-ec2';
import { STSClient } from '@aws-sdk/client-sts';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { NetworkManagerClient } from '@aws-sdk/client-networkmanager';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { IAMClient } from '@aws-sdk/client-iam';
import { HealthClient } from '@aws-sdk/client-health';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { AwsCredentials } from '../types/aws-resources';

const CLIENT_CONFIG = {
  requestHandler: {
    requestTimeout: 15_000, // 15 second timeout per request
  },
};

export function createDxClient(creds: AwsCredentials): DirectConnectClient {
  return new DirectConnectClient({
    ...CLIENT_CONFIG,
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createEc2Client(creds: AwsCredentials): EC2Client {
  return new EC2Client({
    ...CLIENT_CONFIG,
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createStsClient(creds: AwsCredentials): STSClient {
  return new STSClient({
    ...CLIENT_CONFIG,
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createOrganizationsClient(creds: AwsCredentials): OrganizationsClient {
  // Organizations API is global — always use us-east-1
  return new OrganizationsClient({
    ...CLIENT_CONFIG,
    region: 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createNetworkManagerClient(creds: AwsCredentials): NetworkManagerClient {
  // NetworkManager is global — always use us-west-2
  return new NetworkManagerClient({
    ...CLIENT_CONFIG,
    region: 'us-west-2',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createIamClient(creds: AwsCredentials): IAMClient {
  // IAM is global — any region works.
  return new IAMClient({
    ...CLIENT_CONFIG,
    region: 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createCloudWatchClient(creds: AwsCredentials): CloudWatchClient {
  return new CloudWatchClient({
    ...CLIENT_CONFIG,
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createSsmClient(creds: AwsCredentials): SSMClient {
  return new SSMClient({
    ...CLIENT_CONFIG,
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createHealthClient(creds: AwsCredentials): HealthClient {
  // AWS Health API is global; the active endpoint is us-east-1 with failover to us-east-2.
  return new HealthClient({
    ...CLIENT_CONFIG,
    region: 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}