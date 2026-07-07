// AWS Pricing API client — fetches live pricing from the AWS Price List API.
// The Pricing API is only available in us-east-1 and ap-south-1.

import {
  PricingClient,
  GetProductsCommand,
} from '@aws-sdk/client-pricing';
import type { AwsCredentials } from '../types/aws-resources';
import { REGION_NAMES } from '../utils/shared';

const HOURS_PER_MONTH = 730;

// Service codes for the AWS Price List API
const SERVICE_CODES: Record<string, string> = {
  dx: 'AWSDirectConnect',
  tgw: 'AmazonVPC',
  vpn: 'AmazonVPC',
  vgw: 'AmazonVPC',
};

function createPricingClient(creds: AwsCredentials): PricingClient {
  return new PricingClient({
    region: 'us-east-1', // Pricing API only available here
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

// Extract USD price from a Price List API product JSON
function extractPrice(priceListItem: string): { pricePerUnit: number; unit: string; description: string } | null {
  try {
    const product = JSON.parse(priceListItem);
    const terms = product.terms?.OnDemand;
    if (!terms) return null;

    for (const termKey of Object.keys(terms)) {
      const priceDimensions = terms[termKey].priceDimensions;
      for (const dimKey of Object.keys(priceDimensions)) {
        const dim = priceDimensions[dimKey];
        const usd = parseFloat(dim.pricePerUnit?.USD ?? '0');
        if (usd > 0) {
          return {
            pricePerUnit: usd,
            unit: dim.unit ?? '',
            description: dim.description ?? '',
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Direct Connect Pricing ----

export interface DxPricingResult {
  monthlyPortCostPerConnection: number;
  numConnections: number;
  totalMonthlyPortCost: number;
  dataTransferRatePerGb: number;
  currency: 'USD';
  notes: string;
}

export async function lookupDxPricing(
  creds: AwsCredentials,
  region: string,
  portSpeed: string,
  numConnections: number = 1
): Promise<DxPricingResult> {
  const client = createPricingClient(creds);
  const regionName = REGION_NAMES[region] ?? region;

  // Map portSpeed to capacity filter value — the Pricing API uses different formats
  const capacityVariants: Record<string, string[]> = {
    '1Gbps': ['1Gbps', '1000Mbps', '1 Gbps'],
    '10Gbps': ['10Gbps', '10 Gbps'],
    '100Gbps': ['100Gbps', '100 Gbps'],
  };
  const variants = capacityVariants[portSpeed] ?? [portSpeed];

  try {
    // Try multiple capacity formats since the Pricing API is inconsistent
    let hourlyRate = 0;
    for (const capacity of variants) {
      const portCmd = new GetProductsCommand({
        ServiceCode: SERVICE_CODES.dx,
        Filters: [
          { Type: 'TERM_MATCH', Field: 'location', Value: regionName },
          { Type: 'TERM_MATCH', Field: 'capacity', Value: capacity },
        ],
        MaxResults: 10,
      });
      const portResp = await client.send(portCmd);

      for (const item of portResp.PriceList ?? []) {
        const price = extractPrice(item);
        if (price) {
          hourlyRate = price.pricePerUnit;
          break;
        }
      }
      if (hourlyRate > 0) break;
    }

    // Fetch data transfer pricing
    const dtCmd = new GetProductsCommand({
      ServiceCode: SERVICE_CODES.dx,
      Filters: [
        { Type: 'TERM_MATCH', Field: 'fromLocation', Value: regionName },
        { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Data Transfer' },
      ],
      MaxResults: 5,
    });
    const dtResp = await client.send(dtCmd);

    let dtRate = 0;
    for (const item of dtResp.PriceList ?? []) {
      const price = extractPrice(item);
      if (price && price.pricePerUnit > 0) {
        dtRate = price.pricePerUnit;
        break;
      }
    }

    if (hourlyRate === 0) {
      return {
        monthlyPortCostPerConnection: 0,
        numConnections,
        totalMonthlyPortCost: 0,
        dataTransferRatePerGb: dtRate,
        currency: 'USD',
        notes: `AWS Pricing API returned no port pricing for ${portSpeed} in ${regionName} — cannot answer right now.`,
      };
    }

    const monthlyPerConn = Math.round(hourlyRate * HOURS_PER_MONTH * 100) / 100;
    return {
      monthlyPortCostPerConnection: monthlyPerConn,
      numConnections,
      totalMonthlyPortCost: Math.round(monthlyPerConn * numConnections * 100) / 100,
      dataTransferRatePerGb: dtRate,
      currency: 'USD',
      notes: `Live pricing for ${regionName}, ${portSpeed} port ($${hourlyRate}/hr). Data transfer: $${dtRate}/GB outbound.`,
    };
  } catch (err) {
    const isAccessDenied = err instanceof Error && (err.name === 'AccessDeniedException' || err.message.includes('not authorized'));
    return {
      monthlyPortCostPerConnection: 0,
      numConnections,
      totalMonthlyPortCost: 0,
      dataTransferRatePerGb: 0,
      currency: 'USD',
      notes: isAccessDenied
        ? 'Access denied: your IAM role does not have the `pricing:GetProducts` permission. Please add this permission to fetch live pricing.'
        : `AWS Pricing API unavailable — cannot answer right now (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}

// ---- Network Service Pricing (TGW, VPN, VGW) ----

export interface NetworkServicePricingResult {
  service: string;
  region: string;
  hourlyRate: number;
  monthlyEstimate: number;
  perGbRate: number;
  currency: 'USD';
  notes: string;
}

export async function lookupNetworkServicePricing(
  creds: AwsCredentials,
  service: 'tgw' | 'vpn' | 'vgw',
  region: string,
  numAttachments: number = 1,
): Promise<NetworkServicePricingResult> {
  // VGW itself has no charge
  if (service === 'vgw') {
    return {
      service: 'Virtual Private Gateway (VGW)',
      region,
      hourlyRate: 0,
      monthlyEstimate: 0,
      perGbRate: 0,
      currency: 'USD',
      notes: 'VGW has no hourly charge. Costs come from attached VPN connections or Direct Connect VIFs.',
    };
  }

  const client = createPricingClient(creds);
  const regionName = REGION_NAMES[region] ?? region;

  try {
    if (service === 'tgw') {
      // TGW attachment pricing
      const attachCmd = new GetProductsCommand({
        ServiceCode: SERVICE_CODES.tgw,
        Filters: [
          { Type: 'TERM_MATCH', Field: 'location', Value: regionName },
          { Type: 'TERM_MATCH', Field: 'group', Value: 'AWSTransitGateway' },
          { Type: 'TERM_MATCH', Field: 'groupDescription', Value: 'TransitGateway Attachment' },
        ],
        MaxResults: 5,
      });
      const attachResp = await client.send(attachCmd);

      let attachHourly = 0;
      for (const item of attachResp.PriceList ?? []) {
        const price = extractPrice(item);
        if (price) { attachHourly = price.pricePerUnit; break; }
      }

      // TGW data processing
      const dataCmd = new GetProductsCommand({
        ServiceCode: SERVICE_CODES.tgw,
        Filters: [
          { Type: 'TERM_MATCH', Field: 'location', Value: regionName },
          { Type: 'TERM_MATCH', Field: 'group', Value: 'AWSTransitGateway' },
          { Type: 'TERM_MATCH', Field: 'groupDescription', Value: 'TransitGateway Data Processing' },
        ],
        MaxResults: 5,
      });
      const dataResp = await client.send(dataCmd);

      let dataPerGb = 0;
      for (const item of dataResp.PriceList ?? []) {
        const price = extractPrice(item);
        if (price) { dataPerGb = price.pricePerUnit; break; }
      }

      const totalHourly = attachHourly * numAttachments;
      const monthly = Math.round(totalHourly * HOURS_PER_MONTH * 100) / 100;

      return {
        service: 'Transit Gateway (TGW)',
        region: regionName,
        hourlyRate: totalHourly,
        monthlyEstimate: monthly,
        perGbRate: dataPerGb,
        currency: 'USD',
        notes: `Live pricing: $${attachHourly}/hr per attachment × ${numAttachments}. Data processing: $${dataPerGb}/GB.`,
      };
    }

    // VPN pricing
    const vpnCmd = new GetProductsCommand({
      ServiceCode: SERVICE_CODES.vpn,
      Filters: [
        { Type: 'TERM_MATCH', Field: 'location', Value: regionName },
        { Type: 'TERM_MATCH', Field: 'group', Value: 'VPNConnection' },
      ],
      MaxResults: 5,
    });
    const vpnResp = await client.send(vpnCmd);

    let vpnHourly = 0;
    for (const item of vpnResp.PriceList ?? []) {
      const price = extractPrice(item);
      if (price) { vpnHourly = price.pricePerUnit; break; }
    }

    const totalHourly = vpnHourly * numAttachments;
    const monthly = Math.round(totalHourly * HOURS_PER_MONTH * 100) / 100;

    return {
      service: 'Site-to-Site VPN',
      region: regionName,
      hourlyRate: totalHourly,
      monthlyEstimate: monthly,
      perGbRate: 0,
      currency: 'USD',
      notes: `Live pricing: $${vpnHourly}/hr per VPN connection × ${numAttachments}.`,
    };
  } catch (err) {
    const isAccessDenied = err instanceof Error && (err.name === 'AccessDeniedException' || err.message.includes('not authorized'));
    return {
      service: service === 'tgw' ? 'Transit Gateway (TGW)' : 'Site-to-Site VPN',
      region,
      hourlyRate: 0,
      monthlyEstimate: 0,
      perGbRate: 0,
      currency: 'USD',
      notes: isAccessDenied
        ? 'Access denied: your IAM role does not have the `pricing:GetProducts` permission. Please add this permission to fetch live pricing.'
        : `Failed to fetch pricing: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
