export interface JwtPayload {
  sub: string | number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  exp: number;
  iat: number;
}

export interface NodeData {
  lastReport: number;
  uptime?: number;
  model?: string;
  os?: string;
  cpu?: { load: number; temp?: number };
  memory?: { percent: number; used: number; total: number };
  network?: { rx_sec: number; tx_sec: number; ext_ip?: string };
  storage?: {
    root?: { percent: number; used: number; total: number };
    drives?: DriveInfo[];
  };
  gateway?: {
    dsl_sync?: string;
    vpn_active?: boolean;
    logs?: string;
  };
  stats?: { jobs?: JobInfo[]; drives?: PhysicalDrive[] };
  jobs?: JobInfo[];
  drives?: PhysicalDrive[];
  history?: HistoryPoint[];
  hostname?: string;
}

export interface FleetResponse {
  servers: Record<string, NodeData>;
  hubSystem?: { uptime: number; model?: string; os?: string };
}

export interface DriveInfo {
  device: string;
  status: string;
}

export interface PhysicalDrive {
  name: string;
  model: string;
  size: number;
  state: string;
  status: string;
}

export interface JobInfo {
  name: string;
  status: string;
  started?: string;
}

export interface HistoryPoint {
  time?: string;
  cpu?: number;
  ram?: number;
  rx?: number;
  tx?: number;
  [key: string]: unknown;
}

export interface SpeedLog {
  tested_at: string;
  download_mbps: string;
  upload_mbps: string;
  ping_ms: string;
  jitter_ms: string;
  isp?: string;
  client_ip?: string;
  location?: string;
}

export interface User {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  totp_enabled: boolean;
  created_at: string;
}

export interface ServiceInfo {
  name: string;
  status: string;
  description: string;
}
