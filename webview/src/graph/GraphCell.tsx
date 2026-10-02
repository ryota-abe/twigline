import { memo } from 'react';
import { laneColor } from '../util/format';
import type { GraphRow } from './layout';

// Drawing: a small SVG per row. The upper half draws up (lines gathering into the node) and through,
// the lower half draws down (lines going to the parents) and through.

export const ROW_HEIGHT = 22;
export const LANE_WIDTH = 14;
const PAD = 6;

export function laneX(lane: number): number {
  return PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

export function graphWidth(lanes: number): number {
  return PAD * 2 + Math.max(lanes, 1) * LANE_WIDTH;
}

interface Props {
  row: GraphRow;
  colors: string[];
  width: number;
  kind: 'commit' | 'merge' | 'uncommitted' | 'stash';
  isHead?: boolean;
  dots?: boolean;
  /** Color number of the branch to emphasize (from fork to merge of the selected commit) */
  span?: number;
}

const BASE_WIDTH = 2;
const SPAN_WIDTH = 3.2;

function GraphCellImpl({ row, colors, width, kind, isHead, dots, span }: Props) {
  const h = ROW_HEIGHT;
  const mid = h / 2;
  const xl = laneX(row.lane);
  const color = (i: number) => laneColor(colors, i);
  const nodeColor = color(row.color);
  const dashed = kind === 'uncommitted' ? '3 3' : undefined;
  const sw = (i: number) => (i === span ? SPAN_WIDTH : BASE_WIDTH);

  return (
    <svg className="graph-cell" width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true">
      {!dots &&
        row.through.map((t) => <line key={`t${t.lane}`} x1={laneX(t.lane)} y1={0} x2={laneX(t.lane)} y2={h} stroke={color(t.color)} strokeWidth={sw(t.color)} />)}
      {!dots &&
        row.up.map((u) => {
          const xi = laneX(u.lane);
          const d = xi === xl ? `M ${xi} 0 L ${xl} ${mid}` : `M ${xi} 0 C ${xi} ${mid * 0.7}, ${xl} ${mid * 0.3}, ${xl} ${mid}`;
          return <path key={`u${u.lane}`} d={d} fill="none" stroke={color(u.color)} strokeWidth={sw(u.color)} />;
        })}
      {!dots &&
        row.down.map((dn, i) => {
          const xt = laneX(dn.to);
          const d = xt === xl ? `M ${xl} ${mid} L ${xt} ${h}` : `M ${xl} ${mid} C ${xl} ${mid + (h - mid) * 0.7}, ${xt} ${mid + (h - mid) * 0.3}, ${xt} ${h}`;
          return <path key={`d${i}`} d={d} fill="none" stroke={color(dn.color)} strokeWidth={sw(dn.color)} strokeDasharray={dashed} />;
        })}
      {kind === 'uncommitted' ? (
        <circle cx={xl} cy={mid} r={4.5} fill="var(--twigline-bg)" stroke={nodeColor} strokeWidth={1.6} strokeDasharray="2 2" />
      ) : kind === 'stash' ? (
        <rect x={xl - 4} y={mid - 4} width={8} height={8} rx={1.5} fill="var(--twigline-bg)" stroke={nodeColor} strokeWidth={1.8} />
      ) : (
        <>
          {isHead && <circle cx={xl} cy={mid} r={7} fill="none" stroke={nodeColor} strokeWidth={1.5} />}
          <circle cx={xl} cy={mid} r={row.color === span ? 5.5 : 4.5} fill={nodeColor} />
          {kind === 'merge' && <circle cx={xl} cy={mid} r={2} fill="var(--twigline-bg)" />}
        </>
      )}
    </svg>
  );
}

export const GraphCell = memo(GraphCellImpl);
