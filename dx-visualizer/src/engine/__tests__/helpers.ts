import type { TopologyData } from '../../types/topology';

export function makeEmptyTopology(): TopologyData {
  return {
    connections: [],
    virtualInterfaces: [],
    dxGateways: [],
    dxGatewayAssociations: [],
    locations: [],
    lags: [],
    vpcs: [],
    vpnGateways: [],
    vpnConnections: [],
    transitGateways: [],
    transitGatewayAttachments: [],
    transitGatewayPeeringAttachments: [],
    vpcPeerings: [],
    customerGateways: [],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    tgwRouteTables: new Map(),
    vpcRouteTables: new Map(),
    cloudWanRoutes: new Map(),
  };
}
