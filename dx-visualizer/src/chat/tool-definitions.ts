import type { ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

export const TOOL_CONFIG: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'get_dx_pricing',
        description:
          'Look up AWS Direct Connect pricing for a given region and port speed. Returns monthly port cost and data transfer rates.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              region: {
                type: 'string',
                description: 'AWS region code, e.g. us-east-1, ap-southeast-1',
              },
              port_speed: {
                type: 'string',
                enum: ['1Gbps', '10Gbps', '100Gbps'],
                description: 'DX port speed',
              },
              num_connections: {
                type: 'number',
                description: 'Number of connections to price (default 1)',
              },
            },
            required: ['region', 'port_speed'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_network_service_pricing',
        description:
          'Look up pricing for AWS networking services related to Direct Connect topologies: Transit Gateway (TGW), Virtual Private Gateway (VGW), or Site-to-Site VPN. Returns hourly and monthly cost estimates.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              service: {
                type: 'string',
                enum: ['tgw', 'vpn', 'vgw'],
                description: 'The networking service to look up pricing for',
              },
              region: {
                type: 'string',
                description: 'AWS region code, e.g. us-east-1, ap-southeast-1',
              },
              num_attachments: {
                type: 'number',
                description: 'Number of attachments/connections to price (default 1)',
              },
            },
            required: ['service', 'region'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_topology_summary',
        description:
          'Get a structured summary of the current Direct Connect topology including connection counts, locations, VIFs, gateways, and per-DX-Gateway resiliency level (none/devtest/high/maximum).',
        inputSchema: {
          json: {
            type: 'object',
            properties: {},
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'compare_dx_gateways',
        description:
          'Compare two Direct Connect Gateways against each other. Returns (1) whether they serve the same downstream TGW/VGW/VPC/Cloud WAN core network — which decides whether a difference is a redundancy gap or the intended design, (2) a diff of the allowedPrefixes each gateway may advertise back to on-premises, always available, and (3) a diff of the BGP prefixes each gateway accepts from the customer routers, when route data has been fetched. Use this whenever the user asks to compare, diff, or check redundancy between two named DX Gateways. Read the returned howToReport field before describing any difference.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              gateway_a: {
                type: 'string',
                description: 'First DX Gateway, by name or by ID. Names are matched case-insensitively, and a unique partial match is accepted.',
              },
              gateway_b: {
                type: 'string',
                description: 'Second DX Gateway, by name or by ID.',
              },
            },
            required: ['gateway_a', 'gateway_b'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'estimate_upgrade_cost',
        description:
          'Estimate what additional connections and locations are needed, plus the cost, to upgrade to a target resiliency level.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              target_level: {
                type: 'string',
                enum: ['devtest', 'high', 'maximum'],
                description: 'Target resiliency tier to upgrade to',
              },
            },
            required: ['target_level'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'switch_view',
        description:
          'Switch the visualizer between "current" (existing topology) and "recommended" (with improvement overlay) views.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              view: {
                type: 'string',
                enum: ['current', 'recommended'],
                description: 'Which view to switch to',
              },
            },
            required: ['view'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'toggle_simulation',
        description:
          'Enable or disable failure simulation mode, which lets users click on zones and edges to simulate failures.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              enabled: {
                type: 'boolean',
                description: 'true to start simulation, false to stop',
              },
            },
            required: ['enabled'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_actual_costs',
        description:
          'Fetch actual AWS costs for Direct Connect and related networking services (VPC, VPN, Transit Gateway) from AWS Cost Explorer. Returns total cost and per-service breakdown.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format (default: 30 days ago)',
              },
              end_date: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format (default: today)',
              },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_daily_dx_costs',
        description:
          'Fetch daily cost breakdown for AWS Direct Connect over a time period. Useful for identifying cost trends and spikes.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format (default: 30 days ago)',
              },
              end_date: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format (default: today)',
              },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'toggle_live_status',
        description:
          'Toggle the live status overlay on or off. When enabled, edge labels show operational status indicators (connection state, VIF state, BGP status, VPN tunnel status) with colored dots. When disabled, edge labels show only topology information.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              enabled: {
                type: 'boolean',
                description: 'true to show live status, false to hide it. If omitted, toggles current state.',
              },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'change_scenario',
        description:
          'Switch to a different demo scenario (only works in mock/demo mode). Available scenarios: noResiliency, devTest, high, maximum, crossAccount.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              scenario: {
                type: 'string',
                enum: ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'],
                description: 'Demo scenario to load',
              },
            },
            required: ['scenario'],
          },
        },
      },
    },
  ],
};
