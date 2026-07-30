import type { NodeProps } from '@xyflow/react';
import { useTopologyStore } from '../../store/topology-store';
import { AwsLogo } from './aws-icons';

export function AwsCloudNode(_: NodeProps) {
  const theme = useTopologyStore((s) => s.theme);
  const light = theme === 'light';

  const awsNavy = '#232F3E';
  return (
    <div
      className="rounded-xl pointer-events-none"
      style={{
        borderWidth: 2,
        borderStyle: 'solid',
        borderColor: light ? '#94a3b8' : '#64748b',
        backgroundColor: light ? 'rgba(248,250,252,0.65)' : 'rgba(30,41,59,0.6)',
        width: '100%',
        height: '100%',
        position: 'relative',
        opacity: 1,
        boxShadow: light ? '0 0 0 1px rgba(71,85,105,0.10), 0 2px 10px rgba(15,23,42,0.06)' : '0 0 0 1px rgba(100,116,139,0.2)',
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5"
        style={{
          backgroundColor: awsNavy,
          borderBottom: `1px solid ${awsNavy}`,
          borderRadius: '10px 10px 0 0',
        }}
      >
        <div className="text-white">
          <AwsLogo size={28} />
        </div>
      </div>
    </div>
  );
}
