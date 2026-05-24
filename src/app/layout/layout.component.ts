import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { filter } from 'rxjs/operators';
import { AuthService } from '../core/auth.service';
import { FleetService } from '../core/fleet.service';
import { JwtPayload } from '../models/types';
import { AccountModalComponent } from '../shared/account-modal/account-modal.component';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, AccountModalComponent],
  templateUrl: './layout.component.html'
})
export class LayoutComponent implements OnInit, OnDestroy {
  user: JwtPayload | null = null;
  menuOpen = false;
  heartbeat = false;
  showAccountModal = false;
  currentPath = '';

  private subs = new Subscription();
  private tokenTimer?: ReturnType<typeof setInterval>;

  constructor(
    public auth: AuthService,
    private fleet: FleetService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.user = this.auth.currentUser();

    this.subs.add(
      this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
        this.currentPath = this.router.url;
        this.menuOpen = false;
      })
    );

    this.subs.add(
      interval(10000).subscribe(() => this.sendHeartbeat())
    );
    this.sendHeartbeat();

    this.tokenTimer = setInterval(() => this.checkTokenRefresh(), 60_000);
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.tokenTimer) clearInterval(this.tokenTimer);
  }

  private sendHeartbeat(): void {
    this.fleet.sendHeartbeat().subscribe({
      next: () => { this.heartbeat = true; setTimeout(() => this.heartbeat = false, 500); },
      error: () => {}
    });
  }

  private async checkTokenRefresh(): Promise<void> {
    const payload = this.auth.currentUser();
    if (!payload) return;
    const msLeft = payload.exp * 1000 - Date.now();
    if (msLeft < 3 * 60 * 1000) {
      const ok = await this.auth.tryRefresh();
      if (!ok) { this.auth.clearToken(); this.router.navigate(['/login']); }
    }
  }

  get isAdmin(): boolean { return this.user?.role === 'admin'; }
  get isOperator(): boolean { return this.user?.role === 'operator' || this.user?.role === 'admin'; }

  logout(): void { this.auth.logout(); this.menuOpen = false; }
  openAccount(): void { this.menuOpen = false; this.showAccountModal = true; }

  @HostListener('document:click', ['$event'])
  onDocumentClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.closest('#user-chip-btn') && !target.closest('#user-menu')) {
      this.menuOpen = false;
    }
  }
}
