'use client';

import { useMemo, useRef } from 'react';

export interface GraphNode {
  id: string;
  title: string;
  dir: string;
  kind: string;
  tags: string[];
  chars: number;
  edited: string;
  outgoing: number;
  backlinks: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface NodeKindMeta {
  color: string;
  icon: string;
}

export interface LayoutAlgorithm {
  type: 'cluster' | 'force-directed' | 'grid';
  config?: Record<string, any>;
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  nodeKindMeta: Record<string, NodeKindMeta>;
  layout?: LayoutAlgorithm;
  width?: number;
  height?: number;
  className?: string;
}

function topDir(dir: string): string {
  if (!dir) return '(root)';
  return dir.split('/')[0] ?? '(root)';
}

// Cluster layout: nodes are positioned in clusters by top-level directory.
// Each cluster gets a slot on a ring; nodes inside spread radially.
function calculateClusterLayout(
  nodes: GraphNode[], 
  width: number, 
  height: number, 
  config?: Record<string, any>
): Map<string, { x: number; y: number; cluster: string; hue: number }> {
  const byTop = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const top = topDir(node.dir);
    const arr = byTop.get(top) ?? [];
    arr.push(node);
    byTop.set(top, arr);
  }
  
  const tops = Array.from(byTop.keys()).sort();
  const R = Math.min(width, height) / 2 - 80;
  const cx = width / 2;
  const cy = height / 2;
  const pos = new Map<string, { x: number; y: number; cluster: string; hue: number }>();
  
  tops.forEach((top, i) => {
    const angle = (i / tops.length) * Math.PI * 2 - Math.PI / 2;
    const clusterX = cx + Math.cos(angle) * R * 0.55;
    const clusterY = cy + Math.sin(angle) * R * 0.55;
    const items = byTop.get(top) ?? [];
    const hue = (i * 137.508) % 360;
    const ringR = Math.min(140, 14 + Math.sqrt(items.length) * 12);
    
    items.forEach((node, j) => {
      const a = (j / Math.max(items.length, 1)) * Math.PI * 2;
      pos.set(node.id, {
        x: clusterX + Math.cos(a) * ringR * (0.6 + 0.4 * (((node.id.length * 17) % 100) / 100)),
        y: clusterY + Math.sin(a) * ringR * (0.6 + 0.4 * (((node.id.length * 31) % 100) / 100)),
        cluster: top,
        hue,
      });
    });
  });
  
  return pos;
}

// Simple force-directed layout simulation
function calculateForceDirectedLayout(
  nodes: GraphNode[], 
  edges: GraphEdge[], 
  width: number, 
  height: number, 
  config?: Record<string, any>
): Map<string, { x: number; y: number; cluster: string; hue: number }> {
  const pos = new Map<string, { x: number; y: number; cluster: string; hue: number }>();
  
  // Initialize positions randomly
  nodes.forEach((node, i) => {
    pos.set(node.id, {
      x: Math.random() * (width - 100) + 50,
      y: Math.random() * (height - 100) + 50,
      cluster: topDir(node.dir),
      hue: (i * 137.508) % 360,
    });
  });
  
  // Simple force-directed simulation iterations
  const iterations = config?.iterations || 50;
  const repulsionStrength = config?.repulsionStrength || 1000;
  const attractionStrength = config?.attractionStrength || 0.1;
  const damping = config?.damping || 0.9;
  
  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map<string, { x: number; y: number }>();
    
    // Initialize forces
    nodes.forEach(node => {
      forces.set(node.id, { x: 0, y: 0 });
    });
    
    // Repulsion forces between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeA = nodes[i];
        const nodeB = nodes[j];
        const posA = pos.get(nodeA.id)!;
        const posB = pos.get(nodeB.id)!;
        
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        
        const force = repulsionStrength / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        
        forces.set(nodeA.id, { 
          x: forces.get(nodeA.id)!.x + fx, 
          y: forces.get(nodeA.id)!.y + fy 
        });
        forces.set(nodeB.id, { 
          x: forces.get(nodeB.id)!.x - fx, 
          y: forces.get(nodeB.id)!.y - fy 
        });
      }
    }
    
    // Attraction forces along edges
    edges.forEach(edge => {
      const posA = pos.get(edge.from);
      const posB = pos.get(edge.to);
      if (!posA || !posB) return;
      
      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      
      const force = distance * attractionStrength;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      
      forces.set(edge.from, { 
        x: forces.get(edge.from)!.x + fx, 
        y: forces.get(edge.from)!.y + fy 
      });
      forces.set(edge.to, { 
        x: forces.get(edge.to)!.x - fx, 
        y: forces.get(edge.to)!.y - fy 
      });
    });
    
    // Apply forces with damping
    nodes.forEach(node => {
      const position = pos.get(node.id)!;
      const force = forces.get(node.id)!;
      
      position.x += force.x * damping;
      position.y += force.y * damping;
      
      // Keep nodes within bounds
      position.x = Math.max(20, Math.min(width - 20, position.x));
      position.y = Math.max(20, Math.min(height - 20, position.y));
    });
  }
  
  return pos;
}

// Grid layout: nodes are positioned in a grid pattern
function calculateGridLayout(
  nodes: GraphNode[], 
  width: number, 
  height: number, 
  config?: Record<string, any>
): Map<string, { x: number; y: number; cluster: string; hue: number }> {
  const pos = new Map<string, { x: number; y: number; cluster: string; hue: number }>();
  
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const rows = Math.ceil(nodes.length / cols);
  
  const cellWidth = (width - 100) / cols;
  const cellHeight = (height - 100) / rows;
  
  nodes.forEach((node, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    
    pos.set(node.id, {
      x: 50 + col * cellWidth + cellWidth / 2,
      y: 50 + row * cellHeight + cellHeight / 2,
      cluster: topDir(node.dir),
      hue: (i * 137.508) % 360,
    });
  });
  
  return pos;
}

export default function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelectNode,
  nodeKindMeta,
  layout = { type: 'cluster' },
  width = 1000,
  height = 700,
  className,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Layout algorithms for positioning nodes
  const positions = useMemo(() => {
    switch (layout.type) {
      case 'cluster':
        return calculateClusterLayout(nodes, width, height, layout.config);
      case 'force-directed':
        return calculateForceDirectedLayout(nodes, edges, width, height, layout.config);
      case 'grid':
        return calculateGridLayout(nodes, width, height, layout.config);
      default:
        return calculateClusterLayout(nodes, width, height, layout.config);
    }
  }, [nodes, edges, width, height, layout]);

  const visibleEdges = useMemo(() => 
    edges.filter(edge => positions.has(edge.from) && positions.has(edge.to)), 
    [edges, positions]
  );
  
  const selectedEdges = useMemo(() => 
    selectedId ? visibleEdges.filter((e) => e.from === selectedId || e.to === selectedId) : [],
    [visibleEdges, selectedId]
  );

  return (
    <div 
      className={className}
      style={{ 
        position: 'relative', 
        background: 'var(--bg)', 
        overflow: 'hidden', 
        display: 'flex', 
        flexDirection: 'column', 
        minWidth: 0 
      }}
    >
      <div className="bg-grid" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <svg 
        ref={svgRef} 
        viewBox={`0 0 ${width} ${height}`} 
        preserveAspectRatio="xMidYMid meet" 
        style={{ flex: 1, width: '100%', height: '100%', minHeight: 0 }}
      >
        <g opacity={0.18}>
          {visibleEdges.map((edge, i) => {
            const fromPos = positions.get(edge.from)!;
            const toPos = positions.get(edge.to)!;
            return (
              <line 
                key={i} 
                x1={fromPos.x} 
                y1={fromPos.y} 
                x2={toPos.x} 
                y2={toPos.y} 
                stroke="var(--ink-3)" 
                strokeWidth={0.4} 
              />
            );
          })}
        </g>
        {selectedId && (
          <g opacity={0.95}>
            {selectedEdges.map((edge, i) => {
              const fromPos = positions.get(edge.from)!;
              const toPos = positions.get(edge.to)!;
              const isOut = edge.from === selectedId;
              return (
                <line 
                  key={i} 
                  x1={fromPos.x} 
                  y1={fromPos.y} 
                  x2={toPos.x} 
                  y2={toPos.y}
                  stroke={isOut ? 'var(--accent)' : 'var(--warn)'} 
                  strokeWidth={1.2} 
                />
              );
            })}
          </g>
        )}
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          
          const meta = nodeKindMeta[node.kind] ?? nodeKindMeta.note ?? { color: 'var(--ink-3)', icon: 'NTE' };
          const radius = 2.5 + Math.min(6, Math.sqrt(node.backlinks + node.outgoing));
          const active = selectedId === node.id;
          
          return (
            <g key={node.id} onClick={() => onSelectNode(node.id)} style={{ cursor: 'pointer' }}>
              <circle 
                cx={pos.x} 
                cy={pos.y} 
                r={radius} 
                fill={meta.color} 
                opacity={active ? 1 : 0.85}
                stroke={active ? 'var(--ink)' : 'transparent'} 
                strokeWidth={active ? 1.5 : 0} 
              />
              {active && (
                <text 
                  x={pos.x + radius + 4} 
                  y={pos.y + 3} 
                  fontSize={10} 
                  fill="var(--ink)" 
                  fontFamily="'JetBrains Mono', monospace"
                >
                  {node.title.slice(0, 40)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}