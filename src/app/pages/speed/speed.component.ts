import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { Chart, registerables } from 'chart.js';
import { SpeedService } from '../../core/speed.service';
import { SpeedLog } from '../../models/types';

Chart.register(...registerables);

function createGradient(ctx: CanvasRenderingContext2D, hex: string, aTop: number, aBot: number): CanvasGradient {
  const g = ctx.createLinearGradient(0,0,0,150);
  const r = parseInt(hex.slice(1,3),16), gr = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  g.addColorStop(0, `rgba(${r},${gr},${b},${aTop})`); g.addColorStop(1, `rgba(${r},${gr},${b},${aBot})`);
  return g;
}

@Component({
  selector: 'app-speed',
  standalone: true,
  imports: [CommonModule, DatePipe],
  templateUrl: './speed.component.html'
})
export class SpeedComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('speedCanvas') speedCanvas!: ElementRef<HTMLCanvasElement>;

  logs: SpeedLog[] = [];
  loadError = '';
  avgDl = '--'; avgUl = '--'; avgPing = '--';
  private chart?: Chart;

  constructor(private speedService: SpeedService) {}

  ngOnInit(): void { this.loadLogs(); }

  ngAfterViewInit(): void { this.initChart(); }

  ngOnDestroy(): void { this.chart?.destroy(); }

  private initChart(): void {
    const ctx = this.speedCanvas?.nativeElement.getContext('2d');
    if (!ctx) return;
    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Download (Mbit/s)', data: [], borderColor: '#4d7cfe', backgroundColor: createGradient(ctx,'#4d7cfe',0.15,0), fill: true, tension: 0.4, borderWidth: 2 },
          { label: 'Upload (Mbit/s)', data: [], borderColor: '#ff8c00', backgroundColor: createGradient(ctx,'#ff8c00',0.15,0), fill: true, tension: 0.4, borderWidth: 2 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { display: true, ticks: { color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } },
          y: { min: 0, display: true, ticks: { color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 5, callback: v => v + ' Mb/s' }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } }
        },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: 'rgba(255,255,255,0.6)', font: { size: 10 }, usePointStyle: true, boxWidth: 6, boxHeight: 6 } },
          tooltip: { enabled: true, mode: 'index', intersect: false, backgroundColor: 'rgba(10,10,20,0.95)', bodyColor: '#e2e2ee', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10, callbacks: { label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) => ` ${ctx.dataset.label}: ${(ctx.parsed.y ?? 0).toFixed(2)}` } }
        },
        elements: { line: { tension: 0.4, borderWidth: 2 }, point: { radius: 2, hoverRadius: 5 } },
        animation: { duration: 350 }
      }
    });
    if (this.logs.length) this.updateChart();
  }

  private loadLogs(): void {
    this.speedService.getLogs().subscribe({
      next: data => {
        this.logs = data;
        if (data.length) {
          let dl = 0, ul = 0, ping = 0;
          data.forEach(r => { dl += parseFloat(r.download_mbps)||0; ul += parseFloat(r.upload_mbps)||0; ping += parseFloat(r.ping_ms)||0; });
          const n = data.length;
          this.avgDl = (dl/n).toFixed(1); this.avgUl = (ul/n).toFixed(1); this.avgPing = (ping/n).toFixed(1);
        }
        if (this.chart) this.updateChart();
      },
      error: (e) => { this.loadError = e?.error?.error || e?.message || 'Failed to load speed logs'; console.error('speedlogs:', e); }
    });
  }

  private updateChart(): void {
    if (!this.chart) return;
    const sorted = [...this.logs].reverse();
    this.chart.data.labels = sorted.map(r => { const d = new Date(r.tested_at); return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); });
    this.chart.data.datasets[0].data = sorted.map(r => parseFloat(r.download_mbps)||0);
    this.chart.data.datasets[1].data = sorted.map(r => parseFloat(r.upload_mbps)||0);
    this.chart.update('none');
  }

  fmtDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
}
