import { COLORS } from '../../utils/colors';

interface LiveStatusDotProps {
  state: string | undefined;
  upPattern?: RegExp;
}

export function LiveStatusDot({ state, upPattern }: LiveStatusDotProps) {
  if (!state) return null;
  const isUp = upPattern ? upPattern.test(state) : state === 'available';
  const color = isUp ? COLORS.status.up : COLORS.status.down;
  return (
    <div className="flex items-center gap-1 text-[9px]">
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          display: 'inline-block',
          backgroundColor: color,
        }}
      />
      <span style={{ color, fontWeight: 600 }}>{state}</span>
    </div>
  );
}
