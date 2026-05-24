import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, interval } from 'rxjs';
import { Chart, registerables } from 'chart.js';
import { FleetService } from '../../core/fleet.service';
import { AuthService } from '../../core/auth.service';
import { NodeData, HistoryPoint, PhysicalDrive } from '../../models/types';

Chart.register(...registerables);

function formatBytes(b: number): string {
  if (!b) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
}
function formatUptime(s: number): string {
  if (!s) return '--';
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  const p: string[] = []; if (d) p.push(`${d}d`); if (h) p.push(`${h}h`); p.push(`${m}m`);
  return p.join(' ');
}
function getTempClass(t: number): string { return t < 45 ? 'cool' : t < 65 ? 'warm' : 'hot'; }
function createGradient(ctx: CanvasRenderingContext2D, color: string, aTop: number, aBot: number): CanvasGradient {
  const g = ctx.createLinearGradient(0,0,0,150);
  const r = parseInt(color.slice(1,3),16), gr = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  g.addColorStop(0, `rgba(${r},${gr},${b},${aTop})`);
  g.addColorStop(1, `rgba(${r},${gr},${b},${aBot})`);
  return g;
}

const CHART_OPTS: object = {
  responsive: true, maintainAspectRatio: false,
  scales: {
    x: { display: false },
    y: { min: 0, display: true, ticks: { color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3, callback: (v: unknown) => v + '%' }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } }
  },
  plugins: {
    legend: { display: false },
    tooltip: { enabled: true, mode: 'index', intersect: false, backgroundColor: 'rgba(10,10,20,0.95)', titleColor: '#6b7280', bodyColor: '#e2e2ee', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10 }
  },
  animation: { duration: 350 },
  elements: { line: { tension: 0.4, borderWidth: 2 }, point: { radius: 0, hoverRadius: 5 } },
  layout: { padding: { left: 0, right: 8, top: 8, bottom: 0 } }
};

const NET_OPTS: object = {
  ...CHART_OPTS,
  scales: {
    x: { display: false },
    y: { min: 0, display: true, beginAtZero: true, ticks: { color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3 }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } }
  }
};

@Component({
  selector: 'app-detail-drawer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './detail-drawer.component.html'
})
export class DetailDrawerComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() hostname!: string;
  @Output() closed = new EventEmitter<void>();

  @ViewChild('cpuCanvas') cpuCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('ramCanvas') ramCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('netCanvas') netCanvas!: ElementRef<HTMLCanvasElement>;

  data: NodeData | null = null;
  viewMode: 'chart' | 'raw' = 'chart';
  historyRange = '';
  heartbeat = false;

  cpuLoad = '--'; ramUsage = '--'; stripTemp = '--'; stripUptime = '--';
  netRx = '0.0'; netTx = '0.0';
  ramDetail = '-- / --'; rootPercent = '--%'; rootDetail = '-- / --'; rootBar = 0;
  osInfo = '—'; cpuTempClass = ''; cpuTempVal = '';
  isGateway = false;
  drives: PhysicalDrive[] = [];
  historyRows: HistoryPoint[] = [];

  formatBytes = formatBytes;
  formatUptime = formatUptime;
  getTempClass = getTempClass;

  private cpuChart?: Chart;
  private ramChart?: Chart;
  private netChart?: Chart;
  private sub?: Subscription;
  private readonly MAX_PTS = 120;

  constructor(private fleetService: FleetService, public auth: AuthService) {}

  ngOnInit(): void {
    this.fetchStats();
    this.sub = interval(5000).subscribe(() => this.fetchStats());
    document.title = `${this.hostname} | cockpit`;
  }

  ngAfterViewInit(): void {
    this.initCharts();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.cpuChart?.destroy();
    this.ramChart?.destroy();
    this.netChart?.destroy();
    document.title = 'nerifeige.de · cockpit';
  }

  private initCharts(): void {
    if (this.cpuCanvas) {
      const ctx = this.cpuCanvas.nativeElement.getContext('2d')!;
      this.cpuChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#ff9f0a', backgroundColor: createGradient(ctx,'#ff9f0a',0.18,0), fill: true, spanGaps: true }] }, options: CHART_OPTS as never });
    }
    if (this.ramCanvas) {
      const ctx = this.ramCanvas.nativeElement.getContext('2d')!;
      this.ramChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: '#8b5cf6', backgroundColor: createGradient(ctx,'#8b5cf6',0.18,0), fill: true, spanGaps: true }] }, options: CHART_OPTS as never });
    }
    if (this.netCanvas) {
      const ctx = this.netCanvas.nativeElement.getContext('2d')!;
      this.netChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [
        { label: 'Download (Rx)', data: [], borderColor: '#4d7cfe', backgroundColor: createGradient(ctx,'#4d7cfe',0.15,0), fill: true, tension: 0.5, borderWidth: 2 },
        { label: 'Upload (Tx)', data: [], borderColor: '#ff8c00', backgroundColor: createGradient(ctx,'#ff8c00',0.15,0), fill: true, tension: 0.5, borderWidth: 2 }
      ] }, options: NET_OPTS as never });
    }
  }

  onRangeChange(): void {
    [this.cpuChart, this.ramChart, this.netChart].forEach(c => {
      if (!c) return;
      c.data.labels = [];
      c.data.datasets.forEach(d => { d.data = []; });
      c.update('none');
    });
    this.fetchStats();
  }

  private fetchStats(): void {
    this.fleetService.getNodeStats(this.hostname, this.historyRange || undefined).subscribe({
      next: d => {
        this.data = d;
        this.heartbeat = true; setTimeout(() => this.heartbeat = false, 500);
        this.updateDisplay(d);
        if (this.viewMode === 'raw' && d.history) this.historyRows = [...d.history].reverse();
      },
      error: () => {}
    });
  }

  private updateDisplay(d: NodeData): void {
    this.isGateway = d.os === 'fritzbox' || !!(d.model?.toLowerCase().includes('fritz'));
    this.osInfo = `${d.model || 'Unknown'} · ${d.os || 'Linux'} · Up ${formatUptime(d.uptime ?? 0)}`;

    const isLive = !this.historyRange;
    const shouldLoad = d.history && (this.cpuChart?.data.datasets[0].data.length === 0 || !isLive);
    if (shouldLoad && d.history) {
      const hist = d.history.slice(-this.MAX_PTS);
      [this.cpuChart, this.ramChart, this.netChart].forEach(c => { if (!c) return; c.data.labels = []; c.data.datasets.forEach(ds => { ds.data = []; }); });
      const fmt = ['7d','30d'].includes(this.historyRange)
        ? { month: 'short' as const, day: 'numeric' as const, hour: '2-digit' as const, minute: '2-digit' as const }
        : { hour: '2-digit' as const, minute: '2-digit' as const, second: '2-digit' as const };
      hist.forEach(h => {
        const t = h.time ? new Date(h.time).toLocaleTimeString([], fmt) : '';
        this.pushChart(this.cpuChart, h.cpu ?? 0, t);
        this.pushChart(this.ramChart, h.ram ?? 0, t);
        if (this.netChart) {
          this.netChart.data.labels!.push(t);
          this.netChart.data.datasets[0].data.push(h.rx ?? 0);
          this.netChart.data.datasets[1].data.push(h.tx ?? 0);
        }
      });
      this.cpuChart?.update('none'); this.ramChart?.update('none'); this.netChart?.update('none');
    }

    const tl = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    if (d.cpu?.load != null) {
      this.cpuLoad = String(d.cpu.load);
      this.pushChart(this.cpuChart, d.cpu.load, tl);
      if (d.cpu.temp) { this.stripTemp = `${d.cpu.temp}°C`; this.cpuTempVal = `${d.cpu.temp}°C`; this.cpuTempClass = getTempClass(d.cpu.temp); }
      else { this.stripTemp = '--'; this.cpuTempVal = ''; }
    }
    if (d.memory?.percent != null) {
      this.ramUsage = String(d.memory.percent);
      this.pushChart(this.ramChart, d.memory.percent, tl);
      this.ramDetail = `${formatBytes(d.memory.used)} / ${formatBytes(d.memory.total)}`;
    }
    if (d.uptime) this.stripUptime = formatUptime(d.uptime);
    if (d.network && this.netChart) {
      const rx = (d.network.rx_sec / 1024).toFixed(1), tx = (d.network.tx_sec / 1024).toFixed(1);
      this.netRx = rx; this.netTx = tx;
      this.netChart.data.labels!.push(tl);
      this.netChart.data.datasets[0].data.push(parseFloat(rx));
      this.netChart.data.datasets[1].data.push(parseFloat(tx));
      if ((this.netChart.data.labels?.length ?? 0) > this.MAX_PTS) {
        this.netChart.data.labels!.shift();
        this.netChart.data.datasets[0].data.shift();
        this.netChart.data.datasets[1].data.shift();
      }
      this.netChart.update('none');
    }
    if (d.storage?.root) {
      this.rootPercent = `${d.storage.root.percent}%`;
      this.rootBar = d.storage.root.percent;
      this.rootDetail = `${formatBytes(d.storage.root.used)} / ${formatBytes(d.storage.root.total)}`;
    }
    this.drives = (d.stats?.drives || d.drives || []) as PhysicalDrive[];
  }

  private pushChart(chart: Chart | undefined, val: number, label: string): void {
    if (!chart) return;
    chart.data.datasets[0].data.push(val);
    chart.data.labels!.push(label);
    if ((chart.data.datasets[0].data.length) > this.MAX_PTS) { chart.data.datasets[0].data.shift(); chart.data.labels!.shift(); }
    chart.update('none');
  }

  get historyKeys(): string[] {
    if (!this.historyRows.length) return [];
    const all = new Set<string>();
    this.historyRows.forEach(h => Object.keys(h).forEach(k => { if (!['time','recorded_at','data','GATEWAY_LOGS','cpu','ram','rx','tx'].includes(k)) all.add(k); }));
    return Array.from(all).sort();
  }

  exportData(): void {
    const token = this.auth.getToken();
    const tf = (document.getElementById('export-timeframe') as HTMLSelectElement)?.value || 'all';
    const a = document.createElement('a');
    a.href = `/api/export/${this.hostname}?timeframe=${tf}&token=${encodeURIComponent(token ?? '')}`;
    a.setAttribute('download', '');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  setViewMode(m: 'chart' | 'raw'): void {
    this.viewMode = m;
    if (m === 'raw') this.fetchStats();
  }

  driveOk(d: PhysicalDrive): boolean { return d.status === 'Healthy'; }
  close(): void { this.closed.emit(); }
}
