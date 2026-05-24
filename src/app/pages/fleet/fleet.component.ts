import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { Chart, registerables } from 'chart.js';
import { FleetService } from '../../core/fleet.service';
import { AuthService } from '../../core/auth.service';
import { NodeData, FleetResponse, ServiceInfo } from '../../models/types';
import { DetailDrawerComponent } from '../../shared/detail-drawer/detail-drawer.component';

Chart.register(...registerables);

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function formatUptime(seconds: number): string {
  if (!seconds) return '--';
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
  const p: string[] = [];
  if (d) p.push(`${d}d`); if (h) p.push(`${h}h`); p.push(`${m}m`);
  return p.join(' ');
}
function getTempClass(t: number): string { return t < 45 ? 'cool' : t < 65 ? 'warm' : 'hot'; }

export interface NodeEntry { hostname: string; data: NodeData; }

@Component({
  selector: 'app-fleet',
  standalone: true,
  imports: [CommonModule, DetailDrawerComponent],
  templateUrl: './fleet.component.html'
})
export class FleetComponent implements OnInit, OnDestroy {
  nodes: NodeEntry[] = [];
  stats = { avgCpu: '--', avgRam: '--', avgRx: '--', avgTx: '--', rxUnit: 'KB/s inbound', txUnit: 'KB/s outbound', peakTemp: '--', tempClass: '', nodesOnline: '--', nodesSub: 'of fleet online', cpuBar: 0, ramBar: 0, rxBar: 0, txBar: 0, tempBar: 0, nodesBar: 0 };
  hubInfo = { uptime: '--', model: '--', os: '--' };
  services: ServiceInfo[] = [];
  selectedHostname: string | null = null;
  drawerOpen = false;

  formatBytes = formatBytes;
  formatUptime = formatUptime;
  getTempClass = getTempClass;

  private subs = new Subscription();

  constructor(
    private fleetService: FleetService,
    public auth: AuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.subs.add(
      this.route.params.subscribe(params => {
        const hostname = params['hostname'];
        if (hostname) {
          this.selectedHostname = hostname;
          this.drawerOpen = true;
        } else {
          this.drawerOpen = false;
          this.selectedHostname = null;
        }
      })
    );

    this.fetchFleet();
    this.subs.add(interval(5000).subscribe(() => this.fetchFleet()));

    const user = this.auth.currentUser();
    if (user?.role === 'operator' || user?.role === 'admin') {
      this.fetchServices();
      this.subs.add(interval(10000).subscribe(() => this.fetchServices()));
    }
  }

  ngOnDestroy(): void { this.subs.unsubscribe(); }

  get isOperator(): boolean {
    const u = this.auth.currentUser();
    return u?.role === 'operator' || u?.role === 'admin';
  }

  private fetchFleet(): void {
    this.fleetService.getFleet().subscribe({
      next: (data: FleetResponse) => {
        if (data.hubSystem) {
          this.hubInfo = {
            uptime: formatUptime(data.hubSystem.uptime),
            model: data.hubSystem.model || 'Unknown',
            os: data.hubSystem.os || 'Linux'
          };
        }
        const servers = data.servers || {};
        this.nodes = Object.entries(servers).map(([hostname, d]) => ({ hostname, data: d }));
        this.updateStats(servers);
      },
      error: () => {}
    });
  }

  private fetchServices(): void {
    this.fleetService.getServices().subscribe({
      next: s => { this.services = s; },
      error: () => {}
    });
  }

  private updateStats(servers: Record<string, NodeData>): void {
    const entries = Object.entries(servers);
    let total = 0, online = 0, gateways = 0;
    let cpuS = 0, cpuC = 0, ramS = 0, ramC = 0, rxS = 0, txS = 0, netC = 0, maxT = 0;

    entries.forEach(([, d]) => {
      const isGw = d.gateway || d.model?.toLowerCase().includes('fritz');
      const isOn = (Date.now() - d.lastReport) < 45000;
      if (isGw) { gateways++; return; }
      total++;
      if (isOn) online++;
      if (d.cpu?.load != null && d.cpu.load > 0) { cpuS += d.cpu.load; cpuC++; if ((d.cpu.temp ?? 0) > maxT) maxT = d.cpu.temp ?? 0; }
      if (d.memory?.percent != null && d.memory.percent > 0) { ramS += d.memory.percent; ramC++; }
      if (d.network?.rx_sec != null) { rxS += d.network.rx_sec / 1024; txS += d.network.tx_sec / 1024; netC++; }
    });

    const avgCpu = cpuC > 0 ? cpuS / cpuC : null;
    const avgRam = ramC > 0 ? ramS / ramC : null;
    const avgRx = netC > 0 ? rxS / netC : null;
    const avgTx = netC > 0 ? txS / netC : null;
    const fmtNet = (v: number | null) => v === null ? '--' : v >= 1024 ? (v/1024).toFixed(1) : v.toFixed(1);

    this.stats = {
      avgCpu: avgCpu !== null ? avgCpu.toFixed(1) : '--',
      avgRam: avgRam !== null ? avgRam.toFixed(1) : '--',
      avgRx: fmtNet(avgRx), avgTx: fmtNet(avgTx),
      rxUnit: avgRx !== null && avgRx >= 1024 ? 'MB/s inbound' : 'KB/s inbound',
      txUnit: avgTx !== null && avgTx >= 1024 ? 'MB/s outbound' : 'KB/s outbound',
      peakTemp: maxT > 0 ? `${maxT}°C` : '--',
      tempClass: maxT > 0 ? getTempClass(maxT) : '',
      nodesOnline: total > 0 ? `${online}/${total}` : '--',
      nodesSub: `of fleet online${gateways ? ` · ${gateways} gw` : ''}`,
      cpuBar: avgCpu !== null ? Math.min(avgCpu, 100) : 0,
      ramBar: avgRam !== null ? Math.min(avgRam, 100) : 0,
      rxBar: avgRx !== null ? Math.min((avgRx / (avgRx >= 1024 ? 100 : 1000)) * 100, 100) : 0,
      txBar: avgTx !== null ? Math.min((avgTx / (avgTx >= 1024 ? 100 : 1000)) * 100, 100) : 0,
      tempBar: maxT > 0 ? Math.min((maxT / 90) * 100, 100) : 0,
      nodesBar: total > 0 ? (online / total) * 100 : 0
    };
  }

  openDetails(hostname: string): void {
    this.router.navigate(['/', hostname]);
  }

  onDrawerClose(): void {
    this.drawerOpen = false;
    this.selectedHostname = null;
    this.router.navigate(['/']);
  }

  isOnline(data: NodeData): boolean { return (Date.now() - data.lastReport) < 45000; }
  isGateway(data: NodeData): boolean { return !!(data.gateway || data.model?.toLowerCase().includes('fritz')); }
  cpuClass(data: NodeData): string { const c = data.cpu?.load ?? 0; return c > 85 ? 'hot' : c > 65 ? 'warm' : 'cpu'; }

  serviceAction(name: string, action: string): void {
    if (!confirm(`${action} ${name}?`)) return;
    this.fleetService.serviceAction(name, action).subscribe({ next: () => this.fetchServices(), error: () => {} });
  }

  triggerUpdate(): void {
    if (!confirm('Hub aktualisieren? Git pull + Rebuild werden ausgeführt.')) return;
    this.fleetService.triggerUpdate().subscribe({ next: () => alert('Update-Befehl gesendet!'), error: () => {} });
  }
}
